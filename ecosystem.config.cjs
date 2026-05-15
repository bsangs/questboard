/**
 * PM2 ecosystem for questboard (self-hosted dev configuration).
 *
 * Three long-running questboard start processes — server, dispatcher, ui —
 * defined in one file so a single `pm2 start questboard/ecosystem.config.cjs`
 * brings the whole stack up. Workers (ephemeral Claude Code processes) are
 * NOT managed by PM2; the dispatcher spawns them via child_process.
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
const questboardBin = path.join(appRoot, "board/worker-tools/bin/questboard.mjs");

const envCandidates = [
  path.join(projectRoot, ".questboard", ".env"),
  path.join(appRoot, ".env"),
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
const childCwd = projectRoot;

module.exports = {
  apps: [
    {
      name: "questboard-server",
      script: process.execPath,
      args: [questboardBin, "start", "--no-dispatcher", "--no-ui"],
      cwd: childCwd,
      env,
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "512M",
    },
    {
      name: "questboard-dispatcher",
      script: process.execPath,
      args: [questboardBin, "start", "--no-server", "--no-ui"],
      cwd: childCwd,
      env,
      autorestart: true,
      max_restarts: 10,
      max_memory_restart: "256M",
    },
    {
      name: "questboard-ui",
      script: process.execPath,
      args: [questboardBin, "start", "--no-server", "--no-dispatcher"],
      cwd: childCwd,
      env,
      autorestart: true,
      max_restarts: 10,
    },
  ],
};

if (envFile) {
  process.stdout.write(`[ecosystem] loaded env from ${envFile}\n`);
} else {
  process.stdout.write(
    "[ecosystem] no .env found at .questboard/.env or package-local .env; relying on process.env\n",
  );
}
