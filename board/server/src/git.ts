/**
 * Thin wrapper around git CLI. We shell out (no shell, arg-array form) for
 * predictable behavior. Server is the sole writer to main.
 *
 * `cwd` is BOARD_ROOT for main-branch operations; the per-card worktree is
 * `BOARD_WORKTREES/card-<id>`. Worker pushes have already happened by the
 * time we merge — we only need fetch + ff merge + branch delete.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "@questboard/core";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { getConfig } from "./config.js";

const execFileP = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

/**
 * Idempotent / best-effort failure modes that callers wrap in
 * try/catch on purpose (cleanup paths after a card is done, branch
 * delete after the remote already removed it, worktree prune of an
 * already-pruned dir). Logging these at WARN spams the JSONL log with
 * non-actionable noise; we drop them to DEBUG so they're still
 * traceable when needed but invisible by default.
 */
const KNOWN_IDEMPOTENT_FAILURES: RegExp[] = [
  /branch '[^']+' not found/i,                         // branch -D <missing>
  /not a working tree/i,                                // worktree remove of non-WT
  /is not a working tree/i,
  /'.*' is not a working tree/i,
  /No such file or directory/i,                         // worktree path missing
  /not found in worktree list/i,
];

export async function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const msg = e.stderr || e.stdout || e.message || String(err);
    const trimmed = msg.trim();
    const isIdempotent = KNOWN_IDEMPOTENT_FAILURES.some((re) => re.test(trimmed));
    if (isIdempotent) {
      logger.debug("git_command_failed_idempotent", { cwd, args, msg: trimmed });
    } else {
      logger.warn("git_command_failed", { cwd, args, msg });
    }
    throw Object.assign(new Error(`git ${args.join(" ")}: ${trimmed}`), {
      code: "git_failed",
      stdout: e.stdout,
      stderr: e.stderr,
    });
  }
}

export const gitMain = (args: string[], timeoutMs?: number) => runGit(env.BOARD_ROOT, args, timeoutMs);

function safeRelativeTemplate(template: string, values: Record<string, string>): string {
  const rendered = renderTemplate(template, values).replace(/\\/g, "/");
  const parts = rendered.split("/");
  if (
    rendered.trim() === "" ||
    rendered.startsWith("/") ||
    parts.some((part) => part === "..")
  ) {
    throw new Error(`template rendered outside worktree root: ${rendered}`);
  }
  return rendered;
}

export function worktreePathFor(cardId: string): string {
  return join(
    env.BOARD_WORKTREES,
    safeRelativeTemplate(getConfig().git.worktree_template, { card_id: cardId }),
  );
}

export function workerBranchFor(cardId: string): string {
  return renderTemplate(getConfig().git.worker_branch_template, { card_id: cardId });
}

async function configuredBaseBranch(): Promise<string> {
  try {
    return (await import("./config.js")).getConfig().git.base_branch;
  } catch {
    return env.BOARD_BASE_BRANCH ?? "main";
  }
}

/** `git fetch origin <branch>` (or all). */
export async function fetchOrigin(branch?: string): Promise<void> {
  const args = ["fetch", "origin"];
  if (branch) args.push(branch);
  await gitMain(args);
}

/**
 * Attempt fast-forward merge of origin/<workerBranch> into the current HEAD
 * of BOARD_ROOT (assumed to be the main branch). Returns the new HEAD sha.
 *
 * If the merge cannot fast-forward, throws { code: "ff_failed" }.
 */
export async function ffMergeWorkerBranch(cardId: string): Promise<string> {
  const branch = workerBranchFor(cardId);
  await fetchOrigin(branch);
  try {
    await gitMain(["merge", "--ff-only", `origin/${branch}`]);
  } catch (err) {
    const e = err as { stderr?: string };
    if (/Not possible to fast-forward|not possible to fast-forward|fast-forward/i.test(e.stderr ?? "")) {
      throw Object.assign(new Error("ff merge failed"), { code: "ff_failed" });
    }
    throw err;
  }
  // Push to origin/main (best effort; if origin push fails we still keep local main).
  try {
    await gitMain(["push", "origin", "HEAD"]);
  } catch (err) {
    logger.warn("git_push_main_failed", { cardId, err: String(err) });
  }
  // Delete the remote worker branch — best effort.
  try {
    await gitMain(["push", "origin", "--delete", branch]);
  } catch (err) {
    logger.warn("git_delete_remote_branch_failed", { cardId, err: String(err) });
  }
  const { stdout } = await gitMain(["rev-parse", "HEAD"]);
  return stdout.trim();
}

/** Remove the worktree dir + local branch. Idempotent / best-effort. */
export async function cleanupWorktree(cardId: string): Promise<void> {
  const path = worktreePathFor(cardId);
  if (existsSync(path)) {
    try {
      await gitMain(["worktree", "remove", "--force", path]);
    } catch (err) {
      logger.warn("worktree_remove_failed", { cardId, err: String(err) });
    }
  }
  // Even if the worktree command fails, try pruning + branch delete.
  try {
    await gitMain(["worktree", "prune"]);
  } catch {
    /* ignore */
  }
  try {
    await gitMain(["branch", "-D", workerBranchFor(cardId)]);
  } catch {
    /* branch may not exist — ignore */
  }
}

/**
 * Raw `git diff` text against origin/main for a card.
 *
 * Sources, in priority order:
 *   1. Worktree (if it exists) — `git diff origin/main` inside the
 *      per-card worktree. Captures committed + working-tree + staged
 *      changes, so in-progress cards (no commits yet, just live edits)
 *      actually show something.
 *   2. Remote worker branch — `git diff origin/main...origin/<branch>`.
 *   3. Local worker branch — fallback when remote isn't reachable.
 */
export async function diffMainTo(cardId: string): Promise<string> {
  const branch = workerBranchFor(cardId);
  const worktree = worktreePathFor(cardId);

  // Done cards: post-ff-merge worktree HEAD == origin/main HEAD, so the
  // merge-base diff is empty. Use pre_merge_sha (snapshot at
  // approveToMerging) as the anchor: <pre_merge_sha>..<merged_sha> is
  // exactly the commits the merger added.
  try {
    const { getCardRow } = await import("./db.js");
    const row = getCardRow(cardId);
    if (row?.status === "done" && row.merged_sha) {
      const { card: full } = (await import("./files.js")).readCard(cardId);
      const preMergeSha = full.frontmatter.pre_merge_sha;
      if (preMergeSha) {
        try {
          const { stdout } = await gitMain([
            "diff",
            `${preMergeSha}..${row.merged_sha}`,
          ]);
          return stdout;
        } catch (err) {
          logger.warn("done_diff_failed", { cardId, err: String(err) });
        }
      }
      // Fallback for done cards without pre_merge_sha (older cards).
      try {
        const { stdout } = await gitMain([
          "show",
          "--no-color",
          row.merged_sha,
        ]);
        return stdout;
      } catch {
        /* fall through */
      }
    }
  } catch {
    /* fall through to live-worktree path */
  }

  if (existsSync(worktree)) {
    try {
      // Diff against the MERGE-BASE of origin/main and HEAD, not against
      // origin/main directly. If origin/main has moved forward since the
      // worker branched off, `git diff origin/main` reports main's new
      // commits as if the worktree had reverted them — bogus diff full of
      // unrelated files. The merge-base anchors at the worker's actual
      // branch point, so the diff shows only the worker's own commits +
      // uncommitted edits.
      const preferred = await configuredBaseBranch();
      let baseRef = `origin/${preferred}`;
      try {
        await runGit(worktree, ["rev-parse", "--verify", "--quiet", baseRef]);
      } catch {
        baseRef = preferred;
      }
      const base = (
        await runGit(worktree, ["merge-base", baseRef, "HEAD"])
      ).stdout.trim();
      if (base) {
        const { stdout } = await runGit(worktree, ["diff", base]);
        return stdout;
      }
    } catch (err) {
      logger.warn("worktree_diff_failed", { cardId, err: String(err) });
    }
  }
  try {
    await fetchOrigin(branch);
  } catch {
    /* offline or branch missing remotely — fall through to local */
  }
  const preferred = await configuredBaseBranch();
  let baseRef = `origin/${preferred}`;
  try {
    await gitMain(["rev-parse", "--verify", "--quiet", baseRef]);
  } catch {
    baseRef = preferred;
  }
  for (const ref of [`origin/${branch}`, branch]) {
    try {
      const { stdout } = await gitMain(["diff", `${baseRef}...${ref}`]);
      return stdout;
    } catch {
      /* try next */
    }
  }
  return "";
}
