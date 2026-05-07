/**
 * Project-wide base prompt the dispatcher prepends to every helper's system
 * prompt. Lives in `.questboard/data/base-prompt.md` so the user can commit
 * it alongside board state. Edited via UI Settings.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "./env.js";

const DEFAULT = `# Project base prompt

(Edit this from the UI Settings drawer. Anything you put here is shown to
EVERY worker / reviewer / merger spawned for this board, in addition to
their role-specific system prompt.)

Use this for:

- A short description of what the project is and who uses it.
- Conventions / coding style the AI must follow.
- Tools / commands that are standard in this repo (e.g. test command).
- Anything the AI should know once-per-card and never re-discover.
`;

mkdirSync(dirname(env.BASE_PROMPT_PATH), { recursive: true });

export function getBasePrompt(): string {
  if (!existsSync(env.BASE_PROMPT_PATH)) {
    writeFileSync(env.BASE_PROMPT_PATH, DEFAULT, "utf8");
    return DEFAULT;
  }
  return readFileSync(env.BASE_PROMPT_PATH, "utf8");
}

export function setBasePrompt(text: string): void {
  writeFileSync(env.BASE_PROMPT_PATH, text, "utf8");
}
