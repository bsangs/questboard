"use client";
/**
 * Read-only Transcript tab body for the card drawer.
 *
 * Surfaces what a card's worker / reviewer / merger is actually doing:
 * the assistant's text turns and the built-in tool calls (Read / Edit /
 * Write / Bash / Glob / Grep / WebFetch / WebSearch / TodoWrite / …).
 * Mirrors the visual vocabulary of `Composer/Message.tsx` +
 * `Composer/ToolCard.tsx` — but the rendering is COPIED rather than
 * imported, so:
 *
 *   1. Composer-only affordances (Approve buttons, MakeCardPreview /
 *      SavePlanPreview gates, the input box, lifetime token chip,
 *      thread title editor) never leak into this read-only view.
 *   2. Future Composer changes don't accidentally rewrite how worker
 *      transcripts render here, and vice versa.
 *
 * Wiring:
 *   - The drawer hands us a card id + the list of stages it already
 *     fetched. We fetch the transcript on mount and on every
 *     `worker_heartbeat` SSE event for this card. Files are small
 *     enough (<~1 MB typical) that re-parsing the whole thing on
 *     every heartbeat is cheap; v1 doesn't bother with byte-offset
 *     cursoring.
 *   - The user can switch between stages via a tiny role/attempt
 *     picker. The "active" stage (worker for in_progress, reviewer
 *     for ai_review, merger for merging) is selected by default.
 *   - The viewport auto-scrolls to the bottom on new content UNLESS
 *     the user scrolled up to read history (matching Composer's
 *     ChatView behavior — re-implemented here so it stays read-only).
 */
import clsx from "clsx";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileText,
  FilePlus,
  Folder,
  Globe,
  ListChecks,
  Pencil,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getCardTranscript } from "@/lib/api";
import { useSse } from "@/lib/sse";
import type { CardStage, TranscriptMessage } from "@/lib/types";
import { Markdown } from "./Markdown";

interface Props {
  cardId: string;
  stages: CardStage[];
  /** Card status, so we can pick the "interesting" stage by default. */
  cardStatus: import("@/lib/types").CardStatus;
}

type StageKey = `${CardStage["role"]}-${number}`;
const stageKey = (s: CardStage): StageKey => `${s.role}-${s.attempt}`;

/**
 * Map card status → the role whose transcript the user most likely
 * wants to watch. Mirrors the server's default-target-stage selection
 * so the UI's pre-selected stage agrees with what `?role&attempt`-less
 * fetches return.
 */
const STATUS_TO_LIVE_ROLE: Partial<Record<Props["cardStatus"], CardStage["role"]>> = {
  in_progress: "worker",
  stuck: "worker",
  ai_review: "reviewer",
  human_review: "reviewer",
  merging: "merger",
};

const ROLE_STYLE: Record<
  CardStage["role"],
  { dot: string; label: string; text: string }
> = {
  worker: { dot: "bg-accent", label: "worker", text: "text-accent-strong" },
  reviewer: { dot: "bg-amber-500", label: "reviewer", text: "text-amber-700" },
  merger: { dot: "bg-slate-500", label: "merger", text: "text-slate-700" },
};

/**
 * Render the read-only transcript surface. Pure UI — all data flows
 * through the api helper and SSE hook; no mutations from this view.
 */
export function CardTranscriptView({ cardId, stages, cardStatus }: Props) {
  // Pre-select the live stage (or fall back to most recent) whenever
  // the stage list changes. The user can override via the picker; we
  // remember their explicit choice in `selectedKey` and only auto-pick
  // when no stage is selected, the selection no longer exists, or
  // the live stage advanced (e.g. worker-1 → reviewer-1 transition).
  const [selectedKey, setSelectedKey] = useState<StageKey | null>(null);

  // What the server would pick by default — used to detect "the live
  // stage just advanced; follow it" without overriding a user override.
  const liveStage = useMemo<CardStage | null>(() => {
    if (stages.length === 0) return null;
    const role = STATUS_TO_LIVE_ROLE[cardStatus];
    if (role) {
      for (let i = stages.length - 1; i >= 0; i--) {
        const s = stages[i];
        if (s && s.role === role) return s;
      }
    }
    return stages[stages.length - 1] ?? null;
  }, [stages, cardStatus]);
  const liveKey = liveStage ? stageKey(liveStage) : null;

  // Track which live stage we last auto-followed; if the live stage
  // advances (e.g. worker-1 ended, reviewer-1 started), bump the
  // selection along — but never override an explicit user pick.
  const lastFollowedLiveRef = useRef<StageKey | null>(null);
  const userOverrodeRef = useRef(false);

  useEffect(() => {
    if (!liveKey) return;
    // Initial mount or selection cleared: follow live.
    if (selectedKey == null) {
      setSelectedKey(liveKey);
      lastFollowedLiveRef.current = liveKey;
      return;
    }
    // The live stage moved on AND the user hasn't overridden → follow.
    if (
      !userOverrodeRef.current &&
      lastFollowedLiveRef.current !== null &&
      liveKey !== lastFollowedLiveRef.current &&
      selectedKey === lastFollowedLiveRef.current
    ) {
      setSelectedKey(liveKey);
      lastFollowedLiveRef.current = liveKey;
    } else if (lastFollowedLiveRef.current === null) {
      // Track the live stage we landed on so we can detect future jumps.
      lastFollowedLiveRef.current = liveKey;
    }
    // If selectedKey points at a stage that no longer exists (rare —
    // would only happen if a transcript file was deleted), fall back
    // to live.
    if (!stages.some((s) => stageKey(s) === selectedKey)) {
      setSelectedKey(liveKey);
      userOverrodeRef.current = false;
      lastFollowedLiveRef.current = liveKey;
    }
  }, [liveKey, selectedKey, stages]);

  const onPickStage = (key: StageKey) => {
    setSelectedKey(key);
    userOverrodeRef.current = key !== liveKey;
    lastFollowedLiveRef.current = liveKey;
  };

  // The selected stage object itself (if any).
  const selected = useMemo<CardStage | null>(() => {
    if (!selectedKey) return null;
    return stages.find((s) => stageKey(s) === selectedKey) ?? null;
  }, [selectedKey, stages]);

  // Whether the selected stage is the LIVE one (for the LIVE pill).
  const isLiveSelected = !!liveStage && !!selected && stageKey(selected) === liveKey;
  // We only consider it "actively streaming" if the card status maps
  // to a live role (otherwise the live stage is just "the most recent
  // ended one"). E.g. status=done → no pulse.
  const isStreaming =
    isLiveSelected && STATUS_TO_LIVE_ROLE[cardStatus] !== undefined;

  // ── Fetch transcript ──────────────────────────────────────────────
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inflight = useRef(0);

  const refetch = useCallback(async () => {
    if (!selected) {
      setMessages([]);
      return;
    }
    const ticket = ++inflight.current;
    setLoading(true);
    try {
      const data = await getCardTranscript(cardId, {
        role: selected.role,
        attempt: selected.attempt,
      });
      // Drop stale responses (e.g. user switched stages mid-fetch).
      if (ticket !== inflight.current) return;
      setMessages(data.messages);
      setError(null);
    } catch (e) {
      if (ticket !== inflight.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (ticket === inflight.current) setLoading(false);
    }
  }, [cardId, selected]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  // Re-fetch on every heartbeat for THIS card. Server filters elsewhere
  // so an irrelevant heartbeat for another card just no-ops.
  useSse((ev) => {
    if (ev.type !== "worker_heartbeat") return;
    if (ev.card_id !== cardId) return;
    if (!isStreaming) return; // not watching the live stage; skip
    void refetch();
  });

  // ── Auto-scroll wiring (mirrors Composer/ChatView) ────────────────
  // Pin to bottom unless the user scrolled up. Threshold is generous
  // (~24px) to absorb sub-pixel rounding from font metrics.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const pinnedRef = useRef(true);
  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance < 24;
  }, []);
  // Layout effect so growth from new content is reconciled BEFORE we
  // scroll, avoiding a one-frame "stuck" flash.
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length]);
  // When the user switches stages, reset to "pinned" so the new
  // transcript opens at its tail rather than honoring an old scroll.
  useEffect(() => {
    pinnedRef.current = true;
  }, [selectedKey]);

  if (stages.length === 0) {
    return (
      <div className="text-[12.5px] text-ink-subtle">
        No transcripts yet. They appear once a worker, reviewer, or merger
        runs for this card.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* Stage picker + status chip */}
      <div className="flex max-h-24 shrink-0 items-start gap-2 overflow-y-auto rounded-md border border-border bg-surface p-1.5 text-[11px]">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {stages.map((s) => {
            const k = stageKey(s);
            const r = ROLE_STYLE[s.role];
            const active = k === selectedKey;
            const isLive = k === liveKey;
            return (
              <button
                key={k}
                type="button"
                onClick={() => onPickStage(k)}
                className={clsx(
                  "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono transition-colors",
                  active
                    ? "border-accent bg-accent-soft text-accent-strong"
                    : "border-border-strong bg-surface text-ink-muted hover:bg-surface-muted",
                )}
                title={`Started ${s.started_at}`}
              >
                <span
                  className={clsx(
                    "h-1.5 w-1.5 rounded-full",
                    r.dot,
                    isLive && isStreaming && "animate-pulseDot",
                  )}
                  aria-hidden
                />
                <span>{r.label}</span>
                <span className="opacity-70">#{s.attempt}</span>
              </button>
            );
          })}
        </div>
        <div className="shrink-0">
          {isStreaming ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10px] font-medium text-accent-strong ring-1 ring-inset ring-accent">
              <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-accent" />
              LIVE
            </span>
          ) : selected ? (
            <span
              className="font-mono text-[10.5px] text-ink-subtle"
              title={selected.ended_at ?? selected.started_at}
            >
              ended {fmtRelative(selected.ended_at ?? selected.started_at)}
            </span>
          ) : null}
        </div>
      </div>

      {/* Body */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        tabIndex={0}
        className="min-h-[320px] flex-1 overflow-y-auto rounded-md border border-border bg-[var(--bg-muted,#fafafa)] px-3 py-3 focus:outline-none"
      >
        {error && (
          <div className="mb-2 rounded bg-red-50 px-2 py-1 text-[11.5px] text-red-800 ring-1 ring-inset ring-red-200">
            {error}
          </div>
        )}
        {messages.length === 0 ? (
          <div className="text-[12.5px] text-ink-subtle">
            {loading ? "Loading transcript…" : "No content in this transcript yet."}
          </div>
        ) : (
          <PairedMessageList messages={messages} cardId={cardId} />
        )}
      </div>
    </div>
  );
}

/**
 * Render messages with tool_results paired under their matching tool_use
 * card, if both arrive in the same buffer. Same approach as Composer's
 * ChatView, replicated here so the read-only view stays self-contained.
 */
function PairedMessageList({
  messages,
  cardId,
}: {
  messages: TranscriptMessage[];
  /** Threaded down so the user / assistant rows can resolve
   *  `attachments/<filename>` against the right per-card dir. */
  cardId: string;
}) {
  // Build an index from tool_use id → its tool_result message so we can
  // skip the standalone result row and nest it inside the tool card.
  const resultById = useMemo(() => {
    const m = new Map<string, TranscriptMessage>();
    for (const msg of messages) {
      if (msg.tool_result?.tool_use_id) m.set(msg.tool_result.tool_use_id, msg);
    }
    return m;
  }, [messages]);
  // tool_result rows whose tool_use is in the list are skipped.
  const skipIds = useMemo(() => {
    const s = new Set<string>();
    for (const msg of messages) {
      if (msg.tool_use?.id && resultById.has(msg.tool_use.id)) {
        const r = resultById.get(msg.tool_use.id);
        if (r) s.add(r.id);
      }
    }
    return s;
  }, [messages, resultById]);

  return (
    <div className="flex flex-col gap-2">
      {messages.map((m) => {
        if (skipIds.has(m.id)) return null;
        const pairedResult = m.tool_use?.id
          ? resultById.get(m.tool_use.id)?.tool_result
          : undefined;
        return (
          <TranscriptRow
            key={m.id}
            message={m}
            pairedResult={pairedResult}
            cardId={cardId}
          />
        );
      })}
    </div>
  );
}

// ── Single row renderer (read-only twin of Composer/Message.tsx) ──────

function TranscriptRow({
  message,
  pairedResult,
  cardId,
}: {
  message: TranscriptMessage;
  pairedResult?: TranscriptMessage["tool_result"];
  /** Card scope for the Markdown renderer's `attachments/...` rewrite. */
  cardId: string;
}) {
  const { role, text, tool_use, tool_result, usage } = message;

  // System rows (currently rare for helper transcripts — kept for parity).
  if (role === "system") {
    return (
      <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-900 ring-1 ring-inset ring-amber-200">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="whitespace-pre-wrap">{text || "(system event)"}</span>
      </div>
    );
  }

  // User-style content (initial prompt to the helper). Right-aligned to
  // distinguish from the assistant's left-aligned cards. Rendered as
  // markdown so a human's stuck-reply containing `![](attachments/foo)`
  // (typed via the same paste-to-attach flow) shows the image instead
  // of the raw markdown text.
  if (role === "user" && text && !tool_result) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-gray-100 px-3 py-2 font-mono text-[11.5px] text-ink break-words">
          <Markdown cardId={cardId}>{text}</Markdown>
        </div>
      </div>
    );
  }

  // Standalone tool_result with no matching tool_use in this transcript.
  if (tool_result) {
    return (
      <div
        className={clsx(
          "rounded-md border bg-gray-50 px-2.5 py-1.5 font-mono text-[11px]",
          tool_result.is_error
            ? "border-red-200 text-red-900"
            : "border-border-strong text-ink",
        )}
      >
        <div className="mb-1 text-[10.5px] uppercase text-ink-subtle">
          result {tool_result.is_error && "(error)"}
        </div>
        <pre className="max-h-56 overflow-auto whitespace-pre-wrap leading-snug">
          {tool_result.content || "(empty)"}
        </pre>
      </div>
    );
  }

  // Assistant text → markdown bubble + optional usage chip on hover.
  if (role === "assistant" && text) {
    return (
      <div className="group relative flex flex-col">
        <div className="max-w-full rounded-lg bg-surface px-3 py-2 text-ink ring-1 ring-inset ring-border">
          <Markdown cardId={cardId}>{text}</Markdown>
        </div>
        {usage && (usage.input_tokens > 0 || usage.output_tokens > 0) && (
          <UsageChip usage={usage} />
        )}
      </div>
    );
  }

  // Assistant tool_use → collapsible card.
  if (role === "assistant" && tool_use) {
    return (
      <div className="flex flex-col">
        <ReadOnlyToolCard tool={tool_use} result={pairedResult} />
      </div>
    );
  }

  return null;
}

function UsageChip({
  usage,
}: {
  usage: { input_tokens: number; output_tokens: number };
}) {
  return (
    <span
      className="pointer-events-none mt-0.5 self-start font-mono text-[10px] text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100"
      title={`input ${usage.input_tokens.toLocaleString()} · output ${usage.output_tokens.toLocaleString()}`}
    >
      ↓{fmtTok(usage.input_tokens)} ↑{fmtTok(usage.output_tokens)}
    </span>
  );
}

// ── ToolCard (read-only twin of Composer/ToolCard.tsx) ────────────────
//
// Same visual vocabulary as the Composer version, but stripped of:
//  - the GATED set (make_card / save_plan never appear in helper
//    transcripts, since those tools are Composer-only).
//  - any approval / preview affordances.

interface ToolUse {
  id: string;
  name: string;
  input?: unknown;
}
interface ToolResultShape {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

function ReadOnlyToolCard({
  tool,
  result,
}: {
  tool: ToolUse;
  result?: ToolResultShape;
}) {
  const [open, setOpen] = useState(false);
  const meta = renderToolHeader(tool);
  const isError = !!result?.is_error;

  return (
    <div
      className={clsx(
        "rounded-md border bg-surface text-[12px]",
        isError ? "border-red-200" : "border-border-strong",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-ink hover:bg-gray-50"
      >
        <ChevronRight
          className={clsx(
            "h-3.5 w-3.5 shrink-0 text-ink-subtle transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0 text-ink-subtle">{meta.icon}</span>
        <span className="shrink-0 font-mono text-[11px] font-semibold text-ink-muted">
          {meta.label}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">
          {meta.summary}
        </span>
        {meta.tail && (
          <span className="shrink-0 font-mono text-[10.5px] text-ink-subtle">
            {meta.tail}
          </span>
        )}
        {isError && (
          <span className="shrink-0 rounded bg-red-50 px-1.5 py-0.5 font-mono text-[10px] font-medium text-red-700 ring-1 ring-inset ring-red-200">
            error
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-border px-2.5 py-2 text-[11.5px]">
          {meta.body}
          {result && <ToolResultBlock result={result} />}
        </div>
      )}
    </div>
  );
}

interface HeaderMeta {
  icon: ReactNode;
  label: string;
  summary: string;
  tail?: string;
  body: ReactNode;
}

function pickString(input: unknown, key: string): string | null {
  if (input && typeof input === "object" && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "string") return v;
  }
  return null;
}
function pickNumber(input: unknown, key: string): number | null {
  if (input && typeof input === "object" && key in input) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "number") return v;
  }
  return null;
}
function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Per-tool collapsed-row + expanded-body shape. Falls back to a generic
 * JSON view for tools we don't know about so future MCP additions
 * don't crash the read-only view.
 */
function renderToolHeader(tool: ToolUse): HeaderMeta {
  switch (tool.name) {
    case "Read": {
      const path = pickString(tool.input, "file_path") ?? "(no path)";
      return {
        icon: <FileText className="h-3.5 w-3.5" />,
        label: "Read",
        summary: path,
        body: (
          <div className="font-mono text-ink-subtle">
            Reading <span className="text-ink">{path}</span>
            {pickNumber(tool.input, "offset") != null && (
              <span> · offset {pickNumber(tool.input, "offset")}</span>
            )}
            {pickNumber(tool.input, "limit") != null && (
              <span> · limit {pickNumber(tool.input, "limit")}</span>
            )}
          </div>
        ),
      };
    }
    case "Edit": {
      const path = pickString(tool.input, "file_path") ?? "(no path)";
      const oldS = pickString(tool.input, "old_string") ?? "";
      const newS = pickString(tool.input, "new_string") ?? "";
      const tail = `+${newS.split("\n").length}/-${oldS.split("\n").length}`;
      return {
        icon: <Pencil className="h-3.5 w-3.5" />,
        label: "Edit",
        summary: path,
        tail,
        body: (
          <div className="space-y-1.5">
            <DiffPane label="-" tone="red">
              {trunc(oldS, 600)}
            </DiffPane>
            <DiffPane label="+" tone="green">
              {trunc(newS, 600)}
            </DiffPane>
          </div>
        ),
      };
    }
    case "Write": {
      const path = pickString(tool.input, "file_path") ?? "(no path)";
      const content = pickString(tool.input, "content") ?? "";
      const bytes = new Blob([content]).size;
      const lines = content.split("\n").slice(0, 40).join("\n");
      return {
        icon: <FilePlus className="h-3.5 w-3.5" />,
        label: "Write",
        summary: path,
        tail: `${bytes}b`,
        body: (
          <pre className="max-h-72 overflow-auto rounded bg-gray-50 p-2 font-mono text-[11px] leading-snug text-ink">
            {trunc(lines, 4000)}
          </pre>
        ),
      };
    }
    case "Bash": {
      const cmd = pickString(tool.input, "command") ?? "";
      return {
        icon: <Terminal className="h-3.5 w-3.5" />,
        label: "Bash",
        summary: trunc(cmd, 80),
        body: (
          <pre className="max-h-48 overflow-auto rounded bg-zinc-900 p-2 font-mono text-[11px] leading-snug text-zinc-100">
            {cmd || "(empty command)"}
          </pre>
        ),
      };
    }
    case "Glob": {
      const pattern = pickString(tool.input, "pattern") ?? "";
      const path = pickString(tool.input, "path");
      return {
        icon: <Folder className="h-3.5 w-3.5" />,
        label: "Glob",
        summary: pattern,
        tail: path ?? undefined,
        body: (
          <div className="font-mono text-ink-subtle">
            pattern <span className="text-ink">{pattern}</span>
            {path && (
              <>
                {" "}
                · path <span className="text-ink">{path}</span>
              </>
            )}
          </div>
        ),
      };
    }
    case "Grep": {
      const pattern = pickString(tool.input, "pattern") ?? "";
      const path = pickString(tool.input, "path");
      return {
        icon: <Search className="h-3.5 w-3.5" />,
        label: "Grep",
        summary: pattern,
        tail: path ?? undefined,
        body: (
          <div className="font-mono text-ink-subtle">
            <span className="text-ink">{pattern}</span>
            {path && <span> in {path}</span>}
          </div>
        ),
      };
    }
    case "WebFetch":
    case "WebSearch": {
      const q =
        pickString(tool.input, "url") ??
        pickString(tool.input, "query") ??
        "";
      return {
        icon: <Globe className="h-3.5 w-3.5" />,
        label: tool.name,
        summary: q,
        body: (
          <div className="font-mono text-ink-subtle break-all">
            <span className="text-ink">{q}</span>
          </div>
        ),
      };
    }
    case "TodoWrite": {
      const todos = (tool.input as { todos?: unknown[] } | null)?.todos;
      const count = Array.isArray(todos) ? todos.length : 0;
      return {
        icon: <ListChecks className="h-3.5 w-3.5" />,
        label: "TodoWrite",
        summary: `${count} item${count === 1 ? "" : "s"}`,
        body: (
          <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 font-mono text-[11px] leading-snug">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
        ),
      };
    }
    default: {
      // Unknown / future MCP tools: stringify input so nothing is lost.
      const json = JSON.stringify(tool.input);
      return {
        icon: <Wrench className="h-3.5 w-3.5" />,
        label: tool.name,
        summary: trunc(json, 120),
        body: (
          <pre className="max-h-48 overflow-auto rounded bg-gray-50 p-2 font-mono text-[11px] leading-snug">
            {JSON.stringify(tool.input, null, 2)}
          </pre>
        ),
      };
    }
  }
}

function DiffPane({
  label,
  tone,
  children,
}: {
  label: string;
  tone: "red" | "green";
  children: ReactNode;
}) {
  return (
    <pre
      className={clsx(
        "max-h-40 overflow-auto rounded p-2 font-mono text-[11px] leading-snug",
        tone === "red" ? "bg-red-50 text-red-900" : "bg-emerald-50 text-emerald-900",
      )}
    >
      <span className="select-none pr-1.5 opacity-60">{label}</span>
      {children}
    </pre>
  );
}

function ToolResultBlock({ result }: { result: ToolResultShape }) {
  // Trim long tool results — readers don't need the entire 10k-line file
  // dump; show first ~40 lines + a tail counter, expandable via the
  // <details> handle.
  const lines = result.content.split("\n");
  const visible = lines.slice(0, 40).join("\n");
  const overflow = lines.length - 40;
  return (
    <details className="mt-2 rounded border border-border bg-gray-50">
      <summary className="cursor-pointer px-2 py-1 font-mono text-[10.5px] uppercase text-ink-subtle">
        result {result.is_error && <span className="text-red-700">(error)</span>}
      </summary>
      <pre
        className={clsx(
          "max-h-72 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-snug",
          result.is_error ? "text-red-900" : "text-ink",
        )}
      >
        {visible || "(empty)"}
        {overflow > 0 && (
          <span className="block pt-1 text-ink-subtle">
            … {overflow} more line{overflow === 1 ? "" : "s"}
          </span>
        )}
      </pre>
    </details>
  );
}

// ── Misc formatters ──────────────────────────────────────────────────

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtRelative(iso: string | null): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const diffMs = Date.now() - t;
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
