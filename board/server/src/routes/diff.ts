/**
 * GET /api/cards/:id/diff — `git diff origin/main...origin/worker/card-<id>`.
 * Returns raw text plus a coarse per-file summary parsed from the diff itself.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { diffMainTo } from "../git.js";

const CardIdParam = z.object({ id: z.string().regex(/^\d{4}$/) });

interface FileEntry {
  path: string;
  additions: number;
  deletions: number;
}

function summarizeDiff(raw: string): FileEntry[] {
  const files: FileEntry[] = [];
  let cur: FileEntry | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (cur) files.push(cur);
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      cur = { path: m?.[2] ?? "(unknown)", additions: 0, deletions: 0 };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) cur.additions++;
    else if (line.startsWith("-")) cur.deletions++;
  }
  if (cur) files.push(cur);
  return files;
}

export async function diffRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/cards/:id/diff", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const raw = await diffMainTo(id);
      reply.send({ raw, files: summarizeDiff(raw) });
    } catch (err) {
      const e = err as Error & { code?: string };
      reply.code(500).send({ error: e.code ?? "diff_failed", message: e.message });
    }
  });
}
