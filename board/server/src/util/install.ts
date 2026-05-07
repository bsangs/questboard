/**
 * Run an install command in a target directory and return a structured
 * result. Never throws on non-zero exit — callers (worker/merger spawn)
 * decide what to do with a failure (mark stuck, retry, surface comment).
 *
 * Output is captured incrementally so callers can stream lines into
 * dispatcher logs / SSE without waiting for the whole install to finish.
 */
import { spawn } from "node:child_process";

export interface RunInstallOpts {
  /** Working directory to invoke the install in (the worktree). */
  cwd: string;
  /** Full command line, e.g. `discoverCommands(...).install`. */
  cmd: string;
  /** Optional per-line callback for stdout/stderr (best-effort). */
  log?: (line: string) => void;
  /**
   * Optional kill switch — pass an AbortSignal to terminate the install
   * mid-run (e.g. user cancelled the card). The promise resolves with
   * `ok: false` and exitCode = -1 when aborted.
   */
  signal?: AbortSignal;
  /**
   * Hard timeout in ms. Defaults to 10 minutes. Goes through the same
   * kill path as `signal`.
   */
  timeoutMs?: number;
}

export type RunInstallResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; stdout: string; stderr: string; exitCode: number };

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export async function runInstall(opts: RunInstallOpts): Promise<RunInstallResult> {
  const { cwd, cmd, log, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  // Use shell so users can write `pnpm install --frozen-lockfile` without
  // tokenizing themselves. We trust the cmd because it comes from
  // discoverCommands (no user input is ever interpolated into it).
  return await new Promise<RunInstallResult>((resolveP) => {
    const child = spawn(cmd, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBuf = "";
    let stderrBuf = "";

    const drainLines = (chunk: string, which: "stdout" | "stderr"): void => {
      if (!log) return;
      let buf = which === "stdout" ? stdoutBuf : stderrBuf;
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        log(line);
      }
      if (which === "stdout") stdoutBuf = buf;
      else stderrBuf = buf;
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      drainLines(chunk, "stdout");
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      drainLines(chunk, "stderr");
    });

    let aborted = false;
    const onAbort = (): void => {
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(onAbort, timeoutMs);
    timer.unref?.();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (err) => {
      // spawn-time error (binary not on PATH, EACCES, ...). Treat as
      // failure with a synthetic stderr so the caller has SOMETHING to
      // surface to the user.
      clearTimeout(timer);
      stderr += String(err);
      resolveP({ ok: false, stdout, stderr, exitCode: -1 });
    });

    child.on("exit", (code, sig) => {
      clearTimeout(timer);
      // Flush partial buffered lines (no trailing newline).
      if (log && stdoutBuf) log(stdoutBuf);
      if (log && stderrBuf) log(stderrBuf);
      if (aborted) {
        resolveP({
          ok: false,
          stdout,
          stderr: stderr + (stderr.endsWith("\n") ? "" : "\n") + `[install aborted: ${sig ?? "SIGTERM"}]`,
          exitCode: -1,
        });
        return;
      }
      const exitCode = typeof code === "number" ? code : -1;
      if (exitCode === 0) {
        resolveP({ ok: true, stdout, stderr });
      } else {
        resolveP({ ok: false, stdout, stderr, exitCode });
      }
    });
  });
}
