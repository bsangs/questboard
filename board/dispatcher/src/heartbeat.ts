/**
 * Hang watchdog. Workers no longer call /heartbeat — instead the dispatcher
 * watches each worker's transcript file. If the transcript hasn't been
 * appended to in `heartbeatTimeoutSec` seconds, the worker is considered
 * hung. The dispatcher SIGTERMs it, lets the exit handler do the rest
 * (route to stuck or push if commits exist).
 *
 * This replaces the old API-driven heartbeat. "Worker hang" still maps
 * to stuck(worker_orphaned)
 * but the detection mechanism is transcript mtime, not server-side rows.
 */
import * as fs from "node:fs";
import { killWorker } from "./kill.js";
import type { Logger } from "./logger.js";
import type { SpawnedWorker } from "./spawn.js";

export interface HeartbeatDeps {
  logger: Logger;
  /** card_id → in-memory worker handle */
  active: Map<string, SpawnedWorker>;
  heartbeatTimeoutSec: number;
  killGraceMs: number;
}

export class HeartbeatWatchdog {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: HeartbeatDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => {
        this.deps.logger.log({
          event: "heartbeat_tick_error",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    }, 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const { logger, active, heartbeatTimeoutSec, killGraceMs } = this.deps;
    const cutoff = Date.now() - heartbeatTimeoutSec * 1000;

    for (const worker of active.values()) {
      let mtime = 0;
      try {
        mtime = fs.statSync(worker.transcriptPath).mtimeMs;
      } catch {
        continue; // transcript not yet flushed; skip this round
      }
      const startedMs = Date.parse(worker.startedAt);
      const reference = Math.max(mtime, startedMs);
      if (reference >= cutoff) continue;

      logger.log({
        event: "transcript_hang",
        card_id: worker.cardId,
        pid: worker.pid,
        last_mtime: new Date(mtime).toISOString(),
        timeout_sec: heartbeatTimeoutSec,
      });

      // Best-effort kill; the exit handler will route the card to stuck.
      await killWorker(
        worker,
        { graceMs: killGraceMs, expectedStartedAt: worker.startedAt },
        logger,
      );
    }
  }
}
