/**
 * Server-side post-build command runner with auto-retry for transient
 * failures.
 *
 * After a merger reports MERGED, the server (not the merger AI) runs the
 * user-configured `merger_post_build_command` (e.g. `vercel --prod`,
 * smoke tests, schema migration check). This avoids spending tokens on
 * a deterministic shell command and lets the user iterate on the
 * command without redeploying the merger prompt.
 *
 * Lifecycle:
 *   1. Open append-mode log file at cards/<id>/post_build.log.
 *   2. Spawn `bash -lc <cmd>` with stdio[1,2] = log fd. cwd = BOARD_ROOT
 *      (or the user-configured `merger_post_build_cwd`).
 *   3. Track the run in `activePostBuilds` (cardId → pid) so the
 *      stop-post-build endpoint can SIGTERM it, and so retry-post-build
 *      can refuse a concurrent start.
 *   4. Insert a `workers` row keyed by the bash pid + cardId, so the
 *      dispatcher's sequential-merger gate (isAnyMergerActive) sees the
 *      card as occupied.
 *   5. On exit:
 *        code 0 → mergerCompleteAfterPostBuild → status merging → done
 *        non-0  → classify the log tail:
 *           "transient"  + < MAX_AUTO_RETRIES → schedule a delayed retry
 *           "transient"  + >= MAX_AUTO_RETRIES → stuck (gave up)
 *           "persistent" / "unknown"           → stuck immediately
 *      Either way, we record a row in card.frontmatter.post_build_attempts
 *      so the timeline / drawer can show the history.
 *
 * Auto-retry uses Node's setTimeout in-process. On server restart any
 * pending auto-retry is lost — that's fine, transient failures are short-
 * lived and the user can manually retry.
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from "node:fs";
import {
  join,
  dirname,
  resolve as resolvePath,
  relative as relPath,
  isAbsolute,
  sep,
} from "node:path";
import type { PostBuildAttempt, PostBuildClassification } from "@questboard/core";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { db } from "./db.js";
import { getConfig } from "./config.js";
import { readCard, writeCardAtomic } from "./files.js";
import { upsertCardRow } from "./db.js";

// ─── Active-run tracking + retry state ──────────────────────────────────────

/**
 * cardId → pid of the currently-running post-build. Cleared on exit.
 * We use this (not the workers table) as the source of truth for "is a
 * post-build active right now?" because the workers table is shared with
 * regular workers and we'd otherwise have to disambiguate by status.
 */
const activePostBuilds = new Map<string, number>();

/** cardId → setTimeout handle for a pending auto-retry. */
const pendingRetries = new Map<string, NodeJS.Timeout>();

/**
 * Maximum number of TRANSIENT auto-retry attempts. The first failure (#1)
 * triggers retry #2; the second failure triggers retry #3. After #3 fails
 * we give up and mark the card stuck.
 */
const MAX_AUTO_RETRIES = 3;

/** Backoff schedule for the Nth attempt (0-indexed). Cap at last entry. */
const RETRY_DELAYS_MS = [30_000, 120_000];

/** Hard cap on attempts retained in the frontmatter audit trail. */
const ATTEMPTS_CAP = 20;

export function isPostBuildActive(cardId: string): boolean {
  return activePostBuilds.has(cardId);
}

export function getActivePostBuildPid(cardId: string): number | null {
  return activePostBuilds.get(cardId) ?? null;
}

/** True iff there's a pending auto-retry timer for this card. */
export function hasPendingAutoRetry(cardId: string): boolean {
  return pendingRetries.has(cardId);
}

/**
 * Cancel a pending auto-retry timer. Used by the manual retry endpoint
 * (user wants to retry NOW, ahead of the scheduled delay) and by the
 * stop-post-build endpoint when there's no live process but a retry was
 * queued.
 */
export function cancelPendingAutoRetry(cardId: string): boolean {
  const t = pendingRetries.get(cardId);
  if (!t) return false;
  clearTimeout(t);
  pendingRetries.delete(cardId);
  return true;
}

// ─── Classification ──────────────────────────────────────────────────────────

/**
 * Patterns that, when found anywhere in the log tail, mark a failure as
 * TRANSIENT — i.e. retrying without code changes is likely to succeed.
 * Network blips, rate limits, gateway timeouts, etc.
 */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\bETIMEDOUT\b/i,
  /\bECONNRESET\b/i,
  /\bECONNREFUSED\b/i,
  /\bEAI_AGAIN\b/i,
  /\bENETUNREACH\b/i,
  /\bENOTFOUND\b/i,
  /\b50[34]\b/, // 503 / 504 gateway / unavailable
  /\b429\b/,
  /rate ?limit/i,
  /fetch failed/i,
  /\bnetwork\b/i,
  /socket hang up/i,
  /timeout/i,
];

/**
 * Patterns that mark a failure as PERSISTENT — a code-level problem that
 * won't fix itself with another run. Type errors, missing modules, test
 * failures, etc.
 */
const PERSISTENT_PATTERNS: RegExp[] = [
  /\bTypeError\b/,
  /\bSyntaxError\b/,
  /\bType error\b/i,
  /Cannot find module/i,
  /module not found/i,
  /test failed/i,
  /\bELIFECYCLE\b/,
  /assert(?:ion)? (?:failed|error)/i,
];

/**
 * Classify a non-zero post-build exit by inspecting the captured log tail.
 *
 * Order matters: TRANSIENT wins over PERSISTENT when both match (a flaky
 * network call that triggers an assertion is still ultimately a network
 * problem). UNKNOWN is the safe default — we treat it as persistent at the
 * caller (no retry), but emit it as a distinct classification for audit.
 */
export function classifyPostBuildFailure(logTail: string): PostBuildClassification {
  const text = logTail || "";
  for (const re of TRANSIENT_PATTERNS) {
    if (re.test(text)) return "transient";
  }
  for (const re of PERSISTENT_PATTERNS) {
    if (re.test(text)) return "persistent";
  }
  return "unknown";
}

/**
 * Pull a short, single-line excerpt from the log tail to surface in the
 * audit trail / UI. We prefer the first line that matched our classifier;
 * otherwise fall back to the last non-empty line.
 */
function classificationExcerpt(
  logTail: string,
  classification: PostBuildClassification,
): string {
  if (!logTail) return "";
  const lines = logTail.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (classification === "transient") {
    for (const re of TRANSIENT_PATTERNS) {
      const hit = lines.find((l) => re.test(l));
      if (hit) return hit.slice(0, 240);
    }
  } else if (classification === "persistent") {
    for (const re of PERSISTENT_PATTERNS) {
      const hit = lines.find((l) => re.test(l));
      if (hit) return hit.slice(0, 240);
    }
  }
  const last = lines[lines.length - 1] ?? "";
  return last.slice(0, 240);
}

// ─── Frontmatter helpers ─────────────────────────────────────────────────────

/**
 * Append an attempt row to `card.frontmatter.post_build_attempts`, capping
 * at ATTEMPTS_CAP and writing the file atomically. SQLite mirror is also
 * upserted so the cards row stays in sync (note: post_build_attempts is
 * NOT mirrored to SQL — it's frontmatter-only — but the card revision
 * still bumps updated_at via upsertCardRow).
 */
async function appendPostBuildAttempt(
  cardId: string,
  attempt: PostBuildAttempt,
): Promise<void> {
  try {
    const { card, archived } = readCard(cardId);
    if (archived) return; // archived cards aren't mutated
    const existing = card.frontmatter.post_build_attempts ?? [];
    const next = [...existing, attempt];
    // Trim oldest first if we exceed the cap so the audit row stays small.
    const trimmed =
      next.length > ATTEMPTS_CAP ? next.slice(next.length - ATTEMPTS_CAP) : next;
    const nextCard = {
      ...card,
      frontmatter: {
        ...card.frontmatter,
        post_build_attempts: trimmed,
        updated_at: new Date().toISOString(),
      },
    };
    await writeCardAtomic(cardId, nextCard, false);
    upsertCardRow(nextCard.frontmatter, nextCard.frontmatter.deps);
  } catch (err) {
    logger.warn("post_build_attempt_record_failed", {
      cardId,
      err: String(err),
    });
  }
}

/**
 * Count consecutive TRANSIENT attempts from the tail of the audit trail
 * (stop on the first non-transient row, since that resets the streak).
 */
function consecutiveTransientCount(card: {
  frontmatter: { post_build_attempts?: PostBuildAttempt[] };
}): number {
  const arr = card.frontmatter.post_build_attempts ?? [];
  let n = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const row = arr[i];
    if (row && row.classification === "transient") n++;
    else break;
  }
  return n;
}

// ─── cwd resolution (unchanged behavior, kept verbatim) ──────────────────────

/**
 * Resolve `merger_post_build_cwd` (project-relative POSIX path) into an
 * absolute path under BOARD_ROOT. Falls back to BOARD_ROOT when the
 * config has no override or when the value resolves outside the root.
 */
function resolvePostBuildCwd(): string {
  let raw: string | null | undefined;
  try {
    raw = getConfig().merger_post_build_cwd;
  } catch {
    raw = null;
  }
  if (typeof raw !== "string" || raw.trim() === "") return env.BOARD_ROOT;
  const abs = resolvePath(env.BOARD_ROOT, raw.trim());
  const rel = relPath(env.BOARD_ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    logger.warn("post_build_cwd_outside_root", {
      configured: raw,
      board_root: env.BOARD_ROOT,
    });
    return env.BOARD_ROOT;
  }
  try {
    if (!statSync(abs).isDirectory()) {
      logger.warn("post_build_cwd_not_dir", { path: abs });
      return env.BOARD_ROOT;
    }
  } catch {
    logger.warn("post_build_cwd_missing", { path: abs });
    return env.BOARD_ROOT;
  }
  void rel.split(sep).join("/");
  return abs;
}

const HEAD_LIMIT = 4_000;
const TAIL_LIMIT = 4_000;

function readLogTail(path: string): string {
  if (!existsSync(path)) return "";
  try {
    const buf = readFileSync(path);
    if (buf.length <= HEAD_LIMIT + TAIL_LIMIT) return buf.toString("utf8");
    const head = buf.subarray(0, HEAD_LIMIT).toString("utf8");
    const tail = buf.subarray(buf.length - TAIL_LIMIT).toString("utf8");
    return `${head}\n\n... [${buf.length - HEAD_LIMIT - TAIL_LIMIT} bytes omitted] ...\n\n${tail}`;
  } catch {
    return "";
  }
}

function lockCardForPostBuild(cardId: string, pid: number): void {
  try {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO workers(pid, card_id, started_at, last_heartbeat, tokens_used)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(pid) DO UPDATE SET
         card_id = excluded.card_id,
         last_heartbeat = excluded.last_heartbeat`,
    ).run(pid, cardId, now, now);
  } catch (err) {
    logger.warn("post_build_lock_failed", { cardId, pid, err: String(err) });
  }
}

function unlockCardForPostBuild(pid: number): void {
  try {
    db.prepare("DELETE FROM workers WHERE pid = ?").run(pid);
  } catch (err) {
    logger.warn("post_build_unlock_failed", { pid, err: String(err) });
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Spawn the post-build command and arrange the follow-up transition. Does
 * NOT await the command — returns immediately so the calling HTTP handler
 * (mergerComplete via /api/cards/:id/merger-complete or the manual retry
 * endpoint) can respond inside its timeout window.
 *
 * If a post-build is already active for this card (or a retry is queued),
 * the caller should have refused at the route layer; we still guard here
 * to keep the spec invariant — only one in-flight post-build per card.
 */
export function runPostBuildAsync(
  cardId: string,
  mergedSha: string,
  cmd: string,
): void {
  if (activePostBuilds.has(cardId)) {
    logger.warn("post_build_already_active", {
      cardId,
      pid: activePostBuilds.get(cardId),
    });
    return;
  }
  // If a retry was queued, fire NOW instead of double-running.
  cancelPendingAutoRetry(cardId);

  const startedAtMs = Date.now();
  const cardDir = join(env.CARDS_DIR, cardId);
  const logPath = join(cardDir, "post_build.log");

  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch (err) {
    logger.error("post_build_mkdir_failed", { cardId, err: String(err) });
    void emergencyStuck(cardId, mergedSha, `couldn't prep log dir: ${String(err)}`);
    return;
  }

  let logFd: number;
  try {
    logFd = openSync(logPath, "a");
  } catch (err) {
    logger.error("post_build_open_log_failed", { cardId, err: String(err) });
    void emergencyStuck(cardId, mergedSha, `couldn't open log: ${String(err)}`);
    return;
  }

  const cwd = resolvePostBuildCwd();

  const header =
    `\n========== ${new Date().toISOString()} ==========\n` +
    `card: ${cardId}\n` +
    `merged_sha: ${mergedSha}\n` +
    `cmd: ${cmd}\n` +
    `cwd: ${cwd}\n` +
    `--------\n`;
  try {
    writeSync(logFd, header);
  } catch {
    /* non-fatal */
  }

  let child;
  try {
    child = spawn("bash", ["-lc", cmd], {
      cwd,
      env: {
        ...process.env,
        BOARD_ROOT: env.BOARD_ROOT,
        CARD_ID: cardId,
        MERGED_SHA: mergedSha,
      },
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
  } catch (err) {
    try {
      closeSync(logFd);
    } catch {}
    logger.error("post_build_spawn_failed", { cardId, err: String(err) });
    void emergencyStuck(cardId, mergedSha, `bash spawn failed: ${String(err)}`);
    return;
  }

  try {
    closeSync(logFd);
  } catch {
    /* ignore */
  }

  if (typeof child.pid !== "number") {
    logger.error("post_build_no_pid", { cardId });
    void emergencyStuck(cardId, mergedSha, "bash spawn returned no pid");
    return;
  }

  const pid = child.pid;
  activePostBuilds.set(cardId, pid);
  lockCardForPostBuild(cardId, pid);
  child.unref();

  logger.info("post_build_started", { cardId, pid, cmd });

  child.on("error", (err) => {
    logger.error("post_build_child_error", { cardId, pid, err: String(err) });
  });

  child.on("exit", (code, signal) => {
    activePostBuilds.delete(cardId);
    unlockCardForPostBuild(pid);
    const sizeBytes = (() => {
      try {
        return statSync(logPath).size;
      } catch {
        return 0;
      }
    })();
    const tail = readLogTail(logPath);
    const durationMs = Date.now() - startedAtMs;
    logger.info("post_build_exited", {
      cardId,
      pid,
      exit_code: code,
      signal: signal ?? null,
      log_bytes: sizeBytes,
      duration_ms: durationMs,
    });

    void (async () => {
      try {
        const { mergerCompleteAfterPostBuild, postBuildFailed } = await import(
          "./transitions.js"
        );

        if (code === 0) {
          // Success path: record the attempt + transition to done.
          await appendPostBuildAttempt(cardId, {
            ts: new Date().toISOString(),
            duration_ms: durationMs,
            classification: "success",
            reason_excerpt: "",
          });
          await mergerCompleteAfterPostBuild(
            cardId,
            mergedSha,
            renderSuccessNote(cmd, tail, sizeBytes),
          );
          return;
        }

        // Failure path: classify, record, decide retry vs. stuck.
        const classification = classifyPostBuildFailure(tail);
        const excerpt = classificationExcerpt(tail, classification);
        await appendPostBuildAttempt(cardId, {
          ts: new Date().toISOString(),
          duration_ms: durationMs,
          classification,
          reason_excerpt: excerpt,
        });

        // Re-read the card so we count THIS attempt in the streak (it was
        // just appended) when deciding whether more retries are allowed.
        const { card: latest } = readCard(cardId);
        const transientStreak = consecutiveTransientCount(latest);

        if (
          classification === "transient" &&
          transientStreak < MAX_AUTO_RETRIES
        ) {
          // Schedule a delayed auto-retry. The card stays in `merging` so
          // the UI shows "retrying" — a separate history event flags the
          // backoff so the user can see what we're doing.
          const delayIdx = Math.min(
            Math.max(transientStreak - 1, 0),
            RETRY_DELAYS_MS.length - 1,
          );
          // Non-null assertion: clamped index is within range by construction.
          const delayMs = RETRY_DELAYS_MS[delayIdx]!;
          logger.info("post_build_auto_retry_scheduled", {
            cardId,
            attempt: transientStreak,
            delayMs,
          });
          await recordAutoRetryScheduled(cardId, transientStreak, delayMs, excerpt);
          const handle = setTimeout(() => {
            pendingRetries.delete(cardId);
            // Re-read the card to make sure it didn't move out of merging
            // (e.g. user manually force-done'd it during the wait).
            try {
              const { card: now } = readCard(cardId);
              if (now.frontmatter.status !== "merging") {
                logger.info("post_build_auto_retry_skipped", {
                  cardId,
                  status: now.frontmatter.status,
                });
                return;
              }
              const cfg = getConfig();
              const cmdNow =
                typeof cfg.merger_post_build_command === "string"
                  ? cfg.merger_post_build_command.trim()
                  : "";
              if (!cmdNow) {
                logger.warn("post_build_auto_retry_no_cmd", { cardId });
                return;
              }
              runPostBuildAsync(cardId, mergedSha, cmdNow);
            } catch (err) {
              logger.error("post_build_auto_retry_failed", {
                cardId,
                err: String(err),
              });
            }
          }, delayMs);
          // Don't keep the event loop alive just for this retry.
          handle.unref?.();
          pendingRetries.set(cardId, handle);
          return;
        }

        // Either persistent / unknown, or transient streak exhausted.
        const stuckReason =
          classification === "transient"
            ? `Post-build failed ${transientStreak}× in a row (transient).`
            : `Post-build failed (${classification}).`;
        await postBuildFailed(
          cardId,
          code,
          signal,
          `${stuckReason}\n\n${tail}`,
        );
      } catch (err) {
        logger.error("post_build_transition_failed", {
          cardId,
          pid,
          exit_code: code,
          err: String(err),
        });
      }
    })();
  });
}

/**
 * SIGTERM the active post-build for a card, if any. Returns true if a
 * process was actually signalled. The exit handler (above) takes over
 * from there: it'll classify the killed run and record an attempt.
 */
export function stopActivePostBuild(cardId: string): boolean {
  const pid = activePostBuilds.get(cardId);
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
    logger.info("post_build_sigterm_sent", { cardId, pid });
    return true;
  } catch (err) {
    logger.warn("post_build_sigterm_failed", { cardId, pid, err: String(err) });
    // Best-effort: unlock anyway so the workers row doesn't pin the cap.
    activePostBuilds.delete(cardId);
    unlockCardForPostBuild(pid);
    return false;
  }
}

// ─── Helpers (small, internal) ───────────────────────────────────────────────

/**
 * Append a single history entry recording the auto-retry decision so the
 * timeline shows the wait between attempts. Reuses `appendComment` rather
 * than open-coding the SSE plumbing.
 */
async function recordAutoRetryScheduled(
  cardId: string,
  attempt: number,
  delayMs: number,
  excerpt: string,
): Promise<void> {
  try {
    const { appendComment } = await import("./transitions.js");
    const seconds = Math.round(delayMs / 1000);
    await appendComment(cardId, {
      author: "system",
      kind: "system_event",
      body: `post-build attempt ${attempt} failed (transient: ${
        excerpt || "no excerpt"
      }); auto-retry in ${seconds}s`,
    });
  } catch (err) {
    logger.warn("post_build_auto_retry_history_failed", {
      cardId,
      err: String(err),
    });
  }
}

function renderSuccessNote(cmd: string, tail: string, sizeBytes: number): string {
  const head = `Post-build command succeeded.\n\n\`${cmd}\``;
  if (!tail.trim()) return `${head}\n\n_(no output, ${sizeBytes} bytes logged)_`;
  return `${head}\n\n\`\`\`\n${tail.trim()}\n\`\`\``;
}

async function emergencyStuck(
  cardId: string,
  mergedSha: string,
  reason: string,
): Promise<void> {
  try {
    const { postBuildFailed } = await import("./transitions.js");
    await postBuildFailed(
      cardId,
      null,
      null,
      `Could not start post-build for sha ${mergedSha.slice(0, 12)}: ${reason}`,
    );
  } catch (err) {
    logger.error("post_build_emergency_stuck_failed", {
      cardId,
      err: String(err),
    });
  }
}
