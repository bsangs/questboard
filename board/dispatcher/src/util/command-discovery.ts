/**
 * Discover the project's package-manager + standard scripts (install, test,
 * build, typecheck) so the dispatcher can hand the worker concrete shell
 * invocations via env vars (BOARD_INSTALL_CMD, BOARD_TEST_CMD, …) instead
 * of forcing the worker to re-derive them by reading package.json.
 *
 * Package manager priority (matches user-provided contract):
 *   1. pnpm    — `pnpm-lock.yaml` present at repo root
 *   2. npm     — `package-lock.json` present
 *   3. yarn    — `yarn.lock` present
 *   4. (none)  — repo has no JS/TS package; commands are null
 *
 * Each command is computed independently from `package.json` `scripts`:
 *   - test:      `<pm> run test` if scripts.test exists
 *   - build:     `<pm> run build` if scripts.build exists
 *   - typecheck: `<pm> run typecheck` if scripts.typecheck exists
 *                 (also accepts `type-check`, `tsc`, `check-types` as aliases)
 *   - install:   `<pm> install` (always emitted when a package manager is
 *                 detected — fresh worktree always needs install)
 *
 * Best-effort: any I/O failure returns all-null. This is a HINT to the
 * worker; missing commands just mean the worker won't have those env vars.
 *
 * NOTE: This file is owned by the X-srv agent in the broader plan. We
 * provide a working implementation here so the worker pool isn't blocked
 * on the cross-agent handoff. X-srv may relocate this under
 * `questboard/board/server/src/util/command-discovery.ts` and re-export
 * through `@questboard/core`; if so, this file becomes a thin re-export.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export interface DiscoveredCommands {
  /** Package manager name detected (pnpm/npm/yarn), or null if no JS project. */
  packageManager: "pnpm" | "npm" | "yarn" | null;
  /** Shell command to install dependencies (e.g. `pnpm install`). Null if no PM. */
  installCmd: string | null;
  /** Shell command to run tests, or null if scripts.test is absent. */
  testCmd: string | null;
  /** Shell command to run a production build, or null if scripts.build is absent. */
  buildCmd: string | null;
  /** Shell command to run typecheck, or null if no matching script is present. */
  typecheckCmd: string | null;
}

/**
 * Inspect `cwd` (typically the worker's worktree path) and return the
 * commands the dispatcher will inject as env vars on spawn. See module
 * docs for resolution rules.
 */
export function discoverCommands(cwd: string): DiscoveredCommands {
  const empty: DiscoveredCommands = {
    packageManager: null,
    installCmd: null,
    testCmd: null,
    buildCmd: null,
    typecheckCmd: null,
  };

  let pm: "pnpm" | "npm" | "yarn" | null = null;
  // Lockfile precedence is intentional: pnpm > npm > yarn. Repos sometimes
  // contain multiple lockfiles during a migration; we pick the canonical
  // one rather than failing.
  if (fs.existsSync(path.join(cwd, "pnpm-lock.yaml"))) pm = "pnpm";
  else if (fs.existsSync(path.join(cwd, "package-lock.json"))) pm = "npm";
  else if (fs.existsSync(path.join(cwd, "yarn.lock"))) pm = "yarn";

  if (!pm) return empty;

  // Read package.json to find which scripts are actually defined. Missing
  // file is treated as "no scripts" — install still works, the others
  // gracefully degrade to null.
  let scripts: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    /* fall through with empty scripts */
  }

  // Aliases: a few common typecheck script names map to the same env var.
  const typecheckScript = ["typecheck", "type-check", "tsc", "check-types"].find(
    (k) => typeof scripts[k] === "string" && scripts[k].length > 0,
  );

  const installCmd = `${pm} install`;
  const runPrefix = `${pm} run`;
  return {
    packageManager: pm,
    installCmd,
    testCmd: scripts.test ? `${runPrefix} test` : null,
    buildCmd: scripts.build ? `${runPrefix} build` : null,
    typecheckCmd: typecheckScript ? `${runPrefix} ${typecheckScript}` : null,
  };
}
