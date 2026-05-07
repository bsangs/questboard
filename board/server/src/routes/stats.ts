/**
 * GET /api/stats — small monitoring panel for the UI.
 *
 * Numbers are derived from SQLite. 24h windows look at the comments table
 * (system_event entries) and the cards table.
 */
import type { FastifyInstance } from "fastify";
import { db, countByStatus, sumTokensTotal } from "../db.js";
import { activeWorkerCount } from "../workers.js";
import { getConfig } from "../config.js";

const cutoff24h = (): string => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/stats", async (_req, reply) => {
    const cfg = getConfig();
    const counts = countByStatus();
    const cutoff = cutoff24h();

    const stuck24h = (db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE kind = 'system_event' AND body LIKE '%→ stuck%' AND ts >= ?")
      .get(cutoff) as { n: number }).n;
    const review24h = (db
      .prepare("SELECT COUNT(*) AS n FROM comments WHERE kind = 'system_event' AND body LIKE '%→ human_review%' AND ts >= ?")
      .get(cutoff) as { n: number }).n;
    const done24h = (db
      .prepare("SELECT COUNT(*) AS n FROM cards WHERE done_at >= ?")
      .get(cutoff) as { n: number }).n;
    const tokens24h = (db
      .prepare("SELECT COALESCE(SUM(tokens_used), 0) AS s FROM workers")
      .get() as { s: number }).s;

    reply.send({
      active_workers: activeWorkerCount(),
      queued_cards: counts.ready ?? 0,
      concurrency_limit: cfg.concurrency_limit,
      counts_by_status: counts,
      tokens_24h: tokens24h,
      // Lifetime input + output tokens (incl. archived). Kept legacy
      // `tokens_total` = input + output for back-compat with old UI.
      tokens_total: (() => {
        const t = sumTokensTotal();
        return t.input_total + t.output_total;
      })(),
      tokens_input_total: sumTokensTotal().input_total,
      tokens_output_total: sumTokensTotal().output_total,
      alerts_24h: {
        stuck: stuck24h,
        human_review: review24h,
        done: done24h,
      },
    });
  });
}
