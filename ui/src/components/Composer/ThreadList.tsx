"use client";

/**
 * Paginated thread row list for the Composer sidebar.
 *
 * One row per ComposerThreadSummary: title (truncate), relative
 * updated_at, message count, outcome chip ("→ N cards" / "→ plan: foo")
 * and a tiny status dot driven by `summary.status`. Click selects a
 * thread (full transcript loaded via getComposerThread on demand).
 * Right-click / kebab opens an action menu with Rename + Delete.
 *
 * Pagination: client-side over the in-memory thread map. Server-driven
 * pagination is exposed by listComposerThreads() but Phase 1B keeps it
 * simple — load N=30, "Load more" pulls the next page.
 */

import clsx from "clsx";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  deleteComposerThread,
  getComposerThread,
  listComposerThreads,
  patchComposerThread,
} from "@/lib/composer";
import { useBoard } from "@/lib/state";
import type {
  ComposerProcessStatus,
  ComposerThreadSummary,
} from "@/lib/types";

const PAGE = 30;

interface Props {
  /** Free-text filter applied to title (case-insensitive). */
  query: string;
  /** Mobile shows the sidebar as a sheet — we close it on selection. */
  onSelected?: () => void;
}

export function ComposerThreadList({ query, onSelected }: Props) {
  const threads = useBoard((s) => s.composerThreads);
  const setComposerThreads = useBoard((s) => s.setComposerThreads);
  const setComposerActive = useBoard((s) => s.setComposerActive);
  const removeComposerThread = useBoard((s) => s.removeComposerThread);
  const upsertComposerThread = useBoard((s) => s.upsertComposerThread);
  const activeId = useBoard((s) => s.composerActive?.id ?? null);
  const pushToast = useBoard((s) => s.pushToast);

  // Cursor over the server-side total. We track `loaded` separately from
  // the thread map size because client-side filters / search collapses
  // visible counts.
  const [loaded, setLoaded] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);

  // First-page load — happens once on mount. Subsequent loads pull the
  // next slice via "Load more".
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const res = await listComposerThreads({ offset: 0, limit: PAGE });
        if (!alive) return;
        setComposerThreads(res.threads);
        setLoaded(res.threads.length);
        setTotal(res.total);
      } catch (e) {
        if (!alive) return;
        pushToast({
          kind: "error",
          message:
            e instanceof Error
              ? `Failed to load threads: ${e.message}`
              : "Failed to load threads",
        });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [setComposerThreads, pushToast]);

  const loadMore = async () => {
    setLoading(true);
    try {
      const res = await listComposerThreads({ offset: loaded, limit: PAGE });
      // Merge into the existing map rather than replacing — we may have
      // received SSE upserts since the first page landed.
      for (const t of res.threads) upsertComposerThread(t);
      setLoaded(loaded + res.threads.length);
      setTotal(res.total);
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  };

  const select = async (id: string) => {
    try {
      const full = await getComposerThread(id);
      setComposerActive(full);
      onSelected?.();
    } catch (e) {
      pushToast({
        kind: "error",
        message:
          e instanceof Error
            ? `Failed to open thread: ${e.message}`
            : "Failed to open thread",
      });
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("Delete this thread? Worktree + transcript will be removed.")) return;
    try {
      await deleteComposerThread(id);
      removeComposerThread(id);
      pushToast({ kind: "info", message: "Thread deleted." });
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const onRename = async (id: string, current: string) => {
    const next = window.prompt("Rename thread:", current);
    if (next == null) return;
    const trimmed = next.trim();
    if (!trimmed || trimmed === current) return;
    try {
      const summary = await patchComposerThread(id, { title: trimmed });
      upsertComposerThread(summary);
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  // Filter + sort (most recently updated first). We deliberately compute
  // off the live `threads` map so SSE updates trickle in without a
  // refetch.
  const all = Object.values(threads);
  const q = query.trim().toLowerCase();
  const visible = (q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all)
    .slice()
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <ol className="flex-1 overflow-y-auto px-1 py-1">
        {visible.length === 0 && !loading && (
          <li className="px-2 py-3 text-[11.5px] text-ink-subtle">
            {q ? "No threads match." : "No threads yet."}
          </li>
        )}
        {visible.map((t) => (
          <ThreadRow
            key={t.id}
            t={t}
            active={t.id === activeId}
            onSelect={() => select(t.id)}
            onDelete={() => onDelete(t.id)}
            onRename={() => onRename(t.id, t.title)}
          />
        ))}
      </ol>
      {/* "Load more" — only when the server has more rows than we've
          already pulled. Hidden when a search filter is active because
          the next server page might still not match the query (we'd
          rather the user clear the filter to see everything). */}
      {!q && total > loaded && (
        <button
          onClick={loadMore}
          disabled={loading}
          className="border-t border-black/5 px-3 py-2 text-[11.5px] font-medium text-ink-muted hover:bg-black/5 disabled:opacity-50"
        >
          {loading ? "Loading…" : `Load more (${total - loaded})`}
        </button>
      )}
    </div>
  );
}

const STATUS_DOT: Record<ComposerProcessStatus, string> = {
  idle: "bg-gray-300",
  running: "bg-emerald-500 animate-pulse",
  awaiting: "bg-amber-500",
  error: "bg-red-500",
};

function ThreadRow({
  t,
  active,
  onSelect,
  onDelete,
  onRename,
}: {
  t: ComposerThreadSummary;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onRename: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the kebab menu on outside click. Plain pointer listener (no
  // Radix dependency) — the popover is small and one-deep.
  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const cards = t.outcome.card_ids.length;
  const plans = t.outcome.plan_paths.length;
  // Pick a single chip — cards take precedence (more common outcome).
  // Plan names are file basenames: "20260503-1200-foo.md" → "foo".
  let outcome: string | null = null;
  if (cards > 0) {
    outcome = `→ ${cards} card${cards === 1 ? "" : "s"}`;
  } else if (plans > 0) {
    const last = t.outcome.plan_paths[plans - 1];
    const base = last.split("/").pop() ?? last;
    const slug = base.replace(/\.md$/, "").replace(/^\d+-\d+-/, "");
    outcome = `→ plan: ${slug}`;
  }

  return (
    <li
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuOpen(true);
      }}
      className={clsx(
        "group relative cursor-pointer rounded px-2 py-2 text-[12.5px]",
        active ? "bg-ink/5" : "hover:bg-black/5",
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className={clsx(
            "mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full",
            STATUS_DOT[t.status] ?? "bg-gray-300",
          )}
          title={t.status}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-ink">{t.title || "(untitled)"}</div>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-ink-subtle">
            <span>{relTime(t.updated_at)}</span>
            <span aria-hidden>·</span>
            <span className="font-mono">{t.message_count} msg</span>
            {outcome && (
              <>
                <span aria-hidden>·</span>
                <span className="truncate text-ink-muted">{outcome}</span>
              </>
            )}
          </div>
        </div>
        <button
          aria-label="Thread actions"
          onClick={(e) => {
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          className="invisible shrink-0 rounded p-0.5 text-ink-subtle hover:bg-black/10 group-hover:visible"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-2 top-7 z-10 w-32 rounded-md border border-black/10 bg-white py-1 text-[12px] shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => {
              setMenuOpen(false);
              onRename();
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-ink hover:bg-black/5"
          >
            <Pencil className="h-3.5 w-3.5" /> Rename
          </button>
          <button
            onClick={() => {
              setMenuOpen(false);
              onDelete();
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-red-600 hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </div>
      )}
    </li>
  );
}

/** Compact relative time. ≥1d: "3d"; ≥1h: "2h"; else "Nm" / "now". */
function relTime(iso: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.round(diff / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
