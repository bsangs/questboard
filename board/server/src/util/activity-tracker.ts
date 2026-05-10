/**
 * Worker activity tracking — replacement for the old POST /heartbeat path.
 *
 * Old model: dispatcher prompt told the worker to POST
 * /api/cards/:id/heartbeat every 60s with cumulative tokens + elapsed.
 * That route updated `cards.tokens_used` / `elapsed_seconds` /
 * `last_heartbeat` and broadcast `worker_heartbeat` over SSE.
 *
 * New model: the worker spawn module observes claude's stream-json
 * envelopes (assistant turns carry per-turn `usage`) and calls this
 * helper directly. No HTTP roundtrip, no clock-skew between the worker
 * and server, no missed heartbeats when claude is mid-turn.
 *
 * Exported surface intentionally narrow: callers only need to say
 * "card X just emitted these tokens". This module owns the SQL
 * mutation, the elapsed-seconds derivation, and the SSE broadcast.
 */
import { db, updateCardTokenTotals } from "../db.js";
import { broadcast } from "../sse.js";
import { getCardTokenTotals, type CardTokenTotals, type StageRole } from "../stages.js";
import { logger } from "../logger.js";

const updateWorkerByCard = db.prepare(
  "UPDATE workers SET last_heartbeat = ?, tokens_used = ? WHERE card_id = ?",
);
const updateWorkerByPid = db.prepare(
  "UPDATE workers SET last_heartbeat = ?, tokens_used = ? WHERE pid = ?",
);
const getWorkerStartByCard = db.prepare(
  "SELECT pid, started_at, tokens_used FROM workers WHERE card_id = ?",
);
const updateCardStats = db.prepare(
  "UPDATE cards SET tokens_used = ?, elapsed_seconds = ?, updated_at = ? WHERE id = ?",
);

interface WorkerRow {
  pid: number;
  started_at: string;
  tokens_used: number;
}

export interface RecordActivityOpts {
  cardId: string;
  /**
   * Optional pid scope. When the worker spawn knows its child PID it
   * can pass it for a tighter where-clause; if omitted we update the
   * row matching `card_id` (workers table has at most one helper per
   * card).
   */
  pid?: number;
  /** Role for the active helper emitting activity. */
  role?: StageRole;
  /**
   * Per-turn token usage from a single claude assistant frame. Both
   * fields default to 0 — pass whatever you have.
   */
  delta?: { input_tokens?: number; output_tokens?: number };
  /**
   * Override for the activity timestamp; defaults to now. Useful when
   * replaying a stream-json line on a backfill path so the recorded
   * `last_heartbeat` matches the original turn time.
   */
  timestamp?: string;
}

/**
 * Record one tick of worker activity for a card.
 *
 * - Bumps `cards.tokens_used` by (input+output) delta.
 * - Recomputes `cards.elapsed_seconds` from `workers.started_at`.
 * - Writes `last_heartbeat` and `tokens_used` on the workers row.
 * - Recomputes per-role lifetime totals from transcripts.
 * - Broadcasts a `worker_heartbeat` SSE event so the UI updates live.
 *
 * No-op if there's no workers row for the card (helper exited or never
 * registered) — we still update `cards.tokens_used` so token counts don't
 * regress, but skip the elapsed/heartbeat columns since we have no
 * started_at to derive from.
 *
 * Best-effort: any DB / SSE failure is logged but never thrown. The
 * stream-json parser must keep flowing regardless — failing here would
 * stall the worker indefinitely.
 */
export function recordWorkerActivity(opts: RecordActivityOpts): void {
  const { cardId } = opts;
  const inputDelta = opts.delta?.input_tokens ?? 0;
  const outputDelta = opts.delta?.output_tokens ?? 0;
  const tickTotal = inputDelta + outputDelta;
  const now = opts.timestamp ?? new Date().toISOString();

  try {
    const workerRow = getWorkerStartByCard.get(cardId) as WorkerRow | undefined;

    // Compute the new cumulative tokens count from the previous total
    // on the workers row (if any). This is what the old /heartbeat route
    // received pre-summed from the dispatcher; we sum here instead.
    const prevTokens = workerRow?.tokens_used ?? 0;
    const newTokens = prevTokens + tickTotal;

    // Elapsed seconds = (now - started_at). Falls back to whatever
    // value the cards row already has if we can't derive it.
    let elapsed: number | null = null;
    if (workerRow?.started_at) {
      const started = Date.parse(workerRow.started_at);
      const ts = Date.parse(now);
      if (Number.isFinite(started) && Number.isFinite(ts) && ts >= started) {
        elapsed = Math.floor((ts - started) / 1000);
      }
    }

    if (workerRow) {
      // Prefer pid-scoped update when caller passed one — guards against
      // a stale row matching the same card_id getting touched.
      if (opts.pid != null) updateWorkerByPid.run(now, newTokens, opts.pid);
      else updateWorkerByCard.run(now, newTokens, cardId);
    }

    // We always write cards.tokens_used + updated_at; elapsed_seconds is
    // only updated when we could derive it, falling back to the existing
    // value otherwise (left = right is a no-op via the read-then-write).
    if (elapsed != null) {
      updateCardStats.run(newTokens, elapsed, now, cardId);
    } else {
      // No workers row — read current elapsed and re-write to keep the
      // column stable while still bumping tokens.
      const existing = db
        .prepare("SELECT elapsed_seconds FROM cards WHERE id = ?")
        .get(cardId) as { elapsed_seconds: number } | undefined;
      updateCardStats.run(newTokens, existing?.elapsed_seconds ?? 0, now, cardId);
    }

    // Recompute per-role lifetime totals from transcripts. Bounded by the
    // number of transcript files for this card — cheap enough per turn.
    let tokenTotals: CardTokenTotals = {
      worker_input_tokens: 0,
      worker_output_tokens: 0,
      reviewer_input_tokens: 0,
      reviewer_output_tokens: 0,
      merger_input_tokens: 0,
      merger_output_tokens: 0,
    };
    try {
      tokenTotals = getCardTokenTotals(cardId);
      if (opts.role === "worker") {
        tokenTotals.worker_input_tokens = Math.max(
          tokenTotals.worker_input_tokens,
          newTokens,
        );
        tokenTotals.worker_output_tokens = Math.max(
          tokenTotals.worker_output_tokens,
          outputDelta,
        );
      } else if (opts.role === "reviewer") {
        tokenTotals.reviewer_input_tokens = Math.max(
          tokenTotals.reviewer_input_tokens,
          newTokens,
        );
        tokenTotals.reviewer_output_tokens = Math.max(
          tokenTotals.reviewer_output_tokens,
          outputDelta,
        );
      } else if (opts.role === "merger") {
        tokenTotals.merger_input_tokens = Math.max(
          tokenTotals.merger_input_tokens,
          newTokens,
        );
        tokenTotals.merger_output_tokens = Math.max(
          tokenTotals.merger_output_tokens,
          outputDelta,
        );
      }
      updateCardTokenTotals(cardId, tokenTotals);
    } catch (err) {
      logger.error("token_totals_recompute_failed", {
        card_id: cardId,
        err: String(err),
      });
    }

    broadcast({
      type: "worker_heartbeat",
      card_id: cardId,
      pid: workerRow?.pid ?? opts.pid ?? 0,
      role: opts.role ?? null,
      tokens_used: newTokens,
      elapsed_seconds: elapsed ?? 0,
      worker_input_tokens: tokenTotals.worker_input_tokens,
      worker_output_tokens: tokenTotals.worker_output_tokens,
      reviewer_input_tokens: tokenTotals.reviewer_input_tokens,
      reviewer_output_tokens: tokenTotals.reviewer_output_tokens,
      merger_input_tokens: tokenTotals.merger_input_tokens,
      merger_output_tokens: tokenTotals.merger_output_tokens,
    });
  } catch (err) {
    logger.warn("activity_tracker_failed", {
      card_id: cardId,
      err: String(err),
    });
  }
}
