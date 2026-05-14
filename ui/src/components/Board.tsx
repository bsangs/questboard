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
import {
  Archive,
  ChevronDown,
  CircleDot,
  MessageSquarePlus,
  Settings2,
} from "lucide-react";
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
import type { BoardConfig, CardStatus, CardSummary } from "@/lib/types";
import { CardDrawer } from "./CardDrawer";
import { CardTile } from "./CardTile";
import { Column } from "./Column";
import { ComposerModal } from "./Composer/Modal";
import { CwdPicker } from "./Composer/CwdPicker";
import { NewCardModal } from "./NewCardModal";
import {
  AppHeader,
  AppRail,
  AppShell,
  MetricPill,
  RailLink,
  SelectionBar,
  StatusDot,
} from "./patterns";
import { StatsPanel } from "./StatsPanel";
import { Toaster } from "./Toaster";
import { Button, IconButton } from "./ui";

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

const STATUS_LABEL = new Map<CardStatus, string>(
  COLUMNS.map((column) => [column.id, column.label]),
);

const WORKBENCH_OPEN_KEY = "questboard:workbenchOpen";

const DEFAULT_CONFIG_FALLBACK: BoardConfig = {
  version: 2,
  auto_review: false,
  concurrency_limit: 8,
  telegram_enabled: false,
  dispatch_paused: false,
  default_language: "en",
  scopes: [],
  default_scope: null,
  composer_concurrency: 3,
  git: {
    base_branch: "main",
    worker_branch_template: "worker/card-{card_id}",
    worktree_template: "card-{card_id}",
    composer_worktree_template: "composer-{thread_id}",
  },
  commands: {
    merge: [
      {
        id: "checkout-base",
        label: "Checkout base",
        command: "git checkout {base_branch}",
        required: true,
      },
      {
        id: "fast-forward",
        label: "Fast-forward merge",
        command: "git merge --ff-only {wip_branch}",
        required: true,
      },
      {
        id: "delete-local-branch",
        label: "Delete local branch",
        command:
          "git worktree remove --force \"{worktree_path}\" 2>/dev/null || true; git branch -d {wip_branch}",
        required: false,
      },
    ],
    stages: {
      in_progress: { pre: null, post: null },
      ai_review: { pre: null, post: null },
      merging: { pre: null, post: null },
      stuck: { pre: null, post: null },
    },
  },
  roles: {
    worker: { prompt_append: "" },
    reviewer: { prompt_append: "" },
    merger: { prompt_append: "" },
  },
  environment: { env: [], secret_env: [] },
  auth: { bare_enabled: false },
  notifications: {
    events: ["card_stuck", "review_requested", "merge_done", "helper_crashed"],
  },
  files: {
    hidden_names: ["node_modules", ".git", ".next", "dist", "build", "out"],
  },
};

/**
 * Resolve the set of valid drop targets for a card. Stuck cards branch on
 * `merged_sha`:
 *   - merged_sha == null  → ["ready"]   (re-queue for fresh worker)
 *   - merged_sha != null  → []          (no DnD targets; drawer exposes
 *     force-done explicitly)
 *
 * The drawer offers force-done on stuck-with-merged_sha cards; we keep it
 * OFF the DnD surface to avoid
 * accidental destructive moves (drag-to-Done losing audit context, etc.).
 */
export function dropTargetsFor(card: CardSummary): CardStatus[] {
  if (card.status !== "stuck") return STATIC_ALLOWED_DROPS[card.status] ?? [];
  return card.merged_sha == null ? ["ready"] : [];
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
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
  const setNewCardOpen = useBoard((s) => s.setNewCardOpen);
  const setComposerOpen = useBoard((s) => s.setComposerOpen);

  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [cardsLoading, setCardsLoading] = useState(true);
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const hasLoadedCardsRef = useRef(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // ─── Initial fetch ────────────────────────────────────────────────────────
  const refreshCards = useCallback(async () => {
    if (!hasLoadedCardsRef.current) setCardsLoading(true);
    try {
      const summaries = await listCards();
      setCards(summaries);
      hasLoadedCardsRef.current = true;
    } catch (e) {
      pushToast({
        kind: "error",
        message: `Failed to load cards: ${e instanceof Error ? e.message : ""}`,
      });
    } finally {
      setCardsLoading(false);
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

  useEffect(() => {
    try {
      setWorkbenchOpen(window.localStorage.getItem(WORKBENCH_OPEN_KEY) === "1");
    } catch {
      // Default is collapsed when localStorage is unavailable.
    }
  }, []);

  const setWorkbenchOpenPersisted = useCallback((next: boolean) => {
    setWorkbenchOpen(next);
    try {
      window.localStorage.setItem(WORKBENCH_OPEN_KEY, next ? "1" : "0");
    } catch {
      // Ignore storage failures; the UI still toggles for this session.
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "n") {
        e.preventDefault();
        setNewCardOpen(true);
        return;
      }
      if (e.key.toLowerCase() === "c") {
        e.preventDefault();
        setComposerOpen(true);
        return;
      }
      if (e.key === "Escape") {
        if (selected.size > 0) {
          e.preventDefault();
          clearSelection();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    clearSelection,
    selected.size,
    setComposerOpen,
    setNewCardOpen,
  ]);

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
  const attentionCards = useMemo(
    () =>
      [
        ...(grouped.stuck ?? []),
        ...(grouped.human_review ?? []),
        ...(grouped.ai_review ?? []),
        ...(grouped.merging ?? []),
      ].slice(0, 8),
    [grouped],
  );
  const activeCards = grouped.in_progress ?? [];
  const readyCards = grouped.ready ?? [];
  const doneCards = grouped.done ?? [];
  const totalCards = Object.keys(cards).length;
  return (
    <AppShell>
      {/* Top bar — condenses on mobile: title + a couple essentials,
          dense pill row hidden under md */}
      <AppHeader>
        <h1 className="flex items-center gap-2 text-[14.5px] font-semibold">
          <span
            aria-hidden
            className="inline-block h-2 w-2 rounded-full bg-accent"
          />
          <span className="hidden sm:inline">questboard</span>
          <span className="sm:hidden">questboard</span>
        </h1>

        <div className="hidden items-center gap-3 text-[12px] text-ink-muted md:flex">
          <MetricPill
            label="workers"
            value={`${activeWorkers}/${concurrencyLimit}`}
            tone={activeWorkers >= concurrencyLimit ? "red" : "neutral"}
          />
          <MetricPill label="queued" value={queuedCount} />
          <StatsPanel />
        </div>

        <div className="ml-auto flex items-center gap-1.5 md:gap-2">
          <DispatchPauseToggle />
          <AutoReviewToggle />
          <ComposerTrigger />
          <NewCardModal />
        </div>
      </AppHeader>

      {/* Paused banner — sits above the columns when the dispatcher is
          parked. Amber so it reads as a temporary, intentional state. */}
      {config?.dispatch_paused ? <DispatchPausedBanner /> : null}

      <div className="flex min-h-0 flex-1">
        <AppSidebar />
        <main
          className={clsx(
            "grid min-h-0 min-w-0 flex-1 grid-rows-[auto_minmax(0,1fr)] bg-bg md:grid-rows-1",
            workbenchOpen
              ? "md:grid-cols-[320px_minmax(0,1fr)]"
              : "md:grid-cols-[48px_minmax(0,1fr)]",
          )}
        >
          <WorkbenchPanel
            open={workbenchOpen}
            onOpenChange={setWorkbenchOpenPersisted}
            attentionCards={attentionCards}
            activeCards={activeCards}
            readyCards={readyCards}
            totalCards={totalCards}
            activeWorkers={activeWorkers}
            concurrencyLimit={concurrencyLimit}
            queuedCount={queuedCount}
            doneCount={doneCards.length}
          />

          <section className="flex min-h-0 min-w-0 flex-col border-t border-border bg-bg md:border-l md:border-t-0">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-surface/72 px-4 py-3 backdrop-blur">
              <div className="min-w-0">
                <h2 className="text-[13px] font-semibold text-ink">
                  Board lanes
                </h2>
                <p className="truncate text-[11.5px] text-ink-subtle">
                  Drag cards across state lanes; use the workbench for attention and active queues.
                </p>
              </div>
              <div className="hidden items-center gap-2 md:flex">
                <MetricPill label="attention" value={attentionCards.length} tone={attentionCards.length > 0 ? "amber" : "neutral"} />
                <MetricPill label="ready" value={readyCards.length} />
              </div>
            </div>

            {/* Board */}
            <DndContext
              sensors={sensors}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDragCancel={() => setActiveDragId(null)}
            >
              <div
                className={clsx(
                  "flex min-h-0 min-w-0 flex-1 gap-3 px-4 py-4",
                  // Desktop: horizontal kanban scroll. Mobile: vertical stack.
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
                      loading={cardsLoading}
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
          </section>
        </main>
      </div>

      {/* Floating action bar — bulk archive (also shown for single selection
          since this is the primary archive UI for power users) */}
      {selected.size >= 1 && (
        <div className="fixed bottom-5 left-1/2 z-30 -translate-x-1/2 animate-fadeIn">
          <SelectionBar count={selected.size} onClear={clearSelection}>
            <Button
              onClick={onArchiveSelected}
              variant="primary"
              size="xs"
              icon={<Archive className="h-3.5 w-3.5" />}
            >
              Archive
            </Button>
          </SelectionBar>
        </div>
      )}

      <CardDrawer />
      <ComposerModal />
      <Toaster />
    </AppShell>
  );
}

function WorkbenchPanel({
  open,
  onOpenChange,
  attentionCards,
  activeCards,
  readyCards,
  totalCards,
  activeWorkers,
  concurrencyLimit,
  queuedCount,
  doneCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attentionCards: CardSummary[];
  activeCards: CardSummary[];
  readyCards: CardSummary[];
  totalCards: number;
  activeWorkers: number;
  concurrencyLimit: number;
  queuedCount: number;
  doneCount: number;
}) {
  if (!open) {
    return (
      <aside className="flex max-h-12 min-h-0 border-b border-border bg-surface/58 md:max-h-none md:border-b-0 md:border-r">
        <button
          type="button"
          onClick={() => onOpenChange(true)}
          className="flex h-12 w-full items-center justify-between gap-2 px-4 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] md:h-full md:w-12 md:flex-col md:justify-start md:px-0 md:py-3"
          aria-expanded={false}
          aria-label="Expand workbench"
          title="Expand workbench"
        >
          <span className="flex min-w-0 items-center gap-2 md:flex-col">
            <ChevronDown className="h-4 w-4 -rotate-90 text-ink-muted" />
            <span className="truncate text-[12px] font-semibold text-ink md:hidden">
              Workbench
            </span>
            <span className="hidden font-mono text-[11px] font-semibold text-ink-muted md:block">
              WB
            </span>
          </span>
          <span className="flex items-center gap-1.5 md:flex-col">
            <span
              className={clsx(
                "rounded-sm px-1.5 py-0.5 font-mono text-[10px] ring-1 ring-inset",
                attentionCards.length > 0
                  ? "bg-amber-50 text-amber-800 ring-amber-200"
                  : "bg-surface text-ink-subtle ring-border",
              )}
              title="Attention cards"
            >
              {attentionCards.length}
            </span>
            <span
              className="rounded-sm bg-surface px-1.5 py-0.5 font-mono text-[10px] text-ink-subtle ring-1 ring-inset ring-border"
              title="Ready cards"
            >
              {readyCards.length}
            </span>
          </span>
        </button>
      </aside>
    );
  }

  return (
    <aside className="flex max-h-[42vh] min-h-0 flex-col border-b border-border bg-surface/58 md:max-h-none md:border-b-0 md:border-r">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-[13px] font-semibold text-ink">Workbench</h2>
            <p className="text-[11.5px] text-ink-subtle">
              Operational queue for what needs attention now.
            </p>
          </div>
          <span className="rounded-md border border-border bg-surface px-2 py-1 font-mono text-[11px] text-ink-muted">
            {totalCards} cards
          </span>
          <IconButton
            label="Collapse workbench"
            size="xs"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            <ChevronDown className="h-4 w-4 rotate-90" />
          </IconButton>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <WorkbenchMetric label="workers" value={`${activeWorkers}/${concurrencyLimit}`} hot={activeWorkers > 0} />
          <WorkbenchMetric label="queued" value={queuedCount} hot={queuedCount > 0} />
          <WorkbenchMetric label="attention" value={attentionCards.length} hot={attentionCards.length > 0} tone="amber" />
          <WorkbenchMetric label="done" value={doneCount} tone="green" />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <QueueSection
          title="Needs attention"
          cards={attentionCards}
          empty="No stuck, review, or merge cards."
        />
        <QueueSection
          title="Running now"
          cards={activeCards.slice(0, 6)}
          empty="No worker is active."
        />
        <QueueSection
          title="Ready queue"
          cards={readyCards.slice(0, 6)}
          empty="No cards waiting for a worker."
        />
      </div>
    </aside>
  );
}

function WorkbenchMetric({
  label,
  value,
  hot = false,
  tone = "cyan",
}: {
  label: string;
  value: number | string;
  hot?: boolean;
  tone?: "cyan" | "amber" | "green";
}) {
  const toneClass =
    tone === "amber"
      ? "border-amber-200 bg-amber-50 text-amber-800"
      : tone === "green"
        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
        : "border-accent bg-accent-soft text-accent-strong";
  return (
    <div
      className={clsx(
        "rounded-md border px-2 py-1.5",
        hot ? toneClass : "border-border bg-surface text-ink-muted",
      )}
    >
      <div className="text-[10.5px] font-medium uppercase">{label}</div>
      <div className="font-mono text-[13px] font-semibold text-ink">
        {value}
      </div>
    </div>
  );
}

function QueueSection({
  title,
  cards,
  empty,
}: {
  title: string;
  cards: CardSummary[];
  empty: string;
}) {
  return (
    <section className="mb-4 last:mb-0">
      <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase text-ink-subtle">
        <span>{title}</span>
        <span className="font-mono">{cards.length}</span>
      </div>
      {cards.length === 0 ? (
        <div className="rounded-md border border-dashed border-border-strong bg-surface/70 px-3 py-2 text-[11.5px] text-ink-subtle">
          {empty}
        </div>
      ) : (
        <ol className="space-y-1.5">
          {cards.map((card) => (
            <QueueRow key={`${title}-${card.id}`} card={card} />
          ))}
        </ol>
      )}
    </section>
  );
}

function QueueRow({ card }: { card: CardSummary }) {
  const openDrawer = useBoard((s) => s.openDrawer);
  const statusLabel = STATUS_LABEL.get(card.status) ?? card.status;
  const tone =
    card.status === "stuck"
      ? "amber"
      : card.status === "human_review" || card.status === "ai_review"
        ? "amber"
        : card.status === "done"
          ? "green"
          : "blue";
  return (
    <li>
      <button
        type="button"
        onClick={() => openDrawer(card.id)}
        className="group flex w-full items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-left shadow-tile transition-shadow hover:shadow-tileHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]"
      >
        <StatusDot tone={tone} className="mt-1.5" />
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 flex items-center gap-1.5">
            <span className="font-mono text-[10.5px] text-ink-subtle">
              {card.id}
            </span>
            <span className="rounded-sm border border-border bg-surface-muted px-1 py-px font-mono text-[10px] text-ink-muted">
              P{card.priority}
            </span>
            {card.owner_pid ? (
              <span className="font-mono text-[10px] text-accent-strong">
                pid {card.owner_pid}
              </span>
            ) : null}
          </div>
          <div className="line-clamp-2 text-[12.5px] font-medium leading-snug text-ink">
            {card.title}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-subtle">
            <CircleDot className="h-3 w-3" />
            <span>{statusLabel}</span>
            {card.scope ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{card.scope}</span>
              </>
            ) : null}
          </div>
        </div>
      </button>
    </li>
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
      <div className="inline-flex overflow-hidden rounded-md border border-border-strong bg-surface shadow-sm">
        <Button
          onClick={() => setComposerOpen(true)}
          variant="ghost"
          size="sm"
          className="rounded-none border-0"
          title="Open Composer"
          icon={<MessageSquarePlus className="h-3.5 w-3.5" />}
        >
          Composer
        </Button>
        <IconButton
          onClick={() => setPickerOpen((v) => !v)}
          label="Composer options"
          variant="ghost"
          size="sm"
          className="rounded-none border-0 border-l border-border"
          title="New thread with working directory…"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {pickerOpen && (
        <div className="absolute right-0 top-[110%] z-30">
          <CwdPicker onClose={() => setPickerOpen(false)} />
        </div>
      )}
    </div>
  );
}

function AppSidebar() {
  return (
    <AppRail>
      <RailLink href="/settings/general" label="Open settings">
        <Settings2 className="h-4 w-4" />
      </RailLink>
    </AppRail>
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
        ...(config ?? DEFAULT_CONFIG_FALLBACK),
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
    <Button
      onClick={flip}
      disabled={busy}
      size="sm"
      variant={checked ? "secondary" : "soft"}
      className={clsx(
        checked && "border-accent bg-accent-soft text-accent-strong hover:bg-accent-soft",
      )}
      role="switch"
      aria-checked={checked}
      title="Toggle global auto-review"
    >
      <span
        className={clsx(
          "inline-block h-1.5 w-1.5 rounded-full",
          checked ? "bg-accent" : "bg-slate-300",
        )}
      />
      Auto-review {checked ? "on" : "off"}
    </Button>
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
    <Button
      onClick={flip}
      disabled={busy}
      size="sm"
      variant={paused ? "secondary" : "soft"}
      className={clsx(
        paused && "border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100",
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
    </Button>
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
