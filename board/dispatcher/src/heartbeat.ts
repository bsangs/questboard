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
import { join } from "node:path";
import type { Database as DBType } from "better-sqlite3";
import { killWorker } from "./kill.js";
import type { Logger } from "./logger.js";
import type { SpawnedWorker } from "./spawn.js";

export interface HeartbeatDeps {
  logger: Logger;
  /** card_id → in-memory worker handle */
  active: Map<string, SpawnedWorker>;
  heartbeatTimeoutSec: number;
  killGraceMs: number;
  db?: DBType;
  cardsDir?: string;
}

interface WorkerRow {
  pid: number;
  card_id: string;
  started_at: string;
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

    await this.tickInherited(cutoff);
  }

  private async tickInherited(cutoff: number): Promise<void> {
    const { db, cardsDir, active, logger, heartbeatTimeoutSec, killGraceMs } =
      this.deps;
    if (!db || !cardsDir) return;
    let rows: WorkerRow[];
    try {
      rows = db
        .prepare("SELECT pid, card_id, started_at FROM workers")
        .all() as WorkerRow[];
    } catch (err) {
      logger.log({
        event: "heartbeat_inherited_query_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    for (const row of rows) {
      if (active.has(row.card_id)) continue;
      const transcript = latestTranscript(cardsDir, row.card_id);
      if (!transcript) continue;
      const startedMs = Date.parse(row.started_at);
      const reference = Math.max(transcript.mtimeMs, Number.isNaN(startedMs) ? 0 : startedMs);
      if (reference >= cutoff) continue;
      logger.log({
        event: "transcript_hang_inherited",
        card_id: row.card_id,
        pid: row.pid,
        last_mtime: new Date(transcript.mtimeMs).toISOString(),
        timeout_sec: heartbeatTimeoutSec,
      });
      killPid(row.pid, killGraceMs);
    }
  }
}

function latestTranscript(
  cardsDir: string,
  cardId: string,
): { path: string; mtimeMs: number } | null {
  const dir = join(cardsDir, cardId, "transcripts");
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of files) {
    const path = join(dir, name);
    try {
      const stat = fs.statSync(path);
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { path, mtimeMs: stat.mtimeMs };
      }
    } catch {
      /* ignore individual transcript stat failures */
    }
  }
  return best;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killPid(pid: number, graceMs: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  setTimeout(() => {
    if (!pidAlive(pid)) return;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* process already gone */
    }
  }, graceMs).unref?.();
}
