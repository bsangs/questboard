/**
 * Stats reporter + dead-pid reconciler.
 *
 * Every 30s, walk the SQLite `workers` table (server-written; survives
 * dispatcher restarts) and for each row:
 *
 *   - If the PID is dead (lost across a dispatcher restart, OOM, etc.):
 *     post /exit with worker_failed so the card moves out of in_progress.
 *   - If alive: locate the latest transcript file under
 *     `cards/<id>/transcripts/`, parse it for cumulative tokens + elapsed,
 *     and POST /heartbeat.
 *
 * Workers themselves never call the server. This is the only way the UI
 * gets live progress and the only way orphaned in_progress rows recover
 * after a dispatcher crash.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Database as DBType } from "better-sqlite3";
import type { ServerApi } from "./api.js";
import type { Logger } from "./logger.js";
import type { SpawnedWorker } from "./spawn.js";
import { transcriptTokens } from "./transcript.js";

export interface StatsReporterDeps {
  db: DBType;
  api: ServerApi;
  logger: Logger;
  active: Map<string, SpawnedWorker>;
  cardsDir: string;
}

interface WorkerRow {
  pid: number;
  card_id: string;
  started_at: string;
  last_heartbeat: string;
}

/**
 * If an exit handler has been running for longer than this, treat it as
 * hung and fall back to the orphan path. routeExit normally finishes in
 * <10s (git push is the slowest step); 90s is generous and well past
 * the 30s HTTP timeout in api.ts so any single wedged call has already
 * thrown by the time we trigger.
 */
const EXIT_HANDLER_HUNG_MS = 90_000;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we can't signal it — still alive.
    if ((err as NodeJS.ErrnoException).code === "EPERM") return true;
    return false;
  }
}

function latestTranscript(cardsDir: string, cardId: string): string | null {
  const dir = path.join(cardsDir, cardId, "transcripts");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  let bestFile: string | null = null;
  let bestMtime = -Infinity;
  for (const f of files) {
    const full = path.join(dir, f);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs > bestMtime) {
        bestMtime = stat.mtimeMs;
        bestFile = full;
      }
    } catch {
      // ignore individual failures
    }
  }
  return bestFile;
}

function elapsedSecondsFromStart(startedAt: string): number {
  const t = Date.parse(startedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 1000));
}

export class StatsReporter {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: StatsReporterDeps) {}

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const { db, api, logger, cardsDir, active } = this.deps;
    let rows: WorkerRow[];
    try {
      rows = db
        .prepare("SELECT pid, card_id, started_at, last_heartbeat FROM workers")
        .all() as WorkerRow[];
    } catch (err) {
      logger.log({
        event: "stats_query_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    for (const row of rows) {
      if (!isAlive(row.pid)) {
        // If this card is in `active`, the dispatcher's own exit handler
        // is in flight (routeExit can take seconds for git push) and
        // hasn't yet called reportExit to drop the workers row. The
        // exit handler will report the real exit_code; we must NOT
        // race ahead and post `code=null`, which the server treats as
        // worker_failed and would flip a clean exit into `stuck`.
        //
        // BUT: if the exit handler has been "running" for too long, it's
        // hung (a wedged HTTP call, a git rev-list that never returned,
        // etc.). In that case we must NOT keep skipping forever — the
        // card is stuck in `in_progress` while the worker is already
        // dead. Fall through to the orphan path so the server flips
        // the card to stuck.
        const w = active.get(row.card_id);
        if (w) {
          const exitStartedAt = w.exitStartedAt;
          const hung =
            exitStartedAt != null && Date.now() - exitStartedAt > EXIT_HANDLER_HUNG_MS;
          if (!hung) {
            continue;
          }
          logger.log({
            event: "exit_handler_hung",
            card_id: row.card_id,
            pid: row.pid,
            stuck_for_ms: Date.now() - exitStartedAt,
          });
          // Drop our local entry so subsequent ticks don't keep re-firing
          // and so the next spawn round isn't blocked on a phantom.
          active.delete(row.card_id);
        }
        logger.log({
          event: "stats_dead_pid",
          card_id: row.card_id,
          pid: row.pid,
        });
        // 3-strikes-out path. Infer role from card status:
        //   in_progress → worker
        //   ai_review   → reviewer
        //   merging     → merger
        //   any other   → server treats as no-op (just drops the workers row)
        const card = db
          .prepare("SELECT status FROM cards WHERE id = ?")
          .get(row.card_id) as { status: string } | undefined;
        const stage =
          card?.status === "ai_review"
            ? ("reviewer" as const)
            : card?.status === "merging"
              ? ("merger" as const)
              : ("worker" as const);
        try {
          const result = await api.helperDied(row.card_id, stage);
          logger.log({
            event: "helper_died_reported",
            card_id: row.card_id,
            pid: row.pid,
            stage,
            action: result.action,
            count: result.count,
            status: result.status,
          });
          // For action="revive": the server has already dropped the workers
          // row. The next spawn round will pick the card up via
          // nextWorkerRevivable / nextReviewable / nextMergeable depending
          // on stage. Nothing more to do here.
          // For action="cancelled": the server has transitioned to cancelled,
          // posted a comment, and dropped the workers row. Nothing to do.
          // For action="noop": stale state; server already cleaned up.
        } catch (err) {
          logger.log({
            event: "helper_died_failed",
            card_id: row.card_id,
            pid: row.pid,
            stage,
            message: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      const transcriptPath = latestTranscript(cardsDir, row.card_id);
      const tokens = transcriptPath ? transcriptTokens(transcriptPath) : 0;
      const elapsed = elapsedSecondsFromStart(row.started_at);

      try {
        await api.reportHeartbeat(row.card_id, row.pid, tokens, elapsed);
      } catch (err) {
        logger.log({
          event: "stats_heartbeat_failed",
          card_id: row.card_id,
          pid: row.pid,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
