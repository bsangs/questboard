/**
 * Git helpers used by the dispatcher to manage per-card worktrees and to
 * inspect a worker's outcome after exit. Workers themselves never run git
 * outside their worktree — the dispatcher owns worktree lifecycle.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}

async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<RunResult> {
  const { stdout, stderr } = await exec("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: String(stdout), stderr: String(stderr) };
}

export interface PrepareWorktreeOpts {
  boardRoot: string;
  worktreesDir: string;
  cardId: string;
  /** Branch name to use, e.g. `worker/card-0042`. */
  branch: string;
  /** Relative directory name under worktreesDir, e.g. `card-0042`. */
  worktreeName: string;
  /** Preferred base branch, e.g. `main` or `develop`. */
  baseBranch?: string | null;
}

async function refExists(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function baseRef(cwd: string, preferredBranch?: string | null): Promise<string> {
  const candidates = preferredBranch
    ? [`origin/${preferredBranch}`, preferredBranch, "origin/main", "main", "master"]
    : ["origin/main", "main", "master"];
  for (const ref of candidates) {
    if (await refExists(cwd, ref)) return ref;
  }
  return "HEAD";
}

async function hasOrigin(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create or reuse the per-card worktree.
 *
 * - Fetches origin/main and origin/<branch> first.
 * - If `worktrees/card-<id>/` already exists AND is registered as a git
 *   worktree on `branch`, reuse it (resumption flow).
 * - Else, ORPHAN-RESUME: if `origin/<branch>` exists with commits ahead of
 *   `origin/main`, base the new worktree on origin/<branch> (preserve the
 *   prior worker's commits). This handles the case where the worktree was
 *   cleaned up but the remote branch still carries the worker's progress —
 *   without this, a new worker would branch fresh from main and silently
 *   redo (or worse, conflict with) the unmerged work.
 * - Else: `git worktree add <path> -b <branch> origin/main` (fresh start).
 *   - If the branch already exists locally, fall back to re-attach mode.
 */
export interface WorktreeHandle {
  worktreePath: string;
  branch: string;
  reused: boolean;
  /**
   * True when the worktree was created from an existing origin/<branch>
   * carrying unmerged worker commits (orphan-resume path). Spawn passes
   * this to the dispatcher so it can record a `system_event` on the
   * card, distinguishing "fresh worker" from "resumed worker" runs.
   */
  resumedFromRemote?: boolean;
  /** Number of commits ahead of origin/main when resumed. 0 otherwise. */
  resumedCommitsAhead?: number;
}

export async function prepareWorktree(opts: PrepareWorktreeOpts): Promise<WorktreeHandle> {
  const { boardRoot, worktreesDir, cardId, branch, worktreeName, baseBranch } = opts;
  const worktreePath = path.join(worktreesDir, worktreeName);

  fs.mkdirSync(worktreesDir, { recursive: true });

  // Best-effort fetch of main AND the worker branch (so the orphan-resume
  // probe below has a fresh ref to compare against). Two separate fetches
  // because `fetch origin <branch>` 404s if the branch doesn't exist
  // remotely, and we don't want one missing branch to skip the main fetch.
  try {
    await git(boardRoot, ["fetch", "origin", baseBranch ?? "main"]);
  } catch {
    // ignore — the user may be offline; worktree add against a stale
    // origin/main still beats failing the spawn outright.
  }
  try {
    await git(boardRoot, ["fetch", "origin", branch]);
  } catch {
    // ignore — the branch may not exist on the remote (fresh card).
  }

  // Check if the worktree is already registered.
  const list = await git(boardRoot, ["worktree", "list", "--porcelain"]);
  const registered = list.stdout.includes(`worktree ${worktreePath}\n`);
  if (registered && fs.existsSync(worktreePath)) {
    return { worktreePath, branch, reused: true };
  }

  // Stale directory but no worktree registration → remove first.
  if (fs.existsSync(worktreePath) && !registered) {
    fs.rmSync(worktreePath, { recursive: true, force: true });
  }

  // Does the branch exist locally?
  let branchExists = false;
  try {
    await git(boardRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    branchExists = true;
  } catch {
    branchExists = false;
  }

  // Orphan-resume probe. Cheap on miss: rev-parse exits non-zero when the
  // remote ref doesn't exist. We only resume when the remote branch is
  // strictly ahead of main — otherwise it's a leftover from a card that
  // shipped (or never produced commits) and should not block a fresh
  // start.
  let resumedFromRemote = false;
  let resumedCommitsAhead = 0;
  if (!branchExists) {
    try {
      await git(boardRoot, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/remotes/origin/${branch}`,
      ]);
      const ahead = await git(boardRoot, [
        "rev-list",
        "--count",
        `${await baseRef(boardRoot, baseBranch)}..origin/${branch}`,
      ]);
      const aheadCount = Number(ahead.stdout.trim()) || 0;
      if (aheadCount > 0) {
        resumedFromRemote = true;
        resumedCommitsAhead = aheadCount;
      }
    } catch {
      // remote branch missing → no resume; fall through to fresh-from-main.
    }
  }

  if (branchExists) {
    await git(boardRoot, ["worktree", "add", worktreePath, branch]);
  } else if (resumedFromRemote) {
    // CRITICAL: pass the existing remote ref as the base, NOT just `-b`
    // alone (which would create a fresh branch from HEAD and lose the
    // worker's commits). With `-b <branch> origin/<branch>` the new
    // local branch tracks the remote's tip, so HEAD~N is the worker's
    // last commit, ready to be appended to.
    await git(boardRoot, [
      "worktree",
      "add",
      worktreePath,
      "-b",
      branch,
      `origin/${branch}`,
    ]);
  } else {
    await git(boardRoot, ["worktree", "add", worktreePath, "-b", branch, await baseRef(boardRoot, baseBranch)]);
  }

  // Hide paths listed in .questboardignore via sparse-checkout (defense-in-
  // depth: workers can't read/edit/commit files that don't exist in their
  // worktree).
  await applyIgnoreSparseCheckout(boardRoot, worktreePath);

  return {
    worktreePath,
    branch,
    reused: false,
    resumedFromRemote,
    resumedCommitsAhead,
  };
}

/**
 * Hide paths listed in `.questboardignore` (at BOARD_ROOT) from the
 * per-card worktree via git sparse-checkout. Use case: keep workers
 * from touching the questboard board's own code while running on top of
 * it.
 *
 * Files stay in git history; they're just not materialized in the
 * worktree, so `git status` / `git add -A` from inside don't see any
 * "deleted" entries to accidentally commit.
 *
 * `.questboardignore` is also added to the hide list automatically so
 * workers can't read the project's ignore policy from inside.
 *
 * Best-effort. If the file is missing or git fails, the worktree gets a
 * normal full checkout — we log to stderr but don't abort spawn.
 */
async function applyIgnoreSparseCheckout(
  boardRoot: string,
  worktreePath: string,
): Promise<void> {
  const ignoreFile = path.join(boardRoot, ".questboardignore");
  let patterns: string[];
  try {
    const raw = fs.readFileSync(ignoreFile, "utf8");
    patterns = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return; // no ignore file → full checkout
  }

  // Hide the ignore file itself.
  patterns.push(".questboardignore");

  // Non-cone sparse-checkout: `/*` includes everything; each `!/<path>`
  // removes one subtree.
  const lines: string[] = ["/*"];
  for (const p of patterns) {
    const norm = p.replace(/^\/+/, "").replace(/\/+$/, "");
    if (!norm) continue;
    lines.push(`!/${norm}`);
    if (!/\.[^/]+$/.test(norm)) {
      lines.push(`!/${norm}/**`);
    }
  }

  try {
    await git(worktreePath, ["sparse-checkout", "init", "--no-cone"]);
    // Linked worktrees use a `.git` FILE pointing at the real gitdir.
    // Resolve it so we write the sparse-checkout file in the right place.
    let sparsePath = path.join(worktreePath, ".git", "info", "sparse-checkout");
    try {
      const dotgit = path.join(worktreePath, ".git");
      const stat = fs.statSync(dotgit);
      if (stat.isFile()) {
        const text = fs.readFileSync(dotgit, "utf8");
        const m = /^gitdir:\s*(.+)$/m.exec(text);
        if (m && m[1]) {
          const resolved = path.isAbsolute(m[1])
            ? m[1]
            : path.resolve(worktreePath, m[1]);
          sparsePath = path.join(resolved, "info", "sparse-checkout");
        }
      }
    } catch {
      /* fall through */
    }
    fs.mkdirSync(path.dirname(sparsePath), { recursive: true });
    fs.writeFileSync(sparsePath, lines.join("\n") + "\n");
    await git(worktreePath, ["sparse-checkout", "reapply"]);
  } catch (err) {
    process.stderr.write(
      `[questboard] applyIgnoreSparseCheckout failed for ${worktreePath}: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    );
  }
}

/** Number of commits on HEAD of `worktreePath` ahead of the best available main ref. */
export async function commitsAheadOfMain(
  worktreePath: string,
  preferredBranch?: string | null,
): Promise<number> {
  try {
    const base = await baseRef(worktreePath, preferredBranch);
    const { stdout } = await git(worktreePath, [
      "rev-list",
      "--count",
      `${base}..HEAD`,
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** Number of commits already present on origin/<branch> ahead of origin/main. */
export async function remoteCommitsAheadOfMain(
  worktreePath: string,
  branch: string,
  preferredBranch?: string | null,
): Promise<number> {
  try {
    await git(worktreePath, ["fetch", "origin", branch]);
    const base = await baseRef(worktreePath, preferredBranch);
    const { stdout } = await git(worktreePath, [
      "rev-list",
      "--count",
      `${base}..origin/${branch}`,
    ]);
    return Number(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Push the worker's branch with --force-with-lease (workers may rebase). Returns
 * the pushed branch name on success; throws on failure.
 */
export async function pushBranch(worktreePath: string, branch: string): Promise<string> {
  if (await hasOrigin(worktreePath)) {
    await git(worktreePath, ["push", "origin", branch, "--force-with-lease"]);
  }
  return branch;
}

/**
 * True if the worktree has any tracked-or-untracked changes that aren't yet
 * committed. Used by the implicit STUCK path to decide whether to wrap a
 * `wip:` commit around in-flight work before surfacing the question to a
 * human.
 *
 * Relies on `git status --porcelain` returning empty on a clean tree. Any
 * non-empty output (including `??` untracked entries) counts as "dirty".
 */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  try {
    const { stdout } = await git(worktreePath, ["status", "--porcelain"]);
    return stdout.trim().length > 0;
  } catch {
    // If we can't even ask git, assume clean — better to under-commit than
    // to silently wedge the stuck path on a bogus error.
    return false;
  }
}

/**
 * Stage everything and create a `wip:` commit on the current branch. Used
 * when a worker exited with a STUCK marker but didn't commit its in-flight
 * work itself — without this the partial work is lost the next time the
 * worktree is recreated. Best-effort: a commit failure is logged by the
 * caller but the stuck transition still proceeds.
 *
 * Returns the new HEAD sha on success; throws on git failure.
 */
export async function wipCommit(
  worktreePath: string,
  reason: string,
): Promise<string> {
  await git(worktreePath, ["add", "-A"]);
  // Strip newlines from the reason — `git commit -m` with embedded newlines
  // creates a multi-line commit body that's awkward to render. Truncate at
  // 200 chars so a chatty STUCK reason doesn't leak as a giant subject.
  const subject = reason.replace(/\s+/g, " ").trim().slice(0, 200) || "stuck";
  await git(worktreePath, ["commit", "-m", `wip: ${subject}`]);
  const { stdout } = await git(worktreePath, ["rev-parse", "HEAD"]);
  return stdout.trim();
}

/**
 * Enumerate prior wip-commits on the worker branch (everything ahead of
 * origin/main on `origin/<branch>`). Returns `[{sha, subject}]` ordered
 * oldest→newest. Used by the spawn-time "Previous attempts" section so a
 * fresh worker can see what its predecessor(s) tried before stalling.
 *
 * Best-effort: any git failure (offline, branch missing) returns []. We
 * don't want spawn to fail just because we couldn't render the section.
 */
export async function listPriorWipCommits(
  boardRoot: string,
  branch: string,
  preferredBranch?: string | null,
): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const base = await baseRef(boardRoot, preferredBranch);
    const { stdout } = await git(boardRoot, [
      "log",
      "--reverse",
      "--pretty=format:%h\t%s",
      `${base}..origin/${branch}`,
    ]);
    const out: Array<{ sha: string; subject: string }> = [];
    for (const line of stdout.split(/\r?\n/)) {
      const [sha, ...rest] = line.split("\t");
      if (!sha) continue;
      out.push({ sha, subject: rest.join("\t").trim() });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * `git diff <base>..<sha> --stat` truncated to the first ~12 lines so the
 * spawn message stays readable. Returns "" on failure.
 */
export async function diffStatAgainstMain(
  boardRoot: string,
  sha: string,
  maxLines = 12,
  preferredBranch?: string | null,
): Promise<string> {
  try {
    const base = await baseRef(boardRoot, preferredBranch);
    const { stdout } = await git(boardRoot, [
      "diff",
      `${base}..${sha}`,
      "--stat",
    ]);
    const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length <= maxLines) return lines.join("\n");
    const head = lines.slice(0, maxLines - 1).join("\n");
    return `${head}\n…(${lines.length - (maxLines - 1)} more lines truncated)`;
  } catch {
    return "";
  }
}
