"use client";
/**
 * Mirror-div overlay that renders mention tokens (`@<filepath>` and
 * `#NNNN`) with a blue chip-like background, layered behind the
 * Composer textarea.
 *
 * Why a mirror div at all?
 *   <textarea> can't style sub-strings — its value is a flat string.
 *   The well-known workaround (used by Slack/Twitter/GitHub composers)
 *   is to overlay a styled `<div>` with the same wrap behaviour, then
 *   render the textarea on top with `color: transparent` (caret stays
 *   visible via `caret-color`). The textarea keeps owning input,
 *   selection, paste, drag-drop, and a11y; the mirror is purely
 *   presentational.
 */
import { forwardRef } from "react";

type Token = { type: "plain" | "mention"; text: string };

/**
 * Walk `text` and split it into plain runs and mention tokens.
 *
 * Rules (must match the Composer's autocomplete trigger logic so the
 * highlight tracks the user's mental model):
 *   - File mention: `@<non-whitespace>+`. The `@` MUST sit at the
 *     start of a word — preceded by start-of-string or whitespace —
 *     so we don't fire inside `email@host.com`.
 *   - Card mention: `#\d{4}` followed by a non-word boundary
 *     (whitespace, punctuation, or end-of-string). Same word-start
 *     rule for the `#` so hex colors `#fff` etc. stay plain.
 *   - A bare `@` or `#` with no chars after is NOT highlighted —
 *     it's mid-typing and the autocomplete dropdown is open.
 */
export function tokenizeMentions(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let plainStart = 0;

  const flushPlain = (until: number) => {
    if (plainStart < until) {
      tokens.push({ type: "plain", text: text.slice(plainStart, until) });
    }
  };

  while (i < text.length) {
    const ch = text[i];
    const prev = i === 0 ? "" : text[i - 1];
    const atWordStart = i === 0 || /\s/.test(prev);

    if (atWordStart && ch === "@") {
      // Greedy: consume non-whitespace until break.
      let j = i + 1;
      while (j < text.length && !/\s/.test(text[j])) j++;
      if (j > i + 1) {
        flushPlain(i);
        tokens.push({ type: "mention", text: text.slice(i, j) });
        plainStart = j;
        i = j;
        continue;
      }
    } else if (atWordStart && ch === "#") {
      // Exactly 4 digits, then a non-word boundary or EOS.
      let j = i + 1;
      let digits = 0;
      while (j < text.length && /\d/.test(text[j])) {
        digits++;
        j++;
      }
      const isBoundary = j === text.length || /\W/.test(text[j]);
      if (digits === 4 && isBoundary) {
        flushPlain(i);
        tokens.push({ type: "mention", text: text.slice(i, j) });
        plainStart = j;
        i = j;
        continue;
      }
    }

    i++;
  }

  flushPlain(text.length);
  return tokens;
}

interface Props {
  value: string;
  /** Mirror the textarea's vertical scroll offset (auto-grows past max). */
  scrollTop: number;
}

/**
 * The overlay div. Critical CSS notes — every prop here is paired with
 * the textarea below; if they drift, glyph positions diverge and the
 * highlight no longer lands under the user's text.
 *
 *   - font-size, line-height, font-family: must match. We use the same
 *     `text-[13px] leading-relaxed` Tailwind classes the textarea uses
 *     and inherit the same sans stack from the page.
 *   - white-space: pre-wrap   → keep newlines + collapse runs of spaces
 *                                like the textarea does.
 *   - overflow-wrap: anywhere → wrap long unbreakable strings exactly
 *                                where the textarea wraps them.
 *   - padding: 0              → the OUTER pill provides padding; the
 *                                textarea itself has none, so neither
 *                                does the mirror.
 *   - position: absolute inset-0 + pointer-events: none → fills the
 *     textarea slot without intercepting clicks/drags.
 *
 * Scroll sync: when the textarea scrolls (auto-grow caps at 10 lines),
 * we translate the mirror content by `-scrollTop` so the visible window
 * agrees with what the textarea is showing. Mirror itself uses
 * `overflow: hidden` (no scrollbar of its own).
 *
 * Trailing-newline fix: a string ending in `\n` collapses its final
 * line in HTML but not in a textarea. Append a single space so the
 * mirror retains that line's height.
 */
export const MentionHighlightOverlay = forwardRef<HTMLDivElement, Props>(
  function MentionHighlightOverlay({ value, scrollTop }, ref) {
    if (value.length === 0) {
      // Nothing to render — keep the mirror empty so the placeholder
      // shows through cleanly without stray whitespace.
      return (
        <div
          ref={ref}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden"
        />
      );
    }

    const tokens = tokenizeMentions(value);

    return (
      <div
        ref={ref}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden text-[13px] leading-relaxed text-ink"
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        <div style={{ transform: `translateY(${-scrollTop}px)` }}>
          {tokens.map((t, idx) =>
            t.type === "mention" ? (
              <span
                key={idx}
                className="rounded-sm bg-accent-soft text-accent-strong"
              >
                {t.text}
              </span>
            ) : (
              <span key={idx}>{t.text}</span>
            ),
          )}
          {/* Sentinel so a trailing \n keeps a visible line of height. */}
          {value.endsWith("\n") ? " " : null}
        </div>
      </div>
    );
  },
);
