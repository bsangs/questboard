/**
 * GET / POST `/api/base-prompt` — read/write the project-wide base prompt
 * shown to every helper (worker / reviewer / merger).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getBasePrompt, setBasePrompt } from "../base-prompt.js";

const Body = z.object({ text: z.string().max(40_000) });

export async function basePromptRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/base-prompt", async (_req, reply) => {
    reply.send({ text: getBasePrompt() });
  });

  app.post("/api/base-prompt", async (req, reply) => {
    try {
      const body = Body.parse(req.body);
      setBasePrompt(body.text);
      reply.send({ ok: true });
    } catch (err) {
      const e = err as Error & { code?: string };
      reply.code(400).send({ error: e.code ?? "bad_request", message: e.message });
    }
  });
}
