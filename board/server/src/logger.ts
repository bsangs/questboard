/**
 * Structured JSONL logger writing to .questboard/data/logs/server.jsonl.
 * Best-effort: failures don't affect requests.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { env } from "./env.js";

mkdirSync(env.LOGS_DIR, { recursive: true });

const LOG_PATH = `${env.LOGS_DIR}/server.jsonl`;

export type LogLevel = "debug" | "info" | "warn" | "error";

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + "\n";
  try {
    appendFileSync(LOG_PATH, line);
  } catch (e) {
    // last-ditch — do not throw out of logging
    process.stderr.write(`log write failed: ${(e as Error).message}\n`);
  }
  if (level === "error" || level === "warn" || process.env.BOARD_LOG_STDOUT) {
    process.stdout.write(line);
  }
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => log("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => log("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => log("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => log("error", event, fields),
};
