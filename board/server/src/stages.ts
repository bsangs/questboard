/**
 * Per-card "stage" history derived from the transcript files.
 *
 * Each transcript file in `cards/<id>/transcripts/` is one helper
 * spawn — a worker (`<ts>-attempt-N.jsonl`), reviewer (`-review.jsonl`)
 * or merger (`-merge.jsonl`). Walking these files in chronological
 * order gives a per-stage activity timeline:
 *
 *   - role         — derived from the filename suffix
 *   - attempt      — the N in `attempt-N`
 *   - started_at   — parsed from the filename timestamp
 *   - ended_at     — last assistant turn timestamp (or null if still
 *                    running / parse failed)
 *   - elapsed_seconds — ended_at − started_at when both available
 *   - context_tokens   — input + cache_creation + cache_read on the
 *                        FINAL assistant turn (= current context size,
 *                        matches the metric the live card tile shows)
 *   - output_tokens    — sum of output_tokens across all assistant
 *                        turns (rough proxy for "work produced")
 *
 * The drawer uses this to show a per-stage table — every requeue back
 * into in_progress spawns a new worker, which produces a new
 * transcript, which appears as a new row.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ComposerMessage } from "@questboard/core";
import { transcriptsDir } from "./files.js";

export type StageRole = "worker" | "reviewer" | "merger";

export interface CardStage {
  /** Filename relative to the card's transcripts/ dir. */
  transcript: string;
  role: StageRole;
  /** N in `attempt-N`. 1-indexed. */
  attempt: number;
  /** ISO timestamp parsed from the filename — when the helper was
   *  spawned by the dispatcher. */
  started_at: string;
  /** Last assistant turn timestamp inside the transcript, or null if
   *  none / parse failed. Roughly equals "when the helper finished
   *  responding," not when it exited (those are usually within a
   *  second of each other). */
  ended_at: string | null;
  /** ended_at − started_at, or null. Seconds. */
  elapsed_seconds: number | null;
  /** Final context size at the LAST assistant turn — matches what the
   *  live card tile shows for an active worker. */
  context_tokens: number;
  /** Sum of (input + cache_creation + cache_read) across every assistant
   *  turn in the stage. Cumulative — what the worker actually paid for. */
  input_tokens: number;
  /** Sum of output tokens across every assistant turn in the stage. */
  output_tokens: number;
}

interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface TranscriptEvent {
  type?: string;
  timestamp?: string;
  message?: { usage?: TokenUsage };
  usage?: TokenUsage;
  event?: {
    type?: string;
    message?: { usage?: TokenUsage };
    usage?: TokenUsage;
  };
}

/**
 * Filename → role + attempt. Format produced by spawn.ts:
 *   `<iso-ts>-attempt-<N>.jsonl`           (worker)
 *   `<iso-ts>-attempt-<N>-review.jsonl`    (reviewer)
 *   `<iso-ts>-attempt-<N>-merge.jsonl`     (merger)
 *
 * The iso-ts has its `:` and `.` replaced with `-` (see fileTimestamp
 * in spawn.ts). We invert that here to recover an ISO string.
 */
const FILENAME_RE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-attempt-(\d+)(?:-(review|merge))?\.jsonl$/;

function decodeFilenameTs(slug: string): string {
  // `2026-05-02T16-30-37-124Z` → `2026-05-02T16:30:37.124Z`
  return slug.replace(
    /T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
    (_, h, m, s, ms) => `T${h}:${m}:${s}.${ms}Z`,
  );
}

function parseFilename(
  name: string,
): { role: StageRole; attempt: number; started_at: string } | null {
  const m = FILENAME_RE.exec(name);
  if (!m) return null;
  const role: StageRole = m[3] === "review" ? "reviewer" : m[3] === "merge" ? "merger" : "worker";
  return {
    role,
    attempt: Number(m[2]),
    started_at: decodeFilenameTs(m[1] ?? ""),
  };
}

interface ParsedStats {
  context_tokens: number;
  input_tokens: number;
  output_tokens: number;
  ended_at: string | null;
}

interface StreamStats {
  settledInput: number;
  settledOutput: number;
  lastContext: number;
  currentUsage: TokenUsage | null;
  sawUsage: boolean;
}

function usageInput(usage: TokenUsage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0)
  );
}

function mergeUsage(prev: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    input_tokens:
      next.input_tokens != null && next.input_tokens > 0
        ? next.input_tokens
        : prev.input_tokens,
    cache_creation_input_tokens:
      next.cache_creation_input_tokens != null && next.cache_creation_input_tokens > 0
        ? next.cache_creation_input_tokens
        : prev.cache_creation_input_tokens,
    cache_read_input_tokens:
      next.cache_read_input_tokens != null && next.cache_read_input_tokens > 0
        ? next.cache_read_input_tokens
        : prev.cache_read_input_tokens,
    output_tokens: next.output_tokens ?? prev.output_tokens,
  };
}

function usageHasTokens(usage: TokenUsage): boolean {
  return usageInput(usage) > 0 || (usage.output_tokens ?? 0) > 0;
}

function applyStreamEvent(stats: StreamStats, event: NonNullable<TranscriptEvent["event"]>): void {
  if (event.type === "message_start") {
    stats.currentUsage = event.message?.usage
      ? mergeUsage({}, event.message.usage)
      : {};
    stats.sawUsage = stats.sawUsage || usageHasTokens(stats.currentUsage);
    return;
  }
  if (event.type === "message_delta" && event.usage) {
    stats.currentUsage = mergeUsage(stats.currentUsage ?? {}, event.usage);
    stats.sawUsage = stats.sawUsage || usageHasTokens(stats.currentUsage);
    return;
  }
  if (event.type === "message_stop" && stats.currentUsage) {
    if (usageHasTokens(stats.currentUsage)) {
      const currentInput = usageInput(stats.currentUsage);
      stats.settledInput += currentInput;
      stats.settledOutput += stats.currentUsage.output_tokens ?? 0;
      stats.lastContext = currentInput;
      stats.sawUsage = true;
    }
    stats.currentUsage = null;
  }
}

/**
 * Walk every assistant turn in the transcript:
 *   - sum output_tokens
 *   - record the LAST turn's input + cache tokens (= current context)
 *   - record the LAST turn's timestamp (= ended_at)
 *
 * Single pass forward; cheap on hundreds of MB.
 */
function parseTranscriptStats(path: string): ParsedStats {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { context_tokens: 0, input_tokens: 0, output_tokens: 0, ended_at: null };
  }
  let assistantContextTokens = 0;
  let assistantInputTokens = 0;
  let assistantOutputTokens = 0;
  let ended_at: string | null = null;
  let resultInput: number | null = null;
  let resultOutput: number | null = null;
  const streamStats: StreamStats = {
    settledInput: 0,
    settledOutput: 0,
    lastContext: 0,
    currentUsage: null,
    sawUsage: false,
  };
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let parsed: TranscriptEvent;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed.timestamp) ended_at = parsed.timestamp;
    if (parsed.type === "stream_event" && parsed.event) {
      applyStreamEvent(streamStats, parsed.event);
      continue;
    }
    if (parsed.type !== "assistant" && parsed.type !== "result") continue;
    const u = parsed.message?.usage ?? parsed.usage;
    if (!u) continue;
    const turnInput = usageInput(u);
    if (parsed.type === "result") {
      resultInput = turnInput;
      resultOutput = u.output_tokens ?? 0;
      continue;
    }
    assistantInputTokens += turnInput;
    assistantOutputTokens += u.output_tokens ?? 0;
    // Overwrite each time so we end with the LAST turn's context size.
    assistantContextTokens = turnInput;
  }
  if (resultInput != null || resultOutput != null) {
    const input_tokens = resultInput ?? 0;
    const output_tokens = resultOutput ?? 0;
    const currentInput = streamStats.currentUsage ? usageInput(streamStats.currentUsage) : 0;
    const context_tokens = currentInput || streamStats.lastContext || assistantContextTokens || input_tokens;
    return { context_tokens, input_tokens, output_tokens, ended_at };
  }
  if (streamStats.sawUsage) {
    const currentInput = streamStats.currentUsage ? usageInput(streamStats.currentUsage) : 0;
    const currentOutput = streamStats.currentUsage?.output_tokens ?? 0;
    const input_tokens = streamStats.settledInput + currentInput;
    const output_tokens = streamStats.settledOutput + currentOutput;
    return {
      context_tokens: currentInput || streamStats.lastContext,
      input_tokens,
      output_tokens,
      ended_at,
    };
  }
  return {
    context_tokens: assistantContextTokens,
    input_tokens: assistantInputTokens,
    output_tokens: assistantOutputTokens,
    ended_at,
  };
}

export interface CardTokenTotals {
  worker_input_tokens: number;
  worker_output_tokens: number;
  reviewer_input_tokens: number;
  reviewer_output_tokens: number;
  merger_input_tokens: number;
  merger_output_tokens: number;
}

/**
 * Sum output_tokens across all stages of a card, grouped by role.
 *
 * "output_tokens" is summed across every assistant turn in each transcript
 * (cumulative work produced) — the metric users mean by "이 카드에 토큰
 * 얼마 썼지?". Unlike `context_tokens`, summing across runs is meaningful
 * here because each turn's `output_tokens` is the marginal cost of THAT
 * turn, not a snapshot.
 */
export function getCardTokenTotals(
  cardId: string,
  opts: { excludeTranscript?: string | null } = {},
): CardTokenTotals {
  const totals: CardTokenTotals = {
    worker_input_tokens: 0,
    worker_output_tokens: 0,
    reviewer_input_tokens: 0,
    reviewer_output_tokens: 0,
    merger_input_tokens: 0,
    merger_output_tokens: 0,
  };
  const dir = transcriptsDir(cardId);
  if (!existsSync(dir)) return totals;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    if (opts.excludeTranscript && name === opts.excludeTranscript) continue;
    const meta = parseFilename(name);
    if (!meta) continue;
    let stats: ParsedStats;
    try {
      stats = parseTranscriptStats(join(dir, name));
    } catch {
      continue;
    }
    if (meta.role === "worker") {
      totals.worker_input_tokens += stats.input_tokens;
      totals.worker_output_tokens += stats.output_tokens;
    } else if (meta.role === "reviewer") {
      totals.reviewer_input_tokens += stats.input_tokens;
      totals.reviewer_output_tokens += stats.output_tokens;
    } else if (meta.role === "merger") {
      totals.merger_input_tokens += stats.input_tokens;
      totals.merger_output_tokens += stats.output_tokens;
    }
  }
  return totals;
}

/**
 * Look up a transcript file by `(role, attempt)` and return its absolute
 * path (or null if no such file). Used by the read-only Transcript tab
 * in the drawer — we want a stable lookup that doesn't depend on the
 * caller knowing the timestamp prefix in the filename.
 *
 * If multiple files match (shouldn't happen — the dispatcher uses a
 * fresh attempt # per spawn), the one with the latest `started_at` wins.
 */
export function findTranscriptPath(
  cardId: string,
  role: StageRole,
  attempt: number,
): string | null {
  const dir = transcriptsDir(cardId);
  if (!existsSync(dir)) return null;
  let bestName: string | null = null;
  let bestTs = "";
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const meta = parseFilename(name);
    if (!meta) continue;
    if (meta.role !== role || meta.attempt !== attempt) continue;
    if (meta.started_at > bestTs) {
      bestTs = meta.started_at;
      bestName = name;
    }
  }
  return bestName ? join(dir, bestName) : null;
}

/**
 * Parse a raw claude-code stream-json transcript file into a flat list
 * of `ComposerMessage`-shaped rows that the UI can render with the same
 * components used in the Composer chat surface.
 *
 * Worker / reviewer / merger transcripts are produced directly by
 * `claude --output-format stream-json` (see dispatcher/spawn). The
 * stream is a sequence of `system` / `assistant` / `user` / `result`
 * envelopes; we project the assistant text + tool_use blocks and the
 * paired user tool_result blocks into ComposerMessage rows. Other
 * blocks (`thinking`) are dropped — read-only viewers don't surface
 * those today.
 *
 * Pure read function: never mutates the file, never throws on a single
 * malformed line. Caller is responsible for clamping size if huge.
 */
export function parseTranscriptMessages(path: string): ComposerMessage[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: ComposerMessage[] = [];
  let seq = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // One bad line shouldn't drop the rest of the transcript — skip.
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const ev = parsed as {
      type?: string;
      timestamp?: string;
      message?: {
        content?: unknown[];
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      };
    };
    const ts = ev.timestamp ?? new Date().toISOString();

    if (ev.type === "assistant" && ev.message) {
      const u = ev.message.usage ?? {};
      const inputTotal =
        (u.input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0) +
        (u.cache_read_input_tokens ?? 0);
      const outputTotal = u.output_tokens ?? 0;
      // Attach usage to the FIRST text/tool_use row in this turn so the
      // UI's per-turn chip lines up with the visible message. Subsequent
      // rows in the same turn carry no usage.
      let attachedUsage = false;
      for (const block of ev.message.content ?? []) {
        if (!block || typeof block !== "object") continue;
        const b = block as {
          type?: string;
          text?: string;
          id?: string;
          name?: string;
          input?: unknown;
        };
        const usage =
          !attachedUsage && (inputTotal > 0 || outputTotal > 0)
            ? { input_tokens: inputTotal, output_tokens: outputTotal }
            : undefined;
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          out.push({
            id: `t${seq++}`,
            ts,
            role: "assistant",
            text: b.text,
            ...(usage ? { usage } : {}),
          });
          if (usage) attachedUsage = true;
        } else if (b.type === "tool_use" && b.id && b.name) {
          out.push({
            id: b.id,
            ts,
            role: "assistant",
            tool_use: { id: b.id, name: b.name, input: b.input ?? {} },
            ...(usage ? { usage } : {}),
          });
          if (usage) attachedUsage = true;
        }
        // `thinking` blocks intentionally dropped.
      }
      continue;
    }

    if (ev.type === "user" && ev.message) {
      // Plain user prompts arrive with `content: <string>` (the system
      // prompt or the resume directive). We surface them as user rows so
      // the viewer shows what the helper was asked. tool_result blocks
      // come in as `content: [{ type: 'tool_result', ... }]`.
      const content = (ev.message as { content?: unknown }).content;
      if (typeof content === "string" && content.length > 0) {
        out.push({
          id: `u${seq++}`,
          ts,
          role: "user",
          text: content,
        });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as {
          type?: string;
          tool_use_id?: string;
          content?: unknown;
          is_error?: boolean;
          text?: string;
        };
        if (b.type === "tool_result" && b.tool_use_id) {
          // tool_result.content can be a string OR an array of
          // {type:'text',text:string}/{type:'image',...} blocks. Flatten
          // text-bearing blocks; stringify the rest so nothing is lost.
          let text: string;
          if (typeof b.content === "string") {
            text = b.content;
          } else if (Array.isArray(b.content)) {
            const parts: string[] = [];
            for (const sub of b.content) {
              if (sub && typeof sub === "object") {
                const s = sub as { type?: string; text?: string };
                if (s.type === "text" && typeof s.text === "string") parts.push(s.text);
                else parts.push(JSON.stringify(sub));
              }
            }
            text = parts.join("\n");
          } else {
            text = JSON.stringify(b.content ?? "");
          }
          out.push({
            id: `r${seq++}`,
            ts,
            role: "user",
            tool_result: {
              tool_use_id: b.tool_use_id,
              content: text,
              is_error: !!b.is_error,
            },
          });
        } else if (b.type === "text" && typeof b.text === "string") {
          out.push({
            id: `u${seq++}`,
            ts,
            role: "user",
            text: b.text,
          });
        }
      }
      continue;
    }

    // `system` (init) and `result` (turn end) are dropped — they're
    // session bookkeeping, not content the viewer cares about.
  }
  return out;
}

export function listStages(cardId: string): CardStage[] {
  const dir = transcriptsDir(cardId);
  if (!existsSync(dir)) return [];
  const out: CardStage[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const meta = parseFilename(name);
    if (!meta) continue;
    const full = join(dir, name);
    let stats: ParsedStats;
    try {
      stats = parseTranscriptStats(full);
    } catch {
      stats = {
        context_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        ended_at: null,
      };
    }
    // If the transcript has no assistant turn yet (just spawned), use the
    // file's mtime as a rough end-time so the elapsed shows something.
    let ended_at = stats.ended_at;
    if (!ended_at) {
      try {
        ended_at = new Date(statSync(full).mtimeMs).toISOString();
      } catch {
        ended_at = null;
      }
    }
    let elapsed_seconds: number | null = null;
    if (ended_at) {
      const a = Date.parse(meta.started_at);
      const b = Date.parse(ended_at);
      if (!Number.isNaN(a) && !Number.isNaN(b)) {
        elapsed_seconds = Math.max(0, Math.floor((b - a) / 1000));
      }
    }
    out.push({
      transcript: name,
      role: meta.role,
      attempt: meta.attempt,
      started_at: meta.started_at,
      ended_at,
      elapsed_seconds,
      context_tokens: stats.context_tokens,
      input_tokens: stats.input_tokens,
      output_tokens: stats.output_tokens,
    });
  }
  // Chronological — earliest first.
  out.sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0));
  return out;
}
