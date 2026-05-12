/**
 * Dispatcher runtime configuration.
 *
 * Path model (companion-app):
 *   appRoot      = installed questboard package location (where prompts live)
 *   projectRoot  = user's Git repository root (where runtime data lives)
 *   dataDir      = projectRoot + BOARD_DATA (default `.questboard/data`)
 *   worktreesDir = projectRoot + BOARD_WORKTREES (default `.questboard/worktrees`)
 *
 * Env file lookup order:
 *   1. <projectRoot>/.questboard/.env
 *   2. package-local .env fallback
 *   3. cwd .env
 *
 * Live concurrency_limit etc. come from `<dataDir>/config.json`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import type { BoardConfig } from "@questboard/core";

/**
 * "bare" mode passes `--bare` to `claude` and forwards ANTHROPIC_BASE_URL /
 * ANTHROPIC_API_KEY to the spawned child, bypassing Claude Code's OAuth login
 * session. Used for proxy / multi-host / non-interactive operation.
 *
 * "session" mode omits `--bare` and forwards no ANTHROPIC env, so `claude`
 * falls back to the user's interactive login session. This is the default
 * when ANTHROPIC_API_KEY is unset, so first-run users don't need any env.
 */
export type AuthMode = "session" | "bare";

export interface DispatcherConfig {
  appRoot: string;
  boardRoot: string;
  boardData: string;
  serverUrl: string;
  dbPath: string;
  configJsonPath: string;
  promptPath: string;
  promptsDir: string;
  logsDir: string;
  cardsDir: string;
  worktreesDir: string;
  /** Preferred base branch for worktrees and diffs, e.g. `main` or `develop`. */
  baseBranch: string | null;
  /** ANTHROPIC_BASE_URL — null when running in session mode. */
  anthropicBaseUrl: string | null;
  /** ANTHROPIC_API_KEY — null when running in session mode. */
  anthropicApiKey: string | null;
  /** Derived from anthropicApiKey presence; see AuthMode docstring. */
  authMode: AuthMode;
  heartbeatTimeoutSec: number;
  /** SIGTERM → SIGKILL grace period (ms). */
  killGraceMs: number;
}

function envValue(name: string): string | undefined {
  const v = process.env[name];
  return v != null && v.trim() !== "" ? v : undefined;
}

function walkUp(start: string, probe: (dir: string) => boolean, hops = 12): string | null {
  let dir = start;
  for (let i = 0; i < hops; i++) {
    if (probe(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface LocatedEnv {
  projectRoot: string;
  envPath: string | null;
}

function locateEnv(here: string): LocatedEnv {
  const explicit = envValue("BOARD_ROOT");
  if (explicit) {
    const abs = path.resolve(explicit);
    for (const cand of [
      path.join(abs, ".questboard", ".env"),
      path.join(abs, "questboard", ".env"),
    ]) {
      if (fs.existsSync(cand)) return { projectRoot: abs, envPath: cand };
    }
    return { projectRoot: abs, envPath: null };
  }

  for (const probe of [
    (dir: string): boolean => fs.existsSync(path.join(dir, ".questboard", ".env")),
    (dir: string): boolean => fs.existsSync(path.join(dir, "questboard", ".env")),
  ]) {
    const fromHere = walkUp(here, probe);
    if (fromHere) {
      const candidate = fs.existsSync(path.join(fromHere, ".questboard", ".env"))
        ? path.join(fromHere, ".questboard", ".env")
        : path.join(fromHere, "questboard", ".env");
      return { projectRoot: fromHere, envPath: candidate };
    }
    const fromCwd = walkUp(process.cwd(), probe);
    if (fromCwd) {
      const candidate = fs.existsSync(path.join(fromCwd, ".questboard", ".env"))
        ? path.join(fromCwd, ".questboard", ".env")
        : path.join(fromCwd, "questboard", ".env");
      return { projectRoot: fromCwd, envPath: candidate };
    }
  }

  return { projectRoot: process.cwd(), envPath: null };
}

let envLoaded = false;
function ensureEnvLoaded(here: string): LocatedEnv {
  const located = locateEnv(here);
  if (!envLoaded) {
    if (located.envPath) dotenv.config({ path: located.envPath });
    else dotenv.config();
    envLoaded = true;
  }
  return located;
}

function findAppRoot(here: string): string {
  const found = walkUp(here, (dir) =>
    fs.existsSync(path.join(dir, "board", "prompts")),
  );
  return found ?? path.resolve(here, "..", "..", "..");
}

export function loadConfig(): DispatcherConfig {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const located = ensureEnvLoaded(here);
  const appRoot = findAppRoot(here);

  const boardRoot = path.resolve(envValue("BOARD_ROOT") ?? located.projectRoot);
  const boardDataRel = envValue("BOARD_DATA") ?? ".questboard/data";
  const boardData = path.isAbsolute(boardDataRel)
    ? boardDataRel
    : path.join(boardRoot, boardDataRel);
  const worktreesRel = envValue("BOARD_WORKTREES") ?? ".questboard/worktrees";
  const worktrees = path.isAbsolute(worktreesRel)
    ? worktreesRel
    : path.join(boardRoot, worktreesRel);

  const serverPort = envValue("BOARD_SERVER_PORT") ?? "3031";
  const serverUrl = envValue("BOARD_SERVER_URL") ?? `http://localhost:${serverPort}`;

  const promptsDir = path.join(appRoot, "board", "prompts");

  // Auth mode is keyed off ANTHROPIC_API_KEY presence. Base URL alone is
  // meaningless without a key (claude has nothing to authenticate with), so
  // we drop it and warn — base URL with no key is almost always a misfilled
  // .env, not an intentional configuration.
  const rawBaseUrl = envValue("ANTHROPIC_BASE_URL") ?? null;
  const rawApiKey = envValue("ANTHROPIC_API_KEY") ?? null;
  let anthropicBaseUrl: string | null;
  let anthropicApiKey: string | null;
  let authMode: AuthMode;
  if (rawApiKey) {
    anthropicBaseUrl = rawBaseUrl;
    anthropicApiKey = rawApiKey;
    authMode = "bare";
  } else {
    if (rawBaseUrl) {
      process.stderr.write(
        "[dispatcher] warning: ANTHROPIC_BASE_URL is set but ANTHROPIC_API_KEY is empty;\n" +
          "  ignoring base URL and falling back to session (claude login) mode.\n",
      );
    }
    anthropicBaseUrl = null;
    anthropicApiKey = null;
    authMode = "session";
  }

  return {
    appRoot,
    boardRoot,
    boardData,
    serverUrl,
    dbPath: path.join(boardData, "board.sqlite"),
    configJsonPath: path.join(boardData, "config.json"),
    promptPath: path.join(promptsDir, "worker.md"),
    promptsDir,
    logsDir: path.join(boardData, "logs"),
    cardsDir: path.join(boardData, "cards"),
    worktreesDir: worktrees,
    baseBranch: envValue("BOARD_BASE_BRANCH") ?? null,
    anthropicBaseUrl,
    anthropicApiKey,
    authMode,
    heartbeatTimeoutSec: Number(envValue("WORKER_HEARTBEAT_TIMEOUT_SEC") ?? 300),
    killGraceMs: 5_000,
  };
}

/**
 * Load the live board config (concurrency_limit, auto_review, etc.) from
 * the board data dir's config.json. Tolerant of legacy field names like
 * `concurrency` (vs `concurrency_limit`). Falls back to defaults when the
 * file is missing or malformed — this lets the dispatcher boot before the
 * server has materialized the file.
 */
export function loadBoardConfig(
  cfg: DispatcherConfig,
): Pick<
  BoardConfig,
  "auto_review" | "concurrency_limit" | "telegram_enabled" | "dispatch_paused"
> {
  const fallback = {
    auto_review: false,
    concurrency_limit: 8,
    telegram_enabled: false,
    dispatch_paused: false,
  };
  try {
    const raw = fs.readFileSync(cfg.configJsonPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const concurrency =
      typeof parsed.concurrency_limit === "number"
        ? parsed.concurrency_limit
        : typeof parsed.concurrency === "number"
          ? parsed.concurrency
          : fallback.concurrency_limit;
    return {
      auto_review: Boolean(parsed.auto_review ?? fallback.auto_review),
      concurrency_limit: concurrency,
      telegram_enabled: Boolean(parsed.telegram_enabled ?? fallback.telegram_enabled),
      dispatch_paused: Boolean(parsed.dispatch_paused ?? fallback.dispatch_paused),
    };
  } catch {
    return fallback;
  }
}
