/**
 * Targeted worker kill: SIGTERM → grace → SIGKILL, scoped to exactly one
 * card_id's PID. Dispatcher.md §5 (CRITICAL boundary): never kill anything
 * else — verify started_at against the in-memory record before sending
 * signals to defend against PID reuse.
 *
 * Returns true if a kill was attempted, false if the worker was already
 * gone or the started_at didn't match (PID reuse case → no-op).
 */
import type { Database as DBType } from "better-sqlite3";
import type { SpawnedWorker } from "./spawn.js";
import type { Logger } from "./logger.js";

export interface KillOptions {
  /** Optional sanity check — if provided and != worker.startedAt, abort. */
  expectedStartedAt?: string;
  graceMs: number;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function killWorker(
  worker: SpawnedWorker,
  opts: KillOptions,
  logger: Logger,
): Promise<boolean> {
  if (opts.expectedStartedAt && opts.expectedStartedAt !== worker.startedAt) {
    logger.log({
      event: "kill_skipped_started_at_mismatch",
      card_id: worker.cardId,
      pid: worker.pid,
      expected: opts.expectedStartedAt,
      actual: worker.startedAt,
    });
    return false;
  }

  if (!pidAlive(worker.pid)) {
    logger.log({ event: "kill_skipped_pid_dead", card_id: worker.cardId, pid: worker.pid });
    return false;
  }

  logger.log({ event: "kill_sigterm", card_id: worker.cardId, pid: worker.pid });
  try {
    worker.child.kill("SIGTERM");
  } catch {
    // already dead
    return false;
  }

  // Wait up to graceMs, polling for liveness.
  const deadline = Date.now() + opts.graceMs;
  while (Date.now() < deadline) {
    if (!pidAlive(worker.pid)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }

  if (pidAlive(worker.pid)) {
    logger.log({ event: "kill_sigkill", card_id: worker.cardId, pid: worker.pid });
    try {
      worker.child.kill("SIGKILL");
    } catch {
      // ignore
    }
  }
  return true;
}

/**
 * High-level kill by card id. Looks up the worker row in SQLite to confirm
 * we're aiming at the right (pid, started_at) pair, finds the in-memory
 * SpawnedWorker handle, and runs SIGTERM → grace → SIGKILL. Closes the
 * transcript file once the child has exited (the exit handler also closes
 * it, but doing it here makes kill idempotent under handler races).
 *
 * Returns true if a kill was issued, false if there was nothing to do.
 */
export async function killCard(
  cardId: string,
  active: Map<string, SpawnedWorker>,
  db: DBType,
  graceMs: number,
  logger: Logger,
): Promise<boolean> {
  const worker = active.get(cardId);
  if (!worker) {
    logger.log({ event: "kill_no_active_worker", card_id: cardId });
    return false;
  }

  const row = db
    .prepare(`SELECT pid, started_at FROM workers WHERE card_id = ?`)
    .get(cardId) as { pid: number; started_at: string } | undefined;

  if (row && row.pid !== worker.pid) {
    logger.log({
      event: "kill_pid_mismatch",
      card_id: cardId,
      db_pid: row.pid,
      memory_pid: worker.pid,
    });
    return false;
  }

  const result = await killWorker(
    worker,
    { graceMs, expectedStartedAt: row?.started_at ?? worker.startedAt },
    logger,
  );
  // Transcript is written directly by the child via inherited fd; no
  // stream to close here.
  return result;
}
