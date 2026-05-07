"use client";

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import clsx from "clsx";
import { Archive, ChevronDown, MessageSquarePlus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  archiveCards,
  approveCard,
  getConfig,
  listCards,
  moveToAiReview,
  moveToBacklog,
  moveToReady,
  patchConfig,
  requeueCard,
  toggleAutoReview,
} from "@/lib/api";
import { useSse } from "@/lib/sse";
import { COLUMNS, useBoard } from "@/lib/state";
import type { CardStatus, CardSummary } from "@/lib/types";
import { CardDrawer } from "./CardDrawer";
import { CardTile } from "./CardTile";
import { Column } from "./Column";
import { ComposerModal } from "./Composer/Modal";
import { CwdPicker } from "./Composer/CwdPicker";
import { NewCardModal } from "./NewCardModal";
import { SettingsDrawer } from "./SettingsDrawer";
import { StatsPanel } from "./StatsPanel";
import { Toaster } from "./Toaster";

/**
 * Static allowed drag-and-drop transitions for non-stuck cards. Stuck cards
 * are computed per-card by `dropTargetsFor` below — their valid targets
 * depend on `merged_sha` (see STUCK_TRANSITIONS in @questboard/core).
 *
 * Adding a new edge: update both this table AND state-machine.ts
 * TRANSITIONS so the server agrees with the UI.
 */
const STATIC_ALLOWED_DROPS: Record<CardStatus, CardStatus[]> = {
  backlog: ["ready"],
  ready: ["backlog"], // pull back (T2b) — only valid before dispatcher claims
  in_progress: ["ready"], // requeue (force re-spawn)
  // stuck handled below — depends on merged_sha
  stuck: [],
  human_review: ["done", "ai_review", "ready"], // approve / send to AI / requeue
  ai_review: ["done", "ready"], // approve directly / requeue
  merging: ["ready"], // bail out of a stuck merge
  // done → cancelled is exposed via the drawer (with a confirm), not as a
  // DnD edge. There's no "Cancelled" column here, and accidental drag-and-
  // drop into a hypothetical column would be far too easy a way to lose
  // tracking on shipped work.
  done: [],
  cancelled: [],
};

/**
 * Resolve the set of valid drop targets for a card. Stuck cards branch on
 * `merged_sha`:
 *   - merged_sha == null  → ["ready"]   (re-queue for fresh worker)
 *   - merged_sha != null  → []          (no DnD targets; drawer handles
 *     retry-post-build and force-done with explicit affordances)
 *
 * The drawer offers retry-post-build and force-done as buttons on
 * stuck-with-merged_sha cards; we keep them OFF the DnD surface to avoid
 * accidental destructive moves (drag-to-Done losing audit context, etc.).
 */
export function dropTargetsFor(card: CardSummary): CardStatus[] {
  if (card.status !== "stuck") return STATIC_ALLOWED_DROPS[card.status] ?? [];
  return card.merged_sha == null ? ["ready"] : [];
}

export function Board() {
  const cards = useBoard((s) => s.cards);
  const setCards = useBoard((s) => s.setCards);
  const config = useBoard((s) => s.config);
  const setConfig = useBoard((s) => s.setConfig);
  const applySseEvent = useBoard((s) => s.applySseEvent);
  const pushToast = useBoard((s) => s.pushToast);
  const selected = useBoard((s) => s.selected);
  const clearSelection = useBoard((s) => s.clearSelection);
  const patchCardLocal = useBoard((s) => s.patchCard);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // ─── Initial fetch ────────────────────────────────────────────────────────
  const refreshCards = useCallback(async () => {
    try {
      const summaries = await listCards();
      setCards(summaries);
    } catch (e) {
      pushToast({
        kind: "error",
        message: `Failed to load cards: ${e instanceof Error ? e.message : ""}`,
      });
    }
  }, [setCards, pushToast]);

  useEffect(() => {
    refreshCards();
    getConfig()
      .then(setConfig)
      .catch(() => {
        // Config endpoint not critical to render; ignore.
      });
  }, [refreshCards, setConfig]);

  // ─── SSE wiring ──────────────────────────────────────────────────────────
  // SSE is now the realtime channel. Periodic polling has been dropped —
  // sse.ts triggers `refreshCards` on every reconnect (catches any events
  // missed during a disconnect window). Live updates land event-by-event;
  // bulk-mutating events (status_changed/archived) also kick a refresh
  // below to keep fields not in the payload (deps, language, comment_count)
  // in sync.
  useSse(
    (ev) => {
      applySseEvent(ev);
      if (
        ev.type === "card_created" ||
        ev.type === "card_updated" ||
        ev.type === "card_status_changed" ||
        ev.type === "card_archived"
      ) {
        // Refetch on any column-changing event so we always render the
        // server's current truth. Fields not in the event payload (deps,
        // language, comment_count, …) also stay in sync.
        refreshCards();
      }
      // Toast notifications for important transitions.
      if (ev.type === "card_status_changed") {
        if (ev.to === "stuck") {
          pushToast({
            kind: "info",
            message: `Card ${ev.card_id} is stuck — needs your input.`,
          });
        } else if (ev.to === "human_review") {
          pushToast({
            kind: "info",
            message: `Card ${ev.card_id} ready for review.`,
          });
        }
      }
    },
    {
      onReconnect: () => {
        // SSE was down for some interval; pull the full board to catch up.
        refreshCards();
      },
    },
  );

  // ─── Group cards by column ───────────────────────────────────────────────
  const grouped = useMemo(() => {
    const out: Record<CardStatus, CardSummary[]> = {
      backlog: [],
      ready: [],
      in_progress: [],
      stuck: [],
      human_review: [],
      ai_review: [],
      merging: [],
      done: [],
      cancelled: [],
    };
    for (const c of Object.values(cards)) {
      const col = (out[c.status] ??= []);
      col.push(c);
    }
    // Sort within each column: priority asc, then created_at asc.
    for (const k of Object.keys(out) as CardStatus[]) {
      out[k].sort(
        (a, b) =>
          a.priority - b.priority ||
          a.created_at.localeCompare(b.created_at),
      );
    }
    return out;
  }, [cards]);

  // ─── DnD ────────────────────────────────────────────────────────────────
  const draggingCard = activeDragId ? cards[activeDragId] : null;
  const allowedTargets = draggingCard ? dropTargetsFor(draggingCard) : [];

  const onDragStart = (e: DragStartEvent) => {
    setActiveDragId(String(e.active.id));
  };

  const onDragEnd = async (e: DragEndEvent) => {
    setActiveDragId(null);
    const cardId = String(e.active.id);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const card = cards[cardId];
    if (!card) return;
    const to = overId as CardStatus;
    if (to === card.status) return;

    const allowed = dropTargetsFor(card);
    if (!allowed.includes(to)) {
      pushToast({
        kind: "error",
        message: `Can't move from ${card.status} to ${to}.`,
      });
      return;
    }

    // Confirm for "destructive" or non-obvious moves.
    if (card.status === "human_review" && to === "ai_review") {
      if (!confirm("Move card to AI Review?")) return;
    }
    if (to === "ready" && card.status !== "backlog") {
      // Re-queueing kills any running worker/merger and resets the card.
      if (
        !confirm(
          `Re-queue card from ${card.status} back to Ready? Any running worker/merger will be stopped.`,
        )
      )
        return;
    }

    // Optimistic update.
    const prevStatus = card.status;
    patchCardLocal(cardId, { status: to });
    try {
      switch (true) {
        case prevStatus === "backlog" && to === "ready":
          await moveToReady(cardId);
          break;
        case prevStatus === "ready" && to === "backlog":
          // T2b — pull a ready card back into backlog before the
          // dispatcher claims it.
          await moveToBacklog(cardId);
          break;
        case to === "ready":
          // Generic re-queue from any waiting/active column.
          await requeueCard(cardId);
          break;
        case (prevStatus === "human_review" || prevStatus === "ai_review") &&
          to === "done":
          // Approve — server now routes via merging; status will land on
          // merging shortly via SSE.
          await approveCard(cardId);
          break;
        case prevStatus === "human_review" && to === "ai_review":
          await moveToAiReview(cardId);
          break;
        default:
          throw new Error(`Unhandled transition ${prevStatus} → ${to}`);
      }
    } catch (err) {
      // Rollback.
      patchCardLocal(cardId, { status: prevStatus });
      pushToast({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // ─── Bulk archive ────────────────────────────────────────────────────────
  const onArchiveSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!confirm(`Archive ${ids.length} card(s)?`)) return;
    try {
      await archiveCards(ids);
      pushToast({
        kind: "success",
        message: `Archived ${ids.length} card(s).`,
      });
      clearSelection();
      // Cards will be removed via SSE `card_archived`.
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // ─── Render ──────────────────────────────────────────────────────────────
  const activeWorkers = useBoard((s) => s.stats?.active_workers ?? 0);
  const concurrencyLimit =
    useBoard((s) => s.stats?.concurrency_limit) ?? config?.concurrency_limit ?? 8;
  const queuedCount = useBoard((s) => s.stats?.queued_cards ?? 0);

  return (
    <div className="flex h-screen flex-col bg-white">
      {/* Top bar — condenses on mobile: title + a couple essentials,
          dense pill row hidden under md */}
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-black/5 bg-white px-4 py-2.5 md:gap-4 md:px-5">
        <h1 className="flex items-center gap-2 text-[14.5px] font-semibold tracking-tight">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-emerald-500"
          />
          <span className="hidden sm:inline">questboard</span>
          <span className="sm:hidden">questboard</span>
        </h1>

        <div className="hidden items-center gap-3 text-[12px] text-ink-muted md:flex">
          <span
            className={clsx(
              "rounded px-1.5 py-0.5 font-mono",
              activeWorkers >= concurrencyLimit
                ? "bg-red-50 text-red-700"
                : "bg-gray-100",
            )}
          >
            {activeWorkers}/{concurrencyLimit} workers
          </span>
          <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono">
            {queuedCount} queued
          </span>
          <StatsPanel />
        </div>

        <div className="ml-auto flex items-center gap-1.5 md:gap-2">
          <DispatchPauseToggle />
          <AutoReviewToggle />
          <ComposerTrigger />
          <NewCardModal />
          <SettingsDrawer />
        </div>
      </header>

      {/* Paused banner — sits above the columns when the dispatcher is
          parked. Amber so it reads as a temporary, intentional state. */}
      {config?.dispatch_paused ? <DispatchPausedBanner /> : null}

      {/* Board */}
      <DndContext
        sensors={sensors}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveDragId(null)}
      >
        <div
          className={clsx(
            "flex flex-1 gap-3 px-4 py-4",
            // Desktop: horizontal kanban scroll (unchanged).
            // Mobile: vertical stack of full-width sections that scroll the page.
            "flex-col overflow-y-auto md:flex-row md:overflow-x-auto md:overflow-y-hidden",
          )}
        >
          {COLUMNS.map((col) => {
            const droppable =
              !!draggingCard && allowedTargets.includes(col.id);
            // A column is "draggable from" iff there's at least one allowed
            // target out of it. We use the STATIC table here as a coarse
            // signal — the per-card `dropTargetsFor` runs at drag-start, so
            // a stuck card with merged_sha will still be picked up but find
            // no valid targets and bounce back. (Marking the column as a
            // whole non-draggable would block the merged_sha=null cards
            // that DO have a valid Ready target.)
            const draggable =
              col.id === "stuck"
                ? true
                : (STATIC_ALLOWED_DROPS[col.id]?.length ?? 0) > 0;
            return (
              <Column
                key={col.id}
                status={col.id}
                label={col.label}
                cards={grouped[col.id] ?? []}
                droppable={droppable}
                draggable={draggable}
                isDragging={!!draggingCard}
              />
            );
          })}
        </div>

        <DragOverlay dropAnimation={null}>
          {draggingCard ? (
            <div className="w-[260px] rotate-1">
              <CardTile card={draggingCard} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {/* Floating action bar — bulk archive (also shown for single selection
          since this is the primary archive UI for power users) */}
      {selected.size >= 1 && (
        <div className="fixed bottom-5 left-1/2 z-30 -translate-x-1/2 animate-fadeIn">
          <div className="flex items-center gap-3 rounded-full border border-black/10 bg-white px-4 py-2 shadow-lg">
            <span className="text-[12.5px]">
              <span className="font-mono">{selected.size}</span> selected
            </span>
            <button
              onClick={onArchiveSelected}
              className="inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1 text-[12px] font-medium text-white hover:bg-black"
            >
              <Archive className="h-3.5 w-3.5" /> Archive
            </button>
            <button
              onClick={clearSelection}
              className="rounded-full px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <CardDrawer />
      <ComposerModal />
      <Toaster />
    </div>
  );
}

/**
 * [Composer ▼] split-button. Left half opens the modal directly; right
 * half drops a small popover for picking the working directory before
 * creating a new thread. Matches the visual weight of the adjacent
 * AutoReviewToggle and "+ New" buttons.
 */
function ComposerTrigger() {
  const setComposerOpen = useBoard((s) => s.setComposerOpen);
  const [pickerOpen, setPickerOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close the popover on outside click. Using a wrapper ref keeps the
  // CwdPicker's own clicks from racing this listener.
  useEffect(() => {
    if (!pickerOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [pickerOpen]);

  return (
    <div ref={wrapRef} className="relative inline-flex">
      <div className="inline-flex overflow-hidden rounded-md border border-black/10 bg-white shadow-sm">
        <button
          onClick={() => setComposerOpen(true)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[12.5px] font-medium text-ink hover:bg-black/5"
          title="Open Composer"
        >
          <MessageSquarePlus className="h-3.5 w-3.5" /> Composer
        </button>
        <button
          onClick={() => setPickerOpen((v) => !v)}
          aria-label="Composer options"
          className="border-l border-black/10 px-1.5 text-ink-muted hover:bg-black/5"
          title="New thread with working directory…"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>
      {pickerOpen && (
        <div className="absolute right-0 top-[110%] z-30">
          <CwdPicker onClose={() => setPickerOpen(false)} />
        </div>
      )}
    </div>
  );
}

function AutoReviewToggle() {
  const config = useBoard((s) => s.config);
  const setConfig = useBoard((s) => s.setConfig);
  const pushToast = useBoard((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const checked = !!config?.auto_review;

  const flip = async () => {
    setBusy(true);
    try {
      const { auto_review, swept_count } = await toggleAutoReview();
      setConfig({
        ...(config ?? {
          concurrency_limit: 8,
          telegram_enabled: false,
          default_language: "en",
          auto_review: false,
          dispatch_paused: false,
          scopes: [],
          default_scope: null,
          merger_post_build_command: null,
          merger_post_build_cwd: null,
          composer_concurrency: 3,
        }),
        auto_review,
      });
      if (swept_count > 0) {
        pushToast({
          kind: "info",
          message: `Auto-review on; swept ${swept_count} card(s) to AI Review.`,
        });
      }
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={flip}
      disabled={busy}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors",
        checked
          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
          : "border-black/10 text-ink-muted hover:bg-black/5",
      )}
      role="switch"
      aria-checked={checked}
      title="Toggle global auto-review"
    >
      <span
        className={clsx(
          "inline-block h-1.5 w-1.5 rounded-full",
          checked ? "bg-emerald-500" : "bg-gray-300",
        )}
      />
      Auto-review {checked ? "on" : "off"}
    </button>
  );
}

/**
 * Pause / resume the dispatcher's spawn loop. PATCH /api/config flips
 * `dispatch_paused`; the dispatcher early-returns from trySpawnRound while
 * the flag is set. Currently-running helpers continue — we never SIGTERM
 * on pause. SSE `config_changed` keeps every other tab in sync.
 */
function DispatchPauseToggle() {
  const config = useBoard((s) => s.config);
  const setConfig = useBoard((s) => s.setConfig);
  const pushToast = useBoard((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const paused = !!config?.dispatch_paused;

  const flip = async () => {
    setBusy(true);
    try {
      const next = await patchConfig({ dispatch_paused: !paused });
      setConfig(next);
      pushToast({
        kind: "info",
        message: next.dispatch_paused
          ? "Dispatcher paused — running helpers will finish, no new ones will start."
          : "Dispatcher resumed.",
      });
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      onClick={flip}
      disabled={busy}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] font-medium transition-colors",
        paused
          ? "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
          : "border-black/10 text-ink-muted hover:bg-black/5",
      )}
      role="switch"
      aria-checked={paused}
      title={
        paused
          ? "Dispatcher is paused — click to resume spawning helpers"
          : "Pause the dispatcher (running helpers will finish)"
      }
    >
      <span aria-hidden className="font-mono leading-none">
        {paused ? "▶" : "⏸"}
      </span>
      {paused ? "Resume line" : "Pause line"}
    </button>
  );
}

/**
 * Full-width amber strip rendered above the columns whenever
 * `config.dispatch_paused` is true. Visually unmistakable so a user who
 * forgot they paused doesn't sit there wondering why ready cards aren't
 * being picked up.
 */
function DispatchPausedBanner() {
  return (
    <div
      role="status"
      className="border-b border-amber-300 bg-amber-50 px-4 py-1.5 text-[12.5px] font-medium text-amber-900 md:px-5"
    >
      <span aria-hidden className="mr-1.5 font-mono">⏸</span>
      Dispatcher paused — running helpers will finish, no new ones will start.
    </div>
  );
}
