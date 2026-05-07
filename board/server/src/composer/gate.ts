/**
 * Permission gate for `make_card` / `save_plan`.
 *
 * Each pending tool_use parks here on a Deferred<DecisionOutcome>. The
 * MCP handler awaits the deferred. The HTTP route (POST
 * /tool-decisions) resolves it after the user clicks Approve / Reject in
 * the UI. Approve runs the actual side-effect (createCard or
 * write+commit plan) and then reports the result back to claude through
 * the awaiting MCP handler.
 *
 * Server-restart resilience: pending records are journaled via threads.ts
 * (recordPending / clearPending). If the server dies while a tool is
 * pending, on boot the UI re-fetches and the preview gate reappears.
 * The MCP handler that was awaiting is gone, of course — claude exited
 * with the server. On the next user message claude re-spawns; we feed
 * a synthesized system note explaining what was approved/rejected
 * while it was offline (handled in spawn.ts by inspecting the resolved
 * markers in pending.jsonl).
 */
import { MakeCardInput, SavePlanInput, type ComposerPendingToolUse } from "@questboard/core";
import { createCard } from "../transitions.js";
import { gitMain } from "../git.js";
import { logger } from "../logger.js";
import { env } from "../env.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { bumpOutcome, clearPending, getThread, patchThread } from "./threads.js";

// ─── Decision queue ──────────────────────────────────────────────────────────

export interface ToolDecision {
  decision: "approve" | "reject";
  edited_input?: unknown;
  reason?: string;
}

/** Internal Deferred wrapper. */
interface Deferred {
  resolve: (v: DecisionOutcome) => void;
  reject: (e: unknown) => void;
  pending: ComposerPendingToolUse;
}

export type DecisionOutcome =
  | { ok: true; result: unknown; result_ref?: string }
  | { ok: false; reason: string };

const waiters = new Map<string, Deferred>();

/**
 * Block until the user resolves this pending tool_use. Called from the
 * MCP handler (mcp.ts), which feeds the returned DecisionOutcome back to
 * claude as the tool_result content.
 */
export function awaitDecision(pending: ComposerPendingToolUse): Promise<DecisionOutcome> {
  return new Promise<DecisionOutcome>((resolve, reject) => {
    waiters.set(pending.id, { resolve, reject, pending });
  });
}

/**
 * Called by the HTTP route (POST /tool-decisions). Validates input,
 * runs the side-effect on approve, and unblocks the MCP handler. The
 * route handler also broadcasts `composer_tool_resolved` after we
 * return — we don't broadcast here because the route owns the SSE event
 * (so the UI clears the gate at the same time the server replies).
 */
export async function resolveDecision(
  threadId: string,
  toolUseId: string,
  decision: ToolDecision,
): Promise<{ ok: true; result_ref?: string } | { ok: false; reason: string }> {
  const w = waiters.get(toolUseId);
  if (!w) {
    // Two ways to land here:
    //   1. Server restarted while pending — claude is gone. We still want
    //      to commit the side-effect (the user wants the card created!),
    //      then mark the pending resolved on disk so the gate clears.
    //   2. Race between two decision posts — first one already won.
    return resolveOrphaned(threadId, toolUseId, decision);
  }
  const { pending } = w;

  if (decision.decision === "reject") {
    const reason = (decision.reason ?? "rejected by user").trim() || "rejected by user";
    waiters.delete(toolUseId);
    clearPending(threadId, toolUseId);
    // Tell claude: tool_error with structured rejection payload so the
    // model can revise the proposal using the rejection reason.
    w.resolve({ ok: false, reason });
    return { ok: true };
  }

  // Approve path. Use edited_input if the user tweaked the proposal.
  const rawInput = decision.edited_input ?? pending.input;
  try {
    let result_ref: string | undefined;
    let result: unknown;
    if (pending.name === "make_card") {
      const parsed = MakeCardInput.parse(rawInput);
      const { card_id } = await commitMakeCard(threadId, parsed);
      result_ref = card_id;
      result = { ok: true, card_id };
      bumpOutcome(threadId, { card_ids: [card_id] });
    } else if (pending.name === "save_plan") {
      const parsed = SavePlanInput.parse(rawInput);
      const { path } = await commitSavePlan(threadId, parsed);
      result_ref = path;
      result = { ok: true, path };
      bumpOutcome(threadId, { plan_paths: [path] });
    } else {
      throw new Error(`unknown composer tool: ${pending.name}`);
    }
    waiters.delete(toolUseId);
    clearPending(threadId, toolUseId);
    w.resolve({ ok: true, result, result_ref });
    return { ok: true, result_ref };
  } catch (err) {
    // Side-effect blew up. Don't kill the gate — surface as a tool_error
    // so claude can retry / pivot. Leave the pending record in place so
    // the UI can re-approve after fixing the underlying issue.
    const reason = (err as Error).message ?? "side-effect failed";
    logger.error("composer_decision_commit_failed", {
      threadId,
      toolUseId,
      tool: pending.name,
      err: reason,
    });
    return { ok: false, reason };
  }
}

/**
 * Handle a decision that arrived AFTER the awaiting MCP handler died
 * (server restart). Run the side-effect anyway and clear the pending
 * marker so the UI moves on.
 */
async function resolveOrphaned(
  threadId: string,
  toolUseId: string,
  decision: ToolDecision,
): Promise<{ ok: true; result_ref?: string } | { ok: false; reason: string }> {
  const thread = getThread(threadId);
  const pending = thread.pending.find((p) => p.id === toolUseId);
  if (!pending) {
    return { ok: false, reason: "no pending tool with that id" };
  }
  if (decision.decision === "reject") {
    clearPending(threadId, toolUseId);
    return { ok: true };
  }
  const rawInput = decision.edited_input ?? pending.input;
  try {
    if (pending.name === "make_card") {
      const parsed = MakeCardInput.parse(rawInput);
      const { card_id } = await commitMakeCard(threadId, parsed);
      bumpOutcome(threadId, { card_ids: [card_id] });
      clearPending(threadId, toolUseId);
      return { ok: true, result_ref: card_id };
    }
    const parsed = SavePlanInput.parse(rawInput);
    const { path } = await commitSavePlan(threadId, parsed);
    bumpOutcome(threadId, { plan_paths: [path] });
    clearPending(threadId, toolUseId);
    return { ok: true, result_ref: path };
  } catch (err) {
    return { ok: false, reason: (err as Error).message ?? "side-effect failed" };
  }
}

// ─── Side-effects ────────────────────────────────────────────────────────────

/**
 * Run make_card → createCard pipeline. Resolves `#N` deps against the
 * thread's outcome.card_ids in commit order so multi-card batches can
 * chain dependencies without the AI knowing the assigned ids upfront.
 */
export async function commitMakeCard(
  threadId: string,
  input: import("@questboard/core").MakeCardInput,
): Promise<{ card_id: string }> {
  const thread = getThread(threadId);
  const priorIds = thread.outcome.card_ids;
  const resolvedDeps: string[] = [];
  for (const d of input.deps ?? []) {
    if (d.startsWith("#")) {
      const idx = Number(d.slice(1));
      const ref = priorIds[idx];
      if (!Number.isInteger(idx) || idx < 0 || ref == null) {
        throw new Error(
          `unresolvable dep ${d}: only ${priorIds.length} card(s) committed in this thread so far`,
        );
      }
      resolvedDeps.push(ref);
    } else {
      resolvedDeps.push(d);
    }
  }
  const card = await createCard({
    title: input.title,
    description: input.description ?? "",
    priority: input.priority ?? 2,
    flavor: input.flavor ?? "feature",
    scope: input.scope ?? null,
    language: input.language,
    deps: resolvedDeps,
    estimated_loc: input.estimated_loc ?? null,
    budget_minutes: input.budget_minutes ?? null,
    created_by: "human",
  });
  return { card_id: card.frontmatter.id };
}

/**
 * Run save_plan → write file + git commit on main + best-effort push.
 *
 * Why no merger gate row: the worker-merger gate exists to serialize
 * push pressure between concurrent worker merges and human-side commits.
 * For a plan doc (single small file, no branch), the simplest correct
 * thing is to commit on main directly — same lane the merger uses.
 * If we ever observe lost pushes from races, we can lift this through
 * the workers table the way the merger does.
 */
export async function commitSavePlan(
  threadId: string,
  input: import("@questboard/core").SavePlanInput,
): Promise<{ path: string }> {
  void threadId;
  // Filename: docs/plan/<YYYY-MM-DD-HHMM>-<slug>.md
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
  const filename = `${stamp}-${input.slug}.md`;
  const relPath = join("docs", "plan", filename);
  const absPath = join(env.BOARD_ROOT, relPath);
  mkdirSync(dirname(absPath), { recursive: true });

  // Frontmatter is intentionally tiny — the body is the artifact, not the
  // metadata. Title/scope go on top so a plan reader sees the context.
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(input.title)}`,
    `slug: ${input.slug}`,
    input.scope ? `scope: ${input.scope}` : "scope: null",
    `created_at: ${now.toISOString()}`,
    "---",
    "",
  ].join("\n");
  const content = frontmatter + (input.body.endsWith("\n") ? input.body : input.body + "\n");
  writeFileSync(absPath, content, "utf8");

  // Commit + best-effort push. We're on the server's main checkout, same
  // working tree the merger uses. The composer worktree (per-thread) lives
  // elsewhere; nothing there is being committed by this call.
  try {
    await gitMain(["add", "--", relPath]);
    await gitMain(["commit", "-m", `docs(plan): ${input.title}`]);
  } catch (err) {
    // Could be "nothing to commit" if the file already existed identically;
    // surface as success in that case (idempotent).
    const msg = (err as Error).message ?? String(err);
    if (!/nothing to commit|no changes added/i.test(msg)) {
      throw err;
    }
  }
  // Push: best-effort, log on failure but don't fail the user.
  try {
    await gitMain(["push", "origin", "HEAD"]);
  } catch (err) {
    logger.warn("composer_save_plan_push_failed", { relPath, err: String(err) });
  }

  return { path: relPath };
}

