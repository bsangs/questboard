/**
 * card.md (re)serialization. YAML frontmatter + markdown body.
 *
 * Layout:
 *   ---
 *   key: value
 *   ...
 *   ---
 *   <description body>
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { Card, CardFrontmatter, type Card as CardT } from "./types.js";

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export class CardParseError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "CardParseError";
  }
}

/** Parse the on-disk card.md text into a typed Card. Throws on schema mismatch.
 *  Body is trimmed at both ends so the in-memory `description` never carries
 *  the blank-line separator that on-disk format requires between frontmatter
 *  and body. Without this trim, the leading "\n" leaks into the UI and
 *  re-serialization keeps growing the gap. */
export function parseCardMd(raw: string): CardT {
  const m = FRONT_RE.exec(raw);
  if (!m) throw new CardParseError("card.md missing frontmatter delimiters");
  const yamlText = m[1] ?? "";
  const body = (m[2] ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  let yamlObj: unknown;
  try {
    yamlObj = parseYaml(yamlText);
  } catch (err) {
    throw new CardParseError("card.md frontmatter YAML invalid", err);
  }
  const fm = CardFrontmatter.safeParse(yamlObj);
  if (!fm.success) {
    throw new CardParseError(`card.md frontmatter schema invalid: ${fm.error.message}`, fm.error);
  }
  return Card.parse({ frontmatter: fm.data, description: body });
}

/** Serialize a Card back to card.md text. Always trailing newline.
 *  Body is trimmed at BOTH ends so round-tripping (parse → serialize) is
 *  idempotent: parseCardMd's regex captures one of the two newlines that
 *  separate the closing `---` from the body, so without leading-trim the
 *  body would grow by one blank line each save. */
export function serializeCardMd(card: CardT): string {
  const fm = CardFrontmatter.parse(card.frontmatter);
  const yaml = stringifyYaml(fm, { lineWidth: 0 }).trimEnd();
  const body = card.description.replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${yaml}\n---\n\n${body}\n`;
}

/** Stamp updated_at to current ISO time and return new card. */
export function touchCard(card: CardT, now: Date = new Date()): CardT {
  return {
    ...card,
    frontmatter: { ...card.frontmatter, updated_at: now.toISOString() },
  };
}
