/**
 * `questboard start` — orchestrator for server, dispatcher, UI.
 *
 * Two modes share the same setup:
 *   - foreground (default): pipes stdout/stderr through role-prefixed
 *     line streams; Ctrl+C tears down all children together.
 *   - `--detach`: spawns each child detached + unref'd, redirects their
 *     stdout/stderr to <projectRoot>/.questboard/run/<role>.log, writes
 *     pid files + start.json, then returns. `questboard stop` is the
 *     symmetric teardown for this mode.
 *
 * Does NOT use PM2. PM2 stays available as an optional, user-driven
 * path via `questboard/ecosystem.config.cjs`.
 *
 * Out of scope:
 *   - log rotation, port-conflict resolution, auto-restart
 *   - launchd / systemd / Windows service integration
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  ALL_ROLES,
  clearPidFile,
  isAlive,
  logFile,
  pidFile,
  readPidFile,
  runtimePathsFor,
  type Role,
  type StartManifest,
} from "./run-paths.js";

export interface CmdStartOptions {
  root?: string;
  ui?: boolean;
  dispatcher?: boolean;
  server?: boolean;
  detach?: boolean;
}

interface ChildSpec {
  role: Role;
  command: string;
  args: string[];
  cwd: string;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v != null && v.trim() !== "" ? v : undefined;
}

function parsePort(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = envValue(env, name);
  const value = raw == null ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer port between 1 and 65535`);
  }
  return value;
}

function findGitRoot(start: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: start,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    });
    return out.trim();
  } catch {
    return null;
  }
}

function walkUp(
  start: string,
  probe: (dir: string) => boolean,
  hops = 12,
): string | null {
  let dir = start;
  for (let i = 0; i < hops; i++) {
    if (probe(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = readFileSync(path, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

interface DiscoveredEnv {
  projectRoot: string;
  envPath: string | null;
  fileEnv: Record<string, string>;
}

function discoverEnv(rootHint: string | undefined): DiscoveredEnv {
  if (rootHint) {
    const projectRoot = resolve(rootHint);
    for (const cand of [
      join(projectRoot, ".questboard", ".env"),
      join(projectRoot, "questboard", ".env"),
    ]) {
      if (existsSync(cand)) {
        return { projectRoot, envPath: cand, fileEnv: parseEnvFile(cand) };
      }
    }
    return { projectRoot, envPath: null, fileEnv: {} };
  }

  const cwd = process.cwd();
  for (const probe of [
    (dir: string): boolean => existsSync(join(dir, ".questboard", ".env")),
    (dir: string): boolean => existsSync(join(dir, "questboard", ".env")),
  ]) {
    const root = walkUp(cwd, probe);
    if (root) {
      const candidate = existsSync(join(root, ".questboard", ".env"))
        ? join(root, ".questboard", ".env")
        : join(root, "questboard", ".env");
      return {
        projectRoot: root,
        envPath: candidate,
        fileEnv: parseEnvFile(candidate),
      };
    }
  }

  const gitRoot = findGitRoot(cwd);
  return {
    projectRoot: gitRoot ?? cwd,
    envPath: null,
    fileEnv: {},
  };
}

function findAppRoot(here: string): string {
  const found = walkUp(here, (dir) =>
    existsSync(join(dir, "board", "prompts")),
  );
  // Fallback: from <appRoot>/board/worker-tools/dist/cmd-start.js, the package
  // root is four levels up.
  return found ?? resolve(here, "..", "..", "..", "..");
}

/**
 * Locate the `next` CLI bin. Two layouts:
 *   - installed npm package: next is hoisted into the consumer's
 *     node_modules and resolves from this bundle's createRequire.
 *   - pnpm workspace dev: next lives under <appRoot>/ui/node_modules,
 *     which isn't on this bundle's resolution path, so anchor a require
 *     at <appRoot>/ui/package.json instead.
 */
function resolveNextBin(appRoot: string): string | null {
  const probes: Array<() => string> = [
    () => createRequire(import.meta.url).resolve("next/dist/bin/next"),
    () =>
      createRequire(join(appRoot, "ui", "package.json")).resolve(
        "next/dist/bin/next",
      ),
  ];
  for (const probe of probes) {
    try {
      return probe();
    } catch {
      /* try next */
    }
  }
  return null;
}

function readJsonFile(path: string): unknown | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function missingUiBuildFiles(uiCwd: string): string[] {
  const nextDir = join(uiCwd, ".next");
  const required = [
    "BUILD_ID",
    "build-manifest.json",
    "routes-manifest.json",
    "server/next-font-manifest.json",
    "server/pages-manifest.json",
  ];
  const missing = required.filter((file) => !existsSync(join(nextDir, file)));

  for (const manifestName of ["build-manifest.json", "app-build-manifest.json"]) {
    const manifest = readJsonFile(join(nextDir, manifestName));
    if (!manifest) continue;
    const refs = collectStrings(manifest).filter((ref) =>
      /^static\/.+\.(js|css)$/.test(ref),
    );
    for (const ref of refs) {
      if (!existsSync(join(nextDir, ref))) missing.push(ref);
    }
  }

  return Array.from(new Set(missing));
}

function canRebuildUi(uiCwd: string): boolean {
  return (
    existsSync(join(uiCwd, "src")) ||
    existsSync(join(uiCwd, "app")) ||
    existsSync(join(uiCwd, "pages"))
  );
}

function ensureUiBuild(uiCwd: string, uiBin: string, env: NodeJS.ProcessEnv): void {
  const missing = missingUiBuildFiles(uiCwd);
  if (missing.length === 0) return;

  if (!canRebuildUi(uiCwd)) {
    process.stderr.write(
      "questboard: packaged UI build is incomplete or stale.\n" +
        missing.slice(0, 8).map((file) => `  - missing ${file}`).join("\n") +
        "\n  Reinstall or upgrade questboard so the package includes a clean UI build.\n",
    );
    process.exit(1);
    return;
  }

  process.stdout.write(
    "questboard: UI build cache is stale; rebuilding it once before start.\n",
  );
  rmSync(join(uiCwd, ".next"), { recursive: true, force: true });
  execFileSync(process.execPath, [uiBin, "build"], {
    cwd: uiCwd,
    env,
    stdio: "inherit",
  });

  const stillMissing = missingUiBuildFiles(uiCwd);
  if (stillMissing.length > 0) {
    process.stderr.write(
      "questboard: UI build is still incomplete after rebuild.\n" +
        stillMissing.slice(0, 8).map((file) => `  - missing ${file}`).join("\n") +
        "\n",
    );
    process.exit(1);
  }
}

function ensureUiApiRewrite(uiCwd: string, serverPort: number): void {
  const manifestPath = join(uiCwd, ".next", "routes-manifest.json");
  const manifest = readJsonFile(manifestPath);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return;
  }

  const nextDestination = `http://127.0.0.1:${serverPort}/api/:path*`;
  let changed = false;
  const rewrites = (manifest as { rewrites?: unknown }).rewrites;
  if (rewrites && typeof rewrites === "object" && !Array.isArray(rewrites)) {
    for (const group of ["beforeFiles", "afterFiles", "fallback"]) {
      const entries = (rewrites as Record<string, unknown>)[group];
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        if (record.source !== "/api/:path*") continue;
        if (record.destination === nextDestination) continue;
        record.destination = nextDestination;
        changed = true;
      }
    }
  }

  if (changed) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  }
}

function ensureUiRequiredServerFiles(uiCwd: string, appRoot: string): void {
  const replacements = [
    ["__QUESTBOARD_UI_DIR__", uiCwd],
    ["__QUESTBOARD_APP_ROOT__", appRoot],
  ] as const;
  for (const manifestPath of [
    join(uiCwd, ".next", "required-server-files.json"),
    join(uiCwd, ".next", "required-server-files.js"),
  ]) {
    if (!existsSync(manifestPath)) continue;
    let text = readFileSync(manifestPath, "utf8");
    for (const [from, to] of replacements) {
      text = text.split(from).join(to);
    }
    writeFileSync(manifestPath, text, "utf8");
  }
}

function streamLines(
  source: NodeJS.ReadableStream | null,
  role: Role,
  sink: NodeJS.WriteStream,
): void {
  if (!source) return;
  const rl = createInterface({ input: source, crlfDelay: Infinity });
  rl.on("line", (line) => {
    sink.write(`[${role}] ${line}\n`);
  });
}

export async function cmdStart(opts: CmdStartOptions): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const appRoot = findAppRoot(here);
  const discovery = discoverEnv(opts.root);

  if (!discovery.envPath) {
    process.stderr.write(
      "questboard: no .questboard/.env found.\n" +
        "  Run `npx questboard init` from inside your Git repository first.\n",
    );
    process.exit(1);
    return;
  }

  // Merge env: file env first, real process env wins (ad-hoc overrides), then
  // pin the path-related variables to safe values.
  const mergedEnv: NodeJS.ProcessEnv = { ...discovery.fileEnv, ...process.env };
  const fileBoardRoot = envValue(discovery.fileEnv as NodeJS.ProcessEnv, "BOARD_ROOT");
  const procBoardRoot = envValue(process.env, "BOARD_ROOT");
  const projectRoot = resolve(procBoardRoot ?? fileBoardRoot ?? discovery.projectRoot);
  mergedEnv.BOARD_ROOT = projectRoot;
  mergedEnv.BOARD_DATA =
    envValue(process.env, "BOARD_DATA") ??
    envValue(discovery.fileEnv as NodeJS.ProcessEnv, "BOARD_DATA") ??
    ".questboard/data";
  mergedEnv.BOARD_WORKTREES =
    envValue(process.env, "BOARD_WORKTREES") ??
    envValue(discovery.fileEnv as NodeJS.ProcessEnv, "BOARD_WORKTREES") ??
    ".questboard/worktrees";
  mergedEnv.NODE_ENV = process.env.NODE_ENV ?? "production";
  // Foreground mode: surface server info-level events to stdout so the user
  // sees lifecycle messages alongside dispatcher / UI output. The JSONL
  // logger still writes to .questboard/data/logs/server.jsonl in parallel.
  mergedEnv.BOARD_LOG_STDOUT = process.env.BOARD_LOG_STDOUT ?? "1";

  let serverPort: number;
  let uiPort: number;
  try {
    serverPort = parsePort(mergedEnv, "BOARD_SERVER_PORT", 3031);
    uiPort = parsePort(mergedEnv, "BOARD_UI_PORT", 3030);
  } catch (err) {
    process.stderr.write(
      `questboard: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
    return;
  }

  const wantServer = opts.server !== false;
  const wantUi = opts.ui !== false;
  const wantDispatcher = opts.dispatcher !== false;

  if (!wantServer && !wantUi && !wantDispatcher) {
    process.stderr.write(
      "questboard: nothing to start (--no-server, --no-dispatcher, and --no-ui all set).\n",
    );
    process.exit(1);
    return;
  }

  const serverEntry = join(appRoot, "board", "server", "dist", "main.js");
  const dispatcherEntry = join(appRoot, "board", "dispatcher", "dist", "main.js");
  const uiCwd = join(appRoot, "ui");
  const uiBin = wantUi ? resolveNextBin(appRoot) : null;

  const missing: string[] = [];
  if (wantServer && !existsSync(serverEntry))
    missing.push(`server entry: ${serverEntry}`);
  if (wantDispatcher && !existsSync(dispatcherEntry))
    missing.push(`dispatcher entry: ${dispatcherEntry}`);
  if (wantUi && uiBin == null)
    missing.push(
      "UI bin (next not found in node_modules — install root deps or pass --no-ui)",
    );
  if (missing.length) {
    process.stderr.write(
      "questboard: required artifacts not found. Did you run `pnpm build` in the questboard package?\n" +
        missing.map((m) => `  - ${m}`).join("\n") +
        "\n",
    );
    process.exit(1);
    return;
  }
  if (wantUi && uiBin != null) {
    ensureUiBuild(uiCwd, uiBin, mergedEnv);
    ensureUiRequiredServerFiles(uiCwd, appRoot);
    ensureUiApiRewrite(uiCwd, serverPort);
  }

  const specs: ChildSpec[] = [];
  if (wantServer) {
    specs.push({
      role: "server",
      command: process.execPath,
      args: [serverEntry],
      cwd: projectRoot,
    });
  }
  if (wantDispatcher) {
    specs.push({
      role: "dispatcher",
      command: process.execPath,
      args: [dispatcherEntry],
      cwd: projectRoot,
    });
  }
  if (wantUi) {
    // uiBin is non-null here: the missing-artifact check above already
    // bailed if resolveNextBin returned null.
    specs.push({
      role: "ui",
      command: process.execPath,
      args: [uiBin as string, "start", "-p", String(uiPort)],
      cwd: uiCwd,
    });
  }

  // Detached mode: spawn each child with stdio redirected to per-role
  // log files, write pid files + start.json, then return. The CLI parent
  // exits cleanly while the children keep running; `questboard stop`
  // reads the pid files and terminates them.
  if (opts.detach) {
    runDetached({
      appRoot,
      projectRoot,
      specs,
      mergedEnv,
      ports: {
        ui: wantUi ? uiPort : undefined,
        server: wantServer ? serverPort : undefined,
      },
    });
    return;
  }

  // Foreground banner.
  const banner: string[] = [];
  banner.push(`Questboard running for ${projectRoot}`);
  banner.push("");
  if (wantUi) banner.push(`UI:  http://localhost:${uiPort}`);
  if (wantServer) banner.push(`API: http://localhost:${serverPort}`);
  if (!wantServer) {
    banner.push(
      "Note: --no-server means the UI must reach the API on a remote host;",
    );
    banner.push("      configure that via your UI build / environment.");
  }
  banner.push("");
  banner.push("Logs are streamed below. Press Ctrl+C to stop.");
  banner.push("");
  process.stdout.write(banner.join("\n") + "\n");

  const children = new Map<Role, ChildProcess>();
  let shuttingDown = false;
  let abnormal = false;
  let viaSignal = false;

  function finalExit(): void {
    const exitCode = abnormal ? 1 : viaSignal ? 130 : 0;
    process.exit(exitCode);
  }

  function triggerShutdown(signaled: boolean): void {
    if (shuttingDown) return;
    shuttingDown = true;
    viaSignal = signaled;

    if (children.size === 0) {
      finalExit();
      return;
    }

    for (const child of children.values()) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }

    // SIGKILL after grace period. No unref — we need the timer to keep the
    // loop alive until either the children exit naturally or we hard-kill.
    setTimeout(() => {
      for (const child of children.values()) {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }, 5_000);
  }

  for (const spec of specs) {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.set(spec.role, child);

    streamLines(child.stdout, spec.role, process.stdout);
    streamLines(child.stderr, spec.role, process.stderr);

    child.on("exit", (code, signal) => {
      children.delete(spec.role);
      if (shuttingDown) {
        if (children.size === 0) finalExit();
        return;
      }
      abnormal = true;
      process.stderr.write(
        `\nquestboard: ${spec.role} exited unexpectedly (code=${code}, signal=${signal}). Shutting down.\n`,
      );
      triggerShutdown(false);
    });

    child.on("error", (err) => {
      process.stderr.write(`[${spec.role}] spawn error: ${err.message}\n`);
      if (shuttingDown) return;
      abnormal = true;
      triggerShutdown(false);
    });
  }

  process.on("SIGINT", () => triggerShutdown(true));
  process.on("SIGTERM", () => triggerShutdown(true));
}

interface DetachContext {
  appRoot: string;
  projectRoot: string;
  specs: ChildSpec[];
  mergedEnv: NodeJS.ProcessEnv;
  ports: { ui?: number; server?: number };
}

/**
 * Detached spawn path. Refuses to start if a previous detached run still
 * has a live pid for any of the requested roles — `questboard stop` is
 * the symmetric teardown.
 */
function runDetached(ctx: DetachContext): void {
  const rp = runtimePathsFor(ctx.projectRoot);
  mkdirSync(rp.runDir, { recursive: true });

  // Refuse to start over a live previous run.
  const conflicts: Array<{ role: Role; pid: number }> = [];
  for (const spec of ctx.specs) {
    const existing = readPidFile(pidFile(rp, spec.role));
    if (existing != null && isAlive(existing)) {
      conflicts.push({ role: spec.role, pid: existing });
    } else if (existing != null) {
      // Stale pid — clean it up so this start succeeds.
      clearPidFile(pidFile(rp, spec.role));
    }
  }
  if (conflicts.length) {
    process.stderr.write(
      `questboard: detached run already active for ${ctx.projectRoot}\n` +
        conflicts
          .map((c) => `  - ${c.role} (pid ${c.pid})`)
          .join("\n") +
        "\n  Run `questboard stop` first, or `questboard status` to inspect.\n",
    );
    process.exit(1);
    return;
  }

  const startedAtIso = new Date().toISOString();
  const manifestRoles: StartManifest["roles"] = [];

  for (const spec of ctx.specs) {
    const logPath = logFile(rp, spec.role);
    const pidPath = pidFile(rp, spec.role);
    // Open the log file in append mode and dup the fd into the child.
    // Parent's copy is closed after spawn; child keeps writing post-detach.
    const fd = openSync(logPath, "a");
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: ctx.mergedEnv,
      detached: true,
      stdio: ["ignore", fd, fd],
    });
    if (child.pid == null) {
      process.stderr.write(
        `questboard: failed to spawn ${spec.role} (no pid).\n`,
      );
      process.exit(1);
      return;
    }
    writeFileSync(pidPath, String(child.pid));
    child.unref();
    manifestRoles.push({
      role: spec.role,
      pid: child.pid,
      logPath,
      pidPath,
    });
  }

  const manifest: StartManifest = {
    projectRoot: ctx.projectRoot,
    appRoot: ctx.appRoot,
    startedAtIso,
    roles: manifestRoles,
    ports: ctx.ports,
  };
  writeFileSync(rp.startJson, JSON.stringify(manifest, null, 2) + "\n");

  // Print a short summary so the user knows where to look.
  const lines: string[] = [];
  lines.push(`Questboard started in background for ${ctx.projectRoot}`);
  lines.push("");
  if (ctx.ports.ui != null) lines.push(`UI:  http://localhost:${ctx.ports.ui}`);
  if (ctx.ports.server != null)
    lines.push(`API: http://localhost:${ctx.ports.server}`);
  lines.push("");
  lines.push("Roles:");
  for (const r of manifestRoles) {
    lines.push(`  ${r.role.padEnd(11)} pid ${r.pid}  log ${r.logPath}`);
  }
  lines.push("");
  lines.push("  questboard status   — check liveness");
  lines.push("  questboard logs     — tail role logs");
  lines.push("  questboard stop     — stop all roles");
  lines.push("");
  process.stdout.write(lines.join("\n"));
  // Reference ALL_ROLES so unused-import lint rules stay quiet (it's
  // exported for the stop / status / logs commands).
  void ALL_ROLES;
}
