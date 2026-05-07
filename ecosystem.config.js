/**
 * PM2 ecosystem for questboard (self-hosted dev configuration).
 *
 * Three long-running processes — server, dispatcher, ui — defined in one
 * file so a single `pm2 start questboard/ecosystem.config.js` brings the
 * whole stack up. Workers (ephemeral Claude Code processes) are NOT
 * managed by PM2; the dispatcher spawns them via child_process.
 *
 * Project / app layout (companion-app model):
 *   appRoot      = this directory (questboard/)
 *   projectRoot  = parent of appRoot (the consuming repo's root)
 *   dataDir      = projectRoot + .questboard/data
 *   worktreesDir = projectRoot + .questboard/worktrees
 *
 * .env loading: PM2 is invoked from a global install and cannot resolve
 * workspace-local `dotenv`, so we parse the env file ourselves with a
 * tiny inline reader. Lookup order:
 *   1. <projectRoot>/.questboard/.env
 *   2. package-local .env fallback
 * Only KEY=value (and KEY="value") lines are supported — matches what
 * `.env.example` ships.
 */
const fs = require("node:fs");
const path = require("node:path");

function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  const text = fs.readFileSync(file, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
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

const appRoot = __dirname;
const projectRoot = path.dirname(appRoot);

const envCandidates = [
  path.join(projectRoot, ".questboard", ".env"),
  path.join(appRoot, ".env"), // package-local env fallback
];
let envFile = null;
let fileEnv = {};
for (const cand of envCandidates) {
  if (fs.existsSync(cand)) {
    envFile = cand;
    fileEnv = loadEnv(cand);
    break;
  }
}

const env = { ...process.env, ...fileEnv, NODE_ENV: "production" };

// Default cwd for child processes is projectRoot so relative BOARD_DATA /
// BOARD_WORKTREES values (e.g. ".questboard/data") resolve there. Server
// and dispatcher also resolve everything explicitly against BOARD_ROOT, so
// cwd is just a safe default.
const childCwd = projectRoot;

module.exports = {
  apps: [
    {
      name: "questboard-server",
      script: path.join(appRoot, "board/server/dist/main.js"),
      cwd: childCwd,
      env,
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "512M",
    },
    {
      name: "questboard-dispatcher",
      script: path.join(appRoot, "board/dispatcher/dist/main.js"),
      cwd: childCwd,
      env,
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "256M",
    },
    {
      name: "questboard-ui",
      script: path.join(appRoot, "ui/node_modules/next/dist/bin/next"),
      args: "start -p " + (env.BOARD_UI_PORT || 3030),
      cwd: path.join(appRoot, "ui"),
      env,
      autorestart: true,
      max_restarts: 10,
    },
  ],
};

// Surface which env file was picked up (visible in PM2 startup logs).
if (envFile) {
  process.stdout.write(`[ecosystem] loaded env from ${envFile}\n`);
} else {
  process.stdout.write(
    "[ecosystem] no .env found at .questboard/.env or package-local .env; relying on process.env\n",
  );
}
