/**
 * SSE broadcaster. Maintains a Set of clients with a small ring buffer for
 * Last-Event-ID backfill (256 events).
 */
import type { FastifyReply } from "fastify";
import type { SseEvent } from "@questboard/core";
import { logger } from "./logger.js";

const RING_SIZE = 256;
const HEARTBEAT_MS = 25_000;

interface Client {
  id: number;
  reply: FastifyReply;
  lastSentId: number;
}

interface BufferedEvent {
  id: number;
  payload: SseEvent;
  ts: string;
}

let nextEventId = 1;
const ring: BufferedEvent[] = [];
const clients = new Set<Client>();
let nextClientId = 1;

function pushRing(ev: BufferedEvent): void {
  ring.push(ev);
  if (ring.length > RING_SIZE) ring.shift();
}

function writeEvent(reply: FastifyReply, ev: BufferedEvent): void {
  const data =
    `id: ${ev.id}\n` +
    `event: ${ev.payload.type}\n` +
    `data: ${JSON.stringify({ ...ev.payload, ts: ev.ts })}\n\n`;
  reply.raw.write(data);
}

export function broadcast(payload: SseEvent): void {
  const ev: BufferedEvent = {
    id: nextEventId++,
    payload,
    ts: new Date().toISOString(),
  };
  pushRing(ev);
  for (const c of clients) {
    try {
      writeEvent(c.reply, ev);
      c.lastSentId = ev.id;
    } catch (err) {
      logger.warn("sse_write_failed", { clientId: c.id, err: String(err) });
    }
  }
}

/** Attach a new SSE client to the given reply. */
export function attachClient(reply: FastifyReply, lastEventId?: number): () => void {
  reply.raw.setHeader("Content-Type", "text/event-stream");
  reply.raw.setHeader("Cache-Control", "no-cache, no-transform");
  reply.raw.setHeader("Connection", "keep-alive");
  reply.raw.setHeader("X-Accel-Buffering", "no");
  reply.raw.flushHeaders?.();

  const id = nextClientId++;
  const client: Client = { id, reply, lastSentId: lastEventId ?? 0 };
  clients.add(client);

  // Backfill missed events from ring buffer.
  if (lastEventId != null) {
    for (const ev of ring) {
      if (ev.id > lastEventId) writeEvent(reply, ev);
    }
  }

  reply.raw.write(`: connected ${id}\n\n`);

  const hb = setInterval(() => {
    try {
      reply.raw.write(`: ping\n\n`);
    } catch {
      /* will be cleaned up by close handler */
    }
  }, HEARTBEAT_MS);

  const dispose = () => {
    clearInterval(hb);
    clients.delete(client);
  };

  reply.raw.on("close", dispose);
  reply.raw.on("error", (err) => {
    logger.debug("sse_client_error", { id, err: String(err) });
    dispose();
  });

  return dispose;
}

export function clientCount(): number {
  return clients.size;
}
