/**
 * `questboard stop` — terminate a detached run.
 *
 * Reads the per-role pid files under <projectRoot>/.questboard/run/,
 * sends SIGTERM to each, then SIGKILL after a 5s grace. Stale pid files
 * (no live process) are silently cleaned up. start.json is removed
 * once every role's pid is gone.
 */
import {
  ALL_ROLES,
  clearPidFile,
  findProjectRoot,
  isAlive,
  pidFile,
  readPidFile,
  runtimePathsFor,
  type Role,
} from "./run-paths.js";
import { existsSync, unlinkSync } from "node:fs";

export interface CmdStopOptions {
  root?: string;
}

const KILL_GRACE_MS = 5_000;

export async function cmdStop(opts: CmdStopOptions): Promise<void> {
  const projectRoot = findProjectRoot(opts.root);
  const rp = runtimePathsFor(projectRoot);

  if (!existsSync(rp.runDir)) {
    process.stdout.write(
      `questboard: no detached run found for ${projectRoot}\n`,
    );
    return;
  }

  // Snapshot current pids per role and decide actions.
  const live: Array<{ role: Role; pid: number }> = [];
  const stale: Role[] = [];
  for (const role of ALL_ROLES) {
    const path = pidFile(rp, role);
    const pid = readPidFile(path);
    if (pid == null) continue;
    if (isAlive(pid)) live.push({ role, pid });
    else stale.push(role);
  }

  for (const role of stale) {
    clearPidFile(pidFile(rp, role));
    process.stdout.write(`  cleared stale ${role} pid file\n`);
  }

  if (live.length === 0) {
    process.stdout.write(
      live.length === 0 && stale.length === 0
        ? `questboard: no live roles for ${projectRoot}\n`
        : "",
    );
    if (existsSync(rp.startJson)) {
      try {
        unlinkSync(rp.startJson);
      } catch {
        /* ignore */
      }
    }
    return;
  }

  process.stdout.write(`Stopping ${live.length} role(s)...\n`);

  // Phase 1: SIGTERM.
  for (const { role, pid } of live) {
    try {
      process.kill(pid, "SIGTERM");
      process.stdout.write(`  ${role} (pid ${pid}) — SIGTERM\n`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        // already gone between snapshot and signal
      } else {
        process.stderr.write(
          `  ${role} (pid ${pid}) — SIGTERM failed: ${(err as Error).message}\n`,
        );
      }
    }
  }

  // Phase 2: poll for exit, then SIGKILL leftovers after the grace.
  const deadline = Date.now() + KILL_GRACE_MS;
  while (Date.now() < deadline) {
    const stillAlive = live.filter(({ pid }) => isAlive(pid));
    if (stillAlive.length === 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  for (const { role, pid } of live) {
    if (!isAlive(pid)) {
      clearPidFile(pidFile(rp, role));
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
      process.stdout.write(`  ${role} (pid ${pid}) — SIGKILL\n`);
    } catch {
      /* may have just exited */
    }
    clearPidFile(pidFile(rp, role));
  }

  if (existsSync(rp.startJson)) {
    try {
      unlinkSync(rp.startJson);
    } catch {
      /* ignore */
    }
  }
  process.stdout.write("Stopped.\n");
}
