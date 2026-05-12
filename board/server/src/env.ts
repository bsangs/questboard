/**
 * Load .env (companion-app model) and expose typed config used across the
 * server.
 *
 * Path model:
 *   appRoot      = installed questboard package location (where prompts live)
 *   projectRoot  = user's Git repository root (where runtime data lives)
 *   dataDir      = projectRoot + BOARD_DATA (default `.questboard/data`)
 *   worktreesDir = projectRoot + BOARD_WORKTREES (default `.questboard/worktrees`)
 *
 * Env file lookup order:
 *   1. <projectRoot>/.questboard/.env
 *   2. package-local .env fallback
 *   3. cwd .env (last resort)
 *
 * projectRoot lookup order:
 *   1. process.env.BOARD_ROOT (non-empty)
 *   2. nearest ancestor of this file containing .questboard/.env
 *   3. nearest ancestor of this file containing a package-local .env
 *   4. nearest ancestor of cwd containing .questboard/.env
 *   5. cwd
 *
 * Empty env values are treated as unset for path-like variables so a stray
 * `BOARD_ROOT=` line cannot silently anchor paths to the process cwd.
 */
import { config as loadDotenv } from "dotenv";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

/** Return env value or undefined when unset / empty / whitespace-only. */
function envValue(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v.trim() !== "" ? v : undefined;
}

/** Walk up `start` checking `probe(dir)`; return first match or null. */
function walkUp(start: string, probe: (dir: string) => boolean, hops = 12): string | null {
  let dir = start;
  for (let i = 0; i < hops; i++) {
    if (probe(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface LocatedEnv {
  projectRoot: string;
  envPath: string | null;
}

function locate(): LocatedEnv {
  const explicit = envValue("BOARD_ROOT");
  if (explicit) {
    const abs = resolve(explicit);
    for (const cand of [join(abs, ".questboard/.env"), join(abs, "questboard/.env")]) {
      if (existsSync(cand)) return { projectRoot: abs, envPath: cand };
    }
    return { projectRoot: abs, envPath: null };
  }

  for (const probe of [
    (dir: string): boolean => existsSync(join(dir, ".questboard", ".env")),
    (dir: string): boolean => existsSync(join(dir, "questboard", ".env")),
  ]) {
    const fromHere = walkUp(here, probe);
    if (fromHere) {
      const candidate = existsSync(join(fromHere, ".questboard", ".env"))
        ? join(fromHere, ".questboard", ".env")
        : join(fromHere, "questboard", ".env");
      return { projectRoot: fromHere, envPath: candidate };
    }
    const fromCwd = walkUp(process.cwd(), probe);
    if (fromCwd) {
      const candidate = existsSync(join(fromCwd, ".questboard", ".env"))
        ? join(fromCwd, ".questboard", ".env")
        : join(fromCwd, "questboard", ".env");
      return { projectRoot: fromCwd, envPath: candidate };
    }
  }

  return { projectRoot: process.cwd(), envPath: null };
}

const located = locate();
if (located.envPath) loadDotenv({ path: located.envPath });
else loadDotenv(); // fall back to cwd .env

function req(name: string, fallback?: string): string {
  const v = envValue(name);
  if (v != null) return v;
  if (fallback != null) return fallback;
  throw new Error(`Missing required env: ${name}`);
}

/**
 * appRoot = the directory where the questboard package source lives. Used to
 * resolve prompt files. Walks up from this module until a directory contains
 * `board/prompts`. Falls back to a fixed three-levels-up which matches both
 * `<appRoot>/board/server/dist/env.js` and `<appRoot>/board/server/src/env.ts`.
 */
function findAppRoot(): string {
  const found = walkUp(here, (dir) => existsSync(join(dir, "board", "prompts")));
  return found ?? resolve(here, "..", "..", "..");
}

const APP_ROOT = findAppRoot();
const BOARD_ROOT = resolve(req("BOARD_ROOT", located.projectRoot));
const BOARD_DATA_REL = envValue("BOARD_DATA") ?? ".questboard/data";
const BOARD_WORKTREES_REL = envValue("BOARD_WORKTREES") ?? ".questboard/worktrees";

const BOARD_DATA = resolve(BOARD_ROOT, BOARD_DATA_REL);
const BOARD_WORKTREES = resolve(BOARD_ROOT, BOARD_WORKTREES_REL);

/**
 * Parse BOARD_CORS_ALLOWED_ORIGINS — a comma-separated allowlist of
 * extra origins beyond the localhost defaults. Used by split-host
 * deploys (UI on a separate origin from the API). The wildcard "*" is
 * explicitly rejected so a misconfigured env can't silently turn the
 * API into an open relay.
 */
function parseExtraOrigins(): string[] {
  const raw = envValue("BOARD_CORS_ALLOWED_ORIGINS");
  if (!raw) return [];
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.includes("*")) {
    throw new Error(
      "[server] BOARD_CORS_ALLOWED_ORIGINS rejects '*'. List explicit origins.",
    );
  }
  for (const o of items) {
    if (!/^https?:\/\//i.test(o)) {
      throw new Error(
        `[server] BOARD_CORS_ALLOWED_ORIGINS entry must start with http:// or https://: ${o}`,
      );
    }
  }
  return items;
}

const BOARD_SERVER_PORT = Number(envValue("BOARD_SERVER_PORT") ?? 3031);
const BOARD_UI_PORT = Number(envValue("BOARD_UI_PORT") ?? 3030);
const BOARD_BASE_BRANCH = envValue("BOARD_BASE_BRANCH") ?? null;
const CORS_EXTRA_ORIGINS = parseExtraOrigins();
const CORS_ORIGINS = [
  `http://localhost:${BOARD_UI_PORT}`,
  `http://127.0.0.1:${BOARD_UI_PORT}`,
  ...CORS_EXTRA_ORIGINS,
];

export const env = {
  APP_ROOT,
  BOARD_ROOT,
  BOARD_DATA,
  BOARD_WORKTREES,
  BOARD_BASE_BRANCH,
  BOARD_SERVER_PORT,
  BOARD_UI_PORT,
  CORS_ORIGINS,

  CARDS_DIR: join(BOARD_DATA, "cards"),
  ARCHIVE_DIR: join(BOARD_DATA, "archive"),
  LOGS_DIR: join(BOARD_DATA, "logs"),
  CONFIG_PATH: join(BOARD_DATA, "config.json"),
  BASE_PROMPT_PATH: join(BOARD_DATA, "base-prompt.md"),
  DB_PATH: join(BOARD_DATA, "board.sqlite"),

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID ?? "",
  SECRET_KEY: process.env.SECRET_KEY ?? "",
  ANTHROPIC_API_KEY_CONFIGURED: Boolean(envValue("ANTHROPIC_API_KEY")),
  ANTHROPIC_BASE_URL_CONFIGURED: Boolean(envValue("ANTHROPIC_BASE_URL")),
} as const;

export type Env = typeof env;
