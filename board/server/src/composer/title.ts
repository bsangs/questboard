/**
 * Auto-generate a thread title from the first user message.
 *
 * Best-effort: a one-shot Haiku call via @anthropic-ai/sdk if present;
 * otherwise we fall back to truncating the first user message. Either
 * way the call is fire-and-forget — never block thread creation or the
 * first response on a title.
 *
 * The SDK is dynamically imported so the server keeps building even if
 * the dependency hasn't been added yet (and so users without an API key
 * still get reasonable titles).
 */
import { logger } from "../logger.js";

const MAX_WORDS = 6;
const FALLBACK_CHARS = 40;

function fallbackTitle(text: string): string {
  // Take the first non-empty line, collapse whitespace, cap to N chars.
  const firstLine = text.split("\n").find((l) => l.trim()) ?? text;
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= FALLBACK_CHARS) return collapsed || "Untitled";
  return collapsed.slice(0, FALLBACK_CHARS).trimEnd() + "…";
}

function truncateWords(s: string): string {
  const cleaned = s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  // Strip trailing punctuation that the model often adds.
  const noTail = cleaned.replace(/[.!?…]+\s*$/, "");
  const words = noTail.split(" ").filter(Boolean);
  if (words.length <= MAX_WORDS) return noTail || cleaned;
  return words.slice(0, MAX_WORDS).join(" ");
}

export async function generateThreadTitle(firstUserMessage: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fallbackTitle(firstUserMessage);

  // Dynamic import: if the SDK isn't installed (the common case for now)
  // we silently fall back. We don't want a missing optional dep to mean
  // missing-server.
  let Anthropic: unknown;
  try {
    // String-built specifier so tsc doesn't try to resolve a module that may
    // not be installed. The SDK is an optional runtime dependency: when it's
    // present we use it; when it isn't, we fall back without crashing.
    const spec = ["@anthropic-ai", "sdk"].join("/");
    const mod = (await import(spec)) as { default?: unknown };
    Anthropic = mod.default ?? mod;
  } catch {
    return fallbackTitle(firstUserMessage);
  }
  try {
    type AnthropicCtor = new (opts: { apiKey: string }) => {
      messages: {
        create: (args: {
          model: string;
          max_tokens: number;
          messages: { role: "user"; content: string }[];
          system?: string;
        }) => Promise<{ content: { type: string; text?: string }[] }>;
      };
    };
    const Ctor = Anthropic as AnthropicCtor;
    const client = new Ctor({ apiKey });
    const resp = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 32,
      system:
        "Summarize the user's request as a thread title. Output ≤6 words, plain title-case, no quotes, no trailing punctuation.",
      messages: [{ role: "user", content: firstUserMessage.slice(0, 2000) }],
    });
    const text = resp.content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();
    const truncated = truncateWords(text);
    if (!truncated) return fallbackTitle(firstUserMessage);
    return truncated;
  } catch (err) {
    logger.warn("composer_title_generate_failed", { err: String(err) });
    return fallbackTitle(firstUserMessage);
  }
}
