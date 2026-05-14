"use client";

import { create } from "zustand";
import type {
  BoardConfig,
  BoardStats,
  CardStatus,
  CardSummary,
  Comment,
  ComposerMessage,
  ComposerPendingToolUse,
  ComposerThread,
  ComposerThreadSummary,
  HistoryEntry,
  SseEvent,
} from "./types";

export const COLUMNS: { id: CardStatus; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In Progress" },
  { id: "stuck", label: "Stuck" },
  { id: "human_review", label: "Human Review" },
  { id: "ai_review", label: "AI Review" },
  { id: "merging", label: "Merging" },
  { id: "done", label: "Done" },
  { id: "cancelled", label: "Cancelled" },
];

interface Toast {
  id: number;
  kind: "info" | "error" | "success";
  message: string;
}

/**
 * Transient draft state for the Composer modal.
 *
 * The draft is **client-only** — no thread row exists on the server until
 * the user sends their first message, at which point we POST
 * `/api/composer/threads` with `{initial_message, cwd}` and the returned
 * thread becomes `composerActive`. Closing the modal without typing
 * discards the draft entirely (no orphan rows accumulate server-side).
 */
export interface ComposerDraft {
  /** Working directory chosen via CwdPicker. null = use BOARD_ROOT. */
  cwd: string | null;
}

interface State {
  cards: Record<string, CardSummary>;
  comments: Record<string, Comment[]>; // by card id
  history: Record<string, HistoryEntry[]>; // by card id
  config: BoardConfig | null;
  stats: BoardStats | null;
  drawerCardId: string | null;
  selected: Set<string>; // multi-select for archive
  toasts: Toast[];
  /**
   * Whether the New Card modal is open. Lifted into global state so the
   * top-bar button AND the inline "+ New" button at the bottom of the
   * Backlog column can both control the same dialog.
   */
  newCardOpen: boolean;

  // ── Composer slice (Agent B owns; Phase-0 slot) ───────────────────────
  composerOpen: boolean;
  composerThreads: Record<string, ComposerThreadSummary>;
  /** Currently-loaded full thread (open in modal). */
  composerActive: ComposerThread | null;
  /**
   * Client-only draft surfaced when no `composerActive` is selected. Lets
   * the modal render the chat surface with an empty transcript + working
   * input *before* any server thread exists. First message send promotes
   * the draft into a real thread.
   */
  composerDraft: ComposerDraft | null;
  /**
   * Per-thread "turn currently in flight" flag, driven by the
   * `composer_turn_state` SSE event. True from the moment we send the
   * user's message until the server sees the corresponding `result`
   * envelope from claude. The chat view uses this to keep the typing
   * indicator visible during long thinking pauses between assistant
   * chunks (the prior heuristic dropped it as soon as the first chunk
   * landed).
   */
  composerTurnInFlight: Record<string, boolean>;

  // mutations
  setCards: (cards: CardSummary[]) => void;
  upsertCard: (card: CardSummary) => void;
  removeCard: (id: string) => void;
  patchCard: (id: string, patch: Partial<CardSummary>) => void;
  setComments: (id: string, comments: Comment[]) => void;
  appendComment: (id: string, comment: Comment) => void;
  setHistory: (id: string, history: HistoryEntry[]) => void;
  appendHistory: (id: string, entry: HistoryEntry) => void;
  setConfig: (cfg: BoardConfig) => void;
  setStats: (s: BoardStats) => void;
  openDrawer: (id: string | null) => void;
  setNewCardOpen: (open: boolean) => void;
  setComposerOpen: (open: boolean) => void;
  setComposerThreads: (threads: ComposerThreadSummary[]) => void;
  upsertComposerThread: (t: ComposerThreadSummary) => void;
  removeComposerThread: (id: string) => void;
  setComposerActive: (t: ComposerThread | null) => void;
  setComposerDraft: (d: ComposerDraft | null) => void;
  appendComposerMessage: (id: string, m: ComposerMessage) => void;
  setComposerPending: (id: string, pending: ComposerPendingToolUse | null) => void;
  toggleSelect: (id: string, multi: boolean) => void;
  clearSelection: () => void;
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: number) => void;

  // event entry-point
  applySseEvent: (e: SseEvent) => void;
}

let toastCounter = 1;

export const useBoard = create<State>((set, get) => ({
  cards: {},
  comments: {},
  history: {},
  config: null,
  stats: null,
  drawerCardId: null,
  selected: new Set(),
  toasts: [],
  newCardOpen: false,
  composerOpen: false,
  composerThreads: {},
  composerActive: null,
  composerDraft: null,
  composerTurnInFlight: {},

  setComposerOpen: (composerOpen) => set({ composerOpen }),
  setComposerDraft: (composerDraft) => set({ composerDraft }),
  setComposerThreads: (threads) =>
    set(() => {
      const map: Record<string, ComposerThreadSummary> = {};
      for (const t of threads) map[t.id] = t;
      return { composerThreads: map };
    }),
  upsertComposerThread: (t) =>
    set((s) => ({ composerThreads: { ...s.composerThreads, [t.id]: t } })),
  removeComposerThread: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.composerThreads;
      return {
        composerThreads: rest,
        composerActive:
          s.composerActive?.id === id ? null : s.composerActive,
      };
    }),
  setComposerActive: (composerActive) =>
    // Selecting (or loading) a real thread always clears the draft —
    // they're mutually exclusive: the chat surface either renders a
    // server-backed thread or the transient draft, never both.
    set({ composerActive, composerDraft: composerActive ? null : get().composerDraft }),
  appendComposerMessage: (id, m) =>
    set((s) => {
      if (!s.composerActive || s.composerActive.id !== id) return s;
      return {
        composerActive: {
          ...s.composerActive,
          messages: [...s.composerActive.messages, m],
        },
      };
    }),
  setComposerPending: (id, pending) =>
    set((s) => {
      if (!s.composerActive || s.composerActive.id !== id) return s;
      const filtered = s.composerActive.pending.filter(
        (p) => !pending || p.id !== pending.id,
      );
      return {
        composerActive: {
          ...s.composerActive,
          pending: pending ? [...filtered, pending] : filtered,
        },
      };
    }),

  setCards: (cards) =>
    set(() => {
      const map: Record<string, CardSummary> = {};
      for (const c of cards) map[c.id] = c;
      return { cards: map };
    }),

  upsertCard: (card) =>
    set((s) => ({ cards: { ...s.cards, [card.id]: card } })),

  removeCard: (id) =>
    set((s) => {
      const { [id]: _gone, ...rest } = s.cards;
      const selected = new Set(s.selected);
      selected.delete(id);
      return {
        cards: rest,
        selected,
        drawerCardId: s.drawerCardId === id ? null : s.drawerCardId,
      };
    }),

  patchCard: (id, patch) =>
    set((s) =>
      s.cards[id] ? { cards: { ...s.cards, [id]: { ...s.cards[id], ...patch } } } : s,
    ),

  setComments: (id, comments) =>
    set((s) => ({ comments: { ...s.comments, [id]: comments } })),

  appendComment: (id, comment) =>
    set((s) => ({
      comments: {
        ...s.comments,
        [id]: [...(s.comments[id] ?? []), comment],
      },
      cards: s.cards[id]
        ? {
            ...s.cards,
            [id]: {
              ...s.cards[id],
              comment_count: (s.cards[id].comment_count ?? 0) + 1,
              updated_at: comment.ts,
            },
          }
        : s.cards,
    })),

  setHistory: (id, history) =>
    set((s) => ({ history: { ...s.history, [id]: history } })),

  appendHistory: (id, entry) =>
    set((s) => ({
      history: {
        ...s.history,
        [id]: [...(s.history[id] ?? []), entry],
      },
    })),

  setConfig: (config) => set({ config }),
  setStats: (stats) => set({ stats }),
  openDrawer: (drawerCardId) => set({ drawerCardId }),
  setNewCardOpen: (newCardOpen) => set({ newCardOpen }),

  toggleSelect: (id, multi) =>
    set((s) => {
      const next = new Set(multi ? s.selected : []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selected: next };
    }),

  clearSelection: () => set({ selected: new Set() }),

  pushToast: (t) => {
    const id = toastCounter++;
    set((s) => ({ toasts: [...s.toasts, { id, ...t }] }));
    setTimeout(() => get().dismissToast(id), 4000);
  },

  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  applySseEvent: (e) => {
    switch (e.type) {
      case "card_created":
      case "card_updated": {
        // Trigger a lazy re-fetch by leaving a stale flag; the Board hook
        // refetches the list on these events for simplicity.
        return;
      }
      case "card_status_changed": {
        get().patchCard(e.card_id, { status: e.to });
        return;
      }
      case "card_archived": {
        get().removeCard(e.card_id);
        return;
      }
      case "comment_added": {
        const id = e.card_id;
        if (get().comments[id]) {
          get().appendComment(id, e.comment);
        } else {
          // Drawer not open; just bump the count + updated_at.
          const card = get().cards[id];
          if (card) {
            get().patchCard(id, {
              comment_count: (card.comment_count ?? 0) + 1,
              updated_at: e.comment.ts,
            });
          }
        }
        return;
      }
      case "history_added": {
        const id = e.card_id;
        // Only refresh local cache if drawer/history tab has been opened
        // for this card. Otherwise the next open will fetch fresh.
        if (get().history[id]) {
          get().appendHistory(id, e.entry);
        }
        return;
      }
      case "worker_heartbeat": {
        const card = get().cards[e.card_id];
        if (!card) return;
        get().patchCard(e.card_id, {
          tokens_used: e.tokens_used,
          elapsed_seconds: e.elapsed_seconds,
          owner_pid: e.pid,
          worker_input_tokens: e.worker_input_tokens,
          worker_output_tokens: e.worker_output_tokens,
          reviewer_input_tokens: e.reviewer_input_tokens,
          reviewer_output_tokens: e.reviewer_output_tokens,
          merger_input_tokens: e.merger_input_tokens,
          merger_output_tokens: e.merger_output_tokens,
        });
        return;
      }
      case "worker_started": {
        get().patchCard(e.card_id, { owner_pid: e.pid });
        return;
      }
      case "worker_ended": {
        get().patchCard(e.card_id, { owner_pid: null });
        return;
      }
      case "config_changed": {
        get().setConfig(e.config);
        return;
      }
      // ── Composer ──────────────────────────────────────────────────────
      case "composer_thread_changed": {
        // Either the summary changed (rename / status flip / outcome
        // update) or the thread was deleted. We patch the sidebar map
        // either way; if the active thread was the one mutated we also
        // rebase its summary fields onto `composerActive` so the chat
        // header / outcome chip stay current without a refetch.
        if (e.deleted) {
          get().removeComposerThread(e.thread_id);
          return;
        }
        if (e.summary) {
          get().upsertComposerThread(e.summary);
          const active = get().composerActive;
          if (active && active.id === e.thread_id) {
            // Spread the new summary fields ONTO the active thread —
            // preserves the locally-loaded `messages` and `pending`
            // arrays which the summary doesn't carry.
            useBoard.setState({
              composerActive: { ...active, ...e.summary },
            });
          }
        }
        return;
      }
      case "composer_message_appended": {
        // Only patch the in-memory transcript when the modal is currently
        // showing this thread — otherwise the next open does a fresh
        // GET /threads/:id and gets the full transcript anyway.
        const active = get().composerActive;
        if (!active || active.id !== e.thread_id) return;
        const incoming = e.message;
        const idx = active.messages.findIndex((m) => m.id === incoming.id);
        // `partial: true` means this is a streaming update — replace any
        // prior chunk with the same id rather than appending a duplicate.
        // The non-partial case might also re-broadcast a message after
        // server restart; treat the by-id replace as the safe default.
        let nextMessages = active.messages;
        if (idx >= 0) {
          nextMessages = [
            ...active.messages.slice(0, idx),
            incoming,
            ...active.messages.slice(idx + 1),
          ];
        } else {
          nextMessages = [...active.messages, incoming];
        }
        useBoard.setState({
          composerActive: { ...active, messages: nextMessages },
        });
        return;
      }
      case "composer_tool_pending": {
        const active = get().composerActive;
        if (!active || active.id !== e.thread_id) return;
        get().setComposerPending(e.thread_id, e.pending);
        return;
      }
      case "composer_tool_resolved": {
        // Drop whichever pending entry matches `tool_use_id`. We can't use
        // setComposerPending(null) directly because it nukes the entire
        // queue; instead filter in place.
        const active = get().composerActive;
        if (!active || active.id !== e.thread_id) return;
        const filtered = active.pending.filter((p) => p.id !== e.tool_use_id);
        useBoard.setState({
          composerActive: { ...active, pending: filtered },
        });
        return;
      }
      case "composer_turn_state": {
        // Authoritative typing-indicator signal. Track per-thread so a
        // background thread's in-flight turn doesn't confuse the active
        // thread's indicator (and vice versa).
        useBoard.setState((s) => ({
          composerTurnInFlight: { ...s.composerTurnInFlight, [e.thread_id]: e.in_flight },
        }));
        return;
      }
    }
  },
}));
