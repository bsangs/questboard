/**
 * Run the project's install command (`$BOARD_INSTALL_CMD`) inside a freshly-
 * created worktree, BEFORE the claude worker is spawned. Fresh worktrees
 * never have node_modules, so without this hook the worker's first
 * Read/Bash on a built-in script would fail.
 *
 * Design choices:
 *   - `installCmd` is the full shell line (e.g. `pnpm install`) emitted by
 *     `discoverCommands`. We split on whitespace and `execFile` the binary
 *     directly — no shell, so a malicious project can't inject commands
 *     via package.json scripts here.
 *   - The hook is best-effort. A missing or failing install yields a
 *     warning log but spawn still proceeds; the worker can recover by
 *     running install itself if needed.
 *   - Timeout is generous (5 minutes) — fresh `pnpm install` on a large
 *     monorepo can legitimately take 2-3 minutes; tighter caps cause
 *     spurious failures on slow CI hardware.
 *
 * NOTE: This file is owned by the X-srv agent in the broader plan. We
 * provide a working implementation here so the worker pool isn't blocked
 * on the cross-agent handoff. If X-srv lands a canonical version under
 * `questboard/board/server/src/util/install.ts`, this becomes a thin
 * re-export.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface RunInstallOpts {
  /** Absolute path of the directory to run install in (typically the worktree). */
  cwd: string;
  /** Full install command, e.g. `pnpm install`. Null/empty = no-op. */
  installCmd: string | null;
  /** Hard timeout in ms. Defaults to 5 minutes. */
  timeoutMs?: number;
  /** Optional logger for one-line progress events. */
  log?: (event: Record<string, unknown>) => void;
}

export interface RunInstallResult {
  ran: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/**
 * Execute the install command. Returns a summary so the caller can decide
 * whether to surface a warning on the card. Never throws — install
 * failures are returned as `{ran: true, exitCode: <n>, error: "..."}`.
 */
export async function runInstall(opts: RunInstallOpts): Promise<RunInstallResult> {
  const start = Date.now();
  const { cwd, installCmd, timeoutMs = 5 * 60_000, log } = opts;

  if (!installCmd || !installCmd.trim()) {
    return {
      ran: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
    };
  }

  // Split on whitespace — install commands are always `<pm> install` with
  // no shell metacharacters (we control the producer in command-discovery).
  // If we ever extend to user-customised commands we'll need a real shell
  // parser here, but that's not the current contract.
  const [bin, ...args] = installCmd.trim().split(/\s+/);
  if (!bin) {
    return {
      ran: false,
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 0,
      error: "installCmd had no executable token",
    };
  }

  log?.({ event: "install_start", cwd, cmd: installCmd });
  try {
    const { stdout, stderr } = await exec(bin, args, {
      cwd,
      timeout: timeoutMs,
      // Install logs can be large (pnpm prints every package name); cap
      // generously but don't go unbounded.
      maxBuffer: 32 * 1024 * 1024,
      // Inherit env so e.g. CI=1, npm_config_registry, etc. propagate.
      env: process.env,
    });
    const durationMs = Date.now() - start;
    log?.({ event: "install_ok", cwd, cmd: installCmd, duration_ms: durationMs });
    return {
      ran: true,
      exitCode: 0,
      stdout: String(stdout),
      stderr: String(stderr),
      durationMs,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    // execFile rejects with an Error that has stdout/stderr/code mixed in.
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    const exitCode = typeof e.code === "number" ? e.code : null;
    log?.({
      event: "install_failed",
      cwd,
      cmd: installCmd,
      duration_ms: durationMs,
      exit_code: exitCode,
      message: e.message,
    });
    return {
      ran: true,
      exitCode,
      stdout: String(e.stdout ?? ""),
      stderr: String(e.stderr ?? ""),
      durationMs,
      error: e.message,
    };
  }
}
