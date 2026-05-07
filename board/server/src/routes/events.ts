/**
 * SSE endpoint: GET /api/events
 *
 * Honors `Last-Event-ID` header for ring-buffer backfill. Sends a `: ping`
 * heartbeat every 25s.
 */
import type { FastifyInstance } from "fastify";
import { attachClient } from "../sse.js";

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/events", async (req, reply) => {
    const headerId = req.headers["last-event-id"];
    const lastEventId =
      typeof headerId === "string" && /^\d+$/.test(headerId) ? Number(headerId) : undefined;
    // CORS must be applied BEFORE hijack — the @fastify/cors hook will not
    // run once the reply is detached. Without this, browsers silently drop
    // the cross-origin EventSource connection from localhost:3030.
    const origin = req.headers.origin;
    if (typeof origin === "string") {
      reply.raw.setHeader("Access-Control-Allow-Origin", origin);
      reply.raw.setHeader("Vary", "Origin");
    }
    // Detach the response from Fastify's lifecycle so we own writes.
    reply.hijack();
    attachClient(reply, lastEventId);
  });
}
