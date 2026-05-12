/**
 * Worker exit decision-making. The dispatcher inspects the worktree's git
 * state and the transcript to decide what happens to the card next.
 *
 * Markers are the source of truth — exit codes are ignored:
 *
 *   - STUCK marker present (worker only, also triggers wip-commit + push)
 *                                    → /stuck (blocking) with the marker body
 *   - commits ahead of origin/main   → push + /review (state-machine.md T6)
 *   - neither marker nor commits     → /stuck (worker_failed)
 *                                      "no verdict / process exited unexpectedly"
 *
 * Workers never call the server themselves, so this function is the ONLY
 * place card transitions are made on a worker's behalf.
 */
import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";
import type { ServerApi } from "./api.js";
import type { DispatcherConfig } from "./config.js";
import type { Logger } from "./logger.js";
import {
  refreshLiveTokensFromTranscript,
  type SpawnedWorker,
  type WorkerRole,
} from "./spawn.js";
import {
  commitsAheadOfMain,
  hasUncommittedChanges,
  pushBranch,
  remoteCommitsAheadOfMain,
  wipCommit,
} from "./git.js";
import {
  extractNotesSection,
  extractStuckMarker,
  lastAssistantText,
} from "./transcript.js";
import { readHelperEnvironment } from "./context.js";
import { runCommandHook } from "./util/hooks.js";

const execFileP = promisify(execFile);

/**
 * Best-effort `git` invocation against a fixed cwd. Used by the merger
 * post-exit cleanup path; we don't surface failures because the cleanup
 * is itself a recovery step — if it fails too, all we can do is log and
 * move on to the card-state transition.
 */
async function runGitBestEffort(
  cwd: string,
  args: string[],
  logger: Logger,
  cardId: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    logger.log({
      event: "merger_cleanup_git_failed",
      card_id: cardId,
      args,
      message: (e.stderr || e.message || String(err)).trim(),
    });
    return {
      ok: false,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

/**
 * After a merger exits with STUCK or FAILED, local main may carry an
 * un-pushed merge commit (the merger formed the merge but didn't push
 * before bailing out) or a partially-resolved merge. Reset local main
 * to origin/main so the next attempt — whether a Claude merger respawn
 * or a server-side ff-merge pre-attempt — starts from a clean state.
 *
 * Idempotent and best-effort; never throws.
 */
async function resetLocalMainAfterMergerExit(
  worker: SpawnedWorker,
  logger: Logger,
): Promise<void> {
  if (worker.role !== "merger") return;
  const cwd = worker.worktreePath; // = cfg.boardRoot for mergers

  // 1. If a merge is mid-flight (no commit formed yet), abort it. No-op
  //    when there's no merge in progress; the helper logs and ignores.
  await runGitBestEffort(cwd, ["merge", "--abort"], logger, worker.cardId);

  // 2. Hard-reset if local main has un-pushed commits ahead of origin/main.
  const aheadRes = await runGitBestEffort(
    cwd,
    ["rev-list", "--count", "origin/main..HEAD"],
    logger,
    worker.cardId,
  );
  const ahead = Number(aheadRes.stdout.trim()) || 0;
  if (ahead > 0) {
    const reset = await runGitBestEffort(
      cwd,
      ["reset", "--hard", "origin/main"],
      logger,
      worker.cardId,
    );
    if (reset.ok) {
      logger.log({
        event: "merger_cleanup_reset",
        card_id: worker.cardId,
        commits_dropped: ahead,
      });
    }
  }
}

/**
 * Map a helper role to the Comment.author value the server stores. There
 * is no `"merger"` author in the schema — merger notes/stucks are
 * attributed to `"system"` (with a `[merger] …` prefix on the comment
 * body so the UI thread reads cleanly).
 */
function helperAuthor(role: WorkerRole): "worker" | "reviewer" | "system" {
  if (role === "worker") return "worker";
  if (role === "reviewer") return "reviewer";
  return "system";
}

function withMergerPrefix(role: WorkerRole, body: string): string {
  return role === "merger" ? `[merger] ${body}` : body;
}

function stageForRole(role: WorkerRole): "in_progress" | "ai_review" | "merging" {
  if (role === "worker") return "in_progress";
  if (role === "reviewer") return "ai_review";
  return "merging";
}

function elapsedSecondsSince(iso: string): number {
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((Date.now() - started) / 1000));
}

async function reportFinalHeartbeat(
  worker: SpawnedWorker,
  deps: ExitHandlerDeps,
): Promise<void> {
  refreshLiveTokensFromTranscript(worker.transcriptPath, worker.liveTokens);
  // `tokens_used` is the card tile's context-window meter, so it must stay
  // input/cache only. Per-role input/output totals are sent separately.
  const contextTokens = worker.liveTokens.context;
  try {
    await deps.api.reportHeartbeat(
      worker.cardId,
      worker.pid,
      contextTokens,
      elapsedSecondsSince(worker.startedAt),
      worker.role,
      worker.liveTokens.input,
      worker.liveTokens.output,
      basename(worker.transcriptPath),
    );
    deps.logger.log({
      event: "final_heartbeat_reported",
      card_id: worker.cardId,
      pid: worker.pid,
      role: worker.role,
      tokens_used: contextTokens,
    });
  } catch (err) {
    deps.logger.log({
      event: "final_heartbeat_failed",
      card_id: worker.cardId,
      pid: worker.pid,
      role: worker.role,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * If the helper's final assistant message contains a `## Notes` section,
 * post it as a `note` comment. Status-neutral — the caller still routes
 * the main verdict afterwards.
 */
async function maybePostNote(
  worker: SpawnedWorker,
  deps: ExitHandlerDeps,
): Promise<void> {
  const notes = extractNotesSection(worker.transcriptPath);
  if (!notes) return;
  try {
    await deps.api.appendNote(
      worker.cardId,
      helperAuthor(worker.role),
      withMergerPrefix(worker.role, notes),
    );
    deps.logger.log({
      event: "helper_note_posted",
      card_id: worker.cardId,
      pid: worker.pid,
      role: worker.role,
      length: notes.length,
    });
  } catch (err) {
    deps.logger.log({
      event: "helper_note_failed",
      card_id: worker.cardId,
      pid: worker.pid,
      role: worker.role,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * If the helper's final assistant message has an explicit STUCK marker,
 * route the card to /stuck (reason="blocking") and return true so the
 * caller skips its default routing.
 *
 * Worker role: also preserves in-flight changes by wrapping a `wip:` commit
 * around any uncommitted edits and force-pushing the branch. Without this,
 * a worker that explores in the worktree and then hits STUCK would lose
 * that work next time the worktree is recreated. Push + commit failures
 * are logged but the card still transitions to stuck — the human needs to
 * know about the question even if we couldn't preserve the WIP.
 *
 * Reviewer / merger: no commit/push step (they don't author code on
 * worker branches). Their STUCK marker is purely an escalation channel.
 */
async function maybeRouteStuck(
  worker: SpawnedWorker,
  deps: ExitHandlerDeps,
): Promise<boolean> {
  const marker = extractStuckMarker(worker.transcriptPath);
  if (!marker) return false;
  const author = helperAuthor(worker.role);
  const commentBody = withMergerPrefix(
    worker.role,
    marker.body || marker.reason,
  );
  const question = marker.reason.split("\n", 1)[0]?.slice(0, 200) || marker.reason;

  // Worker only: snapshot any uncommitted edits as a `wip:` commit so the
  // partial work survives a worktree rebuild on respawn. We do this even
  // when the worker's last commit subject already reads "wip: …" — staging
  // a trailing wip frame is cheap and keeps the diff narrative coherent.
  if (worker.role === "worker") {
    try {
      if (await hasUncommittedChanges(worker.worktreePath)) {
        const sha = await wipCommit(worker.worktreePath, marker.reason);
        deps.logger.log({
          event: "stuck_wip_commit",
          card_id: worker.cardId,
          pid: worker.pid,
          sha,
          reason: marker.reason.slice(0, 200),
        });
      }
    } catch (err) {
      deps.logger.log({
        event: "stuck_wip_commit_failed",
        card_id: worker.cardId,
        pid: worker.pid,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Push the branch so any prior commits + the wip frame are preserved
    // remotely. Use --force-with-lease (pushBranch already does) — workers
    // may have rebased mid-attempt. Best-effort: push failure should NOT
    // block the stuck transition; the human can recover from the local
    // worktree if needed.
    try {
      const ahead = await commitsAheadOfMain(worker.worktreePath, deps.baseBranch);
      if (ahead > 0) {
        await pushBranch(worker.worktreePath, worker.wipBranch);
        deps.logger.log({
          event: "stuck_branch_pushed",
          card_id: worker.cardId,
          pid: worker.pid,
          branch: worker.wipBranch,
          commits: ahead,
        });
      }
    } catch (err) {
      deps.logger.log({
        event: "stuck_branch_push_failed",
        card_id: worker.cardId,
        pid: worker.pid,
        branch: worker.wipBranch,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Merger only: STUCK escalations sometimes come AFTER the merger formed
  // a merge commit but couldn't push (e.g. tests failed). Reset local
  // main to origin/main so the next attempt — whether a Claude merger
  // respawn or the server's ff-merge pre-attempt on the next round —
  // starts from a clean tree. Best-effort.
  if (worker.role === "merger") {
    await resetLocalMainAfterMergerExit(worker, deps.logger);
  }

  try {
    await deps.api.reportStuck(
      worker.cardId,
      "blocking",
      commentBody,
      question,
      author,
    );
    deps.logger.log({
      event: "helper_stuck_marker",
      card_id: worker.cardId,
      pid: worker.pid,
      role: worker.role,
      reason: marker.reason.slice(0, 200),
    });
  } catch (err) {
    deps.logger.log({
      event: "helper_stuck_marker_failed",
      card_id: worker.cardId,
      pid: worker.pid,
      role: worker.role,
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

export interface ExitHandlerDeps {
  api: ServerApi;
  logger: Logger;
  active: Map<string, SpawnedWorker>;
  baseBranch?: string | null;
  cfg: DispatcherConfig;
}

export function attachExitHandler(worker: SpawnedWorker, deps: ExitHandlerDeps): void {
  const { api, logger, active } = deps;
  worker.child.on("exit", async (code, signal) => {
    // Transcript is now written directly by the child via inherited fd —
    // we don't own a writestream to close here. The child closes its own
    // dup of the fd on exit.

    // Stamp the exit-handler start time so StatsReporter can detect a
    // routeExit() that has hung (HTTP timeout / git hang / etc.) and
    // fall back to forcibly marking the card stuck instead of leaving it
    // in_progress forever.
    worker.exitStartedAt = Date.now();

    // NOTE: do NOT remove from `active` yet. The stats reporter checks
    // `active.has(cardId)` to decide whether a dead pid is "ours, still
    // being routed" vs "true orphan." If we delete here, the next stats
    // tick (every 5s, but can land seconds after exit) sees the pid is
    // dead, the workers row hasn't been removed yet (reportExit hasn't
    // run), and reports it as worker_failed → card gets marked stuck even
    // on a clean exit. Keep the entry until reportExit completes.

    logger.log({
      event: "worker_exited",
      card_id: worker.cardId,
      pid: worker.pid,
      attempt: worker.attempt,
      exit_code: code,
      signal: signal ?? null,
    });

    await reportFinalHeartbeat(worker, deps);

    try {
      await routeExit(worker, code, signal, deps);
    } catch (err) {
      logger.log({
        event: "exit_route_failed",
        card_id: worker.cardId,
        pid: worker.pid,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    await runCommandHook({
      cfg: deps.cfg,
      stage: stageForRole(worker.role),
      phase: "post",
      cwd: worker.hookCwd,
      env: {
        ...process.env,
        ...readHelperEnvironment(deps.cfg),
        BOARD_ROOT: deps.cfg.boardRoot,
        BOARD_SERVER_URL: deps.cfg.serverUrl,
        BOARD_DATA: deps.cfg.boardData,
        BOARD_WORKTREES: deps.cfg.worktreesDir,
        CARD_ID: worker.cardId,
        ATTEMPT: String(worker.attempt),
        WIP_BRANCH: worker.wipBranch,
        HELPER_PID: String(worker.pid),
        EXIT_CODE: code == null ? "" : String(code),
        EXIT_SIGNAL: signal ?? "",
      },
      cardId: worker.cardId,
      attempt: worker.attempt,
      wipBranch: worker.wipBranch,
      log: (event) => logger.log(event),
    });

    // Bookkeeping: tell the server the worker exited so workers row gets
    // dropped. Server's /exit no longer drives state transitions (we do).
    try {
      await api.reportExit(worker.cardId, worker.pid, code, signal);
    } catch (err) {
      logger.log({
        event: "report_exit_failed",
        card_id: worker.cardId,
        pid: worker.pid,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    // Now safe to drop from `active` — the workers row has been removed
    // and the stats reporter wouldn't see this pid anymore anyway.
    active.delete(worker.cardId);
  });

  worker.child.on("error", (err) => {
    logger.log({
      event: "child_error",
      card_id: worker.cardId,
      pid: worker.pid,
      message: err.message,
    });
  });
}

async function routeExit(
  worker: SpawnedWorker,
  code: number | null,
  signal: NodeJS.Signals | null,
  deps: ExitHandlerDeps,
): Promise<void> {
  const { api, logger } = deps;

  // Notes section is informational and orthogonal to the main verdict —
  // post it FIRST so it lands on the card regardless of how routing goes.
  await maybePostNote(worker, deps);

  // Explicit `STUCK:` (or `VERDICT: STUCK` for reviewer) marker — overrides
  // every role's default routing and escalates to human.
  if (await maybeRouteStuck(worker, deps)) return;

  // ── Merger routing ───────────────────────────────────────────────────────
  // Merger emits "MERGED: <sha>" on success or "FAILED: <reason>" on failure.
  if (worker.role === "merger") {
    const text = lastAssistantText(worker.transcriptPath) ?? "";
    const mOk = /MERGED:\s*([a-f0-9]{7,40})/i.exec(text);
    const mFail = /FAILED:\s*(.+)/i.exec(text);
    if (mOk?.[1]) {
      try {
        await api.mergerComplete(worker.cardId, mOk[1]);
        logger.log({
          event: "merger_complete",
          card_id: worker.cardId,
          pid: worker.pid,
          merged_sha: mOk[1],
        });
      } catch (err) {
        logger.log({
          event: "merger_complete_failed",
          card_id: worker.cardId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    const reason = mFail?.[1]?.trim() || `merger exited without a verdict (code=${code ?? "null"})`;
    // Same cleanup as the STUCK path: a FAILED merger may have left local
    // main with an un-pushed merge commit or a partially-resolved merge.
    // Reset to origin/main before the server transitions the card back to
    // in_progress — the next worker shouldn't inherit dirty state.
    await resetLocalMainAfterMergerExit(worker, logger);
    try {
      await api.mergerFailed(worker.cardId, reason);
      logger.log({ event: "merger_failed", card_id: worker.cardId, pid: worker.pid, reason });
    } catch (err) {
      logger.log({
        event: "merger_failed_post_error",
        card_id: worker.cardId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ── Reviewer routing ─────────────────────────────────────────────────────
  // Reviewers don't push code; they emit a verdict in their last assistant
  // message. We parse "VERDICT: PASS" / "VERDICT: REJECT" and route.
  if (worker.role === "reviewer") {
    const verdictText = lastAssistantText(worker.transcriptPath) ?? "";
    const m = /VERDICT:\s*(PASS|REJECT)/i.exec(verdictText);
    const verdict = m?.[1]?.toUpperCase();

    if (verdict === "PASS") {
      try {
        await api.reviewerPass(worker.cardId);
        logger.log({ event: "reviewer_pass", card_id: worker.cardId, pid: worker.pid });
      } catch (err) {
        logger.log({
          event: "reviewer_pass_failed",
          card_id: worker.cardId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    if (verdict === "REJECT") {
      try {
        await api.reviewerReject(worker.cardId, verdictText);
        logger.log({ event: "reviewer_reject", card_id: worker.cardId, pid: worker.pid });
      } catch (err) {
        logger.log({
          event: "reviewer_reject_failed",
          card_id: worker.cardId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    // No clear verdict — treat as a soft reject so a human can decide.
    logger.log({
      event: "reviewer_no_verdict",
      card_id: worker.cardId,
      pid: worker.pid,
      exit_code: code,
      signal: signal ?? null,
    });
    try {
      await api.reviewerReject(
        worker.cardId,
        `Reviewer exited without a clear VERDICT: line. Last message:\n\n${
          verdictText || "(empty)"
        }`,
      );
    } catch (err) {
      logger.log({
        event: "reviewer_reject_failed",
        card_id: worker.cardId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  // ── Worker routing (default) ─────────────────────────────────────────────
  // Marker (STUCK or commit→/review) is the source of truth — exit code is
  // ignored. Codes 10/20/30 used to carry meaning ("worker stuck", "self-
  // failure", "claim conflict") but the move to dispatcher-driven routing
  // made them redundant: a clean process exit + presence of commits is a
  // perfectly valid completion regardless of the integer. The only thing
  // we still surface is `signal` for crash diagnostics in the no-verdict
  // fallback below.
  const ahead = await commitsAheadOfMain(worker.worktreePath, deps.baseBranch);

  // Happy path: commits exist → push the branch and request review.
  // Whether the worker exited 0, 137, or signaled — if it left commits,
  // they're worth pushing. We trust the diff over the integer.
  if (ahead > 0) {
    try {
      await pushBranch(worker.worktreePath, worker.wipBranch);
      logger.log({
        event: "branch_pushed",
        card_id: worker.cardId,
        branch: worker.wipBranch,
        commits: ahead,
      });
      await api.reportReview(worker.cardId, worker.wipBranch);
      return;
    } catch (err) {
      logger.log({
        event: "push_or_review_failed",
        card_id: worker.cardId,
        branch: worker.wipBranch,
        message: err instanceof Error ? err.message : String(err),
      });
      await api.reportStuck(
        worker.cardId,
        "worker_failed",
        `Worker had ${ahead} commit(s) but push/review failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
  }

  const remoteAhead = await remoteCommitsAheadOfMain(
    worker.worktreePath,
    worker.wipBranch,
    deps.baseBranch,
  );
  if (remoteAhead > 0) {
    try {
      logger.log({
        event: "review_requested_existing_branch",
        card_id: worker.cardId,
        branch: worker.wipBranch,
        commits: remoteAhead,
      });
      await api.reportReview(worker.cardId, worker.wipBranch);
      return;
    } catch (err) {
      logger.log({
        event: "review_existing_branch_failed",
        card_id: worker.cardId,
        branch: worker.wipBranch,
        message: err instanceof Error ? err.message : String(err),
      });
      await api.reportStuck(
        worker.cardId,
        "worker_failed",
        `Worker made no new commits, but origin/${worker.wipBranch} has ${remoteAhead} existing commit(s); review request failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
  }

  try {
    logger.log({
      event: "no_diff_complete_requested",
      card_id: worker.cardId,
      branch: worker.wipBranch,
    });
    await api.noDiffComplete(worker.cardId, worker.wipBranch);
    return;
  } catch (err) {
    logger.log({
      event: "no_diff_complete_failed",
      card_id: worker.cardId,
      branch: worker.wipBranch,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // No local commits, no existing remote worker commits, no STUCK marker, and
  // no successful completion/review — this is the "no verdict / process exited
  // unexpectedly" bucket. Surface it as blocking so a human can decide whether
  // to retry or split the card. The last assistant message (if any) is included
  // for context. The exit code/signal are appended on a trailing line — purely
  // informational, not a routing input.
  const lastMessage = lastAssistantText(worker.transcriptPath);
  const exitDetail = signal
    ? `signal=${signal}`
    : `code=${code ?? "null"}`;
  const body = lastMessage
    ? `${lastMessage}\n\n_(no verdict / process exited unexpectedly — ${exitDetail})_`
    : `No verdict / process exited unexpectedly (${exitDetail}). Worker left no assistant text and no commits.`;
  const question =
    lastMessage?.split(/\r?\n/, 1)[0]?.slice(0, 200) ||
    "no verdict / process exited unexpectedly";
  await api.reportStuck(
    worker.cardId,
    "worker_failed",
    body,
    question,
  );
}
