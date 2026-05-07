/**
 * Tiny module that exposes the "is Telegram configured?" flag. Lives here
 * (not in telegram.ts) so config.ts and telegram.ts can both import it
 * without forming a cycle.
 */
import { env } from "./env.js";

const ENABLED = !!(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID);

export function telegramEnabled(): boolean {
  return ENABLED;
}
