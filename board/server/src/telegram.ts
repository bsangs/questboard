/**
 * Telegram alert. Silent if BOT_TOKEN / CHAT_ID env not both set.
 * Failures never propagate — telemetry only.
 */
import { env } from "./env.js";
import { logger } from "./logger.js";
import { getConfig } from "./config.js";
import { telegramEnabled as flagTelegramEnabled } from "./telegram-flag.js";
import type { NotificationEvent } from "@questboard/core";

const MD_V2_ESCAPE = /([_*[\]()~`>#+\-=|{}.!\\])/g;
function escapeMdV2(s: string): string {
  return s.replace(MD_V2_ESCAPE, "\\$1");
}

/**
 * Send a Telegram message that already contains MarkdownV2 markup. The
 * caller is responsible for `escapeMdV2()` on user-provided fragments
 * (titles, ids, etc.); the markup characters they intentionally inject
 * (e.g. `*…*` for bold) are left intact.
 */
async function sendMarkup(text: string): Promise<void> {
  if (!flagTelegramEnabled()) {
    logger.debug("telegram_skipped", { reason: "env_missing" });
    return;
  }
  // User toggle: when off, treat alerts as no-ops even though env is set.
  // Wrapped in try/catch so a config-read failure never blocks an alert.
  try {
    if (!getConfig().telegram_enabled) {
      logger.debug("telegram_skipped", { reason: "toggle_off" });
      return;
    }
  } catch {
    /* if config can't be read, fall through and send */
  }
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        parse_mode: "MarkdownV2",
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable>");
      logger.warn("telegram_http_error", { status: res.status, body });
    }
  } catch (err) {
    logger.warn("telegram_send_failed", { err: String(err) });
  }
}

/** Send a plain (no formatting) Telegram message. Best-effort. */
export async function notify(text: string): Promise<void> {
  return sendMarkup(escapeMdV2(text));
}

// Re-export the flag so existing call sites (routes/telegram.ts etc.) keep
// importing from this module. Underlying source of truth is telegram-flag.ts.
export { telegramEnabled } from "./telegram-flag.js";

// ─── Localized templates ─────────────────────────────────────────────────────

type AlertKind =
  | "stuck"
  | "human_review"
  | "done"
  | "worker_failed"
  | "review_passed"
  | "review_rejected"
  | "merge_started"
  | "merge_failed"
  | "card_cancelled";

const ALERT_EVENT: Record<AlertKind, NotificationEvent> = {
  stuck: "card_stuck",
  human_review: "review_requested",
  done: "merge_done",
  worker_failed: "helper_crashed",
  review_passed: "review_passed",
  review_rejected: "review_rejected",
  merge_started: "merge_started",
  merge_failed: "merge_failed",
  card_cancelled: "card_cancelled",
};

interface Card {
  id: string;
  title: string;
  language: string;
  stuck_question?: string | null;
  stuck_reason?: string | null;
}

/**
 * Build "Card 0042 *<title>*" — title is rendered bold via MarkdownV2.
 * Both id and title are MD-V2 escaped so existing punctuation in the title
 * (".", "!", "(", etc.) doesn't break parsing.
 */
function head(card: Card, langKo: boolean): string {
  const idLabel = (langKo ? "카드 " : "Card ") + card.id;
  return `${escapeMdV2(idLabel)} *${escapeMdV2(card.title)}*`;
}

const TEMPLATES = {
  ko: {
    stuck: (c: Card) => `🟡 ${head(c, true)} \\- stuck${
      c.stuck_question ? `\n${escapeMdV2(c.stuck_question)}` : ""
    }`,
    human_review: (c: Card) => `🟢 ${head(c, true)} \\- 사람 리뷰 대기`,
    done: (c: Card) => `✅ ${head(c, true)} \\- merged`,
    worker_failed: (c: Card) =>
      `🔴 ${head(c, true)} \\- 워커 실패 \\(${escapeMdV2(c.stuck_reason ?? "unknown")}\\)`,
    review_passed: (c: Card) => `🟢 ${head(c, true)} \\- AI 리뷰 통과`,
    review_rejected: (c: Card) => `🟠 ${head(c, true)} \\- AI 리뷰 반려`,
    merge_started: (c: Card) => `🔵 ${head(c, true)} \\- merge 시작`,
    merge_failed: (c: Card) =>
      `🔴 ${head(c, true)} \\- merge 실패 \\(${escapeMdV2(c.stuck_reason ?? "unknown")}\\)`,
    card_cancelled: (c: Card) => `⚪ ${head(c, true)} \\- cancelled`,
  },
  en: {
    stuck: (c: Card) => `🟡 ${head(c, false)} \\- stuck${
      c.stuck_question ? `\n${escapeMdV2(c.stuck_question)}` : ""
    }`,
    human_review: (c: Card) => `🟢 ${head(c, false)} \\- awaiting human review`,
    done: (c: Card) => `✅ ${head(c, false)} \\- merged`,
    worker_failed: (c: Card) =>
      `🔴 ${head(c, false)} \\- worker failed \\(${escapeMdV2(c.stuck_reason ?? "unknown")}\\)`,
    review_passed: (c: Card) => `🟢 ${head(c, false)} \\- AI review passed`,
    review_rejected: (c: Card) => `🟠 ${head(c, false)} \\- AI review rejected`,
    merge_started: (c: Card) => `🔵 ${head(c, false)} \\- merge started`,
    merge_failed: (c: Card) =>
      `🔴 ${head(c, false)} \\- merge failed \\(${escapeMdV2(c.stuck_reason ?? "unknown")}\\)`,
    card_cancelled: (c: Card) => `⚪ ${head(c, false)} \\- cancelled`,
  },
} as const;

export async function alertCard(kind: AlertKind, card: Card): Promise<void> {
  try {
    const cfg = getConfig();
    if (!cfg.notifications.events.includes(ALERT_EVENT[kind])) {
      logger.debug("telegram_skipped", {
        reason: "notification_event_disabled",
        kind,
        card_id: card.id,
      });
      return;
    }
  } catch {
    /* if config can't be read, fall through and send */
  }

  // Suppress human_review alerts when auto_review is on — the reviewer
  // handles it without human attention. Other alerts still fire.
  if (kind === "human_review") {
    try {
      const cfg = getConfig();
      if (cfg.auto_review) {
        logger.debug("telegram_skipped", { reason: "auto_review_on", card_id: card.id });
        return;
      }
    } catch {
      /* if config can't be read, fall through and send */
    }
  }

  const lang = (TEMPLATES as Record<string, unknown>)[card.language] ? card.language : "en";
  const tmpl = (TEMPLATES as Record<string, Record<AlertKind, (c: Card) => string>>)[lang]!;
  await sendMarkup(tmpl[kind](card));
}
