"use client";

/**
 * Collapsible thread sidebar inside the Composer modal.
 *
 * Default state is collapsed (~44px rail with hamburger + thread count
 * badge); expanded state is 280px and shows "+ New thread", a search
 * box, and the paginated ThreadList. Persisted in localStorage so the
 * user's preference survives modal reopens and page reloads.
 *
 * On mobile the sidebar is rendered as a top sheet by Modal.tsx — this
 * component itself only knows about the open/closed split.
 */

import clsx from "clsx";
import { Menu, Plus, Search, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useBoard } from "@/lib/state";
import { Button, IconButton, Input } from "@/components/ui";
import { ComposerThreadList } from "./ThreadList";

const SIDEBAR_KEY = "composer:sidebar-open";

interface Props {
  /** Render the sheet variant (full-width, top of screen). */
  asSheet?: boolean;
  /** Sheet variant only — invoked when the sidebar should close. */
  onClose?: () => void;
}

export function ComposerSidebar({ asSheet, onClose }: Props) {
  const [open, setOpen] = useState<boolean>(false);
  const [query, setQuery] = useState("");

  // Hydrate on mount; default = closed (per spec). The sheet variant is
  // always conceptually "open" — we ignore the persisted bit there
  // because the sheet's existence is controlled by the parent modal.
  useEffect(() => {
    if (asSheet) return;
    try {
      const raw = window.localStorage.getItem(SIDEBAR_KEY);
      if (raw === "1") setOpen(true);
    } catch {
      // private mode / quota — fall back to closed
    }
  }, [asSheet]);

  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      try {
        window.localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const threadCount = useBoard((s) => Object.keys(s.composerThreads).length);
  const setComposerActive = useBoard((s) => s.setComposerActive);
  const setComposerDraft = useBoard((s) => s.setComposerDraft);

  // "+ New thread" no longer POSTs — it resets the chat surface to a
  // fresh client-only draft. Empty drafts that the user abandons leave
  // no server trace. The first message Send creates the persistent
  // thread (see Input.tsx onSend draft branch).
  const handleNewThread = () => {
    setComposerActive(null);
    setComposerDraft({ cwd: null });
    // On mobile (sheet variant), drop the sheet so the user sees the
    // chat surface immediately.
    if (asSheet) onClose?.();
  };

  // Sheet variant: full-width pane shown above the chat surface; same
  // controls but no rail.
  if (asSheet) {
    return (
      <aside className="flex h-full w-full flex-col border-b border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <h3 className="text-[13px] font-semibold">Threads</h3>
          <IconButton
            onClick={onClose}
            label="Close threads"
            size="xs"
            className="ml-auto"
          >
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="flex flex-col gap-2 px-3 py-2">
          <Button
            onClick={handleNewThread}
            variant="primary"
            size="sm"
            icon={<Plus className="h-3.5 w-3.5" />}
          >
            New thread
          </Button>
          <SearchBox query={query} onChange={setQuery} />
        </div>
        <ComposerThreadList query={query} onSelected={onClose} />
      </aside>
    );
  }

  // Desktop rail mode. Width swaps via CSS so the chat surface re-flows
  // smoothly when the user toggles open/closed.
  return (
    <aside
      className={clsx(
        "flex h-full shrink-0 flex-col border-r border-border bg-surface-muted transition-[width] duration-150 ease-out",
        open ? "w-[280px]" : "w-[44px]",
      )}
    >
      <div
        className={clsx(
          "flex shrink-0 items-center border-b border-border",
          open ? "justify-between gap-2 px-3 py-2" : "justify-center py-2",
        )}
      >
        <IconButton
          onClick={toggle}
          label={open ? "Collapse sidebar" : "Expand sidebar"}
          size="xs"
          className="relative"
        >
          <Menu className="h-4 w-4" />
          {/* When collapsed, surface the count as a tiny badge so the
              rail is still informative without taking horizontal space. */}
          {!open && threadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 inline-flex h-3.5 min-w-[14px] items-center justify-center rounded-full bg-ink px-1 font-mono text-[9px] leading-none text-white">
              {threadCount > 99 ? "99+" : threadCount}
            </span>
          )}
        </IconButton>
        {open && <h3 className="text-[12.5px] font-semibold">Threads</h3>}
        {open && (
          <IconButton
            onClick={handleNewThread}
            label="New thread"
            title="New thread"
            size="xs"
          >
            <Plus className="h-4 w-4" />
          </IconButton>
        )}
      </div>

      {/* Body: hidden when collapsed so we don't waste a render pass on
          the (potentially long) thread list. */}
      {open && (
        <>
          <div className="px-3 py-2">
            <SearchBox query={query} onChange={setQuery} />
          </div>
          <ComposerThreadList query={query} />
        </>
      )}
    </aside>
  );
}

function SearchBox({
  query,
  onChange,
}: {
  query: string;
  onChange: (q: string) => void;
}) {
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
      <Input
        value={query}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search threads…"
        className="pl-7 text-[12px]"
      />
    </div>
  );
}
