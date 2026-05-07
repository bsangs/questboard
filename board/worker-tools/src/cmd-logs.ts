/**
 * `questboard logs [role]` — stream logs from a detached run.
 *
 * Without a role argument, prints all role log paths and tails them in
 * parallel with `[role]` line prefixes (mirrors foreground formatting).
 * With a role argument, tails just that one log unprefixed.
 *
 * Default behavior is `tail -f`-like (follow). Pass --no-follow to dump
 * the current contents and exit.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import {
  ALL_ROLES,
  findProjectRoot,
  logFile,
  runtimePathsFor,
  type Role,
} from "./run-paths.js";

export interface CmdLogsOptions {
  root?: string;
  follow?: boolean;
}

const VALID_ROLES = new Set<Role>(ALL_ROLES);

export async function cmdLogs(
  roleArg: string | undefined,
  opts: CmdLogsOptions,
): Promise<void> {
  const projectRoot = findProjectRoot(opts.root);
  const rp = runtimePathsFor(projectRoot);
  const follow = opts.follow !== false;

  if (roleArg) {
    if (!VALID_ROLES.has(roleArg as Role)) {
      process.stderr.write(
        `questboard: unknown role '${roleArg}'. Valid: ${ALL_ROLES.join(", ")}\n`,
      );
      process.exit(1);
      return;
    }
    const path = logFile(rp, roleArg as Role);
    if (!existsSync(path)) {
      process.stderr.write(`questboard: log not found: ${path}\n`);
      process.exit(1);
      return;
    }
    await tailOne(path, null, follow);
    return;
  }

  const present = ALL_ROLES.filter((r) => existsSync(logFile(rp, r)));
  if (present.length === 0) {
    process.stderr.write(
      `questboard: no role logs found under ${rp.runDir}\n`,
    );
    process.exit(1);
    return;
  }
  await Promise.all(present.map((r) => tailOne(logFile(rp, r), r, follow)));
}

/**
 * Tail one file; if `prefix` is set, write each line with `[prefix] ` upfront.
 * In follow mode shells out to `tail -f` for OS-native efficiency. In
 * non-follow mode, just streams the existing file once.
 */
function tailOne(
  path: string,
  prefix: string | null,
  follow: boolean,
): Promise<void> {
  if (follow) {
    return new Promise((resolveP) => {
      const tail = spawn("tail", ["-n", "+1", "-f", path], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      const rl = createInterface({ input: tail.stdout, crlfDelay: Infinity });
      rl.on("line", (line) => {
        process.stdout.write(prefix ? `[${prefix}] ${line}\n` : `${line}\n`);
      });
      tail.on("exit", () => resolveP());
      // Forward signals so Ctrl+C cleanly stops all tails.
      const fwd = (sig: NodeJS.Signals): void => {
        try {
          tail.kill(sig);
        } catch {
          /* ignore */
        }
      };
      process.on("SIGINT", () => fwd("SIGINT"));
      process.on("SIGTERM", () => fwd("SIGTERM"));
    });
  }
  return new Promise((resolveP) => {
    const stream = createReadStream(path, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", (line) => {
      process.stdout.write(prefix ? `[${prefix}] ${line}\n` : `${line}\n`);
    });
    rl.on("close", () => resolveP());
  });
}
