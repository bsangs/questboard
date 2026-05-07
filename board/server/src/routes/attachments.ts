/**
 * Attachment HTTP endpoints.
 *
 *   POST   /api/cards/:id/attachments              (multipart/form-data)
 *   GET    /api/cards/:id/attachments/:name        (streams the bytes)
 *   DELETE /api/cards/:id/attachments/:name
 *
 *   POST   /api/uploads                            (multipart/form-data)
 *   GET    /api/uploads/:token/:name
 *   POST   /api/uploads/:token/promote             { card_id }
 *
 * The `/api/uploads/*` family is the temp pool used while the card / thread
 * id doesn't exist yet (NewCardModal, Composer draft mode). The Composer
 * thread side of the promote flow lives in composer/routes.ts because it
 * needs `getThread` validation.
 *
 * Multipart parsing: @fastify/multipart's `attachFieldsToBody` mode would
 * be slick, but it doesn't expose mime-type at the field level cleanly.
 * We use the iterator API (`req.file()`) — single file per request keeps
 * the UX predictable and matches paste/drop semantics.
 */
import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { createReadStream } from "node:fs";
import { z } from "zod";
import {
  AttachmentError,
  cardAttachmentsDir,
  contentTypeForFilename,
  deleteAttachment,
  isValidUploadToken,
  newUploadToken,
  promoteUploadPoolToCard,
  resolveAttachmentPath,
  saveAttachment,
  uploadPoolDir,
} from "../attachments.js";
import { cardExistsOnDisk } from "../files.js";

const CardIdParam = z.object({ id: z.string().regex(/^\d{4}$/) });
const NameParam = z.object({ name: z.string().min(1).max(256) });
const TokenParam = z.object({ token: z.string().min(16).max(64) });
const TokenNameParam = z.object({
  token: z.string().min(16).max(64),
  name: z.string().min(1).max(256),
});

function handleError(err: unknown, reply: import("fastify").FastifyReply): void {
  if (err instanceof AttachmentError) {
    reply.code(err.status).send({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    reply.code(400).send({
      error: "bad_request",
      message: "validation failed",
      details: err.flatten(),
    });
    return;
  }
  const e = err as Error & { code?: string };
  reply.code(500).send({ error: e.code ?? "internal", message: e.message });
}

/**
 * Read the single file part out of a multipart request and buffer it
 * into memory. Throws AttachmentError(400) if no file is present.
 *
 * Buffering vs streaming: we deliberately pull the whole file into RAM
 * before writing because saveAttachment() needs the full bytes (SVG
 * sniff + write-or-reject). Per spec there's no size limit, so callers
 * who paste a huge image will pay for it on this server's heap. That's
 * fine — this is a single-user workbench, not a public service.
 */
async function consumeSingleFile(
  req: import("fastify").FastifyRequest,
): Promise<{ filename: string; mime: string; buffer: Buffer }> {
  if (!req.isMultipart()) {
    throw new AttachmentError(400, "not_multipart", "Request must be multipart/form-data");
  }
  let part: MultipartFile | undefined;
  try {
    part = await req.file();
  } catch (err) {
    throw new AttachmentError(400, "bad_multipart", `Failed to parse multipart: ${(err as Error).message}`);
  }
  if (!part) {
    throw new AttachmentError(400, "no_file", "No file part in request");
  }
  const buffer = await part.toBuffer();
  return {
    filename: part.filename || "image",
    mime: part.mimetype || "application/octet-stream",
    buffer,
  };
}

export async function attachmentsRoutes(app: FastifyInstance): Promise<void> {
  // ── Card attachments ─────────────────────────────────────────────────────

  app.post("/api/cards/:id/attachments", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      // Verify the card actually exists (active or archived). Archived
      // cards shouldn't really be attaching new files, but we don't
      // hard-block — attachments under archive/<id> still resolve via
      // the GET path and the symmetry keeps this endpoint dumb.
      const loc = cardExistsOnDisk(id);
      if (!loc.active && !loc.archived) {
        reply.code(404).send({ error: "card_not_found", message: `card ${id} not found` });
        return;
      }
      const file = await consumeSingleFile(req);
      const result = saveAttachment(cardAttachmentsDir(id), file);
      reply.send({
        path: `attachments/${result.filename}`,
        url: `/api/cards/${id}/attachments/${result.filename}`,
        filename: result.filename,
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.get("/api/cards/:id/attachments/:name", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const { name } = NameParam.parse(req.params);
      const abs = resolveAttachmentPath(cardAttachmentsDir(id), name);
      reply.header("content-type", contentTypeForFilename(name));
      // Cache for an hour — attachment names are immutable (unix-ms prefix)
      // so re-fetching the same name always returns the same bytes.
      reply.header("cache-control", "private, max-age=3600");
      reply.send(createReadStream(abs));
      // Must return reply when streaming from an async handler — otherwise
      // the async fn resolves to undefined, Fastify races the stream with a
      // second send, and the body comes back empty (200 OK, 0 bytes).
      return reply;
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.delete("/api/cards/:id/attachments/:name", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const { name } = NameParam.parse(req.params);
      // Idempotent: 204 whether or not the file existed. The markdown
      // reference, if any, becomes a broken image on next render — the
      // user opted into that by clicking delete.
      deleteAttachment(cardAttachmentsDir(id), name);
      reply.code(204).send();
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Upload pool (no card / thread id yet) ────────────────────────────────

  /**
   * POST /api/uploads — accepts a single file. If the request includes a
   * pre-existing `?token=…`, the file lands in that pool dir; otherwise
   * we mint a fresh token. Returns the token so the UI can keep adding
   * files to the same pool across multiple paste/drop events.
   */
  app.post("/api/uploads", async (req, reply) => {
    try {
      const Q = z.object({ token: z.string().optional() });
      const q = Q.parse(req.query);
      let token = q.token;
      if (token != null) {
        if (!isValidUploadToken(token)) {
          reply.code(400).send({ error: "bad_token", message: "Invalid upload token" });
          return;
        }
      } else {
        token = newUploadToken();
      }
      const file = await consumeSingleFile(req);
      const result = saveAttachment(uploadPoolDir(token), file);
      reply.send({
        token,
        path: `_uploads/${token}/${result.filename}`,
        url: `/api/uploads/${token}/${result.filename}`,
        filename: result.filename,
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.get("/api/uploads/:token/:name", async (req, reply) => {
    try {
      const { token, name } = TokenNameParam.parse(req.params);
      if (!isValidUploadToken(token)) {
        reply.code(400).send({ error: "bad_token", message: "Invalid upload token" });
        return;
      }
      const abs = resolveAttachmentPath(uploadPoolDir(token), name);
      reply.header("content-type", contentTypeForFilename(name));
      reply.header("cache-control", "private, max-age=3600");
      reply.send(createReadStream(abs));
      // Must return reply when streaming from an async handler — otherwise
      // the async fn resolves to undefined, Fastify races the stream with a
      // second send, and the body comes back empty (200 OK, 0 bytes).
      return reply;
    } catch (err) {
      handleError(err, reply);
    }
  });

  /**
   * Promote pool → card. Body: `{ card_id }`. Used by NewCardModal
   * after the create succeeds. We accept missing/empty pool gracefully:
   * the moved list is just empty, no 404 — the create flow shouldn't
   * fail because the user happened to add and remove all attachments.
   */
  app.post("/api/uploads/:token/promote", async (req, reply) => {
    try {
      const { token } = TokenParam.parse(req.params);
      if (!isValidUploadToken(token)) {
        reply.code(400).send({ error: "bad_token", message: "Invalid upload token" });
        return;
      }
      const Body = z.object({ card_id: z.string().regex(/^\d{4}$/) });
      const { card_id } = Body.parse(req.body);
      const loc = cardExistsOnDisk(card_id);
      if (!loc.active && !loc.archived) {
        reply.code(404).send({ error: "card_not_found", message: `card ${card_id} not found` });
        return;
      }
      const result = promoteUploadPoolToCard(token, card_id);
      reply.send({ ok: true, moved: result.moved, card_id });
    } catch (err) {
      handleError(err, reply);
    }
  });
}
