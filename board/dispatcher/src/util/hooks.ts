import { spawn } from "node:child_process";
import type { DispatcherConfig } from "../config.js";
import {
  readStageCommand,
  type StageCommandPhase,
  type StageCommandStage,
} from "../context.js";

export interface RunCommandHookOpts {
  cfg: DispatcherConfig;
  stage: StageCommandStage;
  phase: StageCommandPhase;
  cwd: string;
  env: NodeJS.ProcessEnv;
  cardId?: string;
  attempt?: number;
  wipBranch?: string;
  timeoutMs?: number;
  log?: (event: { event: string } & Record<string, unknown>) => void;
}

export async function runCommandHook(
  opts: RunCommandHookOpts,
): Promise<boolean> {
  const cmd = readStageCommand(opts.cfg, opts.stage, opts.phase);
  if (!cmd) return false;

  const started = Date.now();
  opts.log?.({
    event: "stage_command_start",
    stage: opts.stage,
    phase: opts.phase,
    card_id: opts.cardId,
    cwd: opts.cwd,
    cmd,
  });

  const result = await runShell(cmd, {
    cwd: opts.cwd,
    env: {
      ...opts.env,
      BOARD_ROOT: opts.cfg.boardRoot,
      BOARD_SERVER_URL: opts.cfg.serverUrl,
      BOARD_DATA: opts.cfg.boardData,
      BOARD_WORKTREES: opts.cfg.worktreesDir,
      ...(opts.cardId ? { CARD_ID: opts.cardId } : {}),
      ...(opts.attempt != null ? { ATTEMPT: String(opts.attempt) } : {}),
      ...(opts.wipBranch ? { WIP_BRANCH: opts.wipBranch } : {}),
      QUESTBOARD_STAGE: opts.stage,
      QUESTBOARD_STAGE_PHASE: opts.phase,
    },
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
  });

  const event = result.ok ? "stage_command_ok" : "stage_command_failed";
  opts.log?.({
    event,
    stage: opts.stage,
    phase: opts.phase,
    card_id: opts.cardId,
    exit_code: result.exitCode,
    duration_ms: Date.now() - started,
    stderr_tail: result.stderr.slice(-500),
  });
  return true;
}

function runShell(
  cmd: string,
  opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ ok: boolean; exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", cmd], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, opts.timeoutMs);
    timer.unref?.();

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, exitCode: -1, stderr: String(err) });
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      const exitCode = typeof code === "number" ? code : null;
      const signalText = signal ? ` signal=${signal}` : "";
      const timeoutText = killed ? " timeout" : "";
      resolve({
        ok: exitCode === 0,
        exitCode,
        stderr: stderr + (signalText || timeoutText ? `\n[${signalText}${timeoutText}]` : ""),
      });
    });
  });
}
