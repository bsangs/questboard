"use client";
/**
 * Floating dropdown shown above the Composer textarea while the user
 * is typing a `#` (card) or `@` (file) mention. Driven by props from
 * `Input.tsx`; this component owns the mode-specific data fetch and
 * presentation, while Input.tsx owns the trigger detection, the
 * highlighted-index keystrokes, and inserting the chosen item.
 *
 * Two render modes via `kind`:
 *
 *  - `"card"`  → list cards by id-prefix or title substring. Selecting
 *                inserts `@card-<id> ` (server token format) and closes.
 *
 *  - `"file"`  → navigable file/folder picker rooted at the thread's
 *                cwd (or BOARD_ROOT). Folders are listed first; clicking
 *                a folder narrows the listing to its contents (does NOT
 *                insert), clicking a file inserts `@<relpath> ` and
 *                closes. The user's typed query filters the entries at
 *                the current path only — non-recursive on purpose to
 *                stay fast on big repos.
 *
 * The discriminated `MentionItem` union exposes a `navigate: true` flag
 * for directory entries so Input.tsx can treat Enter-on-dir as a path
 * change instead of an insertion. Files and cards both have `insert`
 * strings; dirs do not.
 */
import clsx from "clsx";
import { ChevronRight, FileText, Folder, Hash, Home } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { listFiles, type FileListEntry } from "@/lib/api";
import { useBoard } from "@/lib/state";

export type MentionItem =
  | { kind: "card"; id: string; title: string; insert: string }
  | { kind: "file"; relpath: string; insert: string }
  | { kind: "dir"; relpath: string; name: string; navigate: true };

export type MentionKind = "card" | "file";

interface Props {
  /** Which trigger fired — `#` for cards, `@` for files. */
  kind: MentionKind;
  /** Substring after the trigger char, no prefix. */
  query: string;
  /** Currently-highlighted index — Input owns this (arrow keys). */
  selectedIndex: number;
  /** Notify Input how many items there are so it can clamp arrows. */
  onItemsChange: (items: MentionItem[]) => void;
  /** User clicked an item (Enter / mouse). Files / cards arrive here for
   *  insertion; dirs are intercepted before getting here (consumed via
   *  `onNavigate` instead). */
  onSelect: (item: MentionItem) => void;
  /** File mode only: the dropdown wants to change directories. Input
   *  responds by clearing the query portion of the textarea so the
   *  next keystrokes filter the new directory. */
  onNavigate?: (relpath: string) => void;
  /** Initial path for file mode. Usually the thread's cwd. Empty = root. */
  initialPath?: string | null;
}

const MAX_RESULTS = 12;

export function ComposerMentionAutocomplete({
  kind,
  query,
  selectedIndex,
  onItemsChange,
  onSelect,
  onNavigate,
  initialPath,
}: Props) {
  if (kind === "card") {
    return (
      <CardMode
        query={query}
        selectedIndex={selectedIndex}
        onItemsChange={onItemsChange}
        onSelect={onSelect}
      />
    );
  }
  return (
    <FileMode
      query={query}
      selectedIndex={selectedIndex}
      onItemsChange={onItemsChange}
      onSelect={onSelect}
      onNavigate={onNavigate}
      initialPath={initialPath ?? ""}
    />
  );
}

// ─── Card mode ───────────────────────────────────────────────────────────────

function CardMode({
  query,
  selectedIndex,
  onItemsChange,
  onSelect,
}: {
  query: string;
  selectedIndex: number;
  onItemsChange: (items: MentionItem[]) => void;
  onSelect: (item: MentionItem) => void;
}) {
  // Cards live in store; we just slice + filter.
  const cards = useBoard((s) => s.cards);

  const items = useMemo<MentionItem[]>(() => {
    const q = query.trim().toLowerCase();
    return Object.values(cards)
      .filter((c) => {
        if (!q) return true;
        // Allow `card-0091` and bare `0091` — strip both prefixes.
        const idQ = q.replace(/^card-/, "");
        if (c.id.startsWith(idQ)) return true;
        return c.title.toLowerCase().includes(q);
      })
      // Stable sort: id ascending. The board already keeps a sensible
      // order; dropdowns work best when consecutive opens look the same.
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, MAX_RESULTS)
      .map<MentionItem>((c) => ({
        kind: "card",
        id: c.id,
        title: c.title,
        // The server expects `@card-<id>` for resolution. We trigger on
        // `#` for the human-friendly UX but emit the canonical token.
        insert: `@card-${c.id} `,
      }));
  }, [cards, query]);

  usePushItems(items, onItemsChange);

  if (items.length === 0) {
    return (
      <Shell>
        <div className="px-2.5 py-2 text-[12px] text-ink-subtle">
          No cards match{" "}
          <span className="font-mono">#{query || "…"}</span>.
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div role="listbox">
        {items.map((it, i) => (
          <MentionRow
            key={`c:${it.kind === "card" ? it.id : ""}`}
            item={it}
            active={i === selectedIndex}
            onClick={() => onSelect(it)}
          />
        ))}
      </div>
    </Shell>
  );
}

// ─── File mode ───────────────────────────────────────────────────────────────

function FileMode({
  query,
  selectedIndex,
  onItemsChange,
  onSelect,
  onNavigate,
  initialPath,
}: {
  query: string;
  selectedIndex: number;
  onItemsChange: (items: MentionItem[]) => void;
  onSelect: (item: MentionItem) => void;
  onNavigate?: (relpath: string) => void;
  initialPath: string;
}) {
  // Current dir we're showing (relative to BOARD_ROOT, POSIX, no
  // leading / trailing slashes).
  const [path, setPath] = useState<string>(normalizePath(initialPath));
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pushToast = useBoard((s) => s.pushToast);

  // Track the last fetched path so race conditions don't render stale
  // entries when the user clicks fast through nested folders.
  const reqIdRef = useRef(0);

  // Path-aware query split: when the user types a query that contains
  // `/`, treat everything before the LAST slash as additional path
  // segments to descend into (relative to the current `path`), and the
  // suffix as the filename filter at that resolved path. This lets the
  // user paste / type a deep relpath like
  //   design-system/docs/plans/0090-foo.md
  // and land on the right entry without manually clicking through every
  // intermediate folder. The committed `path` state stays unchanged so
  // explicit clicks still anchor the breadcrumb.
  const { effectivePath, effectiveQuery } = useMemo(() => {
    const q = query;
    if (!q.includes("/")) {
      return { effectivePath: path, effectiveQuery: q.trim() };
    }
    const lastSlash = q.lastIndexOf("/");
    const pathPart = q.slice(0, lastSlash);
    const filterPart = q.slice(lastSlash + 1);
    const combined = path ? `${path}/${pathPart}` : pathPart;
    return {
      effectivePath: normalizePath(combined),
      effectiveQuery: filterPart.trim(),
    };
  }, [query, path]);

  useEffect(() => {
    const myReq = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    listFiles({ path: effectivePath, q: effectiveQuery || undefined, limit: 200 })
      .then((res) => {
        if (reqIdRef.current !== myReq) return;
        setEntries(res.entries);
        setLoading(false);
      })
      .catch((err) => {
        if (reqIdRef.current !== myReq) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setEntries([]);
        setLoading(false);
        // Don't toast on 404 (user typed past a real folder) — only
        // unexpected errors. ApiError carries `.status`.
        const status = (err as { status?: number }).status;
        if (status && status !== 404 && status !== 400) {
          pushToast({ kind: "error", message: msg });
        }
      });
  }, [effectivePath, effectiveQuery, pushToast]);

  const items = useMemo<MentionItem[]>(() => {
    return entries.slice(0, MAX_RESULTS).map<MentionItem>((e) => {
      if (e.kind === "dir") {
        return {
          kind: "dir",
          relpath: e.relpath,
          name: e.name,
          navigate: true,
        };
      }
      return {
        kind: "file",
        relpath: e.relpath,
        // Insert as `@<relpath> ` so the server (and future mention
        // resolvers) can pick it up as a single token.
        insert: `@${e.relpath} `,
      };
    });
  }, [entries]);

  usePushItems(items, onItemsChange);

  // Centralized navigation: reset filter state, tell Input to clear
  // the typed query so the next keystrokes filter the new directory.
  const navigateTo = useCallback(
    (next: string) => {
      setPath(normalizePath(next));
      onNavigate?.(normalizePath(next));
    },
    [onNavigate],
  );

  // Wrap onSelect so dir clicks are consumed locally (navigation) and
  // file/card clicks bubble out for insertion.
  const handleSelect = useCallback(
    (item: MentionItem) => {
      if (item.kind === "dir") {
        navigateTo(item.relpath);
        return;
      }
      onSelect(item);
    },
    [navigateTo, onSelect],
  );

  // Expose the live navigate callback for Enter-on-dir from Input's
  // keyboard handler. The dropdown is a singleton (one mounted at a
  // time), so this module-level ref is safe.
  useEffect(() => {
    fileModeNavigateRef.current = (item) => handleSelect(item);
    fileModeUpRef.current = () => {
      // "Up one level" = drop the last segment of the current path.
      const parent = path.includes("/")
        ? path.slice(0, path.lastIndexOf("/"))
        : "";
      navigateTo(parent);
    };
    return () => {
      fileModeNavigateRef.current = null;
      fileModeUpRef.current = null;
    };
  }, [handleSelect, navigateTo, path]);

  return (
    <Shell>
      <Breadcrumb path={effectivePath} onJump={navigateTo} />
      <div role="listbox" className="max-h-56 overflow-auto">
        {loading && entries.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-ink-subtle">Loading…</div>
        ) : error ? (
          <div className="px-2.5 py-2 text-[12px] text-red-600">
            {error}
          </div>
        ) : items.length === 0 ? (
          <div className="px-2.5 py-2 text-[12px] text-ink-subtle">
            No matches
            {effectiveQuery ? (
              <> for <span className="font-mono">{effectiveQuery}</span></>
            ) : null}{" "}
            in <span className="font-mono">/{effectivePath}</span>.
          </div>
        ) : (
          items.map((it, i) => (
            <MentionRow
              key={mentionKey(it)}
              item={it}
              active={i === selectedIndex}
              onClick={() => handleSelect(it)}
            />
          ))
        )}
      </div>
      <div className="border-t border-black/5 px-2.5 py-1.5 text-[10.5px] text-ink-subtle">
        ↵ to {items[selectedIndex]?.kind === "dir" ? "open folder" : "insert"} ·
        ⎋ to close
      </div>
    </Shell>
  );
}

/**
 * Imperative bridge: Input.tsx calls `onSelect(item)` for whatever the
 * highlighted row is. When file mode is active and the item is a dir,
 * Input wants navigation, not insertion. We expose the live navigate
 * callback through a module-level ref so the parent's insert path can
 * delegate without prop drilling.
 *
 * This is safe because the dropdown is a singleton (one mounted at a
 * time); two simultaneous file dropdowns would clobber the ref but
 * that's not something the UI ever does.
 */
export const fileModeNavigateRef: { current: ((item: MentionItem) => void) | null } = {
  current: null,
};

/** Module ref: ask the live FileMode dropdown to go up one directory.
 *  Wired by Input's Backspace-at-empty-query handler. Same singleton
 *  contract as `fileModeNavigateRef`. */
export const fileModeUpRef: { current: (() => void) | null } = {
  current: null,
};

// ─── Shared bits ─────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute bottom-full left-0 right-0 mb-1 overflow-hidden rounded-md border border-black/10 bg-white shadow-md">
      {children}
    </div>
  );
}

function Breadcrumb({
  path,
  onJump,
}: {
  path: string;
  onJump: (p: string) => void;
}) {
  // Build clickable segments: Home (root), then each directory on the
  // way down. Clicking a segment jumps directly there.
  const segs = path ? path.split("/") : [];
  return (
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-black/5 px-2 py-1.5 text-[11.5px] text-ink-muted">
      <button
        type="button"
        onMouseDown={(e) => {
          e.preventDefault();
          onJump("");
        }}
        className={clsx(
          "inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-black/5",
          path === "" && "font-medium text-ink",
        )}
        title="Project root"
      >
        <Home className="h-3 w-3" /> root
      </button>
      {segs.map((s, i) => {
        const upTo = segs.slice(0, i + 1).join("/");
        const isLast = i === segs.length - 1;
        return (
          <span key={upTo} className="inline-flex items-center gap-0.5">
            <ChevronRight className="h-3 w-3 text-ink-subtle/60" />
            <button
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onJump(upTo);
              }}
              className={clsx(
                "max-w-[120px] truncate rounded px-1 py-0.5 hover:bg-black/5",
                isLast && "font-medium text-ink",
              )}
              title={upTo}
            >
              {s}
            </button>
          </span>
        );
      })}
    </div>
  );
}

function MentionRow({
  item,
  active,
  onClick,
}: {
  item: MentionItem;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onMouseDown={(e) => {
        // Don't steal focus from the textarea — losing focus would
        // strand the partial mention token mid-edit.
        e.preventDefault();
        onClick();
      }}
      className={clsx(
        "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px]",
        active ? "bg-blue-50 text-ink" : "text-ink hover:bg-gray-50",
      )}
    >
      {item.kind === "card" ? (
        <>
          <Hash className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
          <span className="font-mono text-[11px] text-ink-muted">
            {item.id}
          </span>
          <span className="min-w-0 flex-1 truncate">{item.title}</span>
        </>
      ) : item.kind === "dir" ? (
        <>
          <Folder className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
            {item.name}/
          </span>
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-subtle" />
        </>
      ) : (
        <>
          <FileText className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
            {item.relpath}
          </span>
        </>
      )}
    </button>
  );
}

function mentionKey(it: MentionItem): string {
  if (it.kind === "card") return `c:${it.id}`;
  if (it.kind === "dir") return `d:${it.relpath}`;
  return `f:${it.relpath}`;
}

function sameItems(a: MentionItem[], b: MentionItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (mentionKey(a[i]) !== mentionKey(b[i])) return false;
  }
  return true;
}

/** Push items up to Input via `onItemsChange` only when they actually
 *  change — this avoids re-firing on every keystroke when the
 *  underlying card/file list is stable. */
function usePushItems(
  items: MentionItem[],
  onItemsChange: (items: MentionItem[]) => void,
): void {
  const lastRef = useRef<MentionItem[]>([]);
  useEffect(() => {
    if (sameItems(items, lastRef.current)) return;
    lastRef.current = items;
    onItemsChange(items);
  }, [items, onItemsChange]);
}

function normalizePath(p: string | null | undefined): string {
  if (!p) return "";
  return p.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}
