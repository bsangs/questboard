/**
 * System-side helpers used only by the localhost UI to interact with the
 * developer's machine. The board is a single-user dev tool, so triggering
 * a native macOS folder dialog from a server endpoint is fine.
 *
 * Endpoints:
 *   GET /api/system/board-root      → { boardRoot }
 *   GET /api/system/folder-pick     → { absolute, relative } | { cancelled }
 *
 * folder-pick uses `osascript` (macOS) to pop the system folder picker.
 * Falls back to a 501 on non-darwin platforms — the UI then degrades to a
 * plain text input.
 */
import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import { env } from "../env.js";

function runOsascriptFolderPick(defaultPath: string): Promise<string | null> {
  // Returns absolute POSIX path of the chosen folder, or null on cancel.
  // Errors throw.
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error("folder-pick is only supported on macOS (darwin)"));
      return;
    }
    // Use a tagged sentinel for cancel so we can distinguish it from a
    // real path. AppleScript's `choose folder` raises error -128 on cancel;
    // we trap that and emit CANCELLED on stdout.
    const escDefault = defaultPath.replace(/"/g, '\\"');
    const script = [
      "try",
      `  set f to choose folder with prompt "Pick scope working directory" default location (POSIX file "${escDefault}")`,
      "  return POSIX path of f",
      "on error errMsg number errNum",
      "  if errNum is -128 then",
      "    return \"__QUESTBOARD_CANCELLED__\"",
      "  else",
      "    error errMsg number errNum",
      "  end if",
      "end try",
    ].join("\n");

    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += String(b)));
    child.stderr.on("data", (b) => (err += String(b)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`osascript exited ${code}: ${err.trim()}`));
        return;
      }
      const trimmed = out.trim();
      if (trimmed === "__QUESTBOARD_CANCELLED__" || trimmed === "") {
        resolve(null);
        return;
      }
      // osascript folder POSIX paths come back with a trailing slash —
      // normalize via path.resolve which strips it.
      resolve(path.resolve(trimmed));
    });
  });
}

export async function systemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/system/board-root", async (_req, reply) => {
    reply.send({ boardRoot: env.BOARD_ROOT });
  });

  app.get("/api/system/folder-pick", async (_req, reply) => {
    try {
      const abs = await runOsascriptFolderPick(env.BOARD_ROOT);
      if (abs == null) {
        reply.send({ cancelled: true });
        return;
      }
      // Compute project-relative path (POSIX). Outside-root → return the
      // absolute path with a warning so the UI can surface the issue.
      const rel = path.relative(env.BOARD_ROOT, abs);
      const inside =
        rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        /* ignore */
      }
      if (!stat || !stat.isDirectory()) {
        reply.code(400).send({ error: "not_a_directory", message: abs });
        return;
      }
      reply.send({
        absolute: abs,
        relative: inside ? rel.split(path.sep).join("/") : null,
        boardRoot: env.BOARD_ROOT,
      });
    } catch (err) {
      const e = err as Error;
      reply
        .code(501)
        .send({ error: "picker_unavailable", message: e.message });
    }
  });
}
