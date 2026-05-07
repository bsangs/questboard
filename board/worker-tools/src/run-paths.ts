/**
 * Shared helpers for the detached-mode CLI commands (start --detach,
 * stop, status, logs). Centralizes:
 *
 *   - locating the user's projectRoot from cwd / a --root hint
 *   - canonical paths under <projectRoot>/.questboard/run/
 *   - pid file read + liveness probe + stale cleanup
 *
 * Foreground `start` mode does not use any of this — it streams logs
 * to its own stdout and tears down on Ctrl+C.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Role = "server" | "dispatcher" | "ui";

export const ALL_ROLES: readonly Role[] = ["server", "dispatcher", "ui"];

export interface RuntimePaths {
  projectRoot: string;
  runDir: string;
  startJson: string;
}

function findGitRoot(start: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return out.trim();
  } catch {
    return null;
  }
}

function walkUp(
  start: string,
  probe: (dir: string) => boolean,
  hops = 12,
): string | null {
  let dir = start;
  for (let i = 0; i < hops; i++) {
    if (probe(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Find the project root by walking up looking for .questboard/ (or the
 * legacy questboard/ companion layout). Falls back to git root, then cwd.
 * `rootHint` overrides the walk and is taken at face value (resolved abs).
 */
export function findProjectRoot(rootHint?: string): string {
  if (rootHint) return resolve(rootHint);
  const cwd = process.cwd();
  const fromQuestboard = walkUp(cwd, (dir) =>
    existsSync(join(dir, ".questboard")),
  );
  if (fromQuestboard) return fromQuestboard;
  const fromLegacy = walkUp(cwd, (dir) =>
    existsSync(join(dir, "questboard", ".env")),
  );
  if (fromLegacy) return fromLegacy;
  return findGitRoot(cwd) ?? cwd;
}

export function runtimePathsFor(projectRoot: string): RuntimePaths {
  const runDir = join(projectRoot, ".questboard", "run");
  return {
    projectRoot,
    runDir,
    startJson: join(runDir, "start.json"),
  };
}

export function pidFile(rp: RuntimePaths, role: Role): string {
  return join(rp.runDir, `${role}.pid`);
}

export function logFile(rp: RuntimePaths, role: Role): string {
  return join(rp.runDir, `${role}.log`);
}

/**
 * Read a pid file. Returns null if missing or unparseable. Does NOT
 * check liveness — pair with isAlive() for that.
 */
export function readPidFile(path: string): number | null {
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort process liveness probe via `kill 0`. Returns true if the
 * pid resolves to a process this user can signal (i.e. exists).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process. EPERM = exists but we can't signal it
    // (still "alive" for our purposes).
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Delete the pid file silently. Used to clean up stale entries. */
export function clearPidFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* missing is fine */
  }
}

export interface StartManifest {
  projectRoot: string;
  appRoot: string;
  startedAtIso: string;
  roles: Array<{
    role: Role;
    pid: number;
    logPath: string;
    pidPath: string;
  }>;
  ports: { ui?: number; server?: number };
}

export function readStartManifest(rp: RuntimePaths): StartManifest | null {
  if (!existsSync(rp.startJson)) return null;
  try {
    return JSON.parse(readFileSync(rp.startJson, "utf8")) as StartManifest;
  } catch {
    return null;
  }
}
