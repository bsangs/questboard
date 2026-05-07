/**
 * Global config endpoints.
 *  - GET  /api/config
 *  - POST /api/config              (full or partial body)
 *  - POST /api/config/auto-review-toggle
 *
 * Switching auto_review OFF→ON sweeps existing human_review cards to ai_review
 * (state-machine.md §3.1). All under one logical operation.
 */
import type { FastifyInstance } from "fastify";
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { getConfig, patchConfig } from "../config.js";
import { sweepHumanReviewToAi } from "../transitions.js";
import { broadcast } from "../sse.js";
import { Scope, type Scope as ScopeT } from "@questboard/core";
import { env } from "../env.js";

const ConfigPatch = z.object({
  auto_review: z.boolean().optional(),
  concurrency_limit: z.number().int().positive().optional(),
  telegram_enabled: z.boolean().optional(),
  dispatch_paused: z.boolean().optional(),
  default_language: z.string().min(2).max(3).optional(),
  scopes: z.array(Scope).optional(),
  default_scope: z.string().nullable().optional(),
  // Empty string is normalized to null (no command) so the UI can clear
  // the field by submitting "".
  merger_post_build_command: z
    .string()
    .max(8_000)
    .nullable()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const trimmed = v.trim();
      return trimmed === "" ? null : v;
    }),
  // Validated against BOARD_ROOT below in the route handler the same way
  // scope.cwd is. Empty string normalizes to null (= use repo root).
  merger_post_build_cwd: z
    .string()
    .nullable()
    .optional()
    .transform((v) => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      const trimmed = v.trim();
      return trimmed === "" ? null : trimmed;
    }),
});

/**
 * Normalize and validate a scope cwd against BOARD_ROOT.
 *
 * Returns one of:
 *   - { ok: true, value: null }       — no cwd override
 *   - { ok: true, value: "<rel>" }    — project-relative POSIX path
 *   - { ok: false, error: "..." }     — invalid: outside root or not a dir
 *
 * Accepts absolute paths that fall under BOARD_ROOT (rewrites to relative)
 * so a UI that sends an absolute path from a folder picker still works.
 */
function normalizeScopeCwd(
  raw: string | null | undefined,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw == null) return { ok: true, value: null };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };

  // Resolve against BOARD_ROOT — works for absolute paths inside the root
  // AND for project-relative paths.
  const abs = path.resolve(env.BOARD_ROOT, trimmed);
  const rel = path.relative(env.BOARD_ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `cwd must be inside BOARD_ROOT (${env.BOARD_ROOT})` };
  }
  // Reject the boardRoot itself silently — that's the same as no override.
  if (rel === "") return { ok: true, value: null };

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return { ok: false, error: `cwd does not exist: ${rel}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `cwd is not a directory: ${rel}` };
  }
  // Store as POSIX-style for portability.
  const posix = rel.split(path.sep).join("/");
  return { ok: true, value: posix };
}

function validateScopes(scopes: ScopeT[]): string | null {
  for (const s of scopes) {
    const r = normalizeScopeCwd(s.cwd ?? null);
    if (!r.ok) return `scope "${s.id}": ${r.error}`;
    s.cwd = r.value; // normalize in place
  }
  return null;
}

export async function configRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/config", async (_req, reply) => {
    reply.send(getConfig());
  });

  app.post("/api/config", async (req, reply) => {
    try {
      const body = ConfigPatch.parse(req.body);
      if (body.scopes) {
        const err = validateScopes(body.scopes);
        if (err) {
          reply.code(400).send({ error: "bad_request", message: err });
          return;
        }
      }
      // Same path-resolve-and-validate-under-BOARD_ROOT logic as scope.cwd.
      // Absolute paths from a folder picker get normalized to relative.
      if (body.merger_post_build_cwd !== undefined) {
        const r = normalizeScopeCwd(body.merger_post_build_cwd);
        if (!r.ok) {
          reply.code(400).send({
            error: "bad_request",
            message: `merger_post_build_cwd: ${r.error}`,
          });
          return;
        }
        body.merger_post_build_cwd = r.value;
      }
      const before = getConfig();
      const next = patchConfig(body);
      let swept: string[] = [];
      if (!before.auto_review && next.auto_review) {
        swept = await sweepHumanReviewToAi();
      }
      broadcast({ type: "config_changed", config: next });
      reply.send({ config: next, swept });
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400).send({ error: "bad_request", details: err.flatten() });
        return;
      }
      reply.code(500).send({ error: "internal", message: (err as Error).message });
    }
  });

  app.post("/api/config/auto-review-toggle", async (_req, reply) => {
    const before = getConfig();
    const next = patchConfig({ auto_review: !before.auto_review });
    let swept: string[] = [];
    if (next.auto_review) swept = await sweepHumanReviewToAi();
    broadcast({ type: "config_changed", config: next });
    reply.send({ auto_review: next.auto_review, swept_count: swept.length });
  });
}
