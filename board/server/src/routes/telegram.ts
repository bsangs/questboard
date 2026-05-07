/**
 * Telegram test endpoint. Lets the UI Settings drawer verify bot creds.
 * Returns ok:false if env unset (silent-skip mode), so the UI shows a
 * helpful "no bot token configured" message rather than a hard error.
 */
import type { FastifyInstance } from "fastify";
import { notify, telegramEnabled } from "../telegram.js";

export async function telegramRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/telegram/test", async (_req, reply) => {
    if (!telegramEnabled()) {
      reply.send({ ok: false, reason: "telegram_disabled" });
      return;
    }
    try {
      await notify("questboard: test alert ✅");
      reply.send({ ok: true });
    } catch (err) {
      reply.code(502).send({
        ok: false,
        reason: "telegram_send_failed",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
