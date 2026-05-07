/**
 * Detect the toolchain commands a repo uses (install, typecheck, test, build).
 *
 * Strategy:
 *   1. Pick the package manager by lockfile presence:
 *        pnpm-lock.yaml      → pnpm
 *        package-lock.json   → npm
 *        yarn.lock           → yarn
 *        bun.lockb           → bun
 *      Fallback: pnpm (the project's default).
 *   2. Read package.json scripts to confirm which of typecheck/test/build
 *      actually exist. If a script is missing we still return a sensible
 *      default — callers can decide whether to invoke it.
 *
 * Only filesystem reads, no network, no spawn — safe to call at request
 * time per card. Callers should cache the result if they need it hot.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface DiscoveredCommands {
  /** e.g. "pnpm install --frozen-lockfile" */
  install: string;
  /** e.g. "pnpm typecheck" */
  typecheck: string;
  /** e.g. "pnpm test" */
  test: string;
  /** e.g. "pnpm build" */
  build: string;
}

type Pm = "pnpm" | "npm" | "yarn" | "bun";

function detectPm(repoRoot: string): Pm {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "package-lock.json"))) return "npm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoRoot, "bun.lockb"))) return "bun";
  return "pnpm";
}

/** "pnpm install --frozen-lockfile" / "npm ci" / "yarn install --frozen-lockfile" / "bun install --frozen-lockfile". */
function installCmdFor(pm: Pm): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "npm":
      return "npm ci";
    case "yarn":
      return "yarn install --frozen-lockfile";
    case "bun":
      return "bun install --frozen-lockfile";
  }
}

/** Run-script verb the manager uses ("pnpm <s>", "npm run <s>", ...). */
function runVerb(pm: Pm): string {
  switch (pm) {
    case "pnpm":
      return "pnpm";
    case "npm":
      return "npm run";
    case "yarn":
      return "yarn";
    case "bun":
      return "bun run";
  }
}

function readScripts(repoRoot: string): Record<string, string> {
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return {};
  try {
    const txt = readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(txt) as { scripts?: unknown };
    if (parsed && typeof parsed.scripts === "object" && parsed.scripts !== null) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed.scripts as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

/**
 * Return the commands a worker / reviewer / merger should invoke for
 * install + verification. Always returns a value — no nulls — so callers
 * can treat the result as a closed schema.
 */
export function discoverCommands(repoRoot: string): DiscoveredCommands {
  const pm = detectPm(repoRoot);
  const scripts = readScripts(repoRoot);
  const verb = runVerb(pm);

  // Pick a script if it exists; otherwise default to the conventional name
  // (manager will surface "missing script" loudly when invoked, which is
  // the right failure mode — silent skipping would hide real problems).
  const pickScript = (preferred: string[], fallback: string): string => {
    for (const name of preferred) {
      if (scripts[name]) return `${verb} ${name}`;
    }
    return `${verb} ${fallback}`;
  };

  return {
    install: installCmdFor(pm),
    typecheck: pickScript(["typecheck", "type-check", "tsc"], "typecheck"),
    test: pickScript(["test", "tests"], "test"),
    build: pickScript(["build"], "build"),
  };
}

/** Exposed for tests and callers that want just the package-manager guess. */
export function detectPackageManager(repoRoot: string): Pm {
  return detectPm(repoRoot);
}
