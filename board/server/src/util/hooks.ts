import { spawn } from "node:child_process";
import type { StageCommandPhase, StageCommandStage } from "@questboard/core";
import { getConfig } from "../config.js";
import { env } from "../env.js";
import { logger } from "../logger.js";

export interface RunCommandHookOpts {
  stage: StageCommandStage;
  phase: StageCommandPhase;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cardId?: string;
  timeoutMs?: number;
}

export async function runCommandHook(
  opts: RunCommandHookOpts,
): Promise<boolean> {
  let cmd: string | null | undefined;
  try {
    cmd = getConfig().commands.stages[opts.stage]?.[opts.phase];
  } catch (err) {
    logger.warn("stage_command_config_read_failed", {
      stage: opts.stage,
      phase: opts.phase,
      cardId: opts.cardId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!cmd || cmd.trim() === "") return false;

  const started = Date.now();
  logger.info("stage_command_start", {
    stage: opts.stage,
    phase: opts.phase,
    cardId: opts.cardId,
    cwd: opts.cwd,
    cmd,
  });

  const result = await runShell(cmd, {
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...(opts.env ?? {}),
      BOARD_ROOT: env.BOARD_ROOT,
      ...(opts.cardId ? { CARD_ID: opts.cardId } : {}),
      QUESTBOARD_STAGE: opts.stage,
      QUESTBOARD_STAGE_PHASE: opts.phase,
    },
    timeoutMs: opts.timeoutMs ?? 10 * 60_000,
  });

  const payload = {
    stage: opts.stage,
    phase: opts.phase,
    cardId: opts.cardId,
    exit_code: result.exitCode,
    duration_ms: Date.now() - started,
    stderr_tail: result.stderr.slice(-500),
  };
  if (result.ok) logger.info("stage_command_ok", payload);
  else logger.warn("stage_command_failed", payload);
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
