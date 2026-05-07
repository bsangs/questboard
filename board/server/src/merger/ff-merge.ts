/**
 * Server-side fast-forward merge pre-attempt for cards in `merging`.
 *
 * Most worker branches ARE rebased before they enter merging — so a plain
 * `git merge --ff-only` succeeds and we don't need to spend tokens spinning
 * up a Claude merger to babysit it. This module is the fast path: try the
 * ff merge directly, run install (only if the lockfile changed) + the
 * project's typecheck/build/test gates, and on success push + transition
 * the card to done by reusing `mergerComplete()` (which itself fires the
 * existing post-build hook when configured).
 *
 * On any failure before push we hard-reset main back to origin/main and
 * return `fallback_to_merger: true` so the caller (dispatcher) knows to
 * spawn the regular Claude merger to handle the conflict / failed gate.
 *
 * Mergers are STRICTLY SERIAL globally (see queue.isAnyMergerActive). This
 * module also takes its own in-process mutex so two concurrent dispatcher
 * polls landing here at once don't both `git checkout main` and race on
 * the merge.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  isAbsolute,
  join,
  relative as relPath,
  resolve as resolvePath,
} from "node:path";
import { env } from "../env.js";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import {
  fetchOrigin,
  gitMain,
  workerBranchFor,
} from "../git.js";
import { mergerComplete } from "../transitions.js";
import {
  discoverCommands,
  type DiscoveredCommands,
} from "../util/command-discovery.js";
import { runInstall } from "../util/install.js";

export type TryFfMergeResult =
  | { ok: true; merged_sha: string; status: string; ran: string[] }
  | { ok: false; reason: string; fallback_to_merger: boolean; ran: string[] };

/**
 * In-process mutex so concurrent calls (dispatcher poll race) serialize.
 * The dispatcher's `isAnyMergerActive` already gates on the SQL workers
 * table, but ff-merge doesn't insert a workers row — this is the only
 * thing standing between two polls and a `git checkout main` race.
 */
let inflight: Promise<TryFfMergeResult> | null = null;

/**
 * Public entrypoint. Idempotent w.r.t. concurrent callers — returns the
 * same in-flight promise if one is already running.
 */
export function tryFfMerge(cardId: string): Promise<TryFfMergeResult> {
  if (inflight) return inflight;
  inflight = doFfMerge(cardId).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doFfMerge(cardId: string): Promise<TryFfMergeResult> {
  const branch = workerBranchFor(cardId);
  const cmdCwd = resolveCmdCwd();
  const ran: string[] = [];

  // 1. Refresh state from origin.
  try {
    await fetchOrigin();
    ran.push("fetch");
  } catch (err) {
    logger.warn("ff_merge_fetch_failed", { cardId, err: msg(err) });
    return {
      ok: false,
      reason: `git fetch failed: ${msg(err)}`,
      fallback_to_merger: true,
      ran,
    };
  }

  // 2. Make sure local main is on origin/main. We do checkout + ff-pull so
  // a stale local main doesn't sabotage a real fast-forward attempt.
  try {
    await gitMain(["checkout", "main"]);
    await gitMain(["pull", "--ff-only", "origin", "main"]);
    ran.push("checkout-main");
  } catch (err) {
    logger.warn("ff_merge_checkout_failed", { cardId, err: msg(err) });
    return {
      ok: false,
      reason: `local main pre-merge failed: ${msg(err)}`,
      fallback_to_merger: true,
      ran,
    };
  }

  // 3. Snapshot lockfile hashes so we can decide whether install is needed
  //    AFTER the ff merge — only the post-merge state matters for change
  //    detection, but we capture the pre-state once so the comparison is
  //    cheap.
  const lockfilesBefore = hashLockfiles(cmdCwd);

  // 4. Try ff merge.
  try {
    await gitMain(["merge", "--ff-only", `origin/${branch}`]);
    ran.push("ff-merge");
  } catch (err) {
    // Not a true error from our perspective — just means we have to fall
    // back to the regular merger. Reset just in case the failed merge left
    // anything weird, then report.
    await safeReset();
    return {
      ok: false,
      reason: "fast-forward not possible (history diverged)",
      fallback_to_merger: true,
      ran,
    };
  }

  // 5. Install if a lockfile changed.
  const lockfilesAfter = hashLockfiles(cmdCwd);
  const lockfileChanged = !lockfilesEqual(lockfilesBefore, lockfilesAfter);
  let cmds: DiscoveredCommands;
  try {
    cmds = discoverCommands(cmdCwd);
  } catch (err) {
    logger.warn("ff_merge_discover_failed", { cardId, err: msg(err) });
    await safeReset();
    return {
      ok: false,
      reason: `command discovery failed: ${msg(err)}`,
      fallback_to_merger: true,
      ran,
    };
  }

  if (lockfileChanged) {
    const r = await runInstall({ cwd: cmdCwd, cmd: cmds.install });
    ran.push("install");
    if (!r.ok) {
      logger.warn("ff_merge_install_failed", {
        cardId,
        cmd: cmds.install,
        exit_code: r.exitCode,
        stderr_tail: r.stderr.slice(-400),
      });
      await safeReset();
      return {
        ok: false,
        reason: `install failed (${cmds.install}, exit=${r.exitCode}): ${tail(r.stderr)}`,
        fallback_to_merger: true,
        ran,
      };
    }
  }

  // 6. Build / typecheck / test gates. We always run build; typecheck and
  //    test only run if the discovered command isn't the conventional
  //    fallback name pointing at a non-existent script (a missing script
  //    will still be invoked — it's loud at the package-manager level —
  //    so don't filter aggressively).
  for (const [name, cmd] of [
    ["typecheck", cmds.typecheck],
    ["build", cmds.build],
    ["test", cmds.test],
  ] as const) {
    try {
      await runShell(cmd, cmdCwd, name);
      ran.push(name);
    } catch (err) {
      logger.warn("ff_merge_gate_failed", { cardId, gate: name, err: msg(err) });
      await safeReset();
      return {
        ok: false,
        reason: `${name} failed: ${msg(err)}`,
        fallback_to_merger: true,
        ran,
      };
    }
  }

  // 7. All gates green — push.
  try {
    await gitMain(["push", "origin", "main"]);
    ran.push("push-main");
  } catch (err) {
    logger.warn("ff_merge_push_failed", { cardId, err: msg(err) });
    // Push failed but the local main IS now ahead of origin/main with the
    // ff commits. Reset so a retry / fallback-merger starts from a clean
    // state. We lose the install/build work but the deterministic git
    // state is more valuable than the wasted seconds.
    await safeReset();
    return {
      ok: false,
      reason: `push failed: ${msg(err)}`,
      fallback_to_merger: true,
      ran,
    };
  }

  // 8. Best-effort delete of the worker branch on origin. Failure here is
  //    not fatal — the card is already merged and a leftover branch is
  //    just clutter, not corruption.
  try {
    await gitMain(["push", "origin", "--delete", branch]);
    ran.push("delete-branch");
  } catch (err) {
    logger.warn("ff_merge_delete_branch_failed", { cardId, err: msg(err) });
  }

  // 9. Resolve the merged sha and route through `mergerComplete`. That
  //    function is the same one the dispatcher's exit handler calls today
  //    after a Claude merger reports MERGED — it knows about the post-
  //    build hook and the merging→done transition, so we get all of that
  //    for free.
  let mergedSha = "";
  try {
    const { stdout } = await gitMain(["rev-parse", "HEAD"]);
    mergedSha = stdout.trim();
  } catch (err) {
    logger.error("ff_merge_rev_parse_failed", { cardId, err: msg(err) });
    // We've already pushed; we cannot un-push. The card needs to be
    // transitioned but we don't have the sha. Don't fall back to a merger
    // (it would re-push or fail trying). Return non-ok with
    // fallback_to_merger=false so the caller knows this is terminal but
    // the merge did happen; a human will need to fix the card status.
    return {
      ok: false,
      reason: `rev-parse failed after push: ${msg(err)}`,
      fallback_to_merger: false,
      ran,
    };
  }

  try {
    const card = await mergerComplete(cardId, mergedSha);
    logger.info("ff_merge_complete", {
      cardId,
      merged_sha: mergedSha,
      status: card.frontmatter.status,
      ran,
    });
    return {
      ok: true,
      merged_sha: mergedSha,
      status: card.frontmatter.status,
      ran,
    };
  } catch (err) {
    logger.error("ff_merge_transition_failed", { cardId, err: msg(err) });
    // Same logic as the rev-parse case: the merge is real on origin/main,
    // we just couldn't flip the card. Don't spawn a merger; surface the
    // error and let the user investigate.
    return {
      ok: false,
      reason: `mergerComplete failed: ${msg(err)}`,
      fallback_to_merger: false,
      ran,
    };
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Reset local main to origin/main. Used after any failed step before we
 * push — leaves the working tree clean for either a retry or a Claude
 * merger to take a fresh swing.
 */
async function safeReset(): Promise<void> {
  try {
    await gitMain(["reset", "--hard", "origin/main"]);
  } catch (err) {
    logger.warn("ff_merge_reset_failed", { err: msg(err) });
    // If `merge --abort` wasn't applicable (no merge in progress) it'll
    // just error; ignore. If reset failed AND there's an in-flight merge,
    // try to abort it.
    try {
      await gitMain(["merge", "--abort"]);
    } catch {
      /* ignore */
    }
  }
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function tail(s: string, n = 240): string {
  const t = s.trim();
  return t.length <= n ? t : t.slice(t.length - n);
}

const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
];

function hashLockfiles(cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of LOCKFILES) {
    const p = join(cwd, f);
    if (!existsSync(p)) continue;
    try {
      out.set(f, createHash("sha256").update(readFileSync(p)).digest("hex"));
    } catch {
      /* ignore */
    }
  }
  return out;
}

function lockfilesEqual(
  a: Map<string, string>,
  b: Map<string, string>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Where install / build / typecheck / test commands run. Mirrors the
 * post-build runner: prefers `merger_post_build_cwd` (project-relative,
 * must resolve under BOARD_ROOT), falls back to BOARD_ROOT.
 */
function resolveCmdCwd(): string {
  let raw: string | null | undefined;
  try {
    raw = getConfig().merger_post_build_cwd;
  } catch {
    raw = null;
  }
  if (typeof raw !== "string" || raw.trim() === "") return env.BOARD_ROOT;
  const abs = resolvePath(env.BOARD_ROOT, raw.trim());
  const rel = relPath(env.BOARD_ROOT, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return env.BOARD_ROOT;
  if (!existsSync(abs)) return env.BOARD_ROOT;
  return abs;
}

/**
 * Run a build / typecheck / test command via `bash -lc`. We don't capture
 * full output here (the post-build runner is the place that streams to a
 * card-scoped log file); on failure we rely on the exit code + a stderr
 * tail for the surfaced error message. Successful runs are silent.
 *
 * Hard timeout: 20 minutes per gate. Build is the most likely to drag,
 * but if a gate hasn't terminated in 20 minutes something is wedged and
 * we'd rather kill it than block the merger pipeline indefinitely.
 */
function runShell(
  cmd: string,
  cwd: string,
  label: string,
  timeoutMs = 20 * 60_000,
): Promise<void> {
  return new Promise((resolveP, reject) => {
    const child = spawn("bash", ["-lc", cmd], {
      cwd,
      env: { ...process.env, BOARD_ROOT: env.BOARD_ROOT },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stdout?.on("data", () => {
      /* swallow — gate output is not surfaced anywhere yet */
    });
    child.stderr?.on("data", (d: Buffer) => {
      // Bound the stderr buffer so a chatty failing gate can't blow memory.
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    let killed = false;
    const t = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    t.unref?.();
    child.on("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      if (code === 0) {
        resolveP();
        return;
      }
      const sigPart = signal ? ` signal=${signal}` : "";
      const timedOut = killed ? " (timeout)" : "";
      reject(
        new Error(
          `${label} exited code=${code ?? "null"}${sigPart}${timedOut}: ${tail(
            stderr,
            500,
          )}`,
        ),
      );
    });
  });
}
