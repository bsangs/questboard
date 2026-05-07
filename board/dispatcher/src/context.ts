/**
 * Helpers that pull additional context (base prompt, card scope) from the
 * board data dir. The dispatcher injects these into every spawn so the
 * worker / reviewer / merger sees project-wide guidance plus card-scope
 * specific guidance without ever talking to the server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DispatcherConfig } from "./config.js";

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

/**
 * Read `merger_post_build_command` from `.questboard/data/config.json`.
 * Returns the raw string (possibly multi-line) for injection as the
 * `BOARD_MERGER_POST_BUILD_CMD` env var on the merger spawn. Returns
 * `null` if not set, empty/whitespace, or the file is unreadable —
 * dispatcher just won't set the env var in that case (merger then
 * skips the step per its system prompt).
 */
export function readMergerPostBuildCmd(cfg: DispatcherConfig): string | null {
  try {
    const raw = fs.readFileSync(cfg.configJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { merger_post_build_command?: unknown };
    const v = parsed.merger_post_build_command;
    if (typeof v !== "string") return null;
    return v.trim() === "" ? null : v;
  } catch {
    return null;
  }
}

/**
 * Compose the final system prompt from: base prompt → scope description →
 * role-specific prompt (worker.md / reviewer.md / merger.md). All three
 * are joined with horizontal rules so the model can see the layering.
 */
export function composeSystemPrompt(parts: {
  basePrompt: string;
  scopeDescription: string;
  rolePrompt: string;
}): string {
  const sections: string[] = [];
  if (parts.basePrompt) {
    sections.push("# Project base prompt\n\n" + parts.basePrompt);
  }
  if (parts.scopeDescription) {
    sections.push("# Scope guidance\n\n" + parts.scopeDescription);
  }
  sections.push(parts.rolePrompt);
  return sections.join("\n\n---\n\n");
}
