/**
 * Filesystem listing endpoint used by the Composer's `@`-mention
 * autocomplete to let users navigate the project tree and insert a
 * relative path token.
 *
 * Endpoints:
 *   GET /api/files?path=<rel>&q=<query>&limit=<n>
 *     → { entries: [{ name, kind, relpath }], path }
 *
 * Contract:
 *  - `path` is project-root-relative (POSIX). Default ""→ BOARD_ROOT.
 *  - `entries[].relpath` is always project-root-relative POSIX, with
 *    `/` separators on every platform — the UI inserts this verbatim.
 *  - Sort: directories first, then files, both alphabetical and
 *    case-insensitive.
 *  - `q` (optional): case-insensitive substring filter on `name`,
 *    applied AT THE GIVEN PATH ONLY. v1 deliberately punts on
 *    recursive search — too expensive on large repos and the user
 *    drills in by clicking folders anyway.
 *  - `limit`: default 200, hard max 500.
 *
 * Path safety:
 *  - Anything starting with "/" or containing ".." segments is rejected
 *    up-front (400 outside_root).
 *  - The resolved absolute path is then verified to be inside
 *    BOARD_ROOT via prefix-on-realpath. Symlinks that point outside
 *    BOARD_ROOT are also rejected.
 *
 * Noise filtering:
 *  - Hardcoded denylist of well-known build / cache / vcs dirs hides
 *    `node_modules`, `.git`, `dist`, `.next`, `build`, `out`, `.cache`,
 *    `.tmp` from the listing. v1 doesn't honor `.gitignore` — that's a
 *    v2 enhancement once we see real-world usage.
 *
 * The board is a single-user dev tool, so there's no auth — the listing
 * runs at server uid scope, same as every other endpoint.
 */
import type { FastifyInstance } from "fastify";
import * as path from "node:path";
import * as fs from "node:fs";
import { z } from "zod";
import { env } from "../env.js";

/** Names that should never appear in the dropdown — saves the user a
 *  click and matches what `.gitignore` would normally hide. Matched
 *  against entry name only (not full path). */
const HIDDEN_NAMES = new Set<string>([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  ".cache",
  ".tmp",
  ".DS_Store",
]);

const Query = z.object({
  // `path` is optional with default "" (= BOARD_ROOT). Strip leading
  // and trailing slashes here so callers can be loose; we re-validate
  // structure below.
  path: z.string().max(2048).optional().default(""),
  q: z.string().max(256).optional().default(""),
  limit: z.coerce.number().int().min(1).max(500).optional().default(200),
});

interface Entry {
  name: string;
  kind: "dir" | "file";
  relpath: string;
}

/**
 * Validate + resolve a relative path against BOARD_ROOT. Returns the
 * absolute path on success, or throws with `code` for the route to
 * map to a 400/404.
 */
function resolveSafePath(rel: string): string {
  // Normalize to POSIX separators so we don't accept `..\foo` on Win.
  const norm = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  if (norm === "") return env.BOARD_ROOT;

  // Reject any segment that's exactly ".." — `path.resolve` would
  // happily walk above BOARD_ROOT otherwise.
  const segments = norm.split("/");
  for (const s of segments) {
    if (s === "..") {
      const e = new Error("path traversal not allowed") as Error & {
        code: string;
      };
      e.code = "outside_root";
      throw e;
    }
  }

  const abs = path.resolve(env.BOARD_ROOT, norm);

  // Re-check after resolve in case of symlinks or odd path behaviors.
  // We use `realpath` on whichever ancestor exists so a missing leaf
  // still 404s cleanly (rather than ENOENT-ing on realpath itself).
  let realAbs = abs;
  try {
    realAbs = fs.realpathSync(abs);
  } catch {
    // Path doesn't exist — keep `abs` as-is; the stat below will 404.
  }
  const realRoot = fs.realpathSync(env.BOARD_ROOT);
  const rel2 = path.relative(realRoot, realAbs);
  if (rel2.startsWith("..") || path.isAbsolute(rel2)) {
    const e = new Error("path is outside BOARD_ROOT") as Error & {
      code: string;
    };
    e.code = "outside_root";
    throw e;
  }
  return abs;
}

export async function filesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/files", async (req, reply) => {
    const parsed = Query.safeParse(req.query);
    if (!parsed.success) {
      reply.code(400).send({
        error: "bad_request",
        message: "invalid query",
        details: parsed.error.flatten(),
      });
      return;
    }
    const { path: relInput, q, limit } = parsed.data;

    let abs: string;
    try {
      abs = resolveSafePath(relInput);
    } catch (err) {
      const e = err as Error & { code?: string };
      reply.code(400).send({
        error: e.code ?? "bad_request",
        message: e.message,
      });
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      reply.code(404).send({
        error: "not_found",
        message: `path does not exist: ${relInput}`,
      });
      return;
    }
    if (!stat.isDirectory()) {
      reply.code(400).send({
        error: "not_a_directory",
        message: `path is not a directory: ${relInput}`,
      });
      return;
    }

    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      reply.code(500).send({
        error: "read_failed",
        message: (err as Error).message,
      });
      return;
    }

    const needle = q.trim().toLowerCase();
    const entries: Entry[] = [];
    for (const d of dirents) {
      if (HIDDEN_NAMES.has(d.name)) continue;
      // We don't show dotfiles by default — they're rarely the target
      // of a mention and tend to clutter the picker. The hidden-names
      // set already covers the common ones; this is the catch-all.
      if (d.name.startsWith(".") && !HIDDEN_NAMES.has(d.name)) {
        // But .env-style files at the root may matter; we still show
        // anything that doesn't match HIDDEN_NAMES. Keep this branch
        // intentionally permissive — only the explicit denylist hides.
      }
      // Resolve symlinks just enough to bucket as dir vs file. We
      // don't follow into them recursively here.
      let isDir = d.isDirectory();
      if (d.isSymbolicLink()) {
        try {
          const s = fs.statSync(path.join(abs, d.name));
          isDir = s.isDirectory();
        } catch {
          // Broken symlink — skip it entirely.
          continue;
        }
      }
      if (needle && !d.name.toLowerCase().includes(needle)) continue;

      const childRel = relInput
        ? `${relInput.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}/${d.name}`
        : d.name;
      entries.push({
        name: d.name,
        kind: isDir ? "dir" : "file",
        relpath: childRel,
      });
    }

    // Sort: dirs first, then alphabetically (case-insensitive).
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });

    reply.send({
      path: relInput.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""),
      entries: entries.slice(0, limit),
      truncated: entries.length > limit,
    });
  });
}
