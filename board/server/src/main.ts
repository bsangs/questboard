/**
 * @questboard/server entrypoint.
 *
 * Boot order:
 *   1. Load env (.questboard/.env, package-local fallback, or cwd .env).
 *   2. Open + migrate SQLite (handled by ./db).
 *   3. Bootstrap: rebuild SQLite from filesystem source-of-truth.
 *   4. Build Fastify, register routes, start listening.
 */
import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { bootstrapFromFs } from "./bootstrap.js";
import { sweepStaleUploads } from "./attachments.js";
import { cardsRoutes } from "./routes/cards.js";
import { commentsRoutes } from "./routes/comments.js";
import { diffRoutes } from "./routes/diff.js";
import { configRoutes } from "./routes/config.js";
import { eventsRoutes } from "./routes/events.js";
import { statsRoutes } from "./routes/stats.js";
import { telegramRoutes } from "./routes/telegram.js";
import { basePromptRoutes } from "./routes/base-prompt.js";
import { systemRoutes } from "./routes/system.js";
import { filesRoutes } from "./routes/files.js";
import { attachmentsRoutes } from "./routes/attachments.js";
import { composerRoutes } from "./composer/routes.js";
import { composerMcpRoutes } from "./composer/mcp.js";

async function main(): Promise<void> {
  const stats = bootstrapFromFs();
  // Best-effort one-shot cleanup of orphaned upload-pool dirs older than
  // 24h. Never throws; sweep counts log via the attachments module.
  sweepStaleUploads();
  logger.info("server_starting", {
    port: env.BOARD_SERVER_PORT,
    board_root: env.BOARD_ROOT,
    bootstrap: stats,
  });

  const app = Fastify({
    logger: false, // we use our own JSONL logger
    bodyLimit: 4 * 1024 * 1024,
    disableRequestLogging: true,
  });

  // CORS allowlist: localhost defaults + BOARD_CORS_ALLOWED_ORIGINS extras.
  // See env.ts for the parser; "*" is rejected at boot.
  await app.register(cors, {
    origin: env.CORS_ORIGINS,
    credentials: false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  // Multipart for image attachments. No explicit limit — user opted out
  // of size caps. Keep `attachFieldsToBody: false` so routes can use
  // the iterator API (`req.file()`); bodyLimit above only applies to
  // JSON, not multipart parts.
  await app.register(multipart, {
    limits: {
      // Per spec: no size limit. Set to Infinity-equivalent. Fastify's
      // default 1MB cap would silently truncate large pastes.
      fileSize: Number.MAX_SAFE_INTEGER,
      files: 1,
      fields: 4,
    },
  });

  app.get("/api/health", async () => ({ ok: true, ts: new Date().toISOString() }));

  await app.register(cardsRoutes);
  await app.register(commentsRoutes);
  await app.register(diffRoutes);
  await app.register(configRoutes);
  await app.register(eventsRoutes);
  await app.register(statsRoutes);
  await app.register(telegramRoutes);
  await app.register(basePromptRoutes);
  await app.register(systemRoutes);
  await app.register(filesRoutes);
  await app.register(attachmentsRoutes);
  await app.register(composerRoutes);
  await app.register(composerMcpRoutes);

  app.setErrorHandler((err, req, reply) => {
    logger.error("unhandled_route_error", {
      url: req.url,
      method: req.method,
      err: err.message,
      stack: err.stack,
    });
    if (!reply.sent) {
      reply.code(500).send({ error: "internal", message: err.message });
    }
  });

  app.addHook("onRequest", (req, _reply, done) => {
    logger.debug("http_in", { method: req.method, url: req.url });
    done();
  });

  await app.listen({ port: env.BOARD_SERVER_PORT, host: "127.0.0.1" });
  logger.info("server_listening", { port: env.BOARD_SERVER_PORT });

  const shutdown = async (sig: string) => {
    logger.info("server_shutdown", { signal: sig });
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  logger.error("server_boot_failed", { err: String(err), stack: (err as Error).stack });
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
