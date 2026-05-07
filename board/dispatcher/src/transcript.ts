/**
 * Transcript helpers. The dispatcher reads the worker's transcript JSONL after
 * exit to extract human-facing artifacts (stuck question, etc.) — this lets
 * the worker stay completely API-free and just speak via stdout.
 */
import * as fs from "node:fs";

interface AssistantContent {
  type: string;
  text?: string;
}

interface AssistantMessage {
  type: "assistant";
  message?: { content?: AssistantContent[] };
}

/**
 * Return the text of the last `type:"assistant"` message in the transcript,
 * concatenating all `text` content blocks. Returns null if no assistant
 * message exists or the file is unreadable.
 */
export function lastAssistantText(transcriptPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let parsed: AssistantMessage | { type: string };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if ((parsed as { type?: string }).type !== "assistant") continue;
    const content = (parsed as AssistantMessage).message?.content ?? [];
    const text = content
      .filter((c): c is AssistantContent & { text: string } => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text.trim())
      .filter(Boolean)
      .join("\n\n");
    if (text) return text;
  }
  return null;
}

/**
 * Locate a `## Notes` section in the LAST assistant message and return
 * everything after the heading line, trimmed. Returns null if the heading
 * isn't present or there is no assistant message at all.
 *
 * The heading match is case-insensitive and tolerates trailing words on
 * the same line (e.g. `## Notes (follow-ups)`). The returned body stops
 * at end-of-message (we don't try to bound it by the next `^##` heading
 * because helpers are instructed to put Notes at the end).
 */
export function extractNotesSection(transcriptPath: string): string | null {
  const text = lastAssistantText(transcriptPath);
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  // Find the LAST occurrence of a Notes heading — most messages will only
  // have one, but if a helper accidentally writes two, the trailing one is
  // the most authoritative summary.
  let idx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^##\s+notes\b/i.test(lines[i] ?? "")) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;
  const body = lines.slice(idx + 1).join("\n").trim();
  return body.length > 0 ? body : null;
}

/**
 * Locate a `STUCK: <reason>` marker in the last assistant message and
 * return the message body with that line stripped (so the rest can be
 * used as the stuck comment / question). Reviewers may instead use a line
 * matching `VERDICT: STUCK` — this helper accepts both.
 *
 * Returns null if no marker is present.
 */
export function extractStuckMarker(transcriptPath: string): {
  reason: string;
  body: string;
} | null {
  const text = lastAssistantText(transcriptPath);
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  // Search from the bottom — the LAST marker line wins.
  let markerIdx = -1;
  let reason = "";
  let isVerdictForm = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const mVerdict = /^\s*VERDICT:\s*STUCK\b\s*(.*)$/i.exec(line);
    if (mVerdict) {
      markerIdx = i;
      reason = (mVerdict[1] ?? "").trim();
      isVerdictForm = true;
      break;
    }
    const mStuck = /^\s*STUCK:\s*(.+)$/i.exec(line);
    if (mStuck) {
      markerIdx = i;
      reason = (mStuck[1] ?? "").trim();
      break;
    }
  }
  if (markerIdx < 0) return null;
  // Body = everything except the marker line, trimmed. We keep the rest of
  // the helper's prose intact (incl. any `## Notes` block — the exit
  // handler will pull that out separately if needed).
  const remaining = [...lines.slice(0, markerIdx), ...lines.slice(markerIdx + 1)]
    .join("\n")
    .trim();
  if (!reason && isVerdictForm) reason = "reviewer requested human input";
  return { reason: reason || "stuck", body: remaining };
}

/** Approximate elapsed seconds since transcript file's first write. */
export function transcriptElapsedSeconds(transcriptPath: string): number {
  try {
    const stat = fs.statSync(transcriptPath);
    return Math.max(0, Math.floor((Date.now() - stat.birthtimeMs) / 1000));
  } catch {
    return 0;
  }
}

/** mtime of transcript — used by the hang watchdog. */
export function transcriptMtime(transcriptPath: string): number {
  try {
    return fs.statSync(transcriptPath).mtimeMs;
  } catch {
    return 0;
  }
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface AssistantTurn {
  type?: string;
  message?: { usage?: TokenUsage };
}

/**
 * Current context size — the prompt size the model just saw on its most
 * recent assistant turn. This is what users care about ("how close are we
 * to the 200k window?"), not the lifetime API usage sum.
 *
 * Computed as the LAST assistant message's
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * which represents everything that went INTO the prompt for that turn.
 * Output tokens are intentionally excluded — they're added to the next
 * turn's input automatically by the runtime.
 */
export function transcriptTokens(transcriptPath: string): number {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return 0;
  }
  const lines = raw.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    let parsed: AssistantTurn;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.type !== "assistant") continue;
    const u = parsed.message?.usage;
    if (!u) continue;
    return (
      (u.input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0)
    );
  }
  return 0;
}

