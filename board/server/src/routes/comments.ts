/**
 * Comments REST endpoints.
 *  - GET  /api/cards/:id/comments
 *  - POST /api/cards/:id/comments  (with auto-resume on kind=answer + status=stuck)
 *  - POST /api/cards/:id/answer    (convenience alias; forces kind=answer, author=human)
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { listCommentRows } from "../db.js";
import { appendComment, TransitionError } from "../transitions.js";

const CardIdParam = z.object({ id: z.string().regex(/^\d{4}$/) });

const CommentBody = z.object({
  author: z.enum(["human", "worker", "reviewer", "system"]).default("human"),
  kind: z.enum([
    "stuck",
    "answer",
    "resumed",
    "review_note",
    "note",
    "system_event",
    "description_updated",
  ]),
  body: z.string().min(1),
});

const AnswerBody = z.object({ body: z.string().min(1) });

function handleError(err: unknown, reply: import("fastify").FastifyReply): void {
  if (err instanceof TransitionError) {
    reply.code(err.status).send({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    reply.code(400).send({ error: "bad_request", details: err.flatten() });
    return;
  }
  const e = err as Error & { code?: string };
  reply.code(500).send({ error: e.code ?? "internal", message: e.message });
}

export async function commentsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/cards/:id/comments", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      reply.send({ comments: listCommentRows(id) });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/comments", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = CommentBody.parse(req.body);
      const { comment, resumed } = await appendComment(id, body);
      reply.code(201).send({ comment, resumed });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/answer", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = AnswerBody.parse(req.body);
      const { comment, resumed } = await appendComment(id, {
        author: "human",
        kind: "answer",
        body: body.body,
      });
      reply.code(201).send({ comment, resumed, status: resumed ? "ready" : undefined });
    } catch (err) {
      handleError(err, reply);
    }
  });
}
