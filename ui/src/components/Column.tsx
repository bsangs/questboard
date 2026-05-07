"use client";

import { useDroppable } from "@dnd-kit/core";
import clsx from "clsx";
import { ChevronDown, Plus } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { CardTile } from "./CardTile";
import { useBoard } from "@/lib/state";
import { useIsMobile } from "@/lib/useIsMobile";
import type { CardStatus, CardSummary } from "@/lib/types";

const COLUMN_ACCENT: Record<CardStatus, string> = {
  backlog: "bg-gray-300",
  ready: "bg-blue-400",
  in_progress: "bg-emerald-400",
  stuck: "bg-amber-400",
  human_review: "bg-violet-400",
  ai_review: "bg-fuchsia-400",
  merging: "bg-blue-500",
  done: "bg-emerald-500",
  cancelled: "bg-gray-300",
};

const EMPTY_MSG: Partial<Record<CardStatus, string>> = {
  backlog: "Create your first card",
  ready: "Move a Backlog card here to start",
  in_progress: "No workers active",
  stuck: "Nothing waiting on you",
  human_review: "No reviews pending",
  ai_review: "No AI reviews running",
  merging: "No merges in flight",
  done: "No completed cards yet",
};

interface Props {
  status: CardStatus;
  label: string;
  cards: CardSummary[];
  /** Whether dragging *into* this column is allowed at all. Used to dim others during a drag. */
  highlighted?: boolean;
  /** Whether this column accepts drops in the current drag context. */
  droppable?: boolean;
  /** Whether cards in this column are draggable. */
  draggable?: boolean;
  isDragging?: boolean;
}

/**
 * Best-effort OS hint for the modifier key. Returns "Cmd" on Macs,
 * "Ctrl" on Windows/Linux, "Cmd / Ctrl" if we can't tell — we render
 * a one-line instructional banner so close enough is fine.
 */
function modKeyLabel(): string {
  if (typeof navigator === "undefined") return "Cmd / Ctrl";
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  if (/Mac|iPhone|iPad|iPod/i.test(platform) || /Mac OS X/i.test(ua)) {
    return "Cmd";
  }
  if (/Win|Linux/i.test(platform)) return "Ctrl";
  return "Cmd / Ctrl";
}

export function Column({
  status,
  label,
  cards,
  droppable = false,
  draggable = false,
  isDragging = false,
}: Props) {
  const { setNodeRef, isOver } = useDroppable({
    id: status,
    disabled: !droppable,
  });
  const setNewCardOpen = useBoard((s) => s.setNewCardOpen);
  const selectedCount = useBoard((s) => s.selected.size);
  const isMobile = useIsMobile();

  // Inline "+ New" lives only on Backlog — that's the canonical entry point
  // for new work. Other columns are state-machine destinations only.
  const showInlineNew = status === "backlog";

  // Mobile-only collapse state. Default: collapse empty sections; keep
  // sections with cards expanded so the user sees real work first.
  // Backlog stays open even when empty (the inline "+ New" lives there).
  const [collapsed, setCollapsed] = useState<boolean>(
    () => !showInlineNew && cards.length === 0,
  );
  useEffect(() => {
    // If a column went from empty -> non-empty, auto-expand so new work
    // is visible without an extra tap.
    if (cards.length > 0) setCollapsed(false);
  }, [cards.length]);

  const modKey = useMemo(() => modKeyLabel(), []);
  const showDoneHint =
    status === "done" && cards.length > 0 && selectedCount === 0;

  const headerLabel = (
    <>
      <span
        className={clsx("h-1.5 w-1.5 rounded-full", COLUMN_ACCENT[status])}
        aria-hidden
      />
      <h2 className="text-[12.5px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </h2>
      <span className="ml-1 rounded bg-white px-1.5 py-0.5 font-mono text-[10.5px] text-ink-subtle ring-1 ring-inset ring-black/5">
        {cards.length}
      </span>
    </>
  );

  return (
    <div
      ref={setNodeRef}
      className={clsx(
        "flex shrink-0 flex-col rounded-lg bg-[var(--bg-muted)] transition-colors duration-200",
        // Mobile: full-width stacked sections with auto height.
        // Desktop: fixed 280px column, full available height.
        "w-full md:h-full md:w-[280px]",
        isDragging && !droppable && "opacity-40",
        isOver && droppable && "ring-2 ring-blue-400/70 ring-offset-2 ring-offset-white",
      )}
    >
      {/* Header — clickable on mobile (toggles collapse), static on desktop */}
      {isMobile ? (
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="sticky top-0 z-[1] flex min-h-[44px] w-full items-center gap-2 rounded-t-lg bg-[var(--bg-muted)] px-3 py-2.5 text-left"
          aria-expanded={!collapsed}
          aria-controls={`column-body-${status}`}
        >
          {headerLabel}
          <ChevronDown
            className={clsx(
              "ml-auto h-4 w-4 text-ink-subtle transition-transform",
              collapsed && "-rotate-90",
            )}
            aria-hidden
          />
        </button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2.5">{headerLabel}</div>
      )}

      {/* Body */}
      {(!isMobile || !collapsed) && (
        <div
          id={`column-body-${status}`}
          className="flex-1 space-y-2 overflow-y-auto px-2 pb-3"
        >
          {showDoneHint && (
            <div
              className="rounded-md border border-blue-100 bg-blue-50/70 px-2.5 py-1.5 text-[11.5px] leading-snug text-blue-800"
              role="note"
            >
              <kbd className="rounded border border-blue-200 bg-white px-1 py-px font-mono text-[10.5px] text-blue-900">
                {modKey}
              </kbd>
              -click to multi-select for archive
            </div>
          )}
          {cards.length === 0 ? (
            <div className="flex h-24 items-center justify-center px-3 text-center text-[12px] text-ink-subtle">
              {EMPTY_MSG[status] ?? "—"}
            </div>
          ) : (
            cards.map((c) => (
              <CardTile key={c.id} card={c} draggable={draggable} />
            ))
          )}
          {showInlineNew && (
            <button
              type="button"
              onClick={() => setNewCardOpen(true)}
              className={clsx(
                "flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-black/15 bg-transparent",
                "px-3 py-2 text-[12px] font-medium text-ink-subtle",
                "min-h-[44px] md:min-h-0",
                "transition-colors hover:border-black/30 hover:bg-white hover:text-ink-muted",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50",
              )}
              aria-label="New card"
            >
              <Plus className="h-3.5 w-3.5" />
              New
            </button>
          )}
        </div>
      )}
    </div>
  );
}
