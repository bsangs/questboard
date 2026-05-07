/**
 * Dispatcher entrypoint.
 *
 * Lifecycle:
 *   1. Load .env + dispatcher config.
 *   2. Open the server's SQLite read-only.
 *   3. Run the boot reaper (recovery.ts) — mark dead in_progress workers stuck.
 *   4. Connect to the server SSE channel for card_status_changed / config_changed.
 *   5. Start a 2s poll loop as a belt-and-suspenders backup to SSE.
 *   6. Start the 30s heartbeat watchdog.
 *
 * Concurrency: the in-memory `active` map is the source of truth for what
 * the dispatcher itself spawned. The workers table (server-written) is
 * authoritative for the cap — we never spawn beyond config.concurrency_limit.
 */
import * as path from "node:path";
import EventSource from "eventsource";
import type { Database as DBType } from "better-sqlite3";
import { loadConfig, loadBoardConfig, type DispatcherConfig } from "./config.js";
import { Logger } from "./logger.js";
import { openReadOnlyDb } from "./db.js";
import { ServerApi } from "./api.js";
import { spawnWorker, spawnReviewer, spawnMerger, type SpawnedWorker } from "./spawn.js";
import {
  countRunningWorkers,
  isAnyMergerActive,
  nextMergeable,
  nextReviewable,
  nextSpawnable,
  nextWorkerRevivable,
} from "./queue.js";
import { attachExitHandler } from "./exit.js";
import { HeartbeatWatchdog } from "./heartbeat.js";
import { StatsReporter } from "./stats.js";
import { reapOrphans } from "./recovery.js";
import { killCard } from "./kill.js";

// loadConfig() handles env discovery from .questboard/.env,
// package-local .env fallback, or cwd .env.
const cfg: DispatcherConfig = loadConfig();
const logger = new Logger(path.join(cfg.logsDir, "dispatcher.jsonl"));

logger.log({
  event: "boot",
  message: "dispatcher starting",
  server_url: cfg.serverUrl,
  board_root: cfg.boardRoot,
  db_path: cfg.dbPath,
  auth_mode: cfg.authMode,
});

const api = new ServerApi(cfg.serverUrl);
const active = new Map<string, SpawnedWorker>();
/** Tracks card_ids we've recently spawned so a fast SSE-then-poll race
 *  doesn't double-spawn before the server inserts a workers row. */
const justSpawned = new Set<string>();
/**
 * Cards we've kicked off a server-side ff-merge attempt for. Until the
 * call resolves we mustn't spawn a Claude merger for the same card —
 * `nextMergeable` would still surface it (no workers row exists during
 * the ff attempt), and `isAnyMergerActive` doesn't see ff-merge either.
 * Cleared whether the attempt succeeds, fails-with-fallback, or throws.
 */
const ffMergeInflight = new Set<string>();

// 0. Wait for the server's /api/health to come up before doing anything
//    that talks to the API. PM2 starts both processes near-simultaneously
//    and the dispatcher would otherwise race in front of the server,
//    spawning helpers whose register-helper call fetch-fails.
async function waitForServer(maxAttempts = 60, intervalMs = 500): Promise<void> {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(`${cfg.serverUrl}/api/health`, {
        signal: AbortSignal.timeout(800),
      });
      if (res.ok) {
        if (i > 1) logger.log({ event: "server_ready", attempts: i });
        return;
      }
    } catch {
      /* server not up yet; retry */
    }
    if (i === 1) logger.log({ event: "waiting_for_server", url: cfg.serverUrl });
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  logger.log({
    event: "server_wait_timeout",
    message: `server did not respond at ${cfg.serverUrl} within ${(maxAttempts * intervalMs) / 1000}s; proceeding anyway`,
  });
}

await waitForServer();

// Open the SQLite read-only AFTER the server is up. The server is the
// sole writer and is responsible for creating board.sqlite during its
// own boot; opening before that races and crashes the dispatcher.
let db: DBType;
try {
  db = openReadOnlyDb(cfg.dbPath);
} catch (err) {
  logger.log({
    event: "db_open_failed",
    message: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}

// 1. Boot reaper.
await reapOrphans(db, api, logger).catch((err) => {
  logger.log({
    event: "recovery_failed",
    message: err instanceof Error ? err.message : String(err),
  });
});

// 2. Hang watchdog (transcript-mtime based; workers don't call heartbeat).
const watchdog = new HeartbeatWatchdog({
  logger,
  active,
  heartbeatTimeoutSec: cfg.heartbeatTimeoutSec,
  killGraceMs: cfg.killGraceMs,
});
watchdog.start();

// 2b. Stats reporter — queries SQLite workers table (so it survives
//     dispatcher restarts), parses the latest transcript for each, and
//     pushes tokens/elapsed to the server every 30s. Also reaps PIDs that
//     died across a dispatcher restart.
const stats = new StatsReporter({
  db,
  api,
  logger,
  active,
  cardsDir: cfg.cardsDir,
});
stats.start(30_000);

// 3. Spawn loop. Single in-flight at a time via a tiny mutex flag — the
//    server's workers table (UNIQUE on card_id via claim) is the actual
//    safety net, but this avoids redundant attempts in the same tick.
let spawnRunning = false;
/** Latch so a paused dispatcher logs once on entry, not every 2s poll. Reset
 *  when the next round actually executes (i.e. user resumed). */
let loggedPause = false;

/** Count the active in-memory workers of a given role. The SQLite workers
 *  table doesn't carry a role column, so we trust the dispatcher's own
 *  `active` map for cap enforcement. Death/orphan reaping happens elsewhere. */
function countActive(role: "worker" | "reviewer" | "merger"): number {
  let n = 0;
  for (const w of active.values()) if (w.role === role) n++;
  return n;
}

async function trySpawnRound(reason: string): Promise<void> {
  if (spawnRunning) return;
  spawnRunning = true;
  try {
    const live = loadBoardConfig(cfg);
    if (live.dispatch_paused) {
      // Skip ALL spawn rounds (worker / reviewer / merger). Helpers already
      // running keep going — we never SIGTERM on pause. Log once on entry
      // so the journal doesn't fill with one line every 2s.
      if (!loggedPause) {
        logger.log({ event: "dispatch_paused_skip", reason });
        loggedPause = true;
      }
      return;
    }
    loggedPause = false;
    // Each pool has its OWN cap of `concurrency_limit`. Workers, reviewers,
    // and mergers don't compete for slots — so peak total can be 3x the
    // configured limit. Per user request: pools are isolated.
    const cap = live.concurrency_limit;
    void countRunningWorkers; // (kept for the recovery / stats path)

    const workerSlots = cap - countActive("worker");
    const reviewerSlots = cap - countActive("reviewer");
    const mergerSlots = cap - countActive("merger");

    // ── Round 1: ready cards → workers ─────────────────────────────────
    // Includes 3-strikes-revive cards (status=in_progress, no workers row),
    // which the server's helper-died path leaves for us to re-spawn under
    // the same status. The cards' consecutive_deaths counter prevents this
    // from looping forever.
    const readyCandidates: ReturnType<typeof nextSpawnable> = [];
    if (workerSlots > 0) {
      readyCandidates.push(...nextSpawnable(db, workerSlots));
      const remaining = workerSlots - readyCandidates.length;
      if (remaining > 0) {
        readyCandidates.push(...nextWorkerRevivable(db, remaining));
      }
    }
    for (const card of readyCandidates) {
      if (active.has(card.id) || justSpawned.has(card.id)) continue;
      justSpawned.add(card.id);
      setTimeout(() => justSpawned.delete(card.id), 10_000).unref?.();
      try {
        const worker = await spawnWorker(card, cfg);
        active.set(card.id, worker);
        attachExitHandler(worker, { api, logger, active, baseBranch: cfg.baseBranch });
        logger.log({
          event: "worker_spawned",
          card_id: card.id,
          pid: worker.pid,
          attempt: worker.attempt,
          reason,
          worktree: path.relative(cfg.boardRoot, worker.worktreePath),
          transcript: path.relative(cfg.boardRoot, worker.transcriptPath),
        });
        api.claimForWorker(card.id, worker.pid, worker.attempt).catch((err) => {
          logger.log({
            event: "claim_failed",
            card_id: card.id,
            pid: worker.pid,
            attempt: worker.attempt,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      } catch (err) {
        justSpawned.delete(card.id);
        logger.log({
          event: "spawn_failed",
          card_id: card.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Round 2: ai_review cards → reviewers (independent cap) ─────────
    if (reviewerSlots > 0) {
      const reviewCandidates = nextReviewable(db, reviewerSlots);
      for (const card of reviewCandidates) {
        if (active.has(card.id) || justSpawned.has(card.id)) continue;
        justSpawned.add(card.id);
        setTimeout(() => justSpawned.delete(card.id), 10_000).unref?.();
        try {
          const reviewer = await spawnReviewer(card, cfg);
          active.set(card.id, reviewer);
          attachExitHandler(reviewer, { api, logger, active, baseBranch: cfg.baseBranch });
          logger.log({
            event: "reviewer_spawned",
            card_id: card.id,
            pid: reviewer.pid,
            attempt: reviewer.attempt,
            reason,
            transcript: path.relative(cfg.boardRoot, reviewer.transcriptPath),
          });
          api.registerHelper(card.id, reviewer.pid, "reviewer").catch((err) => {
            logger.log({
              event: "reviewer_register_failed",
              card_id: card.id,
              pid: reviewer.pid,
              message: err instanceof Error ? err.message : String(err),
            });
          });
        } catch (err) {
          justSpawned.delete(card.id);
          logger.log({
            event: "reviewer_spawn_failed",
            card_id: card.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Round 3: merging cards → ff-merge OR Claude merger (STRICTLY SERIAL) ─
    // Mergers serialize regardless of `concurrency_limit`: if any merger
    // is already running anywhere (in our local `active` map, the server-
    // owned workers table, OR an in-flight server-side ff-merge attempt),
    // skip this round entirely. Otherwise pick AT MOST ONE merging card
    // this tick. Two mergers running in parallel race on
    // `git checkout main && git push origin main` and one of them is
    // guaranteed to lose — better to never start the second.
    //
    // For each candidate, we first try the server-side ff-merge fast
    // path (#4 BIG WIN): on a clean fast-forward + green install/build,
    // the server pushes and transitions the card directly, no merger
    // process needed. If ff isn't possible (history diverged, gate
    // failed, etc.) the server signals `fallback_to_merger=true` and we
    // spawn the regular Claude merger to handle conflicts.
    //
    // The ff attempt is fire-and-forget here so trySpawnRound's mutex
    // doesn't get held for the duration of a build. We track it in
    // `ffMergeInflight` so the next poll round skips the same card
    // until the server replies.
    const mergerAlreadyRunning =
      countActive("merger") > 0 ||
      isAnyMergerActive(db) ||
      ffMergeInflight.size > 0;
    if (mergerSlots > 0 && !mergerAlreadyRunning) {
      const mergeCandidates = nextMergeable(db, 1);
      for (const card of mergeCandidates) {
        if (active.has(card.id) || justSpawned.has(card.id)) continue;
        if (ffMergeInflight.has(card.id)) continue;
        justSpawned.add(card.id);
        setTimeout(() => justSpawned.delete(card.id), 10_000).unref?.();
        ffMergeInflight.add(card.id);
        // Run ff-merge attempt + (on fallback) merger spawn off the spawn
        // mutex so other rounds don't block on it.
        void (async () => {
          let result: Awaited<ReturnType<typeof api.tryFfMerge>> | null = null;
          try {
            result = await api.tryFfMerge(card.id);
            logger.log({
              event: "ff_merge_attempt",
              card_id: card.id,
              ok: result.ok,
              reason: result.reason,
              ran: result.ran ?? null,
              merged_sha: result.merged_sha ?? null,
            });
          } catch (err) {
            logger.log({
              event: "ff_merge_call_failed",
              card_id: card.id,
              message: err instanceof Error ? err.message : String(err),
            });
            // Treat HTTP failure as "we don't know whether ff worked";
            // fall through to spawn merger so the card doesn't stall.
            result = {
              ok: false,
              fallback_to_merger: true,
              reason: `tryFfMerge HTTP failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
          if (result.ok) {
            // Server already transitioned the card. Done.
            ffMergeInflight.delete(card.id);
            return;
          }
          if (!result.fallback_to_merger) {
            // Terminal but no merger fallback (e.g. push succeeded but
            // mergerComplete failed). A human needs to look. Logged on
            // the server; we just stop touching this card.
            logger.log({
              event: "ff_merge_terminal_no_fallback",
              card_id: card.id,
              reason: result.reason,
            });
            ffMergeInflight.delete(card.id);
            return;
          }
          // Fall back to spawning the Claude merger. The card is still
          // in `merging` (server-side ff-merge resets local main on
          // failure), so the regular flow takes over from here.
          try {
            const merger = await spawnMerger(card, cfg);
            active.set(card.id, merger);
            attachExitHandler(merger, { api, logger, active, baseBranch: cfg.baseBranch });
            logger.log({
              event: "merger_spawned",
              card_id: card.id,
              pid: merger.pid,
              attempt: merger.attempt,
              reason: `${reason} (ff-fallback)`,
              transcript: path.relative(cfg.boardRoot, merger.transcriptPath),
            });
            api.registerHelper(card.id, merger.pid, "merger").catch((err) => {
              logger.log({
                event: "merger_register_failed",
                card_id: card.id,
                pid: merger.pid,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          } catch (err) {
            justSpawned.delete(card.id);
            logger.log({
              event: "merger_spawn_failed",
              card_id: card.id,
              message: err instanceof Error ? err.message : String(err),
            });
          } finally {
            ffMergeInflight.delete(card.id);
          }
        })();
        // Only kick off one card per tick — the next poll will pick up
        // any others once this one settles (mergers are strictly serial).
        break;
      }
    }
  } finally {
    spawnRunning = false;
  }
}

// 4. SSE subscription. Reconnect logic is built into eventsource; we just
//    handle the events we care about and the poll loop covers any gaps.
//    Typed loose because @types/eventsource pulls in DOM lib types (e.g.
//    MessageEvent) that aren't enabled here.
interface LooseEventSource {
  onopen: ((ev: unknown) => unknown) | null;
  onerror: ((ev: unknown) => unknown) | null;
  onmessage: ((ev: { data?: unknown }) => unknown) | null;
  addEventListener: (type: string, handler: (ev: { data?: unknown }) => unknown) => void;
  close: () => void;
}

function connectSse(): LooseEventSource {
  const url = `${cfg.serverUrl}/api/events`;
  const es = new EventSource(url) as unknown as LooseEventSource;

  es.onopen = () => logger.log({ event: "sse_open", message: url });
  es.onerror = (e: unknown) => {
    const msg = (e as { message?: string } | undefined)?.message ?? "sse error";
    logger.log({ event: "sse_error", message: msg });
  };

  const onAny = (raw: string, evtName: string): void => {
    let parsed: { type?: string; card_id?: string; id?: string } | null = null;
    try {
      parsed = JSON.parse(raw) as { type?: string; card_id?: string; id?: string };
    } catch {
      return;
    }
    if (!parsed) return;
    const t = parsed.type ?? evtName;
    if (t === "card_status_changed" || t === "card.status_changed") {
      // Even if we don't pre-filter to=ready, a spawn round is cheap.
      void trySpawnRound("sse_status");
    } else if (t === "card.cancel_requested" || t === "card_cancel_requested") {
      const cardId = parsed.card_id ?? parsed.id;
      if (cardId) {
        void killCard(cardId, active, db, cfg.killGraceMs, logger);
      }
    } else if (t === "config_changed" || t === "config.changed") {
      logger.log({ event: "config_changed", message: "reloading config" });
    } else if (t === "card_created" || t === "card.created") {
      // No-op: cards land in backlog; spawn happens on ready transition.
    }
  };

  es.onmessage = (ev) => onAny(String(ev.data ?? ""), "message");
  for (const name of [
    "card_status_changed",
    "card.status_changed",
    "card_created",
    "card.created",
    "config_changed",
    "config.changed",
    "comment_added",
    "card.comment_added",
    "card.cancel_requested",
    "card_cancel_requested",
  ]) {
    es.addEventListener(name, (ev) => onAny(String(ev.data ?? ""), name));
  }

  return es;
}

const sse = connectSse();

// 5. Belt-and-suspenders poll every 2s. Cheap (one SQL query, one COUNT,
//    optional spawn). Survives SSE disconnects.
const pollTimer = setInterval(() => {
  void trySpawnRound("poll");
}, 2_000);
pollTimer.unref?.();

// Kick off an immediate round in case there's already a ready card waiting.
void trySpawnRound("boot");

logger.log({ event: "ready", message: "dispatcher ready" });

// 6. Graceful shutdown.
function shutdown(signal: NodeJS.Signals): void {
  logger.log({ event: "shutdown", signal });
  clearInterval(pollTimer);
  watchdog.stop();
  stats.stop();
  try {
    sse.close();
  } catch {
    // ignore
  }
  // Don't kill workers — they have their own lifecycle. PM2 will let us
  // exit cleanly; on hard restart the boot reaper handles cleanup.
  logger.close();
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
