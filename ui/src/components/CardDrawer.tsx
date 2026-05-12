"use client";

import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  CheckCircle2,
  CornerUpLeft,
  ImagePlus,
  RefreshCcw,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { attachToCard, useAttachableTextarea } from "@/lib/attach";
import {
  addComment,
  answerStuck,
  approveCard,
  archiveCards,
  cancelCard,
  deleteCard,
  forceDoneCard,
  getCard,
  getStages,
  moveToAiReview,
  moveToReady,
  patchCard,
  reopenCard,
  requeueCard,
  restoreCard,
} from "@/lib/api";
import { useBoard } from "@/lib/state";
import { Markdown } from "./Markdown";
import type {
  Card,
  CardFlavor,
  CardStage,
  CardStatus,
  CardSummary,
  Comment,
  CommentKind,
  HistoryEntry,
} from "@/lib/types";

/**
 * Allowed status transitions from each column for the drawer's status
 * select. Mirrors Board.tsx STATIC_ALLOWED_DROPS — the stuck row is
 * computed per-card via `transitionsFor` below because its valid
 * targets depend on `merged_sha`.
 */
const STATIC_TRANSITIONS: Record<CardStatus, CardStatus[]> = {
  backlog: ["ready"],
  ready: [],
  in_progress: ["ready"],
  stuck: [],
  human_review: ["done", "ai_review", "ready"],
  ai_review: ["done", "ready"],
  merging: ["ready"],
  // done → cancelled is exposed via the explicit "Cancel card" button on
  // done cards (with confirm), not in the inline status select. Keeping
  // it out of the dropdown avoids accidental clicks on shipped work.
  done: [],
  cancelled: [],
};

/**
 * Per-card transition policy. For stuck cards, branches on `merged_sha`:
 *   merged_sha == null → ["ready"]            (re-queue)
 *   merged_sha != null → ["done"]             (force done)
 *
 * The stuck-with-merged_sha targets ARE listed here so the inline status
 * select shows them too (alongside the explicit drawer banner buttons),
 * giving the user two paths to the same action.
 */
function transitionsFor(card: CardSummary): CardStatus[] {
  if (card.status !== "stuck") return STATIC_TRANSITIONS[card.status] ?? [];
  return card.merged_sha == null ? ["ready"] : ["done"];
}

const STATUS_LABEL: Record<CardStatus, string> = {
  backlog: "Backlog",
  ready: "Ready",
  in_progress: "In Progress",
  stuck: "Stuck",
  human_review: "Human Review",
  ai_review: "AI Review",
  merging: "Merging",
  done: "Done",
  cancelled: "Cancelled",
};

const FLAVOR_OPTIONS: CardFlavor[] = ["feature", "bug", "refactor", "chore", "docs"];

async function transitionCardStatus(
  cardId: string,
  from: CardStatus,
  to: CardStatus,
  /** Optional reason text — used by force-done to attach a `note` comment. */
  opts: { reason?: string } = {},
): Promise<void> {
  if (from === "backlog" && to === "ready") {
    await moveToReady(cardId);
    return;
  }
  // stuck-with-merged_sha → done: user override (force-done). The drawer's
  // banner button passes a reason; the inline select falls back to a
  // browser prompt so the user can still attach context.
  if (from === "stuck" && to === "done") {
    let reason = opts.reason;
    if (reason === undefined) {
      reason = window.prompt(
        "Why are you marking this card done? (e.g. 'vercel down, deployed by hand')",
      ) ?? "";
    }
    await forceDoneCard(cardId, reason);
    return;
  }
  if (to === "ready") {
    await requeueCard(cardId);
    return;
  }
  if ((from === "human_review" || from === "ai_review") && to === "done") {
    await approveCard(cardId);
    return;
  }
  if (from === "human_review" && to === "ai_review") {
    await moveToAiReview(cardId);
    return;
  }
  throw new Error(`Unhandled transition ${from} → ${to}`);
}

const DiffViewer = lazy(() =>
  import("./DiffViewer").then((m) => ({ default: m.DiffViewer })),
);

// Lazy-loaded — read-only transcript viewer. Same precedent as DiffViewer
// above: keep the drawer's initial bundle small; only pull in the
// markdown + tool-card renderers when the user actually clicks the tab.
const CardTranscriptView = lazy(() =>
  import("./CardTranscriptView").then((m) => ({ default: m.CardTranscriptView })),
);

// Curated, grouped lifecycle view (one block per attempt). Lazy-loaded for
// the same reason — even though it's small, lazy keeps the drawer's
// initial paint cheap on cards that don't need it.
const CardTimeline = lazy(() =>
  import("./CardTimeline").then((m) => ({ default: m.CardTimeline })),
);

const KIND_STYLE: Record<CommentKind, string> = {
  stuck: "bg-amber-50 border-amber-200",
  answer: "bg-blue-50 border-blue-200",
  resumed: "bg-emerald-50 border-emerald-200",
  review_note: "bg-amber-50 border-amber-200",
  note: "bg-slate-50 border-slate-200",
  system_event: "bg-gray-50 border-gray-200",
  description_updated: "bg-gray-50 border-gray-200",
};

const KIND_LABEL: Record<CommentKind, string> = {
  stuck: "stuck (worker)",
  answer: "answer (you)",
  resumed: "resumed",
  review_note: "AI review (English)",
  note: "note",
  system_event: "system",
  description_updated: "description updated",
};

function fmtAbs(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/** Media query hook — returns true while `(max-width: 768px)` matches. */
function useIsMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const onChange = () => setM(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return m;
}

const DRAWER_WIDTH_KEY = "questboard:drawerWidth";
const DRAWER_MIN_WIDTH = 480;
const DRAWER_DEFAULT_WIDTH = 640;
/** Leave at least this much board peeking on the left edge. */
const DRAWER_RIGHT_VIEWPORT_MARGIN = 200;

function clampDrawerWidth(px: number, viewportW: number): number {
  const max = Math.max(DRAWER_MIN_WIDTH, viewportW - DRAWER_RIGHT_VIEWPORT_MARGIN);
  if (px < DRAWER_MIN_WIDTH) return DRAWER_MIN_WIDTH;
  if (px > max) return max;
  return px;
}

function readStoredWidth(): number {
  if (typeof window === "undefined") return DRAWER_DEFAULT_WIDTH;
  try {
    const raw = window.localStorage.getItem(DRAWER_WIDTH_KEY);
    if (!raw) return DRAWER_DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) return DRAWER_DEFAULT_WIDTH;
    return n;
  } catch {
    return DRAWER_DEFAULT_WIDTH;
  }
}

export function CardDrawer() {
  const cardId = useBoard((s) => s.drawerCardId);
  const close = () => useBoard.getState().openDrawer(null);

  const open = !!cardId;
  const isMobile = useIsMobile();

  // Persisted desktop width. We keep the state alive across mobile/desktop
  // toggles so resizing the window back doesn't reset to default.
  const [width, setWidth] = useState<number>(DRAWER_DEFAULT_WIDTH);
  const [resizing, setResizing] = useState(false);

  // Hydrate from localStorage on mount, then clamp to current viewport.
  useEffect(() => {
    const stored = readStoredWidth();
    setWidth(clampDrawerWidth(stored, window.innerWidth));
  }, []);

  // Re-clamp on window resize so the drawer can never exceed the viewport
  // budget after the user shrinks the window.
  useEffect(() => {
    const onResize = () => {
      setWidth((w) => clampDrawerWidth(w, window.innerWidth));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistWidth = useCallback((w: number) => {
    try {
      window.localStorage.setItem(DRAWER_WIDTH_KEY, String(Math.round(w)));
    } catch {
      // localStorage may be unavailable (private mode, quota, etc.) — ignore.
    }
  }, []);

  // Drag handle: pointer listeners live on `document` so the drag keeps
  // tracking even when the cursor leaves the 6px strip. We also pin the
  // body cursor while dragging so it doesn't flicker over other elements.
  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // Only react to primary button.
      if (e.button !== 0) return;
      e.preventDefault();
      setResizing(true);
      const prevBodyCursor = document.body.style.cursor;
      const prevBodyUserSelect = document.body.style.userSelect;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";

      const onMove = (ev: PointerEvent) => {
        // Drawer is right-anchored, so width = viewportW - clientX.
        const next = clampDrawerWidth(
          window.innerWidth - ev.clientX,
          window.innerWidth,
        );
        setWidth(next);
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = prevBodyCursor;
        document.body.style.userSelect = prevBodyUserSelect;
        setResizing(false);
        // Persist the final width once on release rather than on every
        // pointermove tick — fewer localStorage writes, same UX.
        setWidth((w) => {
          persistWidth(w);
          return w;
        });
      };
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [persistWidth],
  );

  // Inline style: mobile = full viewport; desktop = pixel width from state.
  // Mobile keeps the existing slide-in-from-right animation (animate-slideIn).
  const contentStyle: React.CSSProperties = isMobile
    ? { width: "100vw", height: "100vh", maxWidth: "100vw" }
    : { width: `${width}px`, height: "100vh", maxWidth: "none" };

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-slate-950/20 backdrop-blur-[2px] animate-fadeIn" />
        <Dialog.Content
          aria-label="Card detail"
          style={contentStyle}
          className={clsx(
            "fixed inset-y-0 right-0 z-40 flex flex-col border-l border-border-strong bg-surface shadow-drawer animate-slideIn focus:outline-none",
            // Suppress text-selection flicker while dragging the resize handle.
            resizing && "select-none",
          )}
        >
          {/* Left-edge resize handle (desktop only). Lives inside the
              Dialog.Content so Radix's focus trap doesn't kick the user
              out when they grab it. Visually subtle — the inner 1px line
              fades in on hover/active so it doesn't compete with content. */}
          {!isMobile && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize drawer"
              onPointerDown={onHandlePointerDown}
              className="group absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize"
            >
              <div
                className={clsx(
                  "absolute inset-y-0 left-0 w-px bg-ink/10 transition-colors",
                  "group-hover:bg-slate-900/30",
                  resizing && "bg-slate-950/40",
                )}
              />
            </div>
          )}
          {cardId && (
            <DrawerBody cardId={cardId} onClose={close} isMobile={isMobile} />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DrawerBody({
  cardId,
  onClose,
  isMobile,
}: {
  cardId: string;
  onClose: () => void;
  isMobile: boolean;
}) {
  const card = useBoard((s) => s.cards[cardId]);
  const comments = useBoard((s) => s.comments[cardId]);
  const history = useBoard((s) => s.history[cardId]);
  const setComments = useBoard((s) => s.setComments);
  const setHistory = useBoard((s) => s.setHistory);
  const patchCardLocal = useBoard((s) => s.patchCard);
  const pushToast = useBoard((s) => s.pushToast);

  const [full, setFull] = useState<Card | null>(null);
  const [stages, setStages] = useState<CardStage[]>([]);
  const [tab, setTab] = useState<
    "description" | "comments" | "timeline" | "diff" | "transcript" | "history"
  >("description");
  const [editingDescription, setEditingDescription] = useState(false);
  const [descDraft, setDescDraft] = useState<string>("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState<string>("");
  const [editingDeps, setEditingDeps] = useState(false);
  const [depsDraft, setDepsDraft] = useState<string>("");
  const [reply, setReply] = useState<string>("");
  const [busy, setBusy] = useState(false);

  // Load full card + comments + history on open.
  useEffect(() => {
    let alive = true;
    setFull(null);
    setStages([]);
    setTab("description");
    setEditingDescription(false);
    setEditingTitle(false);
    setEditingDeps(false);
    (async () => {
      try {
        const [data, st] = await Promise.all([
          getCard(cardId),
          getStages(cardId).catch(() => [] as CardStage[]),
        ]);
        if (!alive) return;
        setFull(data.card);
        setDescDraft(data.card.description);
        setTitleDraft(data.card.frontmatter.title);
        setDepsDraft((data.card.frontmatter.deps ?? []).join(", "));
        setComments(cardId, data.comments);
        setHistory(cardId, data.history);
        setStages(st);
      } catch (e) {
        pushToast({
          kind: "error",
          message: `Failed to load card ${cardId}: ${e instanceof Error ? e.message : ""}`,
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [cardId, setComments, setHistory, pushToast]);

  // ── ALL HOOKS MUST RUN UNCONDITIONALLY ─────────────────────────────────
  // The early return below toggles based on `card` which can flip from
  // defined → undefined when the card is archived/deleted while the drawer
  // is open. If any hook lives below the early return, the hook count
  // changes between renders and React throws #300 ("Rendered fewer hooks
  // than expected"). Keep every hook above the conditional return.
  const dod = useMemo(
    () => parseDoD(full?.description ?? ""),
    [full?.description],
  );

  const currentDeps = full?.frontmatter.deps ?? card?.deps ?? [];

  if (!card) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-ink-subtle">
        Loading…
      </div>
    );
  }

  const status = card.status;
  const canDelete = status === "backlog" || status === "ready";
  const canRestore = status === "cancelled";
  const isHumanReview = status === "human_review";
  // Diff is always available — the viewer handles the empty case, and even
  // backlog/cancelled cards may have leftover worker-branch commits worth inspecting.

  async function withBusy<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  const handleAnswer = () =>
    withBusy(async () => {
      if (!reply.trim()) return;
      await answerStuck(cardId, reply.trim());
      setReply("");
      pushToast({ kind: "success", message: "Answer posted; card moved to Ready." });
    });

  const handleApprove = () =>
    withBusy(async () => {
      await approveCard(cardId);
      pushToast({ kind: "success", message: "Approved & merged." });
      onClose();
    });

  const handleMoveAi = () =>
    withBusy(async () => {
      await moveToAiReview(cardId);
      pushToast({ kind: "info", message: "Moved to AI Review." });
    });

  const handleReopen = () =>
    withBusy(async () => {
      if (reply.trim()) {
        await addComment(cardId, { kind: "system_event", body: reply.trim() });
      }
      await reopenCard(cardId);
      setReply("");
      pushToast({ kind: "info", message: "Reopened to In Progress." });
    });

  const handleCancel = () =>
    withBusy(async () => {
      if (!confirm("Cancel this card? Worker will be killed and worktree removed.")) {
        return;
      }
      await cancelCard(cardId);
      pushToast({ kind: "info", message: "Cancel requested." });
      onClose();
    });

  const handleDelete = () =>
    withBusy(async () => {
      if (!confirm("Delete this card permanently? This cannot be undone.")) return;
      await deleteCard(cardId);
      pushToast({ kind: "info", message: "Card deleted." });
      onClose();
    });

  const handleRestore = () =>
    withBusy(async () => {
      await restoreCard(cardId);
      pushToast({ kind: "info", message: "Restored to Backlog." });
      onClose();
    });

  const handleArchive = () =>
    withBusy(async () => {
      if (!confirm("Archive this card? Transcripts will be deleted.")) return;
      await archiveCards([cardId]);
      pushToast({ kind: "success", message: `Archived card-${cardId}.` });
      onClose();
    });

  const saveDescription = () =>
    withBusy(async () => {
      await patchCard(cardId, { description: descDraft });
      setFull((f) => (f ? { ...f, description: descDraft } : f));
      setEditingDescription(false);
      pushToast({ kind: "success", message: "Description saved." });
    });

  const saveTitle = () =>
    withBusy(async () => {
      const title = titleDraft.trim();
      if (!title) {
        pushToast({ kind: "error", message: "Title cannot be empty." });
        return;
      }
      if (title === card.title) {
        setEditingTitle(false);
        setTitleDraft(card.title);
        return;
      }
      await patchCard(cardId, { title });
      patchCardLocal(cardId, { title });
      setFull((f) =>
        f ? { ...f, frontmatter: { ...f.frontmatter, title } } : f,
      );
      setEditingTitle(false);
      pushToast({ kind: "success", message: "Title saved." });
    });

  const saveDeps = () =>
    withBusy(async () => {
      const parsed = parseDepsDraft(depsDraft);
      if (!parsed.ok) {
        pushToast({ kind: "error", message: parsed.message });
        return;
      }
      await patchCard(cardId, { deps: parsed.deps });
      patchCardLocal(cardId, { deps: parsed.deps });
      setFull((f) =>
        f ? { ...f, frontmatter: { ...f.frontmatter, deps: parsed.deps } } : f,
      );
      setDepsDraft(parsed.deps.join(", "));
      setEditingDeps(false);
      pushToast({ kind: "success", message: "Dependencies saved." });
    });

  return (
    <>
      {/* Header */}
      <header
        className={clsx(
          "flex shrink-0 items-start justify-between gap-3 border-b border-border py-4",
          isMobile ? "px-4" : "px-6",
        )}
      >
        {/* Mobile: back arrow as primary close affordance, sits left of the
            title block. Desktop: no back arrow — the Esc key, overlay click,
            and top-right X are enough. */}
        {isMobile && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Back"
            className="-ml-1 mt-0.5 shrink-0 rounded p-1.5 text-ink-muted hover:bg-surface-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-ink-muted">
            <span className="rounded bg-gray-100 px-1.5 py-0.5">card-{cardId}</span>
            <span className="text-ink-subtle">·</span>
            <InlineMetaSelectors
              card={card}
              scope={full?.frontmatter.scope ?? null}
              onScopeSaved={(s) =>
                setFull((f) =>
                  f ? { ...f, frontmatter: { ...f.frontmatter, scope: s } } : f,
                )
              }
            />
          </div>
          {editingTitle ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <input
                type="text"
                value={titleDraft}
                autoFocus
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void saveTitle();
                  } else if (e.key === "Escape") {
                    setEditingTitle(false);
                    setTitleDraft(card.title);
                  }
                }}
                disabled={busy}
                className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-2 py-1 text-[15px] font-semibold leading-tight text-ink focus:border-ink focus:outline-none"
                aria-label="Card title"
              />
              <button
                type="button"
                onClick={() => {
                  setEditingTitle(false);
                  setTitleDraft(card.title);
                }}
                disabled={busy}
                className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-muted disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={saveTitle}
                disabled={busy || !titleDraft.trim()}
                className="rounded bg-ink px-2 py-0.5 text-[11px] font-medium text-white hover:bg-slate-900 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <h2 className="truncate text-[16px] font-semibold leading-tight text-ink">
                {card.title}
              </h2>
              <button
                type="button"
                onClick={() => {
                  setTitleDraft(card.title);
                  setEditingTitle(true);
                }}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-normal text-ink-muted hover:bg-surface-muted"
              >
                Edit
              </button>
            </div>
          )}
          <p className="mt-1 text-[11px] text-ink-subtle">
            Created {fmtAbs(card.created_at)} · Updated {fmtAbs(card.updated_at)}
          </p>
        </div>
        {/* Hide the right-edge X on mobile — the back arrow is the primary
            close affordance there, and a single phone header doesn't have
            room for both without crowding the title. */}
        {!isMobile && (
          <Dialog.Close asChild>
            <button
              className="rounded p-1.5 text-ink-subtle hover:bg-surface-muted"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </Dialog.Close>
        )}
      </header>

      {/* Stuck banner — yellow for unmerged work, blue for stuck-with-
          merged_sha. The merged variant carries Mark-Done inline; see
          StuckBanner for the policy details. */}
      {card.status === "stuck" && (
        <StuckBanner
          card={card}
          postBuildAttempts={full?.frontmatter.post_build_attempts ?? []}
          busy={busy}
          onForceDone={() =>
            withBusy(async () => {
              const reason = window.prompt(
                "Why are you marking this card done? (optional — e.g. 'vercel down, deployed by hand')",
                "",
              );
              // Cancelled prompt → null. Empty string is valid (no reason).
              if (reason === null) return;
              if (
                !confirm(
                  `Mark card ${cardId} done? Code is already at ${
                    card.merged_sha?.slice(0, 12) ?? "main"
                  }; this accepts the already-merged work as complete.`,
                )
              ) {
                return;
              }
              await forceDoneCard(cardId, reason);
              pushToast({
                kind: "success",
                message: "Card marked done (force).",
              });
              onClose();
            })
          }
        />
      )}

      {/* Per-stage activity (one row per worker / reviewer / merger spawn).
          Lives between header and body so it's visible regardless of
          tab. Hidden when the card has no transcripts yet. */}
      {stages.length > 0 && <StagesStrip stages={stages} />}

      {/* Body: tabs stay fixed; only the active tab content scrolls. */}
      <div className="flex min-h-0 flex-1 flex-col px-6 py-4">
        {/* Tabs */}
        <div className="mb-3 flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border">
          {(
            [
              "description",
              "comments",
              // Timeline sits between comments and diff: same data as
              // history (audit), but grouped by attempt so the user can
              // see the lifecycle at a glance.
              "timeline",
              "diff",
              "transcript",
              "history",
            ] as const
          ).map((t) => {
            const hasTimelineData =
              stages.length > 0 ||
              (full?.frontmatter.post_build_attempts?.length ?? 0) > 0 ||
              (history?.length ?? 0) > 0;
            const disabled =
              (t === "timeline" && !hasTimelineData) ||
              // Transcript tab is meaningful only after at least one
              // helper has spawned (i.e. there's a transcript file on
              // disk). Backlog/ready cards have nothing to show.
              (t === "transcript" && stages.length === 0);
            return (
              <button
                key={t}
                onClick={() => !disabled && setTab(t)}
                disabled={disabled}
                className={clsx(
                  "-mb-px shrink-0 border-b-2 px-3 py-1.5 text-[12.5px] font-medium capitalize transition-colors",
                  tab === t
                    ? "border-ink text-ink"
                    : disabled
                      ? "border-transparent text-ink-subtle/60"
                      : "border-transparent text-ink-muted hover:text-ink",
                )}
              >
                {t}
              </button>
            );
          })}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1 focus:outline-none" tabIndex={0}>
          {tab === "description" && (
          <div className="space-y-4">
            <div className="rounded-md border border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase text-ink-subtle">
                <span>Description</span>
                {!editingDescription ? (
                  <button
                    onClick={() => setEditingDescription(true)}
                    className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-muted"
                  >
                    Edit
                  </button>
                ) : (
                  <div className="flex gap-1">
                    <button
                      onClick={() => {
                        setEditingDescription(false);
                        setDescDraft(full?.description ?? "");
                      }}
                      className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-muted"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={saveDescription}
                      disabled={busy}
                      className="rounded bg-ink px-2 py-0.5 text-[11px] font-medium text-white hover:bg-slate-900 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                )}
              </div>
              <div className="p-3">
                {editingDescription ? (
                  <DescriptionEditor
                    cardId={cardId}
                    value={descDraft}
                    onChange={setDescDraft}
                    onError={(err) =>
                      pushToast({
                        kind: "error",
                        message: err instanceof Error ? err.message : String(err),
                      })
                    }
                  />
                ) : full?.description ? (
                  <Markdown cardId={cardId}>{full.description}</Markdown>
                ) : (
                  <span className="text-ink-subtle">(no description)</span>
                )}
              </div>
            </div>

            <div className="rounded-md border border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase text-ink-subtle">
                <span>Dependencies</span>
                {!editingDeps ? (
                  <button
                    type="button"
                    onClick={() => {
                      setDepsDraft(currentDeps.join(", "));
                      setEditingDeps(true);
                    }}
                    className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-muted"
                  >
                    Edit
                  </button>
                ) : (
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingDeps(false);
                        setDepsDraft(currentDeps.join(", "));
                      }}
                      className="rounded px-1.5 py-0.5 text-[11px] text-ink-muted hover:bg-surface-muted"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveDeps}
                      disabled={busy}
                      className="rounded bg-ink px-2 py-0.5 text-[11px] font-medium text-white hover:bg-slate-900 disabled:opacity-50"
                    >
                      Save
                    </button>
                  </div>
                )}
              </div>
              <div className="p-3 text-[12.5px]">
                {editingDeps ? (
                  <div className="space-y-1.5">
                    <input
                      type="text"
                      value={depsDraft}
                      onChange={(e) => setDepsDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void saveDeps();
                        } else if (e.key === "Escape") {
                          setEditingDeps(false);
                          setDepsDraft(currentDeps.join(", "));
                        }
                      }}
                      disabled={busy}
                      placeholder="0012, 0045, 0101"
                      className="w-full rounded border border-border-strong bg-surface px-2 py-1.5 font-mono text-[12.5px] focus:border-ink focus:outline-none"
                      aria-label="Card dependencies"
                    />
                    <p className="text-[11px] text-ink-subtle">
                      Four-digit card IDs, separated by commas or spaces.
                    </p>
                  </div>
                ) : currentDeps.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {currentDeps.map((dep) => (
                      <span
                        key={dep}
                        className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11.5px] text-ink-muted"
                      >
                        card-{dep}
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="text-ink-subtle">(no dependencies)</span>
                )}
              </div>
            </div>

            {dod.length > 0 && (
              <div className="rounded-md border border-border bg-surface">
                <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase text-ink-subtle">
                  Definition of Done
                </div>
                <ul className="space-y-1 p-3 text-[12.5px]">
                  {dod.map((item, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={item.checked}
                        readOnly
                        aria-label={item.text}
                        className="mt-0.5 h-3.5 w-3.5 cursor-not-allowed accent-emerald-600"
                      />
                      <span
                        className={clsx(
                          item.checked && "text-ink-subtle line-through",
                        )}
                      >
                        {item.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {tab === "comments" && (
          <CommentList cardId={cardId} comments={comments ?? []} />
        )}

        {tab === "timeline" && (
          <Suspense
            fallback={
              <div className="text-[12.5px] text-ink-subtle">
                Loading timeline…
              </div>
            }
          >
            <CardTimeline
              stages={stages}
              history={history ?? []}
              comments={comments ?? []}
              postBuildAttempts={full?.frontmatter.post_build_attempts ?? []}
            />
          </Suspense>
        )}

        {tab === "history" && (
          <HistoryList cardId={cardId} history={history ?? []} />
        )}

        {tab === "diff" && (
          <Suspense
            fallback={
              <div className="text-[12.5px] text-ink-subtle">Loading diff…</div>
            }
          >
            <DiffViewer cardId={cardId} />
          </Suspense>
        )}

        {tab === "transcript" && stages.length > 0 && (
          <Suspense
            fallback={
              <div className="text-[12.5px] text-ink-subtle">
                Loading transcript…
              </div>
            }
          >
            <CardTranscriptView
              cardId={cardId}
              stages={stages}
              cardStatus={status}
            />
          </Suspense>
        )}
        </div>
      </div>

      {/* Reply / actions */}
      <footer className="shrink-0 border-t border-border bg-surface px-6 py-3">
        <ReplyBox
          cardId={cardId}
          status={status}
          value={reply}
          onChange={setReply}
          busy={busy}
          onAnswer={handleAnswer}
          onApprove={handleApprove}
          onMoveAi={handleMoveAi}
          onReopen={handleReopen}
          onError={(err) =>
            pushToast({
              kind: "error",
              message: err instanceof Error ? err.message : String(err),
            })
          }
        />
        <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px]">
          <div className="flex gap-1">
            {canRestore && (
              <button
                onClick={handleRestore}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-ink-muted hover:bg-surface-muted"
              >
                <ArchiveRestore className="h-3.5 w-3.5" /> Restore
              </button>
            )}
            {status === "done" && (
              <button
                onClick={handleArchive}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-ink-muted hover:bg-surface-muted"
              >
                <Archive className="h-3.5 w-3.5" /> Archive
              </button>
            )}
            {/* Limited reopen escape: done → cancelled. Code stays merged
                (we keep merged_sha + done_at) — this just stops tracking
                the card. Useful for duplicates / mis-scoped work that
                happened to ship. The confirm makes the contract explicit
                so users can't toggle it off accidentally. */}
            {status === "done" && (
              <button
                onClick={() =>
                  withBusy(async () => {
                    if (
                      !confirm(
                        `This card's code is already in origin/main${
                          card.merged_sha ? ` @ ${card.merged_sha.slice(0, 12)}` : ""
                        }. Cancelling marks it as no longer tracked but does NOT revert the code. Continue?`,
                      )
                    ) {
                      return;
                    }
                    await cancelCard(
                      cardId,
                      "manual cancel from done (code remains merged)",
                    );
                    pushToast({
                      kind: "info",
                      message: "Card cancelled (merge preserved).",
                    });
                    onClose();
                  })
                }
                disabled={busy}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-red-600 hover:bg-red-50"
                title="Cancel tracking; merged code stays on origin/main"
              >
                <CornerUpLeft className="h-3.5 w-3.5" /> Cancel card
              </button>
            )}
            {!isHumanReview && status !== "done" && status !== "cancelled" && (
              <button
                onClick={handleCancel}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-red-600 hover:bg-red-50"
              >
                <CornerUpLeft className="h-3.5 w-3.5" /> Cancel
              </button>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                disabled={busy}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-red-600 hover:bg-red-50"
              >
                <Trash2 className="h-3.5 w-3.5" /> Delete
              </button>
            )}
          </div>
          {card.attempts > 0 && (
            <span className="text-ink-subtle">
              attempts: {card.attempts}
            </span>
          )}
        </div>
      </footer>
    </>
  );
}

function ReplyBox({
  cardId,
  status,
  value,
  onChange,
  busy,
  onAnswer,
  onApprove,
  onMoveAi,
  onReopen,
  onError,
}: {
  cardId: string;
  status: Card["frontmatter"]["status"];
  value: string;
  onChange: (v: string) => void;
  busy: boolean;
  onAnswer: () => void;
  onApprove: () => void;
  onMoveAi: () => void;
  onReopen: () => void;
  onError: (err: unknown) => void;
}) {
  const isStuck = status === "stuck";
  const isHumanReview = status === "human_review";
  const enabled = isStuck || isHumanReview;

  // Refs need to be declared before any early-return (rules of hooks).
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The hook reads the latest value via getValue() so an in-flight upload
  // races correctly against the user editing.
  const valueRef = useRef(value);
  valueRef.current = value;

  const upload = useCallback(
    async (file: File) => {
      const r = await attachToCard(cardId, file);
      return r.markdown;
    },
    [cardId],
  );

  const { onPaste, onDrop, onDragOver, pickFile, fileInputProps } =
    useAttachableTextarea(textareaRef, {
      upload,
      onError,
      getValue: () => valueRef.current,
      onValueChange: (next) => onChange(next),
      disabled: !enabled,
    });

  if (!enabled) {
    return (
      <div className="rounded-md border border-dashed border-border-strong bg-[var(--bg-muted)] px-3 py-2 text-[11.5px] text-ink-subtle">
        Reply is disabled in this status.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border-strong bg-surface">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={onDragOver}
        rows={isStuck ? 3 : 2}
        placeholder={
          isStuck
            ? "Answer the worker's stuck question… (paste / drop images OK)"
            : "Optional comment for reviewer or reopen reason… (paste / drop images OK)"
        }
        className="w-full resize-none border-0 bg-transparent p-2.5 text-[13px] focus:outline-none"
      />
      <input {...fileInputProps} />
      <div className="flex items-center justify-end gap-1 border-t border-border px-2 py-1.5">
        <button
          type="button"
          onClick={pickFile}
          className="mr-auto rounded p-1 text-ink-subtle hover:bg-surface-muted"
          title="Attach image"
        >
          <ImagePlus className="h-3.5 w-3.5" />
        </button>
        {isStuck && (
          <button
            onClick={onAnswer}
            disabled={busy || !value.trim()}
            className="inline-flex items-center gap-1 rounded bg-ink px-2.5 py-1 text-[12px] font-medium text-white hover:bg-slate-900 disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" /> 답변 작성
          </button>
        )}
        {isHumanReview && (
          <>
            <button
              onClick={onReopen}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-ink-muted hover:bg-surface-muted"
              title="Send feedback and re-spawn worker"
            >
              <RefreshCcw className="h-3.5 w-3.5" /> Reopen
            </button>
            <button
              onClick={onMoveAi}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-amber-700 hover:bg-amber-50"
            >
              Move to AI Review
            </button>
            <button
              onClick={onApprove}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <CheckCircle2 className="h-3.5 w-3.5" /> Approve & Merge
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Inline editor for a card's description with paste/drop image attach.
 * Uploads land at /api/cards/:id/attachments and the textarea gets a
 * `![image](attachments/<filename>)` snippet inserted at the c‍aret.
 */
function DescriptionEditor({
  cardId,
  value,
  onChange,
  onError,
}: {
  cardId: string;
  value: string;
  onChange: (next: string) => void;
  onError: (err: unknown) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  const upload = useCallback(
    async (file: File) => {
      const r = await attachToCard(cardId, file);
      return r.markdown;
    },
    [cardId],
  );

  const { onPaste, onDrop, onDragOver, pickFile, fileInputProps } =
    useAttachableTextarea(ref, {
      upload,
      onError,
      getValue: () => valueRef.current,
      onValueChange: (next) => onChange(next),
    });

  return (
    <div className="space-y-1">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        onDrop={onDrop}
        onDragOver={onDragOver}
        rows={14}
        className="w-full resize-y rounded border border-border-strong bg-surface p-2 font-mono text-[12.5px] focus:border-ink focus:outline-none"
      />
      <input {...fileInputProps} />
      <div className="flex items-center justify-between text-[11px] text-ink-subtle">
        <span>Markdown · paste/drop images OK</span>
        <button
          type="button"
          onClick={pickFile}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-ink-muted hover:bg-surface-muted"
        >
          <ImagePlus className="h-3.5 w-3.5" /> Attach image
        </button>
      </div>
    </div>
  );
}

const HISTORY_LABEL: Record<HistoryEntry["kind"], string> = {
  system_event: "system",
  description_updated: "description updated",
};

function HistoryList({
  cardId,
  history,
}: {
  cardId: string;
  history: HistoryEntry[];
}) {
  if (history.length === 0) {
    return (
      <div className="text-[12.5px] text-ink-subtle">No history yet.</div>
    );
  }
  return (
    <ol className="space-y-1.5">
      {history.map((h, i) => (
        <li
          key={`${cardId}-h-${i}-${h.ts}`}
          className="rounded border border-border bg-surface px-3 py-1.5 text-[12.5px] leading-snug"
        >
          <div className="mb-0.5 flex items-center justify-between text-[10.5px] text-ink-subtle">
            <span className="font-mono">{HISTORY_LABEL[h.kind] ?? h.kind}</span>
            <span>{fmtAbs(h.ts)}</span>
          </div>
          <div className="whitespace-pre-wrap text-ink-muted">{h.body}</div>
        </li>
      ))}
    </ol>
  );
}

function CommentList({
  cardId,
  comments,
}: {
  cardId: string;
  comments: Comment[];
}) {
  if (comments.length === 0) {
    return (
      <div className="text-[12.5px] text-ink-subtle">No comments yet.</div>
    );
  }
  return (
    <ol className="space-y-2.5">
      {comments.map((c, i) => (
        <li
          key={`${cardId}-${i}-${c.ts}`}
          className={clsx(
            "rounded-md border px-3 py-2 text-[13px] leading-relaxed",
            KIND_STYLE[c.kind] ?? "border-gray-200 bg-gray-50",
          )}
        >
          <div className="mb-1 flex items-center justify-between text-[11px] text-ink-muted">
            <span className="font-mono">{KIND_LABEL[c.kind] ?? c.kind}</span>
            <span>{fmtAbs(c.ts)}</span>
          </div>
          <Markdown cardId={cardId}>{c.body}</Markdown>
        </li>
      ))}
    </ol>
  );
}

/**
 * Inline meta selectors rendered in the drawer header. Edit status,
 * scope, priority, and flavor without opening a separate edit panel.
 * Saves immediately on change; rolls back on error so the UI stays in
 * sync with the server's truth.
 *
 * - Status: shows current + the destinations allowed by the state
 *   machine (mirrors Board.tsx STATIC_ALLOWED_DROPS via transitionsFor()).
 *   For terminal/non-transitionable columns the select is disabled.
 * - Scope: pulls from BoardConfig.scopes; "(none)" sets scope=null.
 * - Priority: P1 / P2 / P3.
 * - Flavor: feature / bug / refactor / chore / docs.
 */
function InlineMetaSelectors({
  card,
  scope,
  onScopeSaved,
}: {
  card: CardSummary;
  /** Current scope id (null = no scope). Lives on the full Card frontmatter,
   *  not on CardSummary, so it's threaded through from the drawer. */
  scope: string | null;
  /** Notify the drawer to update its `full` state after a successful save
   *  so the select reflects the new value without a refetch. */
  onScopeSaved: (next: string | null) => void;
}) {
  const config = useBoard((s) => s.config);
  const patchCardLocal = useBoard((s) => s.patchCard);
  const pushToast = useBoard((s) => s.pushToast);
  const cardId = card.id;
  const scopes = config?.scopes ?? [];

  const transitions = transitionsFor(card);
  const statusOptions: CardStatus[] = [card.status, ...transitions];
  const statusDisabled = transitions.length === 0;

  const onStatusChange = async (next: CardStatus) => {
    if (next === card.status) return;
    const from = card.status;
    if (
      next === "ready" &&
      from !== "backlog" &&
      !confirm(
        `Re-queue card from ${from} back to Ready? Any running worker/merger will be stopped.`,
      )
    ) {
      return;
    }
    if ((from === "human_review" || from === "ai_review") && next === "done") {
      if (!confirm("Approve this card? It will go to merging.")) return;
    }
    patchCardLocal(cardId, { status: next });
    try {
      await transitionCardStatus(cardId, from, next);
    } catch (err) {
      patchCardLocal(cardId, { status: from });
      pushToast({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onPatch = async (patch: Partial<CardSummary>) => {
    const prev: Partial<CardSummary> = {};
    for (const k of Object.keys(patch) as (keyof CardSummary)[]) {
      // copy whatever the existing card has so rollback restores it
      (prev as Record<string, unknown>)[k] = (card as unknown as Record<string, unknown>)[k];
    }
    patchCardLocal(cardId, patch);
    try {
      await patchCard(cardId, patch as Parameters<typeof patchCard>[1]);
    } catch (err) {
      patchCardLocal(cardId, prev);
      pushToast({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Scope lives on full Card frontmatter (not CardSummary), so it gets a
  // dedicated path: fire patchCard with the new scope, and on success
  // notify the drawer so the local `full` state stays in sync.
  const onScopeChange = async (next: string | null) => {
    if (next === scope) return;
    const prev = scope;
    onScopeSaved(next); // optimistic
    try {
      await patchCard(cardId, { scope: next });
    } catch (err) {
      onScopeSaved(prev); // rollback
      pushToast({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const selectCls =
    "rounded bg-gray-50 px-1.5 py-0.5 font-mono text-[11px] text-ink hover:bg-gray-100 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-1 focus:ring-blue-500/40";

  return (
    <>
      <select
        className={selectCls}
        value={card.status}
        disabled={statusDisabled}
        onChange={(e) => onStatusChange(e.target.value as CardStatus)}
        aria-label="Status"
        title={statusDisabled ? "No transitions allowed from this column" : "Status"}
      >
        {statusOptions.map((s) => (
          <option key={s} value={s}>
            {STATUS_LABEL[s]}
          </option>
        ))}
      </select>
      <span className="text-ink-subtle">·</span>
      <select
        className={selectCls}
        value={scope ?? ""}
        onChange={(e) =>
          onScopeChange(e.target.value === "" ? null : e.target.value)
        }
        aria-label="Scope"
        title="Scope"
      >
        <option value="">(no scope)</option>
        {scopes.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <span className="text-ink-subtle">·</span>
      <select
        className={selectCls}
        value={card.priority}
        onChange={(e) =>
          onPatch({ priority: Number(e.target.value) as 1 | 2 | 3 })
        }
        aria-label="Priority"
        title="Priority"
      >
        <option value={1}>P1</option>
        <option value={2}>P2</option>
        <option value={3}>P3</option>
      </select>
      <span className="text-ink-subtle">·</span>
      <select
        className={selectCls}
        value={card.flavor}
        onChange={(e) => onPatch({ flavor: e.target.value as CardFlavor })}
        aria-label="Flavor"
        title="Flavor"
      >
        {FLAVOR_OPTIONS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <span className="text-ink-subtle">·</span>
      <span>{card.language}</span>
    </>
  );
}

/**
 * Per-stage activity strip. One row per spawned worker / reviewer /
 * merger. Earlier stints stay visible after the card has moved on, so
 * the user can see "in_progress took N tokens, then again M tokens"
 * after a stuck → ready bounce.
 *
 * Status mapping:
 *   worker   → in_progress
 *   reviewer → ai_review
 *   merger   → merging
 */
function StagesStrip({ stages }: { stages: CardStage[] }) {
  // Cap at 3 rows by default. Cards with many runs would otherwise push
  // the body tabs off-screen. Show the LAST N (most recent activity is
  // usually what the user wants); a toggle reveals earlier stints.
  const VISIBLE = 3;
  const [expanded, setExpanded] = useState(false);
  const total = stages.length;
  const overflow = total - VISIBLE;
  const visible =
    expanded || total <= VISIBLE ? stages : stages.slice(total - VISIBLE);
  return (
    <div className="shrink-0 border-b border-border bg-[var(--bg-muted)] px-6 py-2">
      <div className="mb-1 flex items-baseline justify-between text-[10.5px] font-semibold uppercase text-ink-subtle">
        <span>Stages</span>
        <span className="flex items-center gap-2">
          <span className="font-mono lowercase">
            {total} run{total === 1 ? "" : "s"}
          </span>
          {overflow > 0 && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="rounded px-1.5 py-0.5 font-mono text-[10px] normal-case text-ink-muted ring-1 ring-inset ring-border-strong hover:bg-surface-muted"
            >
              {expanded ? `▾ collapse` : `▸ +${overflow} earlier`}
            </button>
          )}
        </span>
      </div>
      <ol
        className={clsx(
          "space-y-0.5 pr-1",
          expanded && "max-h-36 overflow-y-auto",
        )}
      >
        {visible.map((s) => (
          <StageRow key={s.transcript} stage={s} />
        ))}
      </ol>
    </div>
  );
}

function fmtStageElapsed(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m${s ? ` ${s}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtStageTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtStageClock(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes(),
    ).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return "";
  }
}

const STAGE_ROLE_STYLE: Record<
  CardStage["role"],
  { dot: string; label: string; text: string }
> = {
  worker: { dot: "bg-emerald-500", label: "in_progress", text: "text-emerald-700" },
  reviewer: { dot: "bg-amber-500", label: "ai_review", text: "text-amber-700" },
  merger: { dot: "bg-blue-500", label: "merging", text: "text-blue-700" },
};

function StageRow({ stage }: { stage: CardStage }) {
  const r = STAGE_ROLE_STYLE[stage.role];
  const inTok = stage.input_tokens ?? 0;
  return (
    <li className="grid grid-cols-[12px_1fr_auto_auto_auto] items-center gap-2 font-mono text-[11px] text-ink-muted">
      <span className={clsx("h-1.5 w-1.5 rounded-full", r.dot)} aria-hidden />
      <span className={clsx("font-medium", r.text)}>
        {r.label}
        <span className="ml-1 text-ink-subtle">#{stage.attempt}</span>
      </span>
      <span title={stage.started_at}>{fmtStageClock(stage.started_at)}</span>
      <span title="elapsed">{fmtStageElapsed(stage.elapsed_seconds)}</span>
      <span
        title={`in ${inTok.toLocaleString()} · out ${stage.output_tokens.toLocaleString()} · ctx ${stage.context_tokens.toLocaleString()}`}
        className="tabular-nums"
      >
        <span className="text-ink">↓{fmtStageTok(inTok)}</span>
        <span className="text-ink-subtle"> · </span>
        <span className="text-ink">↑{fmtStageTok(stage.output_tokens)}</span>
      </span>
    </li>
  );
}

/**
 * Banner at top of the drawer for stuck cards. Two flavors:
 *
 *   merged_sha == null (yellow):
 *     The worker never landed code on origin/main. Behavior is unchanged
 *     from the original — show the stuck reason + question, let the user
 *     answer / requeue via the existing affordances.
 *
 *   merged_sha != null (blue):
 *     The worker's code IS on origin/main; only a downstream step (post-
 *     a downstream step failed. Re-queueing would re-spawn a worker on
 *     already-merged work, so we offer one explicit recovery action here:
 *       - Mark Done        (force-done; e.g. "I deployed by hand")
 *
 * The banner pulls the most recent post-build attempt for the failure
 * excerpt + classification so the user can see WHY at a glance without
 * opening the Timeline tab.
 */
function StuckBanner({
  card,
  postBuildAttempts,
  onForceDone,
  busy,
}: {
  card: CardSummary;
  postBuildAttempts: import("@/lib/types").PostBuildAttempt[];
  onForceDone: () => void;
  busy: boolean;
}) {
  const isMerged = card.merged_sha != null;

  if (!isMerged) {
    // Original yellow banner — unchanged behavior for unmerged stucks.
    return (
      <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-6 py-3">
        <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase text-amber-800">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
          Stuck — {card.stuck_reason ?? "unknown reason"}
        </div>
        {card.stuck_question && (
          <div className="text-[13px] font-medium text-amber-900">
            {card.stuck_question}
          </div>
        )}
      </div>
    );
  }

  // Merged variant: blue tone, force-done recovery only.
  const sha12 = card.merged_sha!.slice(0, 12);
  const transientStreak = (() => {
    let n = 0;
    for (let i = postBuildAttempts.length - 1; i >= 0; i--) {
      if (postBuildAttempts[i]!.classification === "transient") n++;
      else break;
    }
    return n;
  })();
  const lastFailure = (() => {
    for (let i = postBuildAttempts.length - 1; i >= 0; i--) {
      const a = postBuildAttempts[i]!;
      if (a.classification !== "success") return a;
    }
    return null;
  })();
  const totalAttempts = postBuildAttempts.length;

  return (
    <div className="shrink-0 border-b border-blue-200 bg-blue-50 px-6 py-3">
      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase text-blue-800">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500" />
        Stuck — code already on{" "}
        <code className="rounded bg-blue-100 px-1 py-0.5 font-mono text-[10.5px]">
          origin/main
        </code>{" "}
        @ <span className="font-mono">{sha12}</span>
      </div>
      <div className="text-[12.5px] text-blue-900">
        {lastFailure ? (
          <>
            Prior post-build/deploy step failed{" "}
            <span className="font-semibold">
              ({lastFailure.classification})
            </span>
            : <span className="italic">{lastFailure.reason_excerpt || "—"}</span>
            .
          </>
        ) : (
          <>The card is stuck even though code is already merged.</>
        )}
        {totalAttempts > 0 && (
          <>
            {" "}
            <span className="text-blue-700">
              Auto-retried {transientStreak}/{3} times ·{" "}
              {totalAttempts} attempt{totalAttempts === 1 ? "" : "s"} total.
            </span>
          </>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onForceDone}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded bg-blue-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          title="Mark the card done; merged_sha is preserved for audit"
        >
          Mark Done
        </button>
      </div>
    </div>
  );
}

function parseDepsDraft(input: string):
  | { ok: true; deps: string[] }
  | { ok: false; message: string } {
  const raw = input
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);
  const invalid = raw.filter((v) => !/^\d{4}$/.test(v));
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `Invalid dependency ID${invalid.length === 1 ? "" : "s"}: ${invalid.join(", ")}`,
    };
  }
  return { ok: true, deps: [...new Set(raw)] };
}

interface DoDItem {
  checked: boolean;
  text: string;
}

function parseDoD(description: string): DoDItem[] {
  const items: DoDItem[] = [];
  const lines = description.split(/\r?\n/);
  const re = /^\s*[-*]\s*\[( |x|X)\]\s+(.+?)\s*$/;
  for (const line of lines) {
    const m = line.match(re);
    if (!m) continue;
    items.push({ checked: m[1].toLowerCase() === "x", text: m[2] });
  }
  return items;
}
