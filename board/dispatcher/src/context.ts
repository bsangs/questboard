/**
 * Helpers that pull additional context (base prompt, card scope) from the
 * board data dir. The dispatcher injects these into every spawn so the
 * worker / reviewer / merger sees project-wide guidance plus card-scope
 * specific guidance without ever talking to the server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createDecipheriv, createHash } from "node:crypto";
import {
  BoardConfig,
  buildToolGuidanceSection,
  type MergeCommandsConfig,
} from "@questboard/core";
import type { DispatcherConfig } from "./config.js";

type HelperRole = "worker" | "reviewer" | "merger";
export type StageCommandStage =
  | "in_progress"
  | "ai_review"
  | "merging"
  | "stuck";
export type StageCommandPhase = "pre" | "post";

interface HelperEnvVar {
  name: string;
  value: string;
}

interface HelperSecretEnvVar {
  name: string;
  secret_ref: string;
}

interface SecretStoreFile {
  secrets?: Record<
    string,
    {
      iv: string;
      tag: string;
      ciphertext: string;
    }
  >;
}

function readConfigJson(cfg: DispatcherConfig): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(cfg.configJsonPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
}

function isEnvVar(value: unknown): value is HelperEnvVar {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" && typeof record.value === "string";
}

function isSecretEnvVar(value: unknown): value is HelperSecretEnvVar {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    typeof record.secret_ref === "string"
  );
}

function decryptSecretValue(cfg: DispatcherConfig, ref: string): string | null {
  const rawKey = process.env.SECRET_KEY;
  if (!rawKey || rawKey.trim() === "") return null;
  try {
    const store = JSON.parse(
      fs.readFileSync(path.join(cfg.boardData, "secrets.json"), "utf8"),
    ) as SecretStoreFile;
    const record = store.secrets?.[ref];
    if (!record) return null;
    const key = createHash("sha256").update(rawKey, "utf8").digest();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(record.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Read `.questboard/data/base-prompt.md`. Empty string if it doesn't exist
 * yet — dispatcher will simply not prepend anything.
 */
export function readBasePrompt(cfg: DispatcherConfig): string {
  const p = path.join(cfg.boardData, "base-prompt.md");
  try {
    return fs.readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Look up a scope definition from `.questboard/data/config.json`'s `scopes`
 * array. Returns null if not found / file unreadable. Best-effort — config
 * is the server's responsibility, we just read it.
 */
export function readScope(
  cfg: DispatcherConfig,
  scopeId: string | null | undefined,
): { id: string; label: string; description: string; cwd: string | null } | null {
  if (!scopeId) return null;
  try {
    const raw = fs.readFileSync(cfg.configJsonPath, "utf8");
    const parsed = JSON.parse(raw) as {
      scopes?: {
        id: string;
        label: string;
        description?: string;
        cwd?: string | null;
      }[];
    };
    const found = parsed.scopes?.find((s) => s.id === scopeId);
    if (!found) return null;
    const cwdRaw = typeof found.cwd === "string" ? found.cwd.trim() : "";
    return {
      id: found.id,
      label: found.label,
      description: found.description ?? "",
      cwd: cwdRaw === "" ? null : cwdRaw,
    };
  } catch {
    return null;
  }
}

export function readRolePromptAppend(
  cfg: DispatcherConfig,
  role: HelperRole,
): string {
  const parsed = readConfigJson(cfg);
  const roles = parsed.roles;
  if (!roles || typeof roles !== "object" || Array.isArray(roles)) return "";
  const roleConfig = (roles as Record<string, unknown>)[role];
  if (
    !roleConfig ||
    typeof roleConfig !== "object" ||
    Array.isArray(roleConfig)
  ) {
    return "";
  }
  const value = (roleConfig as Record<string, unknown>).prompt_append;
  return typeof value === "string" ? value.trim() : "";
}

export function readHelperEnvironment(cfg: DispatcherConfig): Record<string, string> {
  const parsed = readConfigJson(cfg);
  const environment = parsed.environment;
  if (
    !environment ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    return {};
  }

  const out: Record<string, string> = {};
  const envVars = (environment as Record<string, unknown>).env;
  if (Array.isArray(envVars)) {
    for (const item of envVars) {
      if (isEnvVar(item)) out[item.name] = item.value;
    }
  }

  const secretVars = (environment as Record<string, unknown>).secret_env;
  if (Array.isArray(secretVars)) {
    for (const item of secretVars) {
      if (!isSecretEnvVar(item)) continue;
      const value = decryptSecretValue(cfg, item.secret_ref);
      if (value != null) out[item.name] = value;
    }
  }
  return out;
}

export function readStageCommand(
  cfg: DispatcherConfig,
  stage: StageCommandStage,
  phase: StageCommandPhase,
): string | null {
  const parsed = readConfigJson(cfg);
  const commands = parsed.commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands)) {
    return null;
  }
  const stages = (commands as Record<string, unknown>).stages;
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) return null;
  const stageCommands = (stages as Record<string, unknown>)[stage];
  if (
    !stageCommands ||
    typeof stageCommands !== "object" ||
    Array.isArray(stageCommands)
  ) {
    return null;
  }
  const command = (stageCommands as Record<string, unknown>)[phase];
  if (typeof command !== "string") return null;
  return command.trim() === "" ? null : command;
}

export function readMergeCommands(cfg: DispatcherConfig): MergeCommandsConfig {
  const parsed = BoardConfig.safeParse(readConfigJson(cfg));
  if (parsed.success) return parsed.data.commands.merge;
  return BoardConfig.parse({}).commands.merge;
}

export function readBaseBranch(cfg: DispatcherConfig): string {
  const parsed = BoardConfig.safeParse(readConfigJson(cfg));
  if (parsed.success) return parsed.data.git.base_branch;
  return cfg.baseBranch ?? BoardConfig.parse({}).git.base_branch;
}

/**
 * Compose the final system prompt from: base prompt → scope description →
 * role-specific prompt (worker.md / reviewer.md / merger.md). All three
 * are joined with horizontal rules so the model can see the layering.
 */
export function readToolGuidance(
  cfg: DispatcherConfig,
  allowedTools: readonly string[],
): string {
  const guidanceByTool: Record<string, string> = {};
  for (const tool of allowedTools) {
    const p = path.join(
      cfg.promptsDir,
      "claude-code",
      "tool-guidance",
      `${tool}.md`,
    );
    try {
      guidanceByTool[tool] = fs.readFileSync(p, "utf8");
    } catch {
      /* Guidance is optional for each tool. */
    }
  }
  return buildToolGuidanceSection(guidanceByTool);
}

export function composeSystemPrompt(parts: {
  basePrompt: string;
  scopeDescription: string;
  toolGuidance?: string;
  rolePrompt: string;
  rolePromptAppend?: string;
}): string {
  const sections: string[] = [];
  if (parts.basePrompt) {
    sections.push("# Project base prompt\n\n" + parts.basePrompt);
  }
  if (parts.scopeDescription) {
    sections.push("# Scope guidance\n\n" + parts.scopeDescription);
  }
  if (parts.toolGuidance) {
    sections.push("# Tool usage guidance\n\n" + parts.toolGuidance);
  }
  sections.push(parts.rolePrompt);
  if (parts.rolePromptAppend) {
    sections.push("# Custom role prompt\n\n" + parts.rolePromptAppend);
  }
  return sections.join("\n\n---\n\n");
}
