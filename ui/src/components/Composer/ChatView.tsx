"use client";
/**
 * Composer chat surface — header + scrolling transcript + footer
 * input. Reads the active thread out of zustand state (which the
 * SSE handler keeps live). The Modal/Sidebar (Agent B) is responsible
 * for hydrating `composerActive` when the user opens a thread; this
 * component just renders whatever's in store.
 *
 * Auto-scroll behavior: on every new message we scroll to the bottom
 * UNLESS the user has scrolled up to read history. We track the
 * "user is pinned to bottom" state via a scroll listener; the
 * threshold is ~16px to account for sub-pixel rounding.
 */
import clsx from "clsx";
import {
  AlertCircle,
  ArrowDownToLine,
  Loader2,
  MessageSquarePlus,
  Save,
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { patchComposerThread, sendComposerMessage, syncComposerMain } from "@/lib/composer";
import { useBoard } from "@/lib/state";
import type { ComposerMessage, ComposerProcessStatus } from "@/lib/types";
import { ComposerInput } from "./Input";
import { ComposerMakeCardPreview } from "./MakeCardPreview";
import { ComposerMessageRow } from "./Message";
import { ComposerSavePlanPreview } from "./SavePlanPreview";

interface Props {
  /**
   * `null` = draft mode: nothing has been POSTed yet, so we render an
   * empty transcript and a working Input that creates the thread on
   * first send. Otherwise this is a server-backed thread id.
   */
  threadId: string | null;
}

/**
 * Hidden user-message strings that the AI takes as a cue to call the
 * MCP tool for fixed-cost make-card/save-plan decisions.
 */
const MAKE_CARDS_NUDGE = "Drop the agreed plan as cards now via make_card.";
const SAVE_PLAN_NUDGE = "Save this as a plan doc via save_plan.";

const STATUS_STYLE: Record<
  ComposerProcessStatus,
  { dot: string; label: string; text: string }
> = {
  idle: { dot: "bg-gray-400", label: "idle", text: "text-ink-muted" },
  running: { dot: "bg-emerald-500 animate-pulseDot", label: "running", text: "text-emerald-700" },
  awaiting: { dot: "bg-amber-500 animate-pulseDot", label: "awaiting", text: "text-amber-700" },
  error: { dot: "bg-red-500", label: "error", text: "text-red-700" },
};

export function ComposerChatView({ threadId }: Props) {
  const active = useBoard((s) => s.composerActive);
  const draft = useBoard((s) => s.composerDraft);
  const pushToast = useBoard((s) => s.pushToast);
  // Authoritative "claude is currently working on a turn" flag. Comes
  // from `composer_turn_state` SSE events; flips true on stdin write,
  // false on the `result` envelope. Used to keep the typing indicator
  // visible during long thinking pauses between assistant chunks.
  const turnInFlight = useBoard((s) =>
    threadId ? !!s.composerTurnInFlight[threadId] : false,
  );

  // Draft mode = no real thread yet. Header reads as a brand-new
  // conversation; transcript is empty; Make-cards / Save-plan only make
  // sense once there's something to act on, so we hide them.
  const isDraft = threadId === null;
  const isThisThread = !isDraft && active?.id === threadId;
  const messages: ComposerMessage[] = isThisThread ? active.messages : [];
  const pending = isThisThread ? active.pending : [];

  // Pair tool_use rows with their matching tool_result so the result
  // nests inside the ToolCard (visible when expanded) instead of being
  // dropped or rendering as a separate row. Mirrors PairedMessageList in
  // CardTranscriptView.tsx.
  const resultById = useMemo(() => {
    const m = new Map<string, ComposerMessage>();
    for (const msg of messages) {
      if (msg.tool_result?.tool_use_id) m.set(msg.tool_result.tool_use_id, msg);
    }
    return m;
  }, [messages]);
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
  // Empty surface = no transcript and no pending tool gates. Drives the
  // ChatGPT-style "input centered in the middle" empty state vs the
  // normal transcript + bottom-attached input layout. Draft mode (no
  // server thread yet) is always empty by definition.
  const isEmpty = messages.length === 0 && pending.length === 0;
  const status: ComposerProcessStatus = isThisThread ? active.status : "idle";
  const inTokens = isThisThread ? active.input_tokens : 0;
  const outTokens = isThisThread ? active.output_tokens : 0;
  // Commits behind origin/main inside the composer worktree. null = not
  // computed yet (no worktree, or compute failed); 0 = up to date; >=1 =
  // show the orange "↑N behind" chip + Sync button.
  const behindMain = isThisThread ? active.behind_main ?? null : null;

  // Title editing — click to edit; blur or Enter saves; Esc cancels.
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(active?.title ?? "");
  useEffect(() => {
    setTitleDraft(active?.title ?? "");
  }, [active?.title]);

  const onSaveTitle = async () => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (!isThisThread || !threadId || !next || next === active?.title) return;
    try {
      await patchComposerThread(threadId, { title: next });
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
      setTitleDraft(active?.title ?? "");
    }
  };

  // ── Auto-scroll wiring ────────────────────────────────────────────
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // Pinned to bottom = stay-locked. Default true on initial mount.
  const pinnedRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = distance < 16;
  }, []);

  // Use layout effect so DOM growth from a new message is reconciled
  // before we scroll, avoiding a one-frame "stuck" flash.
  useLayoutEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, pending.length]);

  // ── Header action buttons (inject hidden nudge messages) ──────────
  const sending = useRef(false);
  const onMakeCards = async () => {
    if (sending.current || !threadId) return;
    sending.current = true;
    try {
      await sendComposerMessage(threadId, MAKE_CARDS_NUDGE);
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      sending.current = false;
    }
  };
  const onSavePlan = async () => {
    if (sending.current || !threadId) return;
    sending.current = true;
    try {
      await sendComposerMessage(threadId, SAVE_PLAN_NUDGE);
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      sending.current = false;
    }
  };

  // Sync-main affordance — hard-resets the composer worktree to
  // origin/main. We disable the button while the request is in flight
  // (it's a single shot; spamming it would just re-fetch). The server
  // pushes a transcript marker + summary update via SSE, so we don't
  // need to mutate state here on success.
  const [syncing, setSyncing] = useState(false);
  const onSyncMain = async () => {
    if (syncing || !threadId) return;
    setSyncing(true);
    try {
      await syncComposerMain(threadId);
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSyncing(false);
    }
  };

  // Draft mode renders happily even when `active` is null — bail only on
  // the "we have a real id but the active thread is a different one"
  // race (sidebar mid-load). Draft has no id, so isThisThread === false
  // is expected and not a load-failure.
  if (!isDraft && !isThisThread) {
    // Sidebar should hydrate this. If we're rendered without a matching
    // active thread it's a brief inconsistency — show a neutral spinner
    // rather than crashing.
    return (
      <div className="flex h-full items-center justify-center text-[12.5px] text-ink-subtle">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading thread…
      </div>
    );
  }

  const statusStyle = STATUS_STYLE[status];

  return (
    // The parent body container in Modal.tsx is `flex min-h-0 flex-1`
    // (row direction by default), so without `flex-1 min-w-0` here the
    // chat surface shrinks to content-width and the empty-state input
    // ends up squashed in the left third of the modal.
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <Sparkles className="h-4 w-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          {/* Draft mode: title is just a hint until first send creates the
              thread. No edit affordance — there's nothing to PATCH yet. */}
          {isDraft ? (
            <div className="block w-full truncate px-1.5 py-0.5 text-left text-[13.5px] font-semibold text-ink-muted">
              New thread
              {draft?.cwd && (
                <span className="ml-2 font-mono text-[11px] text-ink-subtle">
                  · {draft.cwd}
                </span>
              )}
            </div>
          ) : editingTitle ? (
            <input
              autoFocus
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={onSaveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void onSaveTitle();
                } else if (e.key === "Escape") {
                  setTitleDraft(active?.title ?? "");
                  setEditingTitle(false);
                }
              }}
              className="w-full rounded border border-ink/30 bg-surface px-1.5 py-0.5 text-[13.5px] font-semibold focus:border-ink focus:outline-none"
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTitle(true)}
              className="block w-full truncate rounded px-1.5 py-0.5 text-left text-[13.5px] font-semibold text-ink hover:bg-surface-muted"
              title="Click to rename"
            >
              {active?.title || "(untitled thread)"}
            </button>
          )}
        </div>

        {/* Behind-main chip + Sync button. Hidden in draft mode (no
            thread/worktree yet) and when behind_main is null/0 — the
            common case is "up to date", and a quiet header is nicer
            than a permanent "✓ up to date" badge. */}
        {!isDraft && behindMain != null && behindMain >= 1 && (
          <>
            <span
              className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 font-mono text-[10.5px] font-medium text-amber-800 ring-1 ring-inset ring-amber-200"
              title={`Worktree is ${behindMain} commit${behindMain === 1 ? "" : "s"} behind origin/main`}
            >
              ↑{behindMain} behind main
            </span>
            <button
              type="button"
              onClick={onSyncMain}
              disabled={syncing}
              className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11.5px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              title="Hard-reset the worktree to origin/main"
            >
              {syncing ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ArrowDownToLine className="h-3.5 w-3.5" />
              )}
              Sync
            </button>
          </>
        )}

        {/* Status pill */}
        <span
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-mono text-[10.5px] font-medium ring-1 ring-inset ring-border",
            statusStyle.text,
          )}
          title={`Process status: ${statusStyle.label}`}
        >
          <span className={clsx("inline-block h-1.5 w-1.5 rounded-full", statusStyle.dot)} />
          {statusStyle.label}
        </span>

        {/* Token totals */}
        <span
          className="font-mono text-[10.5px] text-ink-subtle"
          title={`input ${inTokens.toLocaleString()} · output ${outTokens.toLocaleString()}`}
        >
          ↓{fmtTok(inTokens)} ↑{fmtTok(outTokens)}
        </span>

        {/* Action buttons — inject hidden nudge user messages. Hidden in
            draft mode: nothing to act on yet. */}
        {!isDraft && (
          <>
            <button
              type="button"
              onClick={onMakeCards}
              disabled={status === "awaiting"}
              className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11.5px] font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
              title="Ask the AI to drop the agreed plan as cards"
            >
              <MessageSquarePlus className="h-3.5 w-3.5" /> Make cards
            </button>
            <button
              type="button"
              onClick={onSavePlan}
              disabled={status === "awaiting"}
              className="inline-flex items-center gap-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[11.5px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              title="Ask the AI to save this as a plan document"
            >
              <Save className="h-3.5 w-3.5" /> Save plan
            </button>
          </>
        )}
      </header>

      {/*
        Body + input layout. Two modes, picked by `isEmpty`:
        - Empty (no messages, no pending tool gates): ChatGPT-style — the
          input lives centered in the chat surface under a quiet heading.
          No big sparkle / "AI assistant" decoration; the input itself is
          the focal point.
        - Non-empty: the transcript fills the upper region (scrollable)
          and the input snaps to a bottom-attached footer.
        The transition happens automatically when the first message lands
        (`messages.length` flips from 0 → 1). We don't FLIP-animate the
        position change — a snap is fine and keeps the code simple.
      */}
      {isEmpty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-[var(--bg-muted,#fafafa)] px-6">
          <div className="flex w-full max-w-[640px] flex-col items-center gap-5">
            <h2 className="text-center text-[20px] font-medium text-ink">
              무엇을 계획해볼까요?
            </h2>
            <div className="w-full">
              <ComposerInput threadId={threadId} />
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Transcript */}
          <div
            ref={scrollerRef}
            onScroll={onScroll}
            className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-muted,#fafafa)] px-4 py-3"
          >
            <div className="mx-auto flex w-full max-w-[760px] flex-col gap-2.5">
              {messages.map((m) => {
                if (skipIds.has(m.id)) return null;
                const pairedResult = m.tool_use?.id
                  ? resultById.get(m.tool_use.id)?.tool_result
                  : undefined;
                return (
                  <ComposerMessageRow
                    key={m.id}
                    message={m}
                    threadId={threadId}
                    pairedResult={pairedResult}
                  />
                );
              })}

              {/* Typing indicator. Driven by the authoritative
                  `composer_turn_state` SSE signal, which the server
                  flips true on every stdin write and false on claude's
                  `result` envelope. We deliberately keep it visible
                  even after the first assistant chunk lands — long
                  thinking pauses between chunks were previously
                  indistinguishable from a hung process. */}
              {turnInFlight && <TypingIndicator />}

              {/* Pending tool gates render at the tail so they're the
                  last thing the user sees — visually below the message
                  that proposed them. Pending items only exist on
                  server-backed threads, so threadId is guaranteed
                  non-null here at runtime. */}
              {threadId &&
                pending.map((p) =>
                  p.name === "make_card" ? (
                    <ComposerMakeCardPreview
                      key={p.id}
                      pending={p}
                      threadId={threadId}
                    />
                  ) : p.name === "save_plan" ? (
                    <ComposerSavePlanPreview
                      key={p.id}
                      pending={p}
                      threadId={threadId}
                    />
                  ) : null,
                )}
            </div>
          </div>

          {/* Footer / input */}
          <div className="shrink-0 border-t border-border bg-surface px-4 py-2.5">
            {status === "error" && (
              <div className="mb-2 flex items-center gap-1.5 rounded bg-red-50 px-2 py-1 text-[11.5px] text-red-800 ring-1 ring-inset ring-red-200">
                <AlertCircle className="h-3.5 w-3.5" />
                Process exited unexpectedly. Send a message to respawn.
              </div>
            )}
            <ComposerInput threadId={threadId} />
          </div>
        </>
      )}
    </div>
  );
}

function fmtTok(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * Minimal "AI is thinking" affordance — three pulsing dots staggered
 * by a fixed phase offset (no extra keyframes; reuses Tailwind's
 * built-in `animate-pulse`). Sits in the message stream looking like a
 * faint assistant bubble so the user's eye lands on it without being
 * yelled at by motion.
 */
function TypingIndicator() {
  return (
    <div className="flex items-center gap-2 text-[11.5px] text-ink-subtle">
      <div className="flex items-center gap-1 rounded-lg bg-surface px-3 py-2 ring-1 ring-inset ring-border">
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-subtle"
          style={{ animationDelay: "0ms" }}
        />
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-subtle"
          style={{ animationDelay: "150ms" }}
        />
        <span
          className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-ink-subtle"
          style={{ animationDelay: "300ms" }}
        />
      </div>
      <span>thinking…</span>
    </div>
  );
}
