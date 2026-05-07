"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import clsx from "clsx";
import {
  AlertTriangle,
  BookText,
  Bug,
  CheckCircle2,
  CircleDot,
  Hammer,
  MessageSquare,
  Star,
  Wrench,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useBoard } from "@/lib/state";
import type { CardSummary } from "@/lib/types";

const FLAVOR_ICON = {
  feature: Star,
  bug: Bug,
  refactor: Wrench,
  chore: Hammer,
  docs: BookText,
} as const;

const PRIORITY_STYLE: Record<1 | 2 | 3, string> = {
  1: "bg-red-50 text-red-700 ring-red-200",
  2: "bg-amber-50 text-amber-700 ring-amber-200",
  3: "bg-blue-50 text-blue-700 ring-blue-200",
};

function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m${s ? ` ${s}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Claude's context window is 1M tokens. Show how full it is. */
const CONTEXT_WINDOW = 1_000_000;
function fmtTokens(t: number): string {
  const pct = Math.round((t / CONTEXT_WINDOW) * 100);
  let abs: string;
  if (t < 1000) abs = String(t);
  else if (t < 1_000_000) abs = `${(t / 1000).toFixed(1)}K`;
  else abs = `${(t / 1_000_000).toFixed(2)}M`;
  return `${pct}% · ${abs}`;
}

function fmtRelative(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return "";
  const delta = Math.max(0, Date.now() - ts);
  const s = Math.floor(delta / 1000);
  if (s < 30) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

interface Props {
  card: CardSummary;
  draggable?: boolean;
}

export function CardTile({ card, draggable = false }: Props) {
  const openDrawer = useBoard((s) => s.openDrawer);
  const toggleSelect = useBoard((s) => s.toggleSelect);
  const selected = useBoard((s) => s.selected.has(card.id));
  // The `?? []` MUST live OUTSIDE the zustand selector. Inside the
  // selector, a new `[]` is created every call when `config.scopes` is
  // undefined; zustand's default `Object.is` snapshot check sees that
  // as a change → rerender → new `[]` → infinite loop → React #185
  // ("Maximum update depth exceeded"). Selecting the bare value keeps
  // the reference stable across renders.
  const scopes = useBoard((s) => s.config?.scopes) ?? [];
  const FlavorIcon = FLAVOR_ICON[card.flavor] ?? CircleDot;
  // Resolve scope id to the user-friendly label; fall back to the raw id if
  // the scope was deleted from config but the card still references it.
  const scopeLabel = card.scope
    ? (scopes.find((s) => s.id === card.scope)?.label ?? card.scope)
    : null;

  const drag = useDraggable({
    id: card.id,
    data: { card },
    disabled: !draggable,
  });

  const style = drag.transform
    ? { transform: CSS.Translate.toString(drag.transform) }
    : undefined;

  const onClick = (ev: React.MouseEvent<HTMLDivElement>) => {
    // Cmd/Ctrl-click → multi-select (only meaningful for Done column)
    if ((ev.metaKey || ev.ctrlKey) && card.status === "done") {
      ev.preventDefault();
      ev.stopPropagation();
      toggleSelect(card.id, true);
      return;
    }
    openDrawer(card.id);
  };

  const isInProgress = card.status === "in_progress";
  const isStuck = card.status === "stuck";
  // ai_review / merging show their own pulse if a worker is currently
  // attached (owner_pid set), so the column isn't ambiguous between
  // "queued for review" and "reviewer running".
  const isAiReviewing =
    card.status === "ai_review" && card.owner_pid != null;
  const isMerging = card.status === "merging" && card.owner_pid != null;
  // Post-build is a sub-phase of merging — shown when the merger has
  // finished merging and is now running the user's post-build command.
  // Takes precedence over `merging` in the status line so we don't
  // double-display.
  const isPostBuild = card.post_build_active === true;
  const isHelperLive = isInProgress || isAiReviewing || isMerging || isPostBuild;

  // Single-source status descriptor for the dedicated status line. Picks
  // ONE word per card (priority post-build > merging > reviewing > in
  // progress) so the line never reads as multiple states at once.
  const statusBadge: { label: string; color: string; ring: string } | null =
    isPostBuild
      ? { label: "post-build", color: "text-amber-700", ring: "bg-amber-500" }
      : isMerging
      ? { label: "merging", color: "text-blue-700", ring: "bg-blue-500" }
      : isAiReviewing
      ? { label: "reviewing", color: "text-violet-700", ring: "bg-violet-500" }
      : isInProgress
      ? { label: "in progress", color: "text-emerald-700", ring: "bg-emerald-500" }
      : null;

  // Live elapsed: tick once per second between server heartbeats so the
  // user sees the clock move. Anchor each new heartbeat reading to "now"
  // (heartbeatRef) so we extrapolate from it instead of double-counting.
  const heartbeatRef = useRef({
    base: card.elapsed_seconds ?? 0,
    receivedAt: Date.now(),
  });
  useEffect(() => {
    heartbeatRef.current = {
      base: card.elapsed_seconds ?? 0,
      receivedAt: Date.now(),
    };
  }, [card.elapsed_seconds]);

  const [tickNow, setTickNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isHelperLive) return;
    const id = setInterval(() => setTickNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isHelperLive]);

  const liveElapsed = isHelperLive
    ? heartbeatRef.current.base +
      Math.max(0, Math.floor((tickNow - heartbeatRef.current.receivedAt) / 1000))
    : card.elapsed_seconds;

  return (
    <div
      ref={drag.setNodeRef}
      style={style}
      {...drag.attributes}
      {...drag.listeners}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") openDrawer(card.id);
      }}
      className={clsx(
        "group relative cursor-pointer select-none rounded-md bg-white p-3",
        "shadow-tile transition-shadow duration-150 hover:shadow-tileHover",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50",
        selected && "ring-2 ring-blue-500/70",
        drag.isDragging && "opacity-60",
        card.broken && "ring-1 ring-red-300",
      )}
    >
      {/* Top row: flavor icon · priority · ID */}
      <div className="mb-1.5 flex items-center gap-2 text-[11px] text-ink-muted">
        <FlavorIcon className="h-3.5 w-3.5 text-ink-subtle" aria-hidden />
        <span
          className={clsx(
            "rounded px-1.5 py-0.5 font-mono text-[10px] font-medium ring-1 ring-inset",
            PRIORITY_STYLE[card.priority],
          )}
          title={`Priority ${card.priority}`}
        >
          P{card.priority}
        </span>
        <span className="font-mono text-[10px] text-ink-subtle">
          {card.id}
        </span>
        {/* The live helper-state badge used to ride here as a small pill,
            but it duplicated the dedicated status line below the title.
            That single source is now the only place the status word
            appears — header is reserved for static identifiers
            (flavor / priority / id / scope). */}
        {scopeLabel && (
          <span
            className="max-w-[140px] truncate rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-muted ring-1 ring-inset ring-black/5"
            title={`Scope: ${scopeLabel}`}
          >
            {scopeLabel}
          </span>
        )}
      </div>

      {/* Title */}
      <div className="line-clamp-2 text-[13.5px] font-medium leading-snug text-ink">
        {card.title}
      </div>

      {/* Broken */}
      {card.broken && (
        <div className="mt-2 inline-flex items-center gap-1 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700 ring-1 ring-inset ring-red-200">
          <AlertTriangle className="h-3 w-3" /> broken frontmatter
        </div>
      )}

      {/* Dedicated status line — the SINGLE place where the live helper
          state word appears on the card. Pulsing dot + one word, nothing
          else. Hidden when the card isn't actively being worked. */}
      {statusBadge && (
        <div className="mt-2 flex items-center gap-1.5 text-[11.5px] leading-none">
          <span
            className={clsx(
              "inline-block h-1.5 w-1.5 animate-pulseDot rounded-full",
              statusBadge.ring,
            )}
          />
          <span className={clsx("font-medium", statusBadge.color)}>
            {statusBadge.label}
          </span>
        </div>
      )}

      {/* Activity stats — separate row below the status line. Time +
          tokens + pid only; status word is up above. */}
      {isHelperLive && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-ink-muted">
          <span>{fmtElapsed(liveElapsed)}</span>
          <span aria-hidden>·</span>
          <span className="font-mono">{fmtTokens(card.tokens_used)}</span>
          {card.owner_pid && (
            <span className="font-mono text-ink-subtle">pid {card.owner_pid}</span>
          )}
        </div>
      )}

      {/* Per-role lifetime output tokens. Hidden chips for roles that
          haven't produced anything yet, so a fresh card stays clean. */}
      <RoleTokenChips card={card} />

      {/* Stuck */}
      {isStuck && card.stuck_question && (
        <div className="mt-2 flex items-start gap-1.5 rounded bg-amber-50 px-2 py-1 text-[11.5px] text-amber-900 ring-1 ring-inset ring-amber-200">
          <AlertTriangle className="mt-[2px] h-3 w-3 shrink-0" />
          <span className="line-clamp-2">{card.stuck_question}</span>
        </div>
      )}

      {/* Queued / blocked badges */}
      {card.queued && (
        <div className="mt-2 inline-flex rounded bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-muted">
          queued
        </div>
      )}
      {card.blocked_by?.length ? (
        <div className="mt-2 inline-flex rounded bg-gray-100 px-1.5 py-0.5 text-[10.5px] font-medium text-ink-muted">
          blocked by {card.blocked_by.map((d) => `#${d}`).join(", ")}
        </div>
      ) : null}

      {/* Footer: comments + last activity */}
      <div className="mt-2.5 flex items-center justify-between text-[11px] text-ink-subtle">
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3 w-3" />
          {card.comment_count ?? 0}
        </span>
        <span>{fmtRelative(card.updated_at)}</span>
      </div>

      {card.status === "done" && (
        <div className="absolute right-2 top-2 text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        </div>
      )}
    </div>
  );
}

/** Cumulative input + output tokens per helper role for this card. */
function RoleTokenChips({ card }: { card: CardSummary }) {
  const wi = card.worker_input_tokens ?? 0;
  const wo = card.worker_output_tokens ?? 0;
  const ri = card.reviewer_input_tokens ?? 0;
  const ro = card.reviewer_output_tokens ?? 0;
  const mi = card.merger_input_tokens ?? 0;
  const mo = card.merger_output_tokens ?? 0;
  if (wi + wo + ri + ro + mi + mo === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1 text-[10.5px] font-mono">
      {(wi > 0 || wo > 0) && (
        <span
          className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-700 ring-1 ring-inset ring-emerald-200"
          title={`Worker — in ${wi.toLocaleString()} · out ${wo.toLocaleString()}`}
        >
          W ↓{fmtTokensCompact(wi)} ↑{fmtTokensCompact(wo)}
        </span>
      )}
      {(ri > 0 || ro > 0) && (
        <span
          className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-700 ring-1 ring-inset ring-violet-200"
          title={`Reviewer — in ${ri.toLocaleString()} · out ${ro.toLocaleString()}`}
        >
          R ↓{fmtTokensCompact(ri)} ↑{fmtTokensCompact(ro)}
        </span>
      )}
      {(mi > 0 || mo > 0) && (
        <span
          className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 ring-1 ring-inset ring-blue-200"
          title={`Merger — in ${mi.toLocaleString()} · out ${mo.toLocaleString()}`}
        >
          M ↓{fmtTokensCompact(mi)} ↑{fmtTokensCompact(mo)}
        </span>
      )}
    </div>
  );
}

/** Compact token formatter without the context-window percent prefix. */
function fmtTokensCompact(t: number): string {
  if (t < 1000) return String(t);
  if (t < 1_000_000) return `${(t / 1000).toFixed(1)}K`;
  return `${(t / 1_000_000).toFixed(2)}M`;
}
