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
  return BoardConfig.parse({
    git: {
      base_branch: env.BOARD_BASE_BRANCH ?? undefined,
    },
  });
}

/**
 * Decorate the cached BoardConfig with the env-derived `telegram_configured`
 * flag (true iff BOT_TOKEN+CHAT_ID are set). The persisted toggle in
 * `telegram_enabled` is the user's wish; sending also requires the env to be
 * configured. UI consumes both fields independently.
 */
function withDerived(cfg: BoardConfigT): BoardConfigT {
  return {
    ...cfg,
    telegram_configured: telegramEnabled(),
    secret_store_configured: env.SECRET_KEY.trim() !== "",
    auth: {
      ...cfg.auth,
      bare_available: env.ANTHROPIC_API_KEY_CONFIGURED,
    },
  };
}

function normalizeRawConfig(raw: unknown): BoardConfigT {
  const input =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};

  if (input.concurrency_limit == null) {
    input.concurrency_limit = input.concurrency ?? undefined;
  }

  const git =
    input.git && typeof input.git === "object" && !Array.isArray(input.git)
      ? { ...(input.git as Record<string, unknown>) }
      : {};
  if (git.base_branch == null && env.BOARD_BASE_BRANCH) {
    git.base_branch = env.BOARD_BASE_BRANCH;
  }
  input.git = git;

  const commands =
    input.commands && typeof input.commands === "object" && !Array.isArray(input.commands)
      ? { ...(input.commands as Record<string, unknown>) }
      : {};
  const legacyHooks =
    commands.hooks && typeof commands.hooks === "object" && !Array.isArray(commands.hooks)
      ? (commands.hooks as Record<string, unknown>)
      : null;
  const stages =
    commands.stages && typeof commands.stages === "object" && !Array.isArray(commands.stages)
      ? { ...(commands.stages as Record<string, unknown>) }
      : {};
  if (legacyHooks) {
    stages.in_progress ??= pickLegacyStageCommand(legacyHooks, ["worker"]);
    stages.ai_review ??= pickLegacyStageCommand(legacyHooks, ["reviewer"]);
    stages.merging ??= pickLegacyStageCommand(legacyHooks, [
      "merger",
      "merge",
      "post_build",
    ]);
  }
  commands.stages = stages;
  delete commands.hooks;
  delete commands.install;
  delete commands.gates;
  input.commands = commands;

  const environment =
    input.environment &&
    typeof input.environment === "object" &&
    !Array.isArray(input.environment)
      ? { ...(input.environment as Record<string, unknown>) }
      : {};
  const envVars = Array.isArray(environment.env) ? [...environment.env] : [];
  const secretEnvVars = Array.isArray(environment.secret_env)
    ? [...environment.secret_env]
    : [];

  const roles =
    input.roles && typeof input.roles === "object" && !Array.isArray(input.roles)
      ? (input.roles as Record<string, unknown>)
      : {};
  for (const role of ["worker", "reviewer", "merger"]) {
    const roleConfig = roles[role];
    if (!roleConfig || typeof roleConfig !== "object" || Array.isArray(roleConfig)) {
      continue;
    }
    const roleRecord = roleConfig as Record<string, unknown>;
    if (Array.isArray(roleRecord.env)) envVars.push(...roleRecord.env);
    if (Array.isArray(roleRecord.secret_env)) {
      secretEnvVars.push(...roleRecord.secret_env);
    }
  }

  environment.env = dedupeEnvList(envVars);
  environment.secret_env = dedupeEnvList(secretEnvVars);
  input.environment = environment;

  return BoardConfig.parse(input);
}

function pickLegacyStageCommand(
  legacyHooks: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const phase of ["pre", "post"]) {
    for (const key of keys) {
      const value = legacyHooks[key];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const command = (value as Record<string, unknown>)[phase];
      if (typeof command === "string" && command.trim() !== "") {
        out[phase] = command;
        break;
      }
    }
  }
  return out;
}

function dedupeEnvList(items: unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name !== "string" || seen.has(name)) continue;
    seen.add(name);
    out.push(item);
  }
  return out;
}

function stripDerived(cfg: BoardConfigT): BoardConfigT {
  const {
    telegram_configured: _telegramConfigured,
    secret_store_configured: _secretStoreConfigured,
    auth,
    ...rest
  } = cfg;
  const { bare_available: _bareAvailable, ...authPersisted } = auth;
  return { ...rest, auth: authPersisted } as BoardConfigT;
}

function writeMigratedIfNeeded(raw: unknown, parsed: BoardConfigT): void {
  const before = JSON.stringify(raw ?? {}, null, 2) + "\n";
  const after = JSON.stringify(stripDerived(parsed), null, 2) + "\n";
  if (before !== after) {
    writeFileSync(env.CONFIG_PATH, after, "utf8");
  }
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
    cached = normalizeRawConfig(raw);
    writeMigratedIfNeeded(raw, cached);
  } catch (err) {
    logger.warn("config_parse_fail", { err: String(err) });
    cached = defaults();
  }
  return withDerived(cached);
}

export function writeConfig(next: BoardConfigT): void {
  // Strip env-derived flags before persisting — disk is for user truth.
  const persisted = stripDerived(next);
  writeFileSync(env.CONFIG_PATH, JSON.stringify(persisted, null, 2) + "\n", "utf8");
  cached = persisted as BoardConfigT;
}

export function patchConfig(patch: Partial<BoardConfigT>): BoardConfigT {
  const cur = getConfig();
  const curStripped = stripDerived(cur);
  const next = BoardConfig.parse({
    ...curStripped,
    ...patch,
    git: patch.git ? { ...curStripped.git, ...patch.git } : curStripped.git,
    commands: patch.commands
      ? {
          ...curStripped.commands,
          ...patch.commands,
          stages: patch.commands.stages
            ? { ...curStripped.commands.stages, ...patch.commands.stages }
            : curStripped.commands.stages,
        }
      : curStripped.commands,
    roles: patch.roles
      ? {
          ...curStripped.roles,
          ...patch.roles,
          worker: patch.roles.worker
            ? { ...curStripped.roles.worker, ...patch.roles.worker }
            : curStripped.roles.worker,
          reviewer: patch.roles.reviewer
            ? { ...curStripped.roles.reviewer, ...patch.roles.reviewer }
            : curStripped.roles.reviewer,
          merger: patch.roles.merger
            ? { ...curStripped.roles.merger, ...patch.roles.merger }
            : curStripped.roles.merger,
        }
      : curStripped.roles,
    environment: patch.environment
      ? { ...curStripped.environment, ...patch.environment }
      : curStripped.environment,
    auth: patch.auth ? { ...curStripped.auth, ...patch.auth } : curStripped.auth,
    notifications: patch.notifications
      ? { ...curStripped.notifications, ...patch.notifications }
      : curStripped.notifications,
    files: patch.files ? { ...curStripped.files, ...patch.files } : curStripped.files,
  });
  writeConfig(next);
  return getConfig();
}
