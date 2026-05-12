"use client";
/**
 * Single transcript row for the Composer chat surface.
 *
 * Each `ComposerMessage` has at most one of: `text`, `tool_use`, or
 * `tool_result` (per the stream-json shape). `system` role is reserved
 * for server-injected status notes ("process crashed; click to
 * restart"). Token usage, when present, surfaces as a hover chip on
 * assistant rows.
 *
 * Tool result rows currently render as their own row. Visually nesting
 * them inside the matching tool_use card is a v2 nicety — the
 * adjacency in the transcript already conveys "this is the result of
 * the call right above it."
 */
import clsx from "clsx";
import { AlertTriangle } from "lucide-react";
import { Markdown } from "../Markdown";
import { ComposerToolCard } from "./ToolCard";
import type { ComposerMessage } from "@/lib/types";

interface Props {
  message: ComposerMessage;
  /**
   * Active composer thread id, threaded down so the Markdown renderer can
   * resolve `attachments/<filename>` against the right per-thread dir.
   * Optional only because draft mode (no thread yet) has no id — but in
   * draft mode there are no rendered messages either, so the value is
   * required in practice for any real render. */
  threadId?: string | null;
  /**
   * Matching tool_result for this row's tool_use, paired upstream by
   * ChatView. When present, the result is nested inside the ToolCard
   * (visible when expanded) instead of rendering as its own row.
   */
  pairedResult?: ComposerMessage["tool_result"];
}

/** Compact token formatter for the per-turn usage chip. */
function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function ComposerMessageRow({ message, threadId, pairedResult }: Props) {
  const { role, text, tool_use, tool_result, usage } = message;
  // Markdown wants `string | undefined`, not `null`. Normalize once.
  const scopeThreadId = threadId ?? undefined;

  // System messages — full-width muted info row. Used by the server
  // for "process crashed", "spawning…", etc.
  if (role === "system") {
    return (
      <div className="flex items-center gap-2 rounded-md bg-amber-50 px-3 py-1.5 text-[11.5px] text-amber-900 ring-1 ring-inset ring-amber-200">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span className="whitespace-pre-wrap">{text || "(system event)"}</span>
      </div>
    );
  }

  // User message — right-aligned bubble, markdown-rendered so pasted
  // images (`![image](attachments/foo.png)`) display as actual images
  // rather than as raw markdown text. Bare `@card-0091` mentions are
  // safe: no remark plugin auto-links them — they were always just
  // text once a message was sent; the `@` is a typing-time
  // autocomplete affordance, not something the renderer transforms.
  if (role === "user" && text) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-gray-100 px-3 py-2 text-[13px] text-ink break-words">
          <Markdown composerThreadId={scopeThreadId}>{text}</Markdown>
        </div>
      </div>
    );
  }

  // Assistant: text chunk → markdown.
  if (role === "assistant" && text) {
    return (
      <div className="group relative flex flex-col">
        <div className="max-w-full rounded-lg bg-surface px-3 py-2 text-ink ring-1 ring-inset ring-border">
          <Markdown composerThreadId={scopeThreadId}>{text}</Markdown>
        </div>
        {usage && (usage.input_tokens > 0 || usage.output_tokens > 0) && (
          <UsageChip usage={usage} />
        )}
      </div>
    );
  }

  // Assistant: tool_use → ToolCard (collapsed). The matching tool_result
  // (paired upstream by ChatView) nests inside the card when expanded.
  if (role === "assistant" && tool_use) {
    return (
      <div className="flex flex-col">
        <ComposerToolCard tool={tool_use} result={pairedResult} />
      </div>
    );
  }

  // Assistant: standalone tool_result (no matching tool_use in the
  // same row — the result_id was paired upstream by ChatView, but if
  // we landed here we just render it inline so nothing is dropped).
  if (role === "assistant" && tool_result) {
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

  // Empty / unknown — render nothing rather than a placeholder so the
  // stream doesn't pad with blanks.
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
