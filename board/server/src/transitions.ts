/**
 * State transitions. Each function is the atomic side-effect bundle for one
 * transition row in state-machine.md §2 (T2..T15) plus auxiliary mutations
 * (description edit, comment append, archive).
 *
 * Atomicity model:
 *  1. Snapshot current card.md text on disk.
 *  2. BEGIN IMMEDIATE on SQLite.
 *  3. Write the new card.md atomically (temp + rename).
 *  4. Apply SQLite mutations.
 *  5. COMMIT.
 *  6. If COMMIT fails: ROLLBACK and best-effort restore card.md from snapshot.
 *
 * Comment append uses comments.jsonl (append-only) + comments table mirror,
 * both inside the same SQLite transaction. The jsonl write happens before
 * the SQLite append; same revert-on-failure rule applies.
 */
import {
  type Card,
  type CardStatus,
  type Comment,
  type HistoryEntry,
  type SseEvent,
  canTransition,
  type TransitionTrigger,
} from "@questboard/core";
import {
  db,
  upsertCardRow,
  appendCommentRow,
  appendHistoryRow,
  getCardRow,
  allocateCardId,
  listDeps,
} from "./db.js";
import {
  cardExistsOnDisk,
  readCard,
  writeCardAtomic,
  appendCommentToFile,
  appendHistoryToFile,
  snapshotCardMd,
  revertCardMd,
  moveCardToArchive,
  cardMdPath,
  commentsPath,
  historyPath,
} from "./files.js";
import { logger } from "./logger.js";
import { broadcast } from "./sse.js";
import { alertCard } from "./telegram.js";
import { detectLanguage } from "./lang.js";
import { getConfig } from "./config.js";
import { runCommandHook } from "./util/hooks.js";
import { existsSync, readFileSync, openSync, closeSync, ftruncateSync, renameSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { env } from "./env.js";

const ISO = () => new Date().toISOString();

export class TransitionError extends Error {
  constructor(message: string, public readonly code: string, public readonly status = 409) {
    super(message);
    this.name = "TransitionError";
  }
}

// ─── Atomic helper ───────────────────────────────────────────────────────────

interface AtomicArgs {
  cardId: string;
  before: Card;
  after: Card;
  archived?: boolean;
  /** SQL-side mutations (e.g. extra comment row, dep changes). Run inside tx. */
  sqlSideEffects?: () => void;
  /** Comments (worker↔human) to append to comments.jsonl + comments table. */
  comments?: Comment[];
  /** History (audit) entries to append to history.jsonl + history table. */
  history?: HistoryEntry[];
  /** SSE events to broadcast AFTER successful commit. */
  sse?: SseEvent[];
  /** Telegram alerts (fire-and-forget) AFTER successful commit. */
  alerts?: Array<() => Promise<void>>;
}

async function applyAtomic(args: AtomicArgs): Promise<void> {
  const {
    cardId,
    before,
    after,
    archived = false,
    sqlSideEffects,
    comments = [],
    history = [],
    sse = [],
    alerts = [],
  } = args;

  // 1. snapshot
  const cardSnapshot = snapshotCardMd(cardId, archived);
  // jsonl snapshots: track byte length so we can truncate on revert.
  const commentsFile = `${cardMdPath(cardId, archived).replace(/card\.md$/, "comments.jsonl")}`;
  const historyFile = historyPath(cardId, archived);
  const commentsSizeBefore = existsSync(commentsFile) ? readFileSync(commentsFile).length : 0;
  const historySizeBefore = existsSync(historyFile) ? readFileSync(historyFile).length : 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    // 2. write card.md (atomic temp+rename)
    await writeCardAtomic(cardId, after, archived);

    // 3. append jsonl lines
    for (const c of comments) appendCommentToFile(cardId, c, archived);
    for (const h of history) appendHistoryToFile(cardId, h, archived);

    // 4. SQL mirror
    upsertCardRow(after.frontmatter, after.frontmatter.deps);
    for (const c of comments) appendCommentRow(cardId, c);
    for (const h of history) appendHistoryRow(cardId, h);

    // Reset 3-strikes helper-death counter on every status transition. The
    // counter only counts deaths that happen WHILE THE CARD IS AT THE SAME
    // STAGE — moving to a different stage starts a fresh count from 0.
    if (before.frontmatter.status !== after.frontmatter.status) {
      db.prepare(
        "UPDATE cards SET consecutive_deaths = 0, consecutive_deaths_stage = NULL WHERE id = ?",
      ).run(cardId);
    }

    if (sqlSideEffects) sqlSideEffects();

    // 5. commit
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (rerr) {
      logger.error("rollback_failed", { cardId, err: String(rerr) });
    }
    // Best-effort revert of file mutations.
    if (cardSnapshot != null) revertCardMd(cardId, cardSnapshot, archived);
    truncateJsonl(commentsFile, commentsSizeBefore);
    truncateJsonl(historyFile, historySizeBefore);
    throw err;
  }

  // 6. broadcast events / alerts (post-commit, best-effort)
  for (const ev of sse) {
    try {
      broadcast(ev);
    } catch (err) {
      logger.warn("sse_broadcast_failed", { err: String(err) });
    }
  }
  for (const a of alerts) {
    a().catch((err) => logger.warn("alert_failed", { err: String(err) }));
  }

  void before;
}

function truncateJsonl(path: string, size: number): void {
  if (!existsSync(path)) return;
  try {
    const fd = openSync(path, "r+");
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    logger.error("jsonl_revert_failed", { path, err: String(err) });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function loadCard(id: string): { card: Card; archived: boolean } {
  const loc = cardExistsOnDisk(id);
  if (!loc.active && !loc.archived) {
    throw new TransitionError(`card not found: ${id}`, "card_not_found", 404);
  }
  return readCard(id);
}

function statusEvent(id: string, from: CardStatus, to: CardStatus): SseEvent {
  return { type: "card_status_changed", card_id: id, from, to };
}

function commentEvent(id: string, comment: Comment): SseEvent {
  return { type: "comment_added", card_id: id, comment };
}

function historyEvent(id: string, entry: HistoryEntry): SseEvent {
  return { type: "history_added", card_id: id, entry };
}

function systemEvent(body: string): HistoryEntry {
  return { ts: ISO(), author: "system", kind: "system_event", body };
}

function ensureStatus(card: Card, expected: CardStatus | CardStatus[]): void {
  const set = Array.isArray(expected) ? expected : [expected];
  if (!set.includes(card.frontmatter.status)) {
    throw new TransitionError(
      `expected status in [${set.join(",")}] got ${card.frontmatter.status}`,
      "bad_status",
      409,
    );
  }
}

function ensureCanTransition(from: CardStatus, to: CardStatus, trigger: TransitionTrigger): void {
  if (!canTransition(from, to, trigger)) {
    throw new TransitionError(`illegal transition ${from}→${to} by ${trigger}`, "illegal_transition", 409);
  }
}

// ─── T1: create card (backlog) ──────────────────────────────────────────────

export interface CreateCardInput {
  title: string;
  description?: string;
  language?: string;
  priority?: 1 | 2 | 3;
  deps?: string[];
  flavor?: "feature" | "bug" | "refactor" | "chore" | "docs";
  scope?: string | null;
  estimated_loc?: number | null;
  budget_minutes?: number | null;
  created_by?: "human" | "worker";
}

export async function createCard(input: CreateCardInput): Promise<Card> {
  const description = input.description ?? "";
  const config = getConfig();
  const language = input.language ?? detectLanguage(description, config.default_language);
  const now = ISO();

  // Validate deps point to known cards.
  for (const d of input.deps ?? []) {
    if (!getCardRow(d)) throw new TransitionError(`unknown dep: ${d}`, "bad_dep", 400);
  }

  // Allocate id under a write transaction. We can't use applyAtomic here
  // because the card doesn't exist yet — write the file outside the tx but
  // serialize id allocation through SQLite.
  let id = "";
  db.exec("BEGIN IMMEDIATE");
  try {
    id = allocateCardId();
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  }

  const card: Card = {
    frontmatter: {
      id,
      title: input.title,
      status: "backlog",
      flavor: input.flavor ?? "feature",
      priority: input.priority ?? 2,
      language,
      scope: input.scope ?? null,
      deps: input.deps ?? [],
      estimated_loc: input.estimated_loc ?? null,
      budget_minutes: input.budget_minutes ?? null,
      created_by: input.created_by ?? "human",
      created_at: now,
      updated_at: now,
      owner_pid: null,
      worktree: null,
      wip_branch: null,
      attempts: 0,
      stuck_reason: null,
      stuck_question: null,
      tokens_used: 0,
      elapsed_seconds: 0,
      pre_merge_sha: null,
      merged_sha: null,
      done_at: null,
      archived_at: null,
      post_build_attempts: [],
    },
    description,
  };

  const created = systemEvent(`status: ∅ → backlog`);
  await applyAtomic({
    cardId: id,
    before: card, // no prior state
    after: card,
    history: [created],
    sse: [{ type: "card_created", card_id: id }, historyEvent(id, created)],
  });

  return card;
}

// ─── T2: backlog → ready (human) ────────────────────────────────────────────

export async function transitionBacklogToReady(id: string): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "backlog");
  ensureCanTransition("backlog", "ready", "human");

  // Verify deps reference real cards (spec §2 cond).
  for (const d of card.frontmatter.deps) {
    if (!getCardRow(d)) throw new TransitionError(`unknown dep: ${d}`, "bad_dep", 400);
  }

  const next = bumpUpdated(setStatus(card, "ready"));
  const ev = systemEvent("status: backlog → ready");
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, "backlog", "ready"), historyEvent(id, ev)],
  });
  return next;
}

// ─── T2b: ready → backlog (human pulls card back) ──────────────────────────

/**
 * Pull a `ready` card back into `backlog`. Inverse of `transitionBacklogToReady`
 * (T2). Only valid while the card is still in `ready` — once the dispatcher
 * has claimed it (status === in_progress) the user has to go through requeue
 * first. No runtime fields to reset here: a `ready` card has no owner_pid /
 * worktree / stuck state set yet.
 */
export async function moveToBacklog(id: string): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "ready");
  ensureCanTransition("ready", "backlog", "human");

  const next = bumpUpdated(setStatus(card, "backlog"));
  const ev = systemEvent("status: ready → backlog");
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, "ready", "backlog"), historyEvent(id, ev)],
  });
  return next;
}

// ─── T3: ready → in_progress (claim by dispatcher/worker) ───────────────────

export async function claimCard(id: string, pid: number, opts: { worktree?: string; wip_branch?: string } = {}): Promise<Card> {
  const { card } = loadCard(id);

  // Idempotency: if already in_progress with same pid, return current.
  if (card.frontmatter.status === "in_progress" && card.frontmatter.owner_pid === pid) {
    return card;
  }
  if (card.frontmatter.status === "in_progress" && card.frontmatter.owner_pid != null && card.frontmatter.owner_pid !== pid) {
    throw new TransitionError(
      `already_claimed by ${card.frontmatter.owner_pid}`,
      "already_claimed",
      409,
    );
  }

  // Revive case: a previous helper crashed silently, the 3-strikes path
  // dropped owner_pid + workers row, and the dispatcher is now spawning a
  // FRESH worker for the same in_progress card. Status doesn't change;
  // bypass the normal status-transition checks but still bump attempts +
  // owner_pid so the UI/heartbeat see the new pid.
  const isRevive =
    card.frontmatter.status === "in_progress" && card.frontmatter.owner_pid == null;

  if (!isRevive) {
    ensureStatus(card, ["ready", "human_review", "ai_review"]);
    // From ready (T3) or from a re-spawn after reopen/reject (T8/T12
    // handled separately via `reopenCard` / `reviewerReject`). Direct claim
    // is only valid from ready.
    ensureCanTransition(card.frontmatter.status, "in_progress", "dispatcher");
  }

  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "in_progress",
      owner_pid: pid,
      worktree: opts.worktree ?? card.frontmatter.worktree,
      wip_branch: opts.wip_branch ?? card.frontmatter.wip_branch,
      attempts: card.frontmatter.attempts + 1,
    },
  });

  const ev = systemEvent(
    isRevive
      ? `revive: in_progress (pid=${pid})`
      : `status: ${card.frontmatter.status} → in_progress (pid=${pid})`,
  );
  const sse: SseEvent[] = [
    { type: "worker_started", card_id: id, pid },
    historyEvent(id, ev),
  ];
  if (!isRevive) {
    sse.unshift(statusEvent(id, card.frontmatter.status, "in_progress"));
  }
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse,
  });
  return next;
}

// ─── T4: in_progress → stuck (worker) ───────────────────────────────────────

export interface StuckInput {
  stuck_reason: NonNullable<Card["frontmatter"]["stuck_reason"]>;
  stuck_question?: string | null;
  comment_body?: string;
  /**
   * Author to attribute the stuck comment to. Defaults to `"worker"` for
   * backward compat. Reviewer-initiated stucks pass `"reviewer"`, merger-
   * initiated stucks pass `"system"` (Comment.author has no `"merger"`).
   */
  author?: "worker" | "reviewer" | "system";
}

export async function transitionToStuck(id: string, input: StuckInput): Promise<Card> {
  const { card } = loadCard(id);
  // Allow stuck transitions from any of the "active helper" statuses so a
  // reviewer or merger can escalate to human via the same path as a worker.
  if (
    card.frontmatter.status !== "in_progress" &&
    card.frontmatter.status !== "ai_review" &&
    card.frontmatter.status !== "merging"
  ) {
    throw new TransitionError(
      `cannot go stuck from ${card.frontmatter.status}`,
      "bad_status",
      409,
    );
  }
  const fromStatus = card.frontmatter.status;
  const trigger =
    fromStatus === "ai_review"
      ? "reviewer"
      : fromStatus === "merging"
        ? "dispatcher"
        : "worker";
  ensureCanTransition(fromStatus, "stuck", trigger);

  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "stuck",
      owner_pid: null,
      stuck_reason: input.stuck_reason,
      stuck_question: input.stuck_question ?? null,
    },
  });

  const stuckComment: Comment = {
    ts: ISO(),
    author: input.author ?? "worker",
    kind: "stuck",
    body: input.comment_body ?? input.stuck_question ?? `(stuck: ${input.stuck_reason})`,
  };

  const ev = systemEvent(`status: ${fromStatus} → stuck`);
  await runCommandHook({
    stage: "stuck",
    phase: "pre",
    cwd: env.BOARD_ROOT,
    cardId: id,
    env: {
      CARD_ID: id,
      FROM_STATUS: fromStatus,
      STUCK_REASON: input.stuck_reason,
      STUCK_QUESTION: input.stuck_question ?? "",
    },
  });
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    comments: [stuckComment],
    history: [ev],
    sse: [statusEvent(id, fromStatus, "stuck"), commentEvent(id, stuckComment), historyEvent(id, ev)],
    alerts: [() => alertCard("stuck", { id, title: card.frontmatter.title, language: card.frontmatter.language, stuck_question: input.stuck_question ?? null, stuck_reason: input.stuck_reason })],
  });
  await runCommandHook({
    stage: "stuck",
    phase: "post",
    cwd: env.BOARD_ROOT,
    cardId: id,
    env: {
      CARD_ID: id,
      FROM_STATUS: fromStatus,
      STUCK_REASON: input.stuck_reason,
      STUCK_QUESTION: input.stuck_question ?? "",
    },
  });
  return next;
}

// ─── T5: stuck → ready (server, auto on kind=answer) ────────────────────────

export async function autoResumeFromStuck(id: string): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "stuck");
  ensureCanTransition("stuck", "ready", "server");

  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "ready",
      stuck_reason: null,
      stuck_question: null,
    },
  });

  const resumed: Comment = { ts: ISO(), author: "system", kind: "resumed", body: "stuck → ready (answered)" };
  const ev = systemEvent("status: stuck → ready");
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    comments: [resumed],
    history: [ev],
    sse: [statusEvent(id, "stuck", "ready"), commentEvent(id, resumed), historyEvent(id, ev)],
  });
  return next;
}

// ─── T6: in_progress → human_review (worker) ────────────────────────────────

export async function transitionToHumanReview(id: string, opts: { wip_branch?: string } = {}): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "in_progress");
  ensureCanTransition("in_progress", "human_review", "worker");

  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "human_review",
      owner_pid: null,
      wip_branch: opts.wip_branch ?? card.frontmatter.wip_branch,
    },
  });

  // Auto-route to ai_review if config says so.
  const cfg = getConfig();
  if (cfg.auto_review) {
    const ev = systemEvent("status: in_progress → human_review");
    await applyAtomic({
      cardId: id,
      before: card,
      after: next,
      history: [ev],
      sse: [statusEvent(id, "in_progress", "human_review"), historyEvent(id, ev)],
      alerts: [() => alertCard("human_review", { id, title: card.frontmatter.title, language: card.frontmatter.language })],
    });
    // Then immediately push to ai_review (T9).
    return await transitionToAiReview(id, "server");
  }

  const ev = systemEvent("status: in_progress → human_review");
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, "in_progress", "human_review"), historyEvent(id, ev)],
    alerts: [() => alertCard("human_review", { id, title: card.frontmatter.title, language: card.frontmatter.language })],
  });
  return next;
}

// ─── T7: human_review → done (human approve) ────────────────────────────────
// ─── T11: ai_review → done (reviewer pass) ──────────────────────────────────

/**
 * Approval flow → routes the card into the `merging` column. The Merger
 * ephemeral worker (spawned by the dispatcher) is the actor that performs
 * the ff-merge / conflict resolution / final tests. Server stays out of git.
 */
export async function approveToMerging(id: string, by: "human" | "reviewer"): Promise<Card> {
  const { card } = loadCard(id);
  const from = card.frontmatter.status;
  if (by === "human") {
    ensureStatus(card, "human_review");
    ensureCanTransition("human_review", "merging", "human");
  } else {
    ensureStatus(card, "ai_review");
    ensureCanTransition("ai_review", "merging", "reviewer");
  }
  // Snapshot the configured base branch before the merger touches it.
  // pre_merge_sha gives the diff tab a stable anchor after local merges.
  let preMergeSha: string | null = null;
  try {
    const { gitMain } = await import("./git.js");
    const r = await gitMain(["rev-parse", getConfig().git.base_branch]);
    preMergeSha = r.stdout.trim() || null;
  } catch (err) {
    logger.warn("pre_merge_sha_capture_failed", { id, err: String(err) });
  }
  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "merging",
      owner_pid: null,
      pre_merge_sha: preMergeSha,
    },
  });
  const ev = systemEvent(`status: ${from} → merging (by=${by})`);
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, from, "merging"), historyEvent(id, ev)],
  });
  return next;
}

/**
 * Merger reported a clean merge — finalize immediately with merged_sha +
 * done_at. The diff tab uses pre_merge_sha + merged_sha, so configured
 * cleanup commands may remove the worker worktree/branch after the merge.
 */
export async function mergerComplete(id: string, mergedSha: string): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "merging");

  ensureCanTransition("merging", "done", "dispatcher");
  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "done",
      owner_pid: null,
      merged_sha: mergedSha,
      done_at: ISO(),
    },
  });

  const ev = systemEvent(`status: merging → done (sha=${mergedSha.slice(0, 12)})`);
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, "merging", "done"), historyEvent(id, ev)],
    alerts: [() => alertCard("done", { id, title: card.frontmatter.title, language: card.frontmatter.language })],
  });

  return next;
}

/**
 * Worker finished without a remaining diff because the branch is already on main.
 */
export async function noDiffComplete(
  id: string,
  wipBranch: string | null,
): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "in_progress");
  ensureCanTransition("in_progress", "done", "dispatcher");

  let mergedSha = card.frontmatter.merged_sha;
  try {
    const { gitMain } = await import("./git.js");
    const r = await gitMain(["rev-parse", getConfig().git.base_branch]);
    mergedSha = r.stdout.trim() || mergedSha;
  } catch (err) {
    logger.warn("no_diff_complete_sha_failed", { id, err: String(err) });
  }

  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "done",
      owner_pid: null,
      wip_branch: wipBranch ?? card.frontmatter.wip_branch,
      merged_sha: mergedSha,
      done_at: ISO(),
    },
  });

  const ev = systemEvent(
    `status: in_progress → done (no remaining diff${mergedSha ? `, sha=${mergedSha.slice(0, 12)}` : ""})`,
  );
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, "in_progress", "done"), historyEvent(id, ev)],
    alerts: [() => alertCard("done", { id, title: card.frontmatter.title, language: card.frontmatter.language })],
  });
  return next;
}

/**
 * Merger could not complete (conflict not resolved, tests broken after merge,
 * etc.). Route back to in_progress so a fresh worker can take another swing.
 */
export async function mergerFailed(id: string, reason: string): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "merging");
  ensureCanTransition("merging", "in_progress", "dispatcher");

  const next = bumpUpdated({
    ...card,
    frontmatter: { ...card.frontmatter, status: "in_progress", owner_pid: null },
  });
  const mergerNote: Comment = {
    ts: ISO(),
    author: "system",
    kind: "note",
    body: `[merger] FAILED: ${reason}`,
  };
  const note: HistoryEntry = {
    ts: ISO(),
    author: "system",
    kind: "system_event",
    body: `merger failed: ${reason}`,
  };
  const ev = systemEvent("status: merging → in_progress (merge failed)");
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    comments: [mergerNote],
    history: [note, ev],
    sse: [
      statusEvent(id, "merging", "in_progress"),
      commentEvent(id, mergerNote),
      historyEvent(id, note),
      historyEvent(id, ev),
    ],
  });
  return next;
}

/**
 * Manual override on a stuck card whose code is already in origin/main —
 * the user is declaring the card done anyway. We keep merged_sha so the
 * audit trail still shows what shipped.
 *
 * Guards (also enforced at the route layer):
 *   - status === "stuck"
 *   - merged_sha != null
 */
export async function forceDoneFromStuck(
  id: string,
  reason?: string,
): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "stuck");
  if (card.frontmatter.merged_sha == null) {
    throw new TransitionError(
      "force-done requires merged_sha (worker code must already be on origin/main)",
      "no_merged_sha",
      409,
    );
  }
  ensureCanTransition("stuck", "done", "human");

  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "done",
      owner_pid: null,
      stuck_reason: null,
      stuck_question: null,
      done_at: ISO(),
    },
  });

  const reasonNote = reason && reason.trim() ? reason.trim() : "no reason given";
  const noteComment: Comment = {
    ts: ISO(),
    author: "human",
    kind: "note",
    body: `manual force-done: ${reasonNote}`,
  };
  const ev = systemEvent(
    `status: stuck → done (force, merged_sha=${card.frontmatter.merged_sha.slice(0, 12)} kept)`,
  );
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    comments: [noteComment],
    history: [ev],
    sse: [
      statusEvent(id, "stuck", "done"),
      commentEvent(id, noteComment),
      historyEvent(id, ev),
    ],
    alerts: [
      () =>
        alertCard("done", {
          id,
          title: card.frontmatter.title,
          language: card.frontmatter.language,
        }),
    ],
  });

  // Drop any leftover workers row + best-effort worktree cleanup.
  db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
  const { cleanupWorktree } = await import("./git.js");
  cleanupWorktree(id).catch((err) =>
    logger.warn("cleanup_worktree_failed", {
      id,
      stage: "force_done",
      err: String(err),
    }),
  );
  return next;
}

/**
 * Generic re-queue: pop a card back to `ready` from any of the waiting/active
 * columns (stuck, human_review, ai_review, in_progress, merging). UI binds
 * the "drag back to Ready" gesture to this. Resets runtime fields so the
 * dispatcher can spawn a fresh worker on the next round.
 *
 * For from-states with a possibly-running ephemeral process (in_progress,
 * merging) we ALSO drop the workers row and emit `card_cancel_requested` so
 * the dispatcher SIGTERMs the child. Otherwise the worker would keep
 * running while the card sits in Ready waiting for the next dispatch.
 */
export async function requeueCard(id: string): Promise<Card> {
  const { card } = loadCard(id);
  const from = card.frontmatter.status;
  // Stuck-with-merged_sha guard: the worker's code is already on
  // origin/main; re-queueing would re-spawn a worker on already-merged
  // work → conflict / no-op / lost work. Force the user to accept it as
  // done. STUCK_TRANSITIONS in
  // @questboard/core encodes the canonical policy.
  if (from === "stuck" && card.frontmatter.merged_sha != null) {
    throw new TransitionError(
      "cannot requeue stuck card whose merged_sha is set; use force-done",
      "stuck_already_merged",
      409,
    );
  }
  ensureCanTransition(from, "ready", "human");
  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "ready",
      owner_pid: null,
      worktree: null,
      wip_branch: null,
      stuck_reason: null,
      stuck_question: null,
    },
  });
  const sse: SseEvent[] = [statusEvent(id, from, "ready")];
  // Tell the dispatcher to kill any live worker/merger before the card is
  // re-spawned. The cancel_requested handler is idempotent on the dispatcher
  // side — emitting for ai_review (reviewer running) is also fine.
  if (from === "in_progress" || from === "merging" || from === "ai_review") {
    sse.push({ type: "card_cancel_requested", card_id: id });
  }
  const ev = systemEvent(`status: ${from} → ready (requeue)`);
  sse.push(historyEvent(id, ev));
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse,
  });
  // Drop the live worker row so concurrency cap isn't pinned by a zombie.
  db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
  return next;
}

// (Removed) markFfFailedReturnInProgress — was used by the old direct-merge
// path. The Merger role handles ff-failure routing now (see mergerFailed()).

// ─── T8: human_review → in_progress (reopen) ────────────────────────────────

export async function reopenCard(id: string): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "human_review");
  ensureCanTransition("human_review", "in_progress", "human");

  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "in_progress",
      owner_pid: null,
      attempts: card.frontmatter.attempts, // dispatcher will bump on next claim
    },
  });
  const ev = systemEvent("status: human_review → in_progress (reopen)");
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, "human_review", "in_progress"), historyEvent(id, ev)],
  });
  return next;
}

// ─── T9 / T10: human_review → ai_review ─────────────────────────────────────

export async function transitionToAiReview(id: string, by: "human" | "server"): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "human_review");
  ensureCanTransition("human_review", "ai_review", by);

  const next = bumpUpdated({ ...card, frontmatter: { ...card.frontmatter, status: "ai_review" } });
  const ev = systemEvent(`status: human_review → ai_review (by=${by})`);
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, "human_review", "ai_review"), historyEvent(id, ev)],
  });
  return next;
}

// ─── T12: ai_review → in_progress (reviewer reject) ─────────────────────────

export async function reviewerReject(id: string, body: string): Promise<Card> {
  const { card } = loadCard(id);
  ensureStatus(card, "ai_review");
  ensureCanTransition("ai_review", "in_progress", "reviewer");

  const next = bumpUpdated({
    ...card,
    frontmatter: { ...card.frontmatter, status: "in_progress", owner_pid: null },
  });
  const note: Comment = { ts: ISO(), author: "reviewer", kind: "review_note", body };
  const ev = systemEvent("status: ai_review → in_progress (rejected)");
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    comments: [note],
    history: [ev],
    sse: [statusEvent(id, "ai_review", "in_progress"), commentEvent(id, note), historyEvent(id, ev)],
  });
  return next;
}

// ─── T13: any → cancelled ───────────────────────────────────────────────────

export async function cancelCard(id: string, reason?: string): Promise<Card> {
  const { card } = loadCard(id);
  if (card.frontmatter.status === "cancelled") return card; // idempotent
  ensureCanTransition(card.frontmatter.status, "cancelled", "human");

  const from = card.frontmatter.status;
  // done → cancelled is a limited reopen escape. We KEEP merged_sha and
  // done_at so the audit trail still shows what shipped — "cancelled"
  // here means "stop tracking this card", not "revert the merge". The
  // route layer has already shown a confirm explaining this to the user.
  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "cancelled",
      owner_pid: null,
      stuck_reason: null,
      stuck_question: null,
    },
  });

  const ev = systemEvent(`status: ${from} → cancelled${reason ? ` (${reason})` : ""}`);
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [
      statusEvent(id, from, "cancelled"),
      // Distinct event so the dispatcher can SIGTERM the running worker
      // without having to inspect every status_changed payload.
      { type: "card_cancel_requested", card_id: id },
      historyEvent(id, ev),
    ],
  });

  // Cleanup worktree + branch (best-effort).
  const { cleanupWorktree } = await import("./git.js");
  cleanupWorktree(id).catch((err) => logger.warn("cleanup_worktree_failed", { id, err: String(err) }));

  return next;
}

// ─── Helper-death 3-strikes counter ─────────────────────────────────────────
//
// Called by the dispatcher whenever its StatsReporter notices a helper PID
// is dead AND the dispatcher's own exit handler isn't going to recover it
// (i.e. the helper crashed silently — child.on("exit") never fired). We
// don't immediately mark the card stuck; instead we count consecutive
// deaths AT THE SAME STAGE and:
//   - <3 deaths → drop the workers row and let the dispatcher revive a
//     fresh helper of the same role on its next spawn round (card stays
//     in its current status). System_event in history; no per-revive
//     comment noise.
//   - ≥3 deaths → cancel the card with a regular comment + system_event
//     so the human knows why.
//
// The counter resets on every status transition (see applyAtomic), so a
// card that legitimately moves in_progress → ai_review starts the next
// stage's counter at zero.

export type HelperStage = "worker" | "reviewer" | "merger";

export interface HelperDeathResult {
  action: "noop" | "revive" | "cancelled";
  count: number;
  status: CardStatus;
}

const STAGE_BY_STATUS: Partial<Record<CardStatus, HelperStage>> = {
  in_progress: "worker",
  ai_review: "reviewer",
  merging: "merger",
};

const MAX_CONSECUTIVE_DEATHS = 3;

export async function recordHelperDeath(
  id: string,
  stage: HelperStage,
): Promise<HelperDeathResult> {
  const { card } = loadCard(id);
  const status = card.frontmatter.status;
  const expected = STAGE_BY_STATUS[status];
  if (!expected) {
    // Card already moved on (status transitioned out of an active-helper
    // state). Drop any stale workers row so it doesn't pin the cap, then
    // no-op — the next spawn round, if appropriate, will pick the card up.
    db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
    return { action: "noop", count: 0, status };
  }

  const row = db
    .prepare(
      "SELECT consecutive_deaths AS c, consecutive_deaths_stage AS s FROM cards WHERE id = ?",
    )
    .get(id) as { c: number; s: string | null } | undefined;
  const sameStage = row?.s === stage;
  const next = sameStage ? (row?.c ?? 0) + 1 : 1;

  if (next >= MAX_CONSECUTIVE_DEATHS) {
    // 3-strikes-out: cancel with both a regular note (visible in the
    // conversation) and a system_event (audit trail).
    const reason = `Helper died ${next} times in a row at stage ${stage}.`;
    const noteComment: Comment = {
      ts: ISO(),
      author: "system",
      kind: "note",
      body: `${reason} Moving to cancelled — a human can investigate the transcripts and restart the card if needed.`,
    };
    const ev = systemEvent(
      `helper_died_${next}x stage=${stage} → cancelled (3-strikes)`,
    );
    const next_card = bumpUpdated({
      ...card,
      frontmatter: {
        ...card.frontmatter,
        status: "cancelled",
        owner_pid: null,
        stuck_reason: null,
        stuck_question: null,
      },
    });
    ensureCanTransition(status, "cancelled", "human");
    await applyAtomic({
      cardId: id,
      before: card,
      after: next_card,
      comments: [noteComment],
      history: [ev],
      sse: [
        statusEvent(id, status, "cancelled"),
        // Also emit a cancel_requested so any (somehow alive) helper child
        // gets SIGTERM on the dispatcher side.
        { type: "card_cancel_requested", card_id: id },
        commentEvent(id, noteComment),
        historyEvent(id, ev),
      ],
      sqlSideEffects: () => {
        db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
      },
    });
    // Best-effort worktree cleanup, same as cancelCard.
    const { cleanupWorktree } = await import("./git.js");
    cleanupWorktree(id).catch((err) =>
      logger.warn("cleanup_worktree_failed", { id, stage: "helper_3x", err: String(err) }),
    );
    return { action: "cancelled", count: next, status: "cancelled" };
  }

  // Revive path. Status is unchanged; bump the counter, drop the workers
  // row, and append a system_event so the audit log shows what happened.
  // No conversation-channel comment — these would otherwise spam.
  const ev: HistoryEntry = {
    ts: ISO(),
    author: "system",
    kind: "system_event",
    body: `helper_revived stage=${stage} attempt=${next}/${MAX_CONSECUTIVE_DEATHS} (previous helper PID died unexpectedly)`,
  };
  const now = ISO();
  const historyFile = historyPath(id, false);
  const historySizeBefore = existsSync(historyFile) ? readFileSync(historyFile).length : 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      "UPDATE cards SET consecutive_deaths = ?, consecutive_deaths_stage = ?, owner_pid = NULL, updated_at = ? WHERE id = ?",
    ).run(next, stage, now, id);
    db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
    appendHistoryToFile(id, ev, false);
    appendHistoryRow(id, ev);
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    truncateJsonl(historyFile, historySizeBefore);
    throw err;
  }
  broadcast(historyEvent(id, ev));
  broadcast({ type: "card_updated", card_id: id });
  return { action: "revive", count: next, status };
}

// ─── T14: cancelled → backlog (restore) ─────────────────────────────────────

export async function restoreCard(id: string): Promise<Card> {
  const { card, archived } = loadCard(id);

  if (archived) {
    // Move back from archive/ to cards/ first. archive → backlog is an explicit
    // restore path supported by /api/cards/:id/restore per server-api.md.
    const src = join(env.ARCHIVE_DIR, id);
    const dst = join(env.CARDS_DIR, id);
    mkdirSync(dirname(dst), { recursive: true });
    renameSync(src, dst);
  }

  if (card.frontmatter.status !== "cancelled" && !archived) {
    throw new TransitionError(`cannot restore from ${card.frontmatter.status}`, "bad_status", 409);
  }
  const from = card.frontmatter.status;

  const next = bumpUpdated({
    ...card,
    frontmatter: {
      ...card.frontmatter,
      status: "backlog",
      owner_pid: null,
      worktree: null,
      wip_branch: null,
      stuck_reason: null,
      stuck_question: null,
      archived_at: null,
    },
  });

  const ev = systemEvent(`status: ${from} → backlog (restored)`);
  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history: [ev],
    sse: [statusEvent(id, from, "backlog"), historyEvent(id, ev)],
  });
  return next;
}

// ─── T15: archive (done → archived) ─────────────────────────────────────────

export async function archiveCards(ids: string[]): Promise<{ archived: string[]; skipped: string[] }> {
  const archived: string[] = [];
  const skipped: string[] = [];

  for (const id of ids) {
    try {
      const { card } = loadCard(id);
      if (card.frontmatter.status !== "done") {
        skipped.push(id);
        continue;
      }

      const next = bumpUpdated({
        ...card,
        frontmatter: { ...card.frontmatter, archived_at: ISO() },
      });

      // 1) Update card.md (still in cards/)
      // 2) Move folder to archive/
      // 3) Update sqlite mirror
      // 4) Broadcast
      // We do file ops + sql in a single tx.
      db.exec("BEGIN IMMEDIATE");
      try {
        // Rewrite card.md in active folder, then move.
        await writeCardAtomic(id, next, false);
        moveCardToArchive(id);
        upsertCardRow(next.frontmatter, next.frontmatter.deps);
        db.exec("COMMIT");
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        logger.error("archive_failed", { id, err: String(err) });
        skipped.push(id);
        continue;
      }

      broadcast({ type: "card_archived", card_id: id });
      archived.push(id);

      // Safety net: in normal flow mergerComplete already cleaned the
      // worktree at done-time, so this is a no-op for fresh cards. But
      // older cards completed before the cleanup-at-done code shipped,
      // and any future `done` path that bypasses mergerComplete (manual
      // status edits, restore-then-archive, etc.) would still leave a
      // stale worktree behind. Re-running cleanup here is idempotent.
      const { cleanupWorktree } = await import("./git.js");
      cleanupWorktree(id).catch((err) =>
        logger.warn("cleanup_worktree_failed", { id, stage: "archive", err: String(err) }),
      );
    } catch (err) {
      logger.error("archive_card_error", { id, err: String(err) });
      skipped.push(id);
    }
  }

  return { archived, skipped };
}

// ─── PATCH /api/cards/:id (description / metadata edit) ─────────────────────

export interface CardPatch {
  title?: string;
  description?: string;
  priority?: 1 | 2 | 3;
  language?: string;
  flavor?: "feature" | "bug" | "refactor" | "chore" | "docs";
  scope?: string | null;
  deps?: string[];
}

export async function patchCard(id: string, patch: CardPatch): Promise<Card> {
  const { card } = loadCard(id);
  if (card.frontmatter.archived_at) {
    throw new TransitionError("cannot patch archived card", "archived", 409);
  }

  // Cycle check on deps update.
  if (patch.deps != null) {
    // Reject self-dep up front with a clear error. `detectCycle` would
    // also catch it (newDeps contains cardId → first iteration throws)
    // but the resulting "dep cycle via NNNN" message is misleading for
    // what is really just an obvious user mistake.
    if (patch.deps.includes(id)) {
      throw new TransitionError(`card cannot depend on itself: ${id}`, "self_dep", 400);
    }
    for (const d of patch.deps) {
      if (!getCardRow(d)) throw new TransitionError(`unknown dep: ${d}`, "bad_dep", 400);
    }
    detectCycle(id, patch.deps);
  }

  const fm = card.frontmatter;
  const next: Card = {
    frontmatter: {
      ...fm,
      title: patch.title ?? fm.title,
      priority: patch.priority ?? fm.priority,
      language: patch.language ?? fm.language,
      flavor: patch.flavor ?? fm.flavor,
      scope: patch.scope !== undefined ? patch.scope : fm.scope,
      deps: patch.deps ?? fm.deps,
      updated_at: ISO(),
    },
    description: patch.description ?? card.description,
  };

  const history: HistoryEntry[] = [];
  if (patch.description != null && patch.description !== card.description) {
    history.push({
      ts: ISO(),
      author: "human",
      kind: "description_updated",
      body: `description updated (${card.description.length}→${patch.description.length} chars)`,
    });
  }

  await applyAtomic({
    cardId: id,
    before: card,
    after: next,
    history,
    sse: [
      { type: "card_updated", card_id: id },
      ...(history[0] ? [historyEvent(id, history[0])] : []),
    ],
  });
  return next;
}

// ─── Comments append (general path) ────────────────────────────────────────

export async function appendComment(
  cardId: string,
  input: Pick<Comment, "author" | "kind" | "body">,
): Promise<{ comment: Comment; resumed: boolean }> {
  const { card, archived } = loadCard(cardId);
  if (archived) throw new TransitionError("cannot comment on archived card", "archived", 409);

  const isHistory = input.kind === "system_event" || input.kind === "description_updated";

  const entry: Comment = { ts: ISO(), ...input };

  // Dedup: if last row in the appropriate channel is identical, return it.
  const dedupTable = isHistory ? "history" : "comments";
  const lastRow = db
    .prepare(`SELECT ts, author, kind, body FROM ${dedupTable} WHERE card_id = ? ORDER BY id DESC LIMIT 1`)
    .get(cardId) as Comment | undefined;
  if (lastRow && lastRow.author === entry.author && lastRow.kind === entry.kind && lastRow.body === entry.body) {
    return { comment: lastRow, resumed: false };
  }

  // Append in a small atomic operation: write jsonl line, mirror to SQLite.
  const jsonlFile = isHistory ? historyPath(cardId, false) : commentsPath(cardId, false);
  const sizeBefore = existsSync(jsonlFile) ? readFileSync(jsonlFile).length : 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (isHistory) {
      appendHistoryToFile(cardId, entry as HistoryEntry, false);
      appendHistoryRow(cardId, entry as HistoryEntry);
    } else {
      appendCommentToFile(cardId, entry, false);
      appendCommentRow(cardId, entry);
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    if (existsSync(jsonlFile)) {
      try {
        const fd = openSync(jsonlFile, "r+");
        try { ftruncateSync(fd, sizeBefore); } finally { closeSync(fd); }
      } catch { /* ignore */ }
    }
    throw err;
  }
  if (isHistory) {
    broadcast(historyEvent(cardId, entry as HistoryEntry));
  } else {
    broadcast(commentEvent(cardId, entry));
  }

  // Auto-resume: if this is a human answer on a stuck card, transition.
  let resumed = false;
  if (entry.author === "human" && entry.kind === "answer" && card.frontmatter.status === "stuck") {
    await autoResumeFromStuck(cardId);
    resumed = true;
  }
  return { comment: entry, resumed };
}

// ─── auto_review toggle ON: sweep human_review → ai_review ──────────────────

export async function sweepHumanReviewToAi(): Promise<string[]> {
  const rows = db.prepare("SELECT id FROM cards WHERE status = 'human_review'").all() as { id: string }[];
  const swept: string[] = [];
  for (const { id } of rows) {
    try {
      await transitionToAiReview(id, "server");
      swept.push(id);
    } catch (err) {
      logger.warn("sweep_to_ai_failed", { id, err: String(err) });
    }
  }
  return swept;
}

// ─── small helpers ──────────────────────────────────────────────────────────

function setStatus(card: Card, status: CardStatus): Card {
  return { ...card, frontmatter: { ...card.frontmatter, status } };
}

function bumpUpdated(card: Card): Card {
  return { ...card, frontmatter: { ...card.frontmatter, updated_at: ISO() } };
}

function detectCycle(cardId: string, newDeps: string[]): void {
  // Simple DFS: from each new dep, can we reach cardId?
  const adj = (id: string): string[] => listDeps(id);
  const seen = new Set<string>();
  const stack = [...newDeps];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === cardId) {
      throw new TransitionError(`dep cycle via ${cur}`, "dep_cycle", 400);
    }
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...adj(cur));
  }
}
