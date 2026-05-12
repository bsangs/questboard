"use client";
/**
 * Per-tool collapsible card for built-in Claude Code tools surfaced in
 * the Composer transcript (Read / Edit / Write / Bash / Glob / Grep /
 * WebFetch / WebSearch / TodoWrite / NotebookEdit / …).
 *
 * Why a dedicated component instead of just printing JSON: the chat
 * view can become very tall when claude inspects 20+ files. A row that
 * shows just the affected path (and a tiny diff hint for Edit) lets
 * the user skim an exploration in seconds, while still letting them
 * pop a card open to see the actual content.
 *
 * Pairs with Message.tsx: the row decides _whether_ a tool_use becomes
 * a ToolCard at all. `make_card` / `save_plan` are NOT rendered here
 * — they get their own preview-gate components (MakeCardPreview /
 * SavePlanPreview) that double as approval UI.
 */
import clsx from "clsx";
import {
  ChevronRight,
  FileText,
  Pencil,
  FilePlus,
  Terminal,
  Search,
  Folder,
  Globe,
  ListChecks,
  Wrench,
} from "lucide-react";
import { useState, type ReactNode } from "react";

interface ToolUse {
  id: string;
  name: string;
  // Optional to match the canonical ComposerMessage.tool_use shape from
  // core/types.ts (z.unknown() makes the property optional). Without
  // this, Message.tsx fails to assign tool_use → ToolCard.
  input?: unknown;
}

interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error: boolean;
}

interface Props {
  tool: ToolUse;
  /** Optional matching tool_result; nests under the same card. */
  result?: ToolResult;
}

/** Tools whose previews live in dedicated gate components, not here. */
const GATED = new Set(["make_card", "save_plan"]);

/**
 * Best-effort string coercion for `input.<key>` — claude's stream-json
 * boundary is `unknown`, so we narrow defensively.
 */
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

/** Truncate a string to N chars, appending an ellipsis. */
function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function ComposerToolCard({ tool, result }: Props) {
  // Defensive skip: gated tools have their own preview UI rendered by
  // ChatView. ToolCard is only for "informational" tools.
  if (GATED.has(tool.name)) return null;

  const [open, setOpen] = useState(false);
  const meta = renderHeader(tool);
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

/**
 * Compute the collapsed-state header + expanded-state body per tool
 * type. Falls back to a generic JSON view for unknown tools so the
 * UI keeps working when claude-code adds new tools.
 */
function renderHeader(tool: ToolUse): HeaderMeta {
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
      // Naive line-delta hint for the collapsed row. A real diff is more
      // work than v1 wants — the expanded body shows the raw old/new.
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
      // claude-code's todo list — show count only in collapsed.
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
      // Generic fallback. JSON-stringify the input so unknown tools (and
      // future MCP tools) don't crash the UI.
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

function ToolResultBlock({ result }: { result: ToolResult }) {
  // Trim very long tool results — readers don't need the entire 10k-line
  // file dump; the AI does. Show first ~40 lines + a tail counter.
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
