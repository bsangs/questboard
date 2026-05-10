/**
 * Live worker tracking. Mirrors the `workers` SQLite table.
 * dispatcher reports heartbeats via the REST API; we use this to detect orphan
 * workers and to power the stats panel.
 */
import { db, updateCardTokenTotals } from "./db.js";
import { broadcast } from "./sse.js";
import { getCardTokenTotals, type CardTokenTotals, type StageRole } from "./stages.js";
import { logger } from "./logger.js";

const upsertWorker = db.prepare(`
  INSERT INTO workers(pid, card_id, started_at, last_heartbeat, tokens_used)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(pid) DO UPDATE SET
    card_id = excluded.card_id,
    last_heartbeat = excluded.last_heartbeat,
    tokens_used = excluded.tokens_used
`);

const updateHeartbeat = db.prepare(
  "UPDATE workers SET last_heartbeat = ?, tokens_used = ? WHERE pid = ?",
);

const removeWorker = db.prepare("DELETE FROM workers WHERE pid = ?");
const removeWorkerByCard = db.prepare("DELETE FROM workers WHERE card_id = ?");
const countActive = db.prepare("SELECT COUNT(*) AS n FROM workers");
const updateCardStats = db.prepare(
  "UPDATE cards SET tokens_used = ?, elapsed_seconds = ?, updated_at = ? WHERE id = ?",
);

export function registerWorker(pid: number, cardId: string): void {
  const now = new Date().toISOString();
  upsertWorker.run(pid, cardId, now, now, 0);
}

/**
 * Register a non-worker helper (reviewer / merger) in the workers table
 * WITHOUT performing a status transition. Reviewer runs while status stays
 * `ai_review`; merger runs while status stays `merging`. We still need a
 * workers row so:
 *   - StatsReporter pushes tokens/elapsed to the right card
 *   - dead-pid detection kicks in if the dispatcher crashes
 *   - the UI can show "reviewing"/"merging" via cards.owner_pid
 */
export function registerHelper(pid: number, cardId: string): void {
  const now = new Date().toISOString();
  upsertWorker.run(pid, cardId, now, now, 0);
  db.prepare("UPDATE cards SET owner_pid = ?, updated_at = ? WHERE id = ?").run(
    pid,
    now,
    cardId,
  );
  broadcast({ type: "card_updated", card_id: cardId });
}

export function recordHeartbeat(
  cardId: string,
  pid: number,
  tokensUsed: number,
  elapsedSeconds: number,
  role?: StageRole,
  roleInputTokens?: number,
  roleOutputTokens?: number,
  transcript?: string,
): void {
  const now = new Date().toISOString();
  updateHeartbeat.run(now, tokensUsed, pid);
  updateCardStats.run(tokensUsed, elapsedSeconds, now, cardId);
  // Recompute per-role lifetime output totals from transcripts. Bounded
  // by the number of transcript files for this card; cheap enough to do
  // every heartbeat. Best-effort — errors here must not break the
  // heartbeat (which is what keeps the dispatcher alive).
  let tokenTotals: CardTokenTotals = {
    worker_input_tokens: 0,
    worker_output_tokens: 0,
    reviewer_input_tokens: 0,
    reviewer_output_tokens: 0,
    merger_input_tokens: 0,
    merger_output_tokens: 0,
  };
  try {
    tokenTotals = getCardTokenTotals(cardId, {
      excludeTranscript: transcript ?? null,
    });
    if (role === "worker") {
      tokenTotals.worker_input_tokens += roleInputTokens ?? tokensUsed;
      tokenTotals.worker_output_tokens += roleOutputTokens ?? 0;
    } else if (role === "reviewer") {
      tokenTotals.reviewer_input_tokens += roleInputTokens ?? tokensUsed;
      tokenTotals.reviewer_output_tokens += roleOutputTokens ?? 0;
    } else if (role === "merger") {
      tokenTotals.merger_input_tokens += roleInputTokens ?? tokensUsed;
      tokenTotals.merger_output_tokens += roleOutputTokens ?? 0;
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
    pid,
    role: role ?? null,
    tokens_used: tokensUsed,
    elapsed_seconds: elapsedSeconds,
    worker_input_tokens: tokenTotals.worker_input_tokens,
    worker_output_tokens: tokenTotals.worker_output_tokens,
    reviewer_input_tokens: tokenTotals.reviewer_input_tokens,
    reviewer_output_tokens: tokenTotals.reviewer_output_tokens,
    merger_input_tokens: tokenTotals.merger_input_tokens,
    merger_output_tokens: tokenTotals.merger_output_tokens,
  });
}

export function unregisterWorker(pid: number): void {
  removeWorker.run(pid);
}

export function unregisterByCard(cardId: string): void {
  removeWorkerByCard.run(cardId);
}

export function activeWorkerCount(): number {
  return (countActive.get() as { n: number }).n;
}
