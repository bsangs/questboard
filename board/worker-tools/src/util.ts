/**
 * Shared helpers for worker-tools CLI commands.
 */
import { readFileSync } from "node:fs";

/**
 * Resolve a CLI value that may be either inline text or a `@<file>` reference.
 * If the value starts with `@`, the rest is treated as a file path and read
 * as UTF-8. Otherwise the value is returned as-is.
 *
 * Use for any free-form text input (comment bodies, stuck questions, etc.) so
 * the worker can pipe long content from a file without shell-escaping hell.
 */
export function resolveTextOrFile(value: string): string {
  if (!value.startsWith("@")) return value;
  const path = value.slice(1);
  if (!path) throw new Error("`@` prefix requires a file path");
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read ${path}: ${msg}`);
  }
}

/** Print response JSON to stdout (pretty, 2-space indent). */
export function printResponse(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Coerce a value to a positive integer or throw. */
export function toPositiveInt(label: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`--${label} must be a non-negative integer (got "${raw}")`);
  }
  return n;
}
