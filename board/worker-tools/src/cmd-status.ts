/**
 * `questboard status` — report on the current detached run, if any.
 *
 * Prints projectRoot, start time, ports, and per-role pid + alive/dead.
 * Returns exit code 0 if at least one role is alive; 1 if start.json
 * is missing or every recorded pid is dead.
 */
import {
  ALL_ROLES,
  findProjectRoot,
  isAlive,
  pidFile,
  readPidFile,
  readStartManifest,
  runtimePathsFor,
} from "./run-paths.js";

export interface CmdStatusOptions {
  root?: string;
}

export async function cmdStatus(opts: CmdStatusOptions): Promise<void> {
  const projectRoot = findProjectRoot(opts.root);
  const rp = runtimePathsFor(projectRoot);
  const manifest = readStartManifest(rp);

  if (!manifest) {
    process.stdout.write(
      `questboard: no detached run for ${projectRoot}\n` +
        "  (no .questboard/run/start.json)\n",
    );
    process.exit(1);
    return;
  }

  process.stdout.write(`Questboard detached run for ${manifest.projectRoot}\n`);
  process.stdout.write(`  started:  ${manifest.startedAtIso}\n`);
  if (manifest.ports.ui != null)
    process.stdout.write(`  UI:       http://localhost:${manifest.ports.ui}\n`);
  if (manifest.ports.server != null)
    process.stdout.write(
      `  API:      http://localhost:${manifest.ports.server}\n`,
    );
  process.stdout.write("\nRoles:\n");

  let aliveCount = 0;
  // Iterate manifest roles first (preserves order), then check any
  // role that has a pid file but isn't in the manifest (out-of-band).
  const seen = new Set<string>();
  for (const r of manifest.roles) {
    seen.add(r.role);
    const livePid = readPidFile(r.pidPath);
    const status =
      livePid != null && livePid === r.pid && isAlive(r.pid)
        ? "alive"
        : "DEAD";
    if (status === "alive") aliveCount += 1;
    process.stdout.write(
      `  ${r.role.padEnd(11)} pid ${String(r.pid).padEnd(8)} ${status}  ${r.logPath}\n`,
    );
  }
  for (const role of ALL_ROLES) {
    if (seen.has(role)) continue;
    const pid = readPidFile(pidFile(rp, role));
    if (pid == null) continue;
    const status = isAlive(pid) ? "alive" : "DEAD";
    if (status === "alive") aliveCount += 1;
    process.stdout.write(
      `  ${role.padEnd(11)} pid ${String(pid).padEnd(8)} ${status}  (not in manifest)\n`,
    );
  }

  if (aliveCount === 0) process.exit(1);
}
