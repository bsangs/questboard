/**
 * .questboard/data/config.json read/write. Only the server writes.
 * Schema enforced via core's BoardConfig (with safe defaults).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { BoardConfig, type BoardConfig as BoardConfigT } from "@questboard/core";
import { env } from "./env.js";
import { telegramEnabled } from "./telegram-flag.js";
import { logger } from "./logger.js";

mkdirSync(dirname(env.CONFIG_PATH), { recursive: true });

let cached: BoardConfigT | null = null;

function defaults(): BoardConfigT {
  return BoardConfig.parse({});
}

/**
 * Decorate the cached BoardConfig with the env-derived `telegram_configured`
 * flag (true iff BOT_TOKEN+CHAT_ID are set). The persisted toggle in
 * `telegram_enabled` is the user's wish; sending also requires the env to be
 * configured. UI consumes both fields independently.
 */
function withDerived(cfg: BoardConfigT): BoardConfigT {
  return { ...cfg, telegram_configured: telegramEnabled() };
}

export function getConfig(): BoardConfigT {
  if (cached) return withDerived(cached);
  if (!existsSync(env.CONFIG_PATH)) {
    cached = defaults();
    writeConfig(cached);
    return withDerived(cached);
  }
  try {
    const raw = JSON.parse(readFileSync(env.CONFIG_PATH, "utf8"));
    // Tolerate older keys (e.g. `concurrency` instead of `concurrency_limit`).
    // Pass scopes through verbatim so optional fields like `cwd` survive
    // normalization. BoardConfig.parse() applies the Scope schema (which
    // sets defaults) below.
    const normalized = {
      auto_review: raw.auto_review ?? false,
      concurrency_limit: raw.concurrency_limit ?? raw.concurrency ?? 8,
      // User-controlled toggle. Older configs that didn't have this key
      // default to OFF — users opt in explicitly via Settings.
      telegram_enabled: raw.telegram_enabled ?? false,
      default_language: raw.default_language ?? "en",
      scopes: Array.isArray(raw.scopes) ? raw.scopes : [],
      default_scope:
        typeof raw.default_scope === "string" || raw.default_scope === null
          ? raw.default_scope
          : null,
      merger_post_build_command:
        typeof raw.merger_post_build_command === "string"
          ? raw.merger_post_build_command
          : raw.merger_post_build_command === null
            ? null
            : null,
      merger_post_build_cwd:
        typeof raw.merger_post_build_cwd === "string"
          ? raw.merger_post_build_cwd
          : null,
    };
    cached = BoardConfig.parse(normalized);
  } catch (err) {
    logger.warn("config_parse_fail", { err: String(err) });
    cached = defaults();
  }
  return withDerived(cached);
}

export function writeConfig(next: BoardConfigT): void {
  // Strip the env-derived flag before persisting — disk is for user truth.
  const { telegram_configured: _ignored, ...persisted } = next;
  writeFileSync(env.CONFIG_PATH, JSON.stringify(persisted, null, 2) + "\n", "utf8");
  cached = persisted as BoardConfigT;
}

export function patchConfig(patch: Partial<BoardConfigT>): BoardConfigT {
  const cur = getConfig();
  // Drop `telegram_configured` from the merge input — it's not user-settable.
  const { telegram_configured: _ignored, ...curStripped } = cur;
  const next = BoardConfig.parse({ ...curStripped, ...patch });
  writeConfig(next);
  return getConfig();
}
