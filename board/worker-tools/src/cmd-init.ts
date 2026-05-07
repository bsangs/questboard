/**
 * `questboard init` — scaffold the .questboard/ runtime layout inside an
 * existing Git repository.
 *
 * Idempotent: re-running won't overwrite an existing `.env`, `config.json`,
 * or `.questboardignore`, and won't add duplicate entries to `.gitignore`.
 *
 * Layout created at <projectRoot>:
 *
 *   .questboard/
 *     .env           runtime env (only if missing)
 *     config.json    minimal seed (only if missing)
 *     data/          card / archive / log destination (gitignored)
 *     worktrees/     worker worktrees (gitignored)
 *     run/           CLI-managed PM2 ecosystem + pm2.json
 *   .questboardignore (only if missing)
 *
 * The `.gitignore` at the repo root is patched to include `.questboard/`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

interface InitOpts {
  /** Optional explicit project root. Defaults to git rev-parse --show-toplevel. */
  root?: string;
  /** Suppress info output (errors still emit). */
  quiet?: boolean;
}

interface InitOutcome {
  projectRoot: string;
  created: string[];
  skipped: string[];
  patched: string[];
}

const DEFAULT_ENV = `# Anthropic API — OPTIONAL.
#
# Leave both blank to use your \`claude\` CLI login session (default).
# Set ANTHROPIC_API_KEY only when you need bare-mode auth — proxy / multi-host
# / non-interactive operation. ANTHROPIC_BASE_URL is optional even in bare mode.
#ANTHROPIC_BASE_URL=http://localhost:20128/v1
#ANTHROPIC_API_KEY=

# Telegram (optional — empty values disable notifications)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=

# Server / UI ports
BOARD_SERVER_PORT=3031
BOARD_UI_PORT=3030

# CORS allowlist for split-host deploys (UI on a separate origin from API).
# Leave empty for single-host (localhost:<BOARD_UI_PORT> always allowed).
# Comma-separated absolute origins. "*" is rejected at boot.
#BOARD_CORS_ALLOWED_ORIGINS=https://app.example.com

# Worker / reviewer helper CLI base URL.
BOARD_SERVER_URL=http://localhost:3031

# Concurrency
BOARD_CONCURRENCY=4

# Git
# Optional base branch override. If unset, questboard tries origin/main, main,
# master, then HEAD.
#BOARD_BASE_BRANCH=main

# Paths — runtime data lives under .questboard/ in this project.
# BOARD_ROOT is filled in below; do not leave it empty.
`;

const DEFAULT_CONFIG_JSON = `${JSON.stringify({ version: 1 }, null, 2)}\n`;

const DEFAULT_QUESTBOARDIGNORE = `# Paths the questboard worker / reviewer / merger should not touch.
# Patterns are matched against project-relative paths.
node_modules
dist
build
.next
.env
.env.local
.questboard
`;

const GITIGNORE_BLOCK = `
# Questboard local runtime state
.questboard/
`;

function findGitRoot(start: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return out.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Not inside a Git repository (cwd=${start}). 'questboard init' must be run from inside a repo.\n  ${msg}`,
    );
  }
}

function ensureDir(path: string, created: string[]): void {
  if (existsSync(path)) return;
  mkdirSync(path, { recursive: true });
  created.push(path);
}

function writeIfMissing(
  path: string,
  contents: string,
  created: string[],
  skipped: string[],
): void {
  if (existsSync(path)) {
    skipped.push(path);
    return;
  }
  writeFileSync(path, contents, { encoding: "utf8" });
  created.push(path);
}

/** Append `.questboard/` to .gitignore unless it (or a covering pattern) is already present. */
function patchGitignore(
  projectRoot: string,
  outcome: InitOutcome,
): void {
  const path = join(projectRoot, ".gitignore");
  const exists = existsSync(path);
  const original = exists ? readFileSync(path, "utf8") : "";
  // Quick check: any non-comment line that matches `.questboard` exactly or
  // `.questboard/`. This avoids duplicating entries in repos that already
  // ignore the directory.
  const lines = original.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === ".questboard" || line === ".questboard/" || line === "/.questboard" || line === "/.questboard/") {
      outcome.skipped.push(path);
      return;
    }
  }
  let next = original;
  if (next && !next.endsWith("\n")) next += "\n";
  next += GITIGNORE_BLOCK;
  writeFileSync(path, next, { encoding: "utf8" });
  if (exists) outcome.patched.push(path);
  else outcome.created.push(path);
}

export function runInit(opts: InitOpts = {}): InitOutcome {
  const start = opts.root ? resolve(opts.root) : process.cwd();
  const projectRoot = opts.root ? resolve(opts.root) : findGitRoot(start);
  if (!existsSync(projectRoot)) {
    throw new Error(`projectRoot does not exist: ${projectRoot}`);
  }

  const outcome: InitOutcome = {
    projectRoot,
    created: [],
    skipped: [],
    patched: [],
  };

  const qbDir = join(projectRoot, ".questboard");
  ensureDir(qbDir, outcome.created);
  ensureDir(join(qbDir, "data"), outcome.created);
  ensureDir(join(qbDir, "worktrees"), outcome.created);
  ensureDir(join(qbDir, "run"), outcome.created);

  const envBody = `${DEFAULT_ENV}BOARD_ROOT=${projectRoot}\nBOARD_DATA=.questboard/data\nBOARD_WORKTREES=.questboard/worktrees\n`;
  writeIfMissing(join(qbDir, ".env"), envBody, outcome.created, outcome.skipped);
  writeIfMissing(join(qbDir, "config.json"), DEFAULT_CONFIG_JSON, outcome.created, outcome.skipped);

  writeIfMissing(
    join(projectRoot, ".questboardignore"),
    DEFAULT_QUESTBOARDIGNORE,
    outcome.created,
    outcome.skipped,
  );

  patchGitignore(projectRoot, outcome);

  if (!opts.quiet) printOutcome(outcome);
  return outcome;
}

function rel(projectRoot: string, abs: string): string {
  return abs.startsWith(projectRoot + "/") ? abs.slice(projectRoot.length + 1) : abs;
}

function printOutcome(outcome: InitOutcome): void {
  const lines: string[] = [];
  lines.push(`Questboard initialized for ${outcome.projectRoot}`);
  if (outcome.created.length) {
    lines.push("");
    lines.push("Created:");
    for (const p of outcome.created) lines.push(`  ${rel(outcome.projectRoot, p)}`);
  }
  if (outcome.patched.length) {
    lines.push("");
    lines.push("Patched:");
    for (const p of outcome.patched) lines.push(`  ${rel(outcome.projectRoot, p)}`);
  }
  if (outcome.skipped.length) {
    lines.push("");
    lines.push("Already present (kept):");
    for (const p of outcome.skipped) lines.push(`  ${rel(outcome.projectRoot, p)}`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push(
    "  1. (optional) For bare-mode auth, set ANTHROPIC_API_KEY in",
  );
  lines.push(
    "     .questboard/.env. Otherwise leave it blank and use `claude` login.",
  );
  lines.push("  2. Run: npx questboard start");
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

export interface CmdInitOptions {
  root?: string;
}

export async function cmdInit(opts: CmdInitOptions): Promise<void> {
  runInit({ root: opts.root });
}
