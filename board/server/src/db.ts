/**
 * SQLite wrapper. Server is the sole writer. Schema comes from
 * @questboard/core/schema.sql.
 */
import Database, { type Database as DatabaseT } from "better-sqlite3";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";
import type { Card, CardFrontmatter, CardStatus, Comment, HistoryEntry } from "@questboard/core";
import { padCardId, isConversationKind } from "@questboard/core";
import { logger } from "./logger.js";

mkdirSync(dirname(env.DB_PATH), { recursive: true });

export const db: DatabaseT = new Database(env.DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

/**
 * Resolve schema.sql across three layouts:
 *   - bundled prod (esbuild): main.js sits in dist/, schema sibling
 *     is dist/schema.sql (copied by build.mjs).
 *   - tsc-only prod (legacy): @questboard/core publishes the file
 *     via its `exports` map, resolvable through import.meta.resolve.
 *   - workspace dev: walk up to ../../core/src/schema.sql.
 */
function loadSchemaSql(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // 1. Bundled sibling.
  const sibling = resolve(here, "schema.sql");
  try {
    return readFileSync(sibling, "utf8");
  } catch {
    /* try next */
  }
  // 2. Published exports path (core has its dist + exports map).
  try {
    // @ts-ignore — import.meta.resolve is Node 20+
    const url = import.meta.resolve?.("@questboard/core/schema.sql");
    if (url) return readFileSync(fileURLToPath(url as unknown as string), "utf8");
  } catch {
    /* try next */
  }
  // 3. Workspace-relative fallback (dev / tsc dist).
  const candidate = resolve(here, "../../core/src/schema.sql");
  return readFileSync(candidate, "utf8");
}

db.exec(loadSchemaSql());

// ─── Lightweight migrations ──────────────────────────────────────────────────
// CREATE TABLE IF NOT EXISTS doesn't add columns to an existing table, so any
// columns introduced after the initial release need an explicit ALTER. SQLite
// has no ADD COLUMN IF NOT EXISTS, so we probe pragma_table_info first.
function columnExists(table: string, column: string): boolean {
  const rows = db
    .prepare(`PRAGMA table_info(${table})`)
    .all() as { name: string }[];
  return rows.some((r) => r.name === column);
}

function addColumnIfMissing(
  table: string,
  column: string,
  ddl: string,
): void {
  if (columnExists(table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  logger.info("schema_migration", { added: `${table}.${column}` });
}

// 3-strikes helper-death counter (added after initial release).
addColumnIfMissing("cards", "consecutive_deaths", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("cards", "consecutive_deaths_stage", "TEXT");
// Card scope tag (added after initial release; mirrors fm.scope so the list
// endpoint can return it without parsing card.md per row).
addColumnIfMissing("cards", "scope", "TEXT");
// Cached count of conversation comments. List endpoint reads this so the
// badge is accurate on initial fetch (was previously stuck at 0).
addColumnIfMissing("cards", "comment_count", "INTEGER NOT NULL DEFAULT 0");
// Per-role lifetime output token totals (added after initial release).
// Summed across every transcript file under cards/<id>/transcripts/ —
// "output_tokens" per assistant turn, accumulated across all runs of the
// same role. Updated on every /heartbeat by recomputing from transcripts;
// recomputed at bootstrap so existing cards get backfilled. The list
// endpoint surfaces these so the tile can show a per-role breakdown
// without hitting transcripts on every render.
addColumnIfMissing("cards", "worker_output_tokens", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("cards", "reviewer_output_tokens", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("cards", "merger_output_tokens", "INTEGER NOT NULL DEFAULT 0");
// Per-role lifetime INPUT tokens (input + cache_creation + cache_read per
// turn, summed across runs). Without these we showed only output, which
// drastically undercounts actual usage (cache reads alone often > 100x
// output).
addColumnIfMissing("cards", "worker_input_tokens", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("cards", "reviewer_input_tokens", "INTEGER NOT NULL DEFAULT 0");
addColumnIfMissing("cards", "merger_input_tokens", "INTEGER NOT NULL DEFAULT 0");

// ─── Prepared statements ─────────────────────────────────────────────────────

const stmts = {
  getMeta: db.prepare<[string], { value: string }>("SELECT value FROM meta WHERE key = ?"),
  setMeta: db.prepare<[string, string]>(
    "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ),

  insertCard: db.prepare(`
    INSERT INTO cards (
      id, title, status, flavor, priority, language, scope, estimated_loc, budget_minutes,
      created_by, created_at, updated_at, owner_pid, worktree, wip_branch,
      attempts, stuck_reason, stuck_question, tokens_used, elapsed_seconds,
      merged_sha, done_at, archived_at
    ) VALUES (
      @id, @title, @status, @flavor, @priority, @language, @scope, @estimated_loc, @budget_minutes,
      @created_by, @created_at, @updated_at, @owner_pid, @worktree, @wip_branch,
      @attempts, @stuck_reason, @stuck_question, @tokens_used, @elapsed_seconds,
      @merged_sha, @done_at, @archived_at
    )
  `),

  upsertCard: db.prepare(`
    INSERT INTO cards (
      id, title, status, flavor, priority, language, scope, estimated_loc, budget_minutes,
      created_by, created_at, updated_at, owner_pid, worktree, wip_branch,
      attempts, stuck_reason, stuck_question, tokens_used, elapsed_seconds,
      merged_sha, done_at, archived_at
    ) VALUES (
      @id, @title, @status, @flavor, @priority, @language, @scope, @estimated_loc, @budget_minutes,
      @created_by, @created_at, @updated_at, @owner_pid, @worktree, @wip_branch,
      @attempts, @stuck_reason, @stuck_question, @tokens_used, @elapsed_seconds,
      @merged_sha, @done_at, @archived_at
    )
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      status=excluded.status,
      flavor=excluded.flavor,
      priority=excluded.priority,
      language=excluded.language,
      scope=excluded.scope,
      estimated_loc=excluded.estimated_loc,
      budget_minutes=excluded.budget_minutes,
      created_by=excluded.created_by,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at,
      owner_pid=excluded.owner_pid,
      worktree=excluded.worktree,
      wip_branch=excluded.wip_branch,
      attempts=excluded.attempts,
      stuck_reason=excluded.stuck_reason,
      stuck_question=excluded.stuck_question,
      tokens_used=excluded.tokens_used,
      elapsed_seconds=excluded.elapsed_seconds,
      merged_sha=excluded.merged_sha,
      done_at=excluded.done_at,
      archived_at=excluded.archived_at
      -- comment_count intentionally NOT touched: it's maintained by
      -- appendCommentRow / recomputeCommentCounts, not via card.md.
  `),

  getCardById: db.prepare("SELECT * FROM cards WHERE id = ?"),
  // Archived cards are kept in the SQLite mirror (so we can show them in
   // history / drilldown), but they MUST be excluded from the board list —
   // otherwise an archive immediately bounces back into Done after the
   // refetch fires from the `card_archived` SSE handler.
  listAll: db.prepare(
    "SELECT * FROM cards WHERE archived_at IS NULL ORDER BY priority ASC, created_at ASC",
  ),

  insertComment: db.prepare(
    "INSERT INTO comments(card_id, ts, author, kind, body) VALUES (?, ?, ?, ?, ?)",
  ),
  listComments: db.prepare(
    "SELECT ts, author, kind, body FROM comments WHERE card_id = ? ORDER BY id ASC",
  ),

  insertHistory: db.prepare(
    "INSERT INTO history(card_id, ts, author, kind, body) VALUES (?, ?, ?, ?, ?)",
  ),
  listHistory: db.prepare(
    "SELECT ts, author, kind, body FROM history WHERE card_id = ? ORDER BY ts ASC, id ASC",
  ),

  insertDep: db.prepare("INSERT OR IGNORE INTO card_deps(card_id, depends_on_id) VALUES (?, ?)"),
  listDeps: db.prepare("SELECT depends_on_id FROM card_deps WHERE card_id = ?"),
  clearDeps: db.prepare("DELETE FROM card_deps WHERE card_id = ?"),

  truncateCards: db.prepare("DELETE FROM cards"),
  truncateComments: db.prepare("DELETE FROM comments"),
  truncateHistory: db.prepare("DELETE FROM history"),
  truncateDeps: db.prepare("DELETE FROM card_deps"),

  /**
   * Bootstrap-only upsert. Same as `upsertCard` but PRESERVES runtime
   * columns that live only in SQLite (never written back to card.md):
   *   - tokens_used, elapsed_seconds (continuously updated by heartbeat)
   *   - owner_pid, worktree, wip_branch (managed by dispatcher)
   * Without this, every server restart resets these to whatever the
   * frontmatter defaults are (usually 0/null), wiping live progress.
   */
  bootstrapUpsertCard: db.prepare(`
    INSERT INTO cards (
      id, title, status, flavor, priority, language, scope, estimated_loc, budget_minutes,
      created_by, created_at, updated_at, owner_pid, worktree, wip_branch,
      attempts, stuck_reason, stuck_question, tokens_used, elapsed_seconds,
      merged_sha, done_at, archived_at
    ) VALUES (
      @id, @title, @status, @flavor, @priority, @language, @scope, @estimated_loc, @budget_minutes,
      @created_by, @created_at, @updated_at, @owner_pid, @worktree, @wip_branch,
      @attempts, @stuck_reason, @stuck_question, @tokens_used, @elapsed_seconds,
      @merged_sha, @done_at, @archived_at
    )
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title,
      status=excluded.status,
      flavor=excluded.flavor,
      priority=excluded.priority,
      language=excluded.language,
      scope=excluded.scope,
      estimated_loc=excluded.estimated_loc,
      budget_minutes=excluded.budget_minutes,
      created_by=excluded.created_by,
      created_at=excluded.created_at,
      updated_at=excluded.updated_at,
      attempts=excluded.attempts,
      stuck_reason=excluded.stuck_reason,
      stuck_question=excluded.stuck_question,
      merged_sha=excluded.merged_sha,
      done_at=excluded.done_at,
      archived_at=excluded.archived_at
      -- runtime cols (owner_pid, worktree, wip_branch, tokens_used,
      --              elapsed_seconds) and comment_count are intentionally
      -- NOT touched.
  `),

  // Maintenance helpers for comment_count.
  bumpCommentCount: db.prepare(
    "UPDATE cards SET comment_count = comment_count + 1 WHERE id = ?",
  ),
  updateTokenTotals: db.prepare(`
    UPDATE cards
       SET worker_input_tokens    = ?,
           worker_output_tokens   = ?,
           reviewer_input_tokens  = ?,
           reviewer_output_tokens = ?,
           merger_input_tokens    = ?,
           merger_output_tokens   = ?
     WHERE id = ?
  `),
  sumTokensTotal: db.prepare(`
    SELECT
      COALESCE(SUM(worker_input_tokens
                 + reviewer_input_tokens
                 + merger_input_tokens), 0) AS input_total,
      COALESCE(SUM(worker_output_tokens
                 + reviewer_output_tokens
                 + merger_output_tokens), 0) AS output_total
    FROM cards
  `),
  recomputeCommentCount: db.prepare(`
    UPDATE cards SET comment_count = (
      SELECT COUNT(*) FROM comments
      WHERE comments.card_id = cards.id
        AND comments.kind IN ('stuck','answer','resumed','review_note','note')
    )
  `),
};

// ─── Public API ──────────────────────────────────────────────────────────────

export function frontmatterToRow(fm: CardFrontmatter): Record<string, unknown> {
  return {
    id: fm.id,
    title: fm.title,
    status: fm.status,
    flavor: fm.flavor,
    priority: fm.priority,
    language: fm.language,
    scope: fm.scope ?? null,
    estimated_loc: fm.estimated_loc ?? null,
    budget_minutes: fm.budget_minutes ?? null,
    created_by: fm.created_by,
    created_at: fm.created_at,
    updated_at: fm.updated_at,
    owner_pid: fm.owner_pid ?? null,
    worktree: fm.worktree ?? null,
    wip_branch: fm.wip_branch ?? null,
    attempts: fm.attempts,
    stuck_reason: fm.stuck_reason ?? null,
    stuck_question: fm.stuck_question ?? null,
    tokens_used: fm.tokens_used,
    elapsed_seconds: fm.elapsed_seconds,
    merged_sha: fm.merged_sha ?? null,
    done_at: fm.done_at ?? null,
    archived_at: fm.archived_at ?? null,
  };
}

export function upsertCardRow(fm: CardFrontmatter, deps: string[]): void {
  stmts.upsertCard.run(frontmatterToRow(fm));
  stmts.clearDeps.run(fm.id);
  for (const dep of deps) stmts.insertDep.run(fm.id, dep);
}

/** Bootstrap variant: preserves runtime stats (tokens/elapsed/owner/worktree). */
export function bootstrapUpsertCardRow(fm: CardFrontmatter, deps: string[]): void {
  stmts.bootstrapUpsertCard.run(frontmatterToRow(fm));
  stmts.clearDeps.run(fm.id);
  for (const dep of deps) stmts.insertDep.run(fm.id, dep);
}

export function getCardRow(id: string): CardRow | null {
  return (stmts.getCardById.get(id) as CardRow | undefined) ?? null;
}

export function listAllCards(): CardRow[] {
  return stmts.listAll.all() as CardRow[];
}

export function listDeps(id: string): string[] {
  return (stmts.listDeps.all(id) as { depends_on_id: string }[]).map((r) => r.depends_on_id);
}

/**
 * One-shot fetch of every (card_id → deps[]) and (card_id → blocked_by[])
 * mapping in the system. Used by GET /api/cards to enrich every list row
 * without an N+1 of `listDeps` calls.
 *
 * `blocked_by` = subset of deps whose parent card is NOT yet `done`. A
 * dangling dep (parent row missing) is treated as blocking — safer than
 * silently unblocking a card whose upstream was deleted out from under it.
 */
export function listAllDepsAndBlocked(): {
  deps: Map<string, string[]>;
  blockedBy: Map<string, string[]>;
} {
  const rows = db
    .prepare(
      // LEFT JOIN so dangling deps (no matching parent row) still surface;
      // status will be NULL in that case → counted as blocking below.
      `SELECT d.card_id, d.depends_on_id, p.status AS parent_status
         FROM card_deps d
         LEFT JOIN cards p ON p.id = d.depends_on_id`,
    )
    .all() as { card_id: string; depends_on_id: string; parent_status: string | null }[];
  const deps = new Map<string, string[]>();
  const blockedBy = new Map<string, string[]>();
  for (const r of rows) {
    if (!deps.has(r.card_id)) deps.set(r.card_id, []);
    deps.get(r.card_id)!.push(r.depends_on_id);
    if (r.parent_status !== "done") {
      if (!blockedBy.has(r.card_id)) blockedBy.set(r.card_id, []);
      blockedBy.get(r.card_id)!.push(r.depends_on_id);
    }
  }
  return { deps, blockedBy };
}

export function appendCommentRow(cardId: string, c: Comment): void {
  stmts.insertComment.run(cardId, c.ts, c.author, c.kind, c.body);
  // Cached count is for the human-visible conversation channel only —
  // history kinds (system_event / description_updated) shouldn't bump
  // the badge even if a legacy caller writes them through here.
  if (isConversationKind(c.kind)) {
    stmts.bumpCommentCount.run(cardId);
  }
}

/**
 * Recompute `cards.comment_count` for every card from the comments table.
 * Called at bootstrap (after re-ingesting jsonl) so the cached counts on
 * existing rows match disk after a server restart / migration.
 */
export function recomputeCommentCounts(): void {
  stmts.recomputeCommentCount.run();
}

export function listCommentRows(cardId: string): Comment[] {
  return stmts.listComments.all(cardId) as Comment[];
}

export function appendHistoryRow(cardId: string, e: HistoryEntry): void {
  stmts.insertHistory.run(cardId, e.ts, e.author, e.kind, e.body);
}

export function listHistoryRows(cardId: string): HistoryEntry[] {
  return stmts.listHistory.all(cardId) as HistoryEntry[];
}

/**
 * Allocate the next card id atomically. Caller MUST already hold an open
 * transaction (so the allocation + INSERT cards row commit together).
 */
export function allocateCardId(): string {
  const row = stmts.getMeta.get("next_card_id") as { value: string } | undefined;
  const cur = row ? Number(row.value) : 1;
  if (cur > 9999) throw new Error("card id space exhausted (>9999)");
  stmts.setMeta.run("next_card_id", String(cur + 1));
  return padCardId(cur);
}

/** Bootstrap rebuild — clears comments/deps and any cards that no longer
 *  exist on disk, but PRESERVES the cards table itself + the workers table
 *  so runtime stats and live worker tracking survive server restarts.
 *  Stale cards (deleted from filesystem) are pruned by the caller after
 *  re-ingesting from disk. */
export function truncateAll(): void {
  // workers / cards intentionally NOT touched here.
  stmts.truncateComments.run();
  stmts.truncateHistory.run();
  stmts.truncateDeps.run();
}

/** Remove cards rows that no longer have a card.md on disk. */
export function pruneCardsNotIn(ids: ReadonlySet<string>): number {
  const all = (db.prepare("SELECT id FROM cards").all() as { id: string }[]).map((r) => r.id);
  let removed = 0;
  for (const id of all) {
    if (!ids.has(id)) {
      db.prepare("DELETE FROM cards WHERE id = ?").run(id);
      removed++;
    }
  }
  return removed;
}

export type CardRow = {
  id: string;
  title: string;
  status: CardStatus;
  flavor: string;
  priority: number;
  language: string;
  scope: string | null;
  estimated_loc: number | null;
  budget_minutes: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  owner_pid: number | null;
  worktree: string | null;
  wip_branch: string | null;
  attempts: number;
  stuck_reason: string | null;
  stuck_question: string | null;
  tokens_used: number;
  elapsed_seconds: number;
  merged_sha: string | null;
  done_at: string | null;
  archived_at: string | null;
  comment_count: number;
  worker_input_tokens: number;
  worker_output_tokens: number;
  reviewer_input_tokens: number;
  reviewer_output_tokens: number;
  merger_input_tokens: number;
  merger_output_tokens: number;
};

export interface CardTokenTotals {
  worker_input_tokens: number;
  worker_output_tokens: number;
  reviewer_input_tokens: number;
  reviewer_output_tokens: number;
  merger_input_tokens: number;
  merger_output_tokens: number;
}

/** Update the cached per-role input + output token totals for a card. */
export function updateCardTokenTotals(
  cardId: string,
  totals: CardTokenTotals,
): void {
  stmts.updateTokenTotals.run(
    totals.worker_input_tokens,
    totals.worker_output_tokens,
    totals.reviewer_input_tokens,
    totals.reviewer_output_tokens,
    totals.merger_input_tokens,
    totals.merger_output_tokens,
    cardId,
  );
}

/** Sum of input + output token totals across every card (incl. archived). */
export function sumTokensTotal(): { input_total: number; output_total: number } {
  const row = stmts.sumTokensTotal.get() as
    | { input_total: number; output_total: number }
    | undefined;
  return {
    input_total: row?.input_total ?? 0,
    output_total: row?.output_total ?? 0,
  };
}

/** Run a function in a write transaction (BEGIN IMMEDIATE). */
export function runWriteTx<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch (rerr) {
      logger.error("rollback_failed", { err: String(rerr) });
    }
    throw err;
  }
}

/** Read counts by status for stats. */
export function countByStatus(): Record<string, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS n FROM cards GROUP BY status").all() as {
    status: string;
    n: number;
  }[];
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** Helper: card row exists (either active or archived). */
export function cardExists(id: string): boolean {
  return getCardRow(id) != null;
}

/** Card row → minimal type for serializing card.md back. */
export type { Card };
