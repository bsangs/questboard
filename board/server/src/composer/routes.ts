/**
 * Composer HTTP routes.
 *
 * Composer HTTP API. All mutations broadcast SSE so the UI stays in
 * lockstep without polling.
 *
 * The MCP transport routes (`composerMcpRoutes`) are registered
 * separately in main.ts — they live here-adjacent in mcp.ts because the
 * helper script bridges to them.
 */
import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";
import { createReadStream } from "node:fs";
import { z } from "zod";
import { ComposerMessage } from "@questboard/core";
import { broadcast } from "../sse.js";
import { logger } from "../logger.js";
import {
  appendMessage,
  composerThreadAttachmentsDir,
  composerThreadExists,
  createThread,
  deleteThread,
  getThread,
  listThreadSummaries,
  patchThread,
  readTranscriptRaw,
} from "./threads.js";
import {
  computeBehindMain,
  killThread,
  sendUserMessage,
  stopThread,
  syncWorktreeToMain,
} from "./spawn.js";
import { resolveDecision } from "./gate.js";
import {
  AttachmentError,
  contentTypeForFilename,
  deleteAttachment,
  isValidUploadToken,
  promoteUploadPoolToComposer,
  resolveAttachmentPath,
  saveAttachment,
} from "../attachments.js";

// ─── Common helpers ──────────────────────────────────────────────────────────

const ThreadIdParam = z.object({ id: z.string().min(1).max(64) });

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
  const e = err as Error & { code?: string; status?: number };
  if (e.code === "thread_not_found") {
    reply.code(404).send({ error: "thread_not_found", message: e.message });
    return;
  }
  if (e.code === "concurrency_exhausted") {
    reply.code(e.status ?? 429).send({ error: e.code, message: e.message });
    return;
  }
  logger.error("composer_route_error", { err: e.message, stack: e.stack });
  reply.code(500).send({ error: e.code ?? "internal", message: e.message });
}

/**
 * Single-file multipart consumer. Symmetrical to the helper in
 * routes/attachments.ts; duplicated rather than exported because the
 * attachments module is flat and these two files don't otherwise share
 * surface area.
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

// ─── Body schemas ────────────────────────────────────────────────────────────

const ListQuery = z.object({
  offset: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  q: z.string().optional(),
});

const CreateBody = z.object({
  cwd: z.string().nullable().optional(),
  initial_message: z.string().optional(),
});

const PatchBody = z.object({
  title: z.string().min(1).max(200).optional(),
  archived: z.boolean().optional(),
});

const MessageBody = z.object({
  text: z.string().min(1),
});

const ToolDecisionBody = z.object({
  tool_use_id: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  edited_input: z.unknown().optional(),
  reason: z.string().optional(),
});

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function composerRoutes(app: FastifyInstance): Promise<void> {
  // List threads (sidebar). Not paginated by default — the UI requests
  // a slice via offset/limit if it ever needs to.
  app.get("/api/composer/threads", async (req, reply) => {
    try {
      const q = ListQuery.parse(req.query);
      const result = listThreadSummaries(q);
      reply.send(result);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Create. If `initial_message` is provided, immediately schedule the
  // first send (which lazily creates the worktree + spawns claude). The
  // user's POST returns as soon as the thread row exists; the assistant's
  // response streams in via SSE.
  app.post("/api/composer/threads", async (req, reply) => {
    try {
      const body = CreateBody.parse(req.body ?? {});
      const summary = createThread({ cwd: body.cwd ?? null });
      broadcast({ type: "composer_thread_changed", thread_id: summary.id, summary });
      if (body.initial_message) {
        // Don't await — fire and let the SSE stream do its job. We intentionally
        // catch here so a spawn failure surfaces as a system-role message in
        // the transcript (via spawn.ts onExit) rather than a 500 on the create.
        void sendUserMessage(summary.id, body.initial_message).catch((err) => {
          logger.warn("composer_initial_send_failed", { threadId: summary.id, err: String(err) });
        });
      }
      reply.code(201).send({ thread_id: summary.id, summary });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Get single thread (full payload). Lazily refresh `behind_main` on
  // each load — cheap (one `git rev-list --count`) and keeps the chip
  // accurate without a periodic refresh job.
  app.get("/api/composer/threads/:id", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      const thread = getThread(id);
      // Compute behind-main count from the worktree (if any). Best-effort:
      // failures (no worktree yet, transient git error) leave the stored
      // value alone.
      const behind = await computeBehindMain(id);
      if (behind !== null && behind !== thread.behind_main) {
        try {
          const summary = patchThread(id, { behind_main: behind });
          broadcast({ type: "composer_thread_changed", thread_id: id, summary });
          reply.send({ ...thread, behind_main: behind });
          return;
        } catch (err) {
          logger.warn("composer_behind_main_persist_failed", { id, err: String(err) });
        }
      }
      reply.send(thread);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Delete: stop+kill, cleanup worktree, remove dir.
  app.delete("/api/composer/threads/:id", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      // Verify it exists; getThread throws thread_not_found otherwise.
      getThread(id);
      await killThread(id);
      deleteThread(id);
      broadcast({ type: "composer_thread_changed", thread_id: id, deleted: true });
      reply.send({ ok: true });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Patch (title / archived).
  app.patch("/api/composer/threads/:id", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      const body = PatchBody.parse(req.body);
      const summary = patchThread(id, body);
      broadcast({ type: "composer_thread_changed", thread_id: id, summary });
      reply.send({ summary });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Send user message (spawns claude on demand).
  app.post("/api/composer/threads/:id/messages", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      const body = MessageBody.parse(req.body);
      // Verify thread exists.
      getThread(id);
      await sendUserMessage(id, body.text);
      reply.send({ ok: true });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // SIGINT current process; partial transcript stays.
  app.post("/api/composer/threads/:id/stop", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      getThread(id);
      await stopThread(id);
      reply.send({ ok: true });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Approve / reject a pending make_card or save_plan.
  app.post("/api/composer/threads/:id/tool-decisions", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      const body = ToolDecisionBody.parse(req.body);
      // Verify thread exists.
      getThread(id);

      const outcome = await resolveDecision(id, body.tool_use_id, {
        decision: body.decision,
        edited_input: body.edited_input,
        reason: body.reason,
      });

      // Broadcast resolution either way — the UI clears the gate on
      // this event regardless of approve vs reject. The actual delivery
      // of the tool result to claude happens through the MCP transport:
      // gate.ts resolves the awaiting MCP handler in mcp.ts, which
      // returns a JSON-RPC result over the stdio helper, which claude's
      // own MCP client wires back into the model. We do NOT inject a
      // stream-json tool_result on stdin here — that path is for the
      // (Phase-2) case where claude has died but the user still wants
      // to commit the side-effect.
      const result_ref =
        outcome.ok && "result_ref" in outcome ? outcome.result_ref : undefined;
      broadcast({
        type: "composer_tool_resolved",
        thread_id: id,
        tool_use_id: body.tool_use_id,
        decision: body.decision === "approve" ? "approved" : "rejected",
        result_ref,
      });

      if (outcome.ok) {
        reply.send({ ok: true, result_ref: outcome.result_ref });
      } else {
        reply.send({ ok: false, reason: outcome.reason });
      }
    } catch (err) {
      handleError(err, reply);
    }
  });

  /**
   * Sync the composer worktree to origin/main. Hard-resets the worktree
   * to whatever main currently points at, drops a transcript marker so
   * the user has a record, and refreshes the `behind_main` summary chip.
   *
   * Intentionally NO running / idle guard — sync may run while a turn
   * is in flight. Worst case, claude reads files mid-turn and they swap
   * under it. That's acceptable for a scratch worktree.
   *
   * Response: { ok: true, before, after, added, behind_main }.
   */
  app.post("/api/composer/threads/:id/sync-main", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      // Verify thread exists; throws thread_not_found otherwise.
      getThread(id);
      const result = await syncWorktreeToMain(id);
      // Append a system marker so the transcript records the swap. 8-char
      // SHAs match the format used elsewhere in the board UI.
      try {
        const sysMsg = ComposerMessage.parse({
          id: `sync_${Date.now().toString(36)}`,
          ts: new Date().toISOString(),
          role: "system",
          text: `[main 동기화됨: ${result.before.slice(0, 8)} → ${result.after.slice(0, 8)}, +${result.added} commits]`,
        });
        appendMessage(id, sysMsg);
        broadcast({ type: "composer_message_appended", thread_id: id, message: sysMsg });
      } catch (err) {
        // Transcript-write failure shouldn't fail the sync — the actual
        // git reset already happened.
        logger.warn("composer_sync_marker_failed", { id, err: String(err) });
      }
      // Persist behind_main = 0 and broadcast the summary update so the
      // chip clears across all open clients.
      try {
        const summary = patchThread(id, { behind_main: 0 });
        broadcast({ type: "composer_thread_changed", thread_id: id, summary });
      } catch (err) {
        logger.warn("composer_sync_meta_failed", { id, err: String(err) });
      }
      reply.send({
        ok: true,
        before: result.before,
        after: result.after,
        added: result.added,
        behind_main: 0,
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Attachments (per composer thread) ────────────────────────────────────

  app.post("/api/composer/threads/:id/attachments", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      if (!composerThreadExists(id)) {
        reply.code(404).send({ error: "thread_not_found", message: `composer thread ${id} not found` });
        return;
      }
      const file = await consumeSingleFile(req);
      const result = saveAttachment(composerThreadAttachmentsDir(id), file);
      reply.send({
        path: `attachments/${result.filename}`,
        url: `/api/composer/threads/${id}/attachments/${result.filename}`,
        filename: result.filename,
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.get("/api/composer/threads/:id/attachments/:name", async (req, reply) => {
    try {
      const Params = z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(256),
      });
      const { id, name } = Params.parse(req.params);
      const abs = resolveAttachmentPath(composerThreadAttachmentsDir(id), name);
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

  app.delete("/api/composer/threads/:id/attachments/:name", async (req, reply) => {
    try {
      const Params = z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(256),
      });
      const { id, name } = Params.parse(req.params);
      deleteAttachment(composerThreadAttachmentsDir(id), name);
      reply.code(204).send();
    } catch (err) {
      handleError(err, reply);
    }
  });

  /**
   * Promote upload-pool token → composer thread attachments dir.
   * Symmetrical to /api/uploads/:token/promote (which targets cards).
   * Used when the Composer's draft mode (no thread id yet) accumulated
   * pasted images via /api/uploads, then the first send creates the
   * thread.
   */
  app.post("/api/composer/threads/:id/promote-uploads", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      if (!composerThreadExists(id)) {
        reply.code(404).send({ error: "thread_not_found", message: `composer thread ${id} not found` });
        return;
      }
      const Body = z.object({ token: z.string().min(16).max(64) });
      const { token } = Body.parse(req.body);
      if (!isValidUploadToken(token)) {
        reply.code(400).send({ error: "bad_token", message: "Invalid upload token" });
        return;
      }
      const result = promoteUploadPoolToComposer(token, id);
      reply.send({ ok: true, moved: result.moved, thread_id: id });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Raw transcript (debug / export).
  app.get("/api/composer/threads/:id/transcript.jsonl", async (req, reply) => {
    try {
      const { id } = ThreadIdParam.parse(req.params);
      const raw = readTranscriptRaw(id);
      reply.header("content-type", "application/x-ndjson; charset=utf-8");
      reply.send(raw);
    } catch (err) {
      handleError(err, reply);
    }
  });
}
