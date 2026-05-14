/**
 * Server-side fast-forward merge pre-attempt for cards in `merging`.
 *
 * Most worker branches ARE rebased before they enter merging — so a plain
 * `git merge --ff-only` succeeds and we don't need to spend tokens spinning
 * up a Claude merger to babysit it. This module is the fast path: run the
 * configured merge steps, then transition the card to done by reusing
 * `mergerComplete()`.
 *
 * On any required-step failure we abort any in-flight merge and
 * return `fallback_to_merger: true` so the caller (dispatcher) knows to
 * spawn the regular Claude merger to handle the conflict.
 *
 * Mergers are STRICTLY SERIAL globally (see queue.isAnyMergerActive). This
 * module also takes its own in-process mutex so two concurrent dispatcher
 * polls landing here at once don't both check out the base branch and race on
 * the merge.
 */
import { execFile } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { env } from "../env.js";
import { getConfig } from "../config.js";
import { logger } from "../logger.js";
import { gitMain, workerBranchFor, worktreePathFor } from "../git.js";
import { mergerComplete } from "../transitions.js";
import { runCommandHook } from "../util/hooks.js";
import { readSecret } from "../secrets.js";
import type { MergeCommandStep, MergeCommandsConfig } from "@questboard/core";

const execFileP = promisify(execFile);
const LOCK_PATH = join(env.BOARD_DATA, "locks", "ff-merge.lock");

export type TryFfMergeResult =
  | { ok: true; merged_sha: string; status: string; ran: string[] }
  | { ok: false; reason: string; fallback_to_merger: boolean; ran: string[] };

/**
 * In-process mutex so concurrent calls (dispatcher poll race) serialize.
 * The dispatcher's `isAnyMergerActive` already checks the SQL workers
 * table, but ff-merge doesn't insert a workers row — this is the only
 * thing standing between two polls and a base-branch checkout race.
 */
let inflight: Promise<TryFfMergeResult> | null = null;

/**
 * Public entrypoint. Idempotent w.r.t. concurrent callers — returns the
 * same in-flight promise if one is already running.
 */
export function tryFfMerge(cardId: string): Promise<TryFfMergeResult> {
  if (inflight) return inflight;
  if (!acquireLock(cardId)) {
    return Promise.resolve({
      ok: false,
      reason: "another ff-merge is already in progress",
      fallback_to_merger: false,
      ran: [],
    });
  }
  inflight = doFfMerge(cardId).finally(() => {
    inflight = null;
    releaseLock();
  });
  return inflight;
}

function acquireLock(cardId: string): boolean {
  mkdirSync(dirname(LOCK_PATH), { recursive: true });
  try {
    const fd = openSync(LOCK_PATH, "wx");
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, cardId, ts: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") throw err;
    if (lockOwnerAlive()) return false;
    try {
      rmSync(LOCK_PATH, { force: true });
    } catch {
      return false;
    }
    return acquireLock(cardId);
  }
}

function lockOwnerAlive(): boolean {
  try {
    const raw = JSON.parse(readFileSync(LOCK_PATH, "utf8")) as { pid?: unknown };
    const pid = typeof raw.pid === "number" ? raw.pid : null;
    if (pid == null) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function releaseLock(): void {
  try {
    rmSync(LOCK_PATH, { force: true });
  } catch {
    /* best-effort */
  }
}

async function doFfMerge(cardId: string): Promise<TryFfMergeResult> {
  const cfg = getConfig();
  const branch = workerBranchFor(cardId);
  const baseBranch = cfg.git.base_branch;
  const cmdCwd = resolveCmdCwd();
  const ran: string[] = [];

  const preHookRan = await runCommandHook({
    stage: "merging",
    phase: "pre",
    cwd: cmdCwd,
    cardId,
    env: { WIP_BRANCH: branch },
  });
  if (preHookRan) ran.push("pre-merge-hook");

  try {
    return await doFfMergeInner({
      cardId,
      branch,
      baseBranch,
      cwd: cmdCwd,
      commands: cfg.commands.merge,
      ran,
    });
  } finally {
    const postHookRan = await runCommandHook({
      stage: "merging",
      phase: "post",
      cwd: cmdCwd,
      cardId,
      env: { WIP_BRANCH: branch },
    });
    if (postHookRan) ran.push("post-merge-hook");
  }
}

async function doFfMergeInner(args: {
  cardId: string;
  branch: string;
  baseBranch: string;
  cwd: string;
  commands: MergeCommandsConfig;
  ran: string[];
}): Promise<TryFfMergeResult> {
  const { cardId, branch, baseBranch, cwd, commands, ran } = args;
  let executed = false;

  for (const step of commands) {
    try {
      if (await runMergeCommand({
        step,
        cwd,
        baseBranch,
        branch,
        cardId,
      })) {
        executed = true;
        ran.push(step.label);
      }
    } catch (err) {
      logger.warn("ff_merge_step_failed", {
        cardId,
        step: step.label,
        required: step.required,
        err: msg(err),
      });
      if (!step.required) {
        ran.push(`${step.label} (optional failed)`);
        continue;
      }
      await abortMergeIfNeeded();
      return {
        ok: false,
        reason: `${step.label} failed: ${msg(err)}`,
        fallback_to_merger: true,
        ran,
      };
    }
  }

  if (!executed) {
    return {
      ok: false,
      reason: "no merge commands configured",
      fallback_to_merger: true,
      ran,
    };
  }

  // Resolve the merged sha and route through `mergerComplete`. That
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
    // Same logic as the rev-parse case: the merge is real on the local base,
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

async function abortMergeIfNeeded(): Promise<void> {
  try {
    await gitMain(["merge", "--abort"]);
  } catch (err) {
    logger.debug("ff_merge_abort_skipped", { err: msg(err) });
  }
}

function renderCommand(
  command: string,
  vars: { baseBranch: string; branch: string; cardId: string },
): string {
  return command
    .replaceAll("{base_branch}", vars.baseBranch)
    .replaceAll("{wip_branch}", vars.branch)
    .replaceAll("{card_id}", vars.cardId)
    .replaceAll("{worktree_path}", worktreePathFor(vars.cardId));
}

async function runMergeCommand(args: {
  step: MergeCommandStep;
  cwd: string;
  baseBranch: string;
  branch: string;
  cardId: string;
}): Promise<boolean> {
  const raw = args.step.command?.trim();
  if (!raw) {
    logger.debug("ff_merge_command_skipped", {
      cardId: args.cardId,
      step: args.step.label,
    });
    return false;
  }
  const cmd = renderCommand(raw, {
    baseBranch: args.baseBranch,
    branch: args.branch,
    cardId: args.cardId,
  });
  logger.debug("ff_merge_command_start", {
    cardId: args.cardId,
    step: args.step.label,
    cmd,
    cwd: args.cwd,
  });
  try {
    await execFileP("bash", ["-lc", cmd], {
      cwd: args.cwd,
      timeout: 10 * 60_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        ...configuredEnvironment(),
        GIT_TERMINAL_PROMPT: "0",
        BOARD_ROOT: env.BOARD_ROOT,
        BASE_BRANCH: args.baseBranch,
        WIP_BRANCH: args.branch,
        CARD_ID: args.cardId,
      },
    });
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    const detail = (e.stderr || e.stdout || e.message || String(err)).trim();
    throw new Error(`${args.step.label} exited: ${detail}`);
  }
}

function configuredEnvironment(): Record<string, string> {
  const cfg = getConfig();
  const out: Record<string, string> = {};
  for (const item of cfg.environment.env) out[item.name] = item.value;
  for (const item of cfg.environment.secret_env) {
    try {
      const value = readSecret(item.secret_ref);
      if (value != null) out[item.name] = value;
    } catch (err) {
      logger.warn("ff_merge_secret_env_failed", {
        name: item.name,
        err: msg(err),
      });
    }
  }
  return out;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Where merge hooks run. Fast-forward merge is a repo-root operation.
 */
function resolveCmdCwd(): string {
  return env.BOARD_ROOT;
}
