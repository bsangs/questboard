/**
 * Crash-restart reaper. On dispatcher boot, scan every "actively occupied"
 * card status (in_progress / ai_review / merging) and check whether the
 * owner_pid (or the workers-table pid) is still alive. Dead PIDs mean the
 * helper died while the dispatcher was down; route them to the right state
 * via the server API so they get re-queued / re-spawned cleanly.
 *
 * Routing by card status:
 *   in_progress → /stuck (worker_orphaned)
 *   ai_review   → /reviewer-reject (with crash reason)
 *   merging     → /merger-failed   (with crash reason)
 *
 * Bounded by concurrency_limit (≤ 8 per role), so this
 * completes in well under 5 seconds even at peak.
 */
import type { Database as DBType } from "better-sqlite3";
import type { ServerApi } from "./api.js";
import type { Logger } from "./logger.js";

interface ActiveCardRow {
  id: string;
  status: string;
  owner_pid: number | null;
}

interface WorkerRow {
  pid: number;
  card_id: string;
  started_at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

export async function reapOrphans(db: DBType, api: ServerApi, logger: Logger): Promise<void> {
  // Cards the server believes are actively held by some helper process.
  const cards = db
    .prepare(
      `SELECT id, status, owner_pid FROM cards
       WHERE status IN ('in_progress', 'ai_review', 'merging')`,
    )
    .all() as ActiveCardRow[];

  const workerRows = db
    .prepare(`SELECT pid, card_id, started_at FROM workers`)
    .all() as WorkerRow[];
  const byCard = new Map<string, WorkerRow>();
  for (const w of workerRows) byCard.set(w.card_id, w);

  for (const card of cards) {
    const pid = card.owner_pid ?? byCard.get(card.id)?.pid ?? null;
    if (pid == null) {
      logger.log({
        event: "recovery_no_pid",
        card_id: card.id,
        message: `${card.status} card has no owner_pid — treating as orphaned`,
      });
      await routeOrphan(
        api,
        logger,
        card,
        "No recorded PID after dispatcher restart.",
      );
      continue;
    }
    if (pidAlive(pid)) {
      logger.log({ event: "recovery_pid_alive", card_id: card.id, pid });
      // Live process from a previous dispatcher generation. We don't own
      // the child_process handle, but stats.ts will heartbeat it via the
      // workers table and the hang watchdog (transcript-mtime) will reap
      // it if it actually wedges.
      continue;
    }
    logger.log({ event: "recovery_pid_dead", card_id: card.id, pid });
    await routeOrphan(
      api,
      logger,
      card,
      `${card.status} helper PID ${pid} not alive after dispatcher restart.`,
    );
  }
}

async function routeOrphan(
  api: ServerApi,
  logger: Logger,
  card: ActiveCardRow,
  reason: string,
): Promise<void> {
  try {
    if (card.status === "ai_review") {
      await api.reviewerReject(card.id, reason);
    } else if (card.status === "merging") {
      await api.mergerFailed(card.id, reason);
    } else {
      // in_progress (worker)
      await api.reportStuck(card.id, "worker_orphaned", reason);
    }
  } catch (err) {
    logger.log({
      event: "recovery_report_failed",
      card_id: card.id,
      status: card.status,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
