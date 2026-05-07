"use client";

/**
 * Composer modal shell.
 *
 * Big modal (90vh × min(1200px, 95vw)) centered over the board with a
 * black backdrop that closes on click. Two-pane layout: collapsible
 * thread sidebar on the left + ChatView on the right. On mobile the
 * sidebar collapses into a top sheet toggled via a hamburger button in
 * the chat header. Lazy-loaded so the initial bundle stays slim — the
 * Composer is opt-in and most board sessions never open it.
 */

import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { Menu, X } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { listComposerThreads } from "@/lib/composer";
import { useBoard } from "@/lib/state";
import { useIsMobile } from "@/lib/useIsMobile";
import { ComposerSidebar } from "./Sidebar";

// Lazy-load the chat surface — Agent C's component pulls in markdown,
// shiki, and the @-mention machinery. Mirrors the DiffViewer split in
// CardDrawer.
const ComposerChatView = lazy(() =>
  import("./ChatView").then((m) => ({ default: m.ComposerChatView })),
);

export function ComposerModal() {
  const open = useBoard((s) => s.composerOpen);
  const setOpen = useBoard((s) => s.setComposerOpen);
  const active = useBoard((s) => s.composerActive);
  const draft = useBoard((s) => s.composerDraft);
  const setComposerDraft = useBoard((s) => s.setComposerDraft);
  const setComposerThreads = useBoard((s) => s.setComposerThreads);
  const pushToast = useBoard((s) => s.pushToast);
  const isMobile = useIsMobile();

  // Mobile: the sidebar lives as a top sheet triggered by the chat
  // header's hamburger. Initial state = closed; the user pops it
  // explicitly.
  const [sheetOpen, setSheetOpen] = useState(false);

  // Initial thread list fetch — happens once per modal open so the
  // sidebar has something to show even if no SSE events have landed
  // yet. The ThreadList itself fetches on mount too; doing it here
  // (in addition) means the modal feels populated the moment it pops
  // up. Errors surface as a toast and we leave threads empty.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      try {
        const res = await listComposerThreads({ limit: 30, offset: 0 });
        if (!alive) return;
        setComposerThreads(res.threads);
      } catch (e) {
        if (!alive) return;
        pushToast({
          kind: "error",
          message:
            e instanceof Error
              ? `Composer: ${e.message}`
              : "Backend not yet implemented",
        });
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, setComposerThreads, pushToast]);

  // Reset sheet state when modal toggles or viewport flips between
  // mobile/desktop — otherwise an open sheet leaks across modes.
  useEffect(() => {
    if (!open) setSheetOpen(false);
  }, [open]);

  // Auto-mount a fresh draft whenever the modal opens with no active
  // thread (or no pre-populated draft from CwdPicker). This is the heart
  // of the "open Composer → blank chat surface" UX: the user lands in a
  // working chat view, not on the old "No thread selected" dead end.
  // The draft is purely client-side; nothing is POSTed until they hit
  // Send. Closing the modal discards it (see effect below).
  useEffect(() => {
    if (!open) return;
    if (active) return;
    if (draft) return;
    setComposerDraft({ cwd: null });
  }, [open, active, draft, setComposerDraft]);

  // Discard the draft on close so an abandoned blank draft doesn't
  // resurrect on next open with stale cwd state.
  useEffect(() => {
    if (open) return;
    if (!draft) return;
    setComposerDraft(null);
  }, [open, draft, setComposerDraft]);
  useEffect(() => {
    if (!isMobile) setSheetOpen(false);
  }, [isMobile]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-black/40 animate-fadeIn" />
        {/*
          Centering strategy: Dialog.Content is a viewport-filling flex
          container with `pointer-events-none`, and the actual modal box is
          a `pointer-events-auto` child. This is more robust than the
          older `left-1/2 top-1/2 -translate-1/2` trick — that approach
          gets clipped/offset whenever an ancestor (e.g. board's drag
          context) introduces a `transform`, since `position: fixed`
          becomes positioned relative to the transformed ancestor instead
          of the viewport. Filling the viewport with flex centering
          sidesteps the issue. Clicks in the gap fall through to the
          overlay (close on outside-click still works).
        */}
        <Dialog.Content
          aria-label="Composer"
          className="fixed inset-0 z-40 flex items-center justify-center pointer-events-none"
        >
          <Dialog.Title className="sr-only">Composer</Dialog.Title>
          <div
            className={clsx(
              "pointer-events-auto flex flex-col overflow-hidden bg-white shadow-2xl animate-fadeIn",
              isMobile
                ? // Mobile: full screen
                  "h-full w-full"
                : // Desktop: centered card sized normally; flex parent
                  // handles the centering.
                  "h-[90vh] w-[min(1200px,95vw)] rounded-lg border border-black/10",
            )}
          >
          <div className="flex h-full min-h-0 flex-1">
            {!isMobile && <ComposerSidebar />}
            <div className="relative flex min-w-0 flex-1 flex-col">
              {/* Chat header — hamburger (mobile sheet trigger) + close
                  button. Desktop uses just the close button; the sidebar
                  has its own collapse control. */}
              <div className="flex shrink-0 items-center gap-2 border-b border-black/5 px-3 py-2">
                {isMobile && (
                  <button
                    onClick={() => setSheetOpen(true)}
                    aria-label="Show threads"
                    className="rounded p-1 text-ink-muted hover:bg-black/5"
                  >
                    <Menu className="h-4 w-4" />
                  </button>
                )}
                <h2 className="truncate text-[13px] font-semibold text-ink">
                  {active?.title || (draft ? "New thread" : "Composer")}
                </h2>
                {(active?.cwd || draft?.cwd) && (
                  <span className="hidden truncate font-mono text-[11px] text-ink-subtle md:inline">
                    · {active?.cwd ?? draft?.cwd}
                  </span>
                )}
                <Dialog.Close asChild>
                  <button
                    aria-label="Close"
                    className="ml-auto rounded p-1 text-ink-subtle hover:bg-black/5"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </Dialog.Close>
              </div>

              {/* Body */}
              <div className="relative flex min-h-0 flex-1">
                {active || draft ? (
                  // Pass `null` for draft mode — ChatView/Input branch on
                  // it and the first send creates the persistent thread.
                  <Suspense
                    fallback={
                      <div className="flex flex-1 items-center justify-center text-[12.5px] text-ink-subtle">
                        Loading…
                      </div>
                    }
                  >
                    <ComposerChatView threadId={active ? active.id : null} />
                  </Suspense>
                ) : (
                  // Should be unreachable while `open` (the auto-mount
                  // effect ensures a draft exists). Kept as a safety net
                  // for the brief render between open=false→true and the
                  // effect commit.
                  <EmptyState />
                )}

                {/* Mobile sheet: slides down over the chat surface. We
                    keep it inside the chat pane so it doesn't fight with
                    Radix's focus management on Dialog.Content. */}
                {isMobile && sheetOpen && (
                  <div className="absolute inset-0 z-10 flex flex-col bg-white">
                    <ComposerSidebar
                      asSheet
                      onClose={() => setSheetOpen(false)}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function EmptyState() {
  // Note: the "+ New thread" button lives in the sidebar. We just point
  // the user there so the empty state isn't a dead end. Mobile: the
  // sidebar is reachable via the hamburger above.
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <div className="text-[14px] font-medium text-ink">No thread selected</div>
      <p className="max-w-sm text-[12.5px] text-ink-muted">
        Pick a thread on the left, or start a new one with the{" "}
        <span className="font-mono">+</span> button in the sidebar header.
      </p>
    </div>
  );
}
