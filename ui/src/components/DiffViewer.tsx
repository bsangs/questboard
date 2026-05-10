"use client";

import clsx from "clsx";
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Folder,
  FolderOpen,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getDiff } from "@/lib/api";
import type { CardDiff } from "@/lib/types";

/**
 * GitHub-style diff viewer.
 *
 * Layout switches based on the component's measured width — not the
 * viewport's — because the drawer this lives in resizes independently
 * of `window.innerWidth`. A ResizeObserver tracks the container; when
 * width crosses SIDEBAR_BREAKPOINT we lay out as a 2-column grid with
 * a sticky folder-tree sidebar on the left and the diff column on the
 * right. Below the threshold we fall back to the original single
 * column so it stays readable in a narrow drawer.
 *
 * Per-file open/closed state lives up here in the parent (a single
 * `Set<string>` of closed keys, default empty = all open). That lets
 * the header's Expand-all / Collapse-all buttons drive every FileBlock
 * at once, and lets the sidebar's "jump to file" force-open a closed
 * file before scrolling so the user never lands on a collapsed shell.
 *
 * Coloring follows the unified-diff convention:
 *   - green:  addition
 *   - red:    deletion
 *   - blue:   hunk header
 *   - amber:  "\\ No newline at end of file" sentinel
 *   - gray:   context
 *
 * No syntax highlighting per language — we lean on plain monospace
 * with diff coloring (GitHub's "Unified" view). Adding shiki per-file
 * is a follow-up if needed.
 */

// Drawer chrome (px-6 padding = 48px each side, scrollbar ~12px, sidebar
// itself reserves ~220px) eats a chunk of the outer width, so the
// threshold is measured against the *content area* width we actually
// receive inside the drawer — not the drawer's outer width. 720px is
// comfortably reachable on a 1920px monitor with the resize handle.
const SIDEBAR_BREAKPOINT = 720;

interface ParsedFile {
  path: string;
  oldPath: string | null;
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  hunks: ParsedHunk[];
}

interface ParsedHunk {
  header: string;
  lines: ParsedLine[];
}

interface ParsedLine {
  marker: string; // "+" | "-" | " " | "\\"
  text: string;
  oldNo: number | null;
  newNo: number | null;
}

function parseDiff(raw: string): ParsedFile[] {
  if (!raw.trim()) return [];
  const lines = raw.split("\n");
  const files: ParsedFile[] = [];
  let curHunk: ParsedHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (m) {
        const a = m[1] ?? "";
        const b = m[2] ?? "";
        files.push({
          path: b !== "/dev/null" ? b : a,
          oldPath: a !== b ? a : null,
          status:
            a === "/dev/null"
              ? "added"
              : b === "/dev/null"
                ? "deleted"
                : a !== b
                  ? "renamed"
                  : "modified",
          binary: false,
          additions: 0,
          deletions: 0,
          hunks: [],
        });
        curHunk = null;
      }
      continue;
    }
    const cur = files[files.length - 1];
    if (!cur) continue;
    if (line.startsWith("similarity index ")) continue;
    if (line.startsWith("rename from ")) {
      cur.oldPath = line.slice("rename from ".length);
      cur.status = "renamed";
      continue;
    }
    if (line.startsWith("rename to ")) {
      cur.path = line.slice("rename to ".length);
      continue;
    }
    if (line.startsWith("new file mode")) {
      cur.status = "added";
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      cur.status = "deleted";
      continue;
    }
    if (line.startsWith("Binary files ")) {
      cur.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      const a = line.slice(4).replace(/^a\//, "");
      if (a !== "/dev/null") cur.oldPath = a;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const b = line.slice(4).replace(/^b\//, "");
      if (b !== "/dev/null") cur.path = b;
      continue;
    }
    const hh = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hh) {
      oldNo = Number(hh[1]);
      newNo = Number(hh[2]);
      curHunk = { header: line, lines: [] };
      cur.hunks.push(curHunk);
      continue;
    }
    if (!curHunk) continue;
    if (line.startsWith("\\ ")) {
      curHunk.lines.push({ marker: "\\", text: line, oldNo: null, newNo: null });
      continue;
    }
    if (line.startsWith("+")) {
      curHunk.lines.push({
        marker: "+",
        text: line.slice(1),
        oldNo: null,
        newNo: newNo++,
      });
      cur.additions++;
      continue;
    }
    if (line.startsWith("-")) {
      curHunk.lines.push({
        marker: "-",
        text: line.slice(1),
        oldNo: oldNo++,
        newNo: null,
      });
      cur.deletions++;
      continue;
    }
    if (line.startsWith(" ") || line === "") {
      curHunk.lines.push({
        marker: " ",
        text: line.length > 0 ? line.slice(1) : "",
        oldNo: oldNo++,
        newNo: newNo++,
      });
    }
  }
  return files;
}

function statusBadge(status: ParsedFile["status"]) {
  switch (status) {
    case "added":
      return { label: "added", className: "bg-emerald-100 text-emerald-800 ring-emerald-200" };
    case "deleted":
      return { label: "deleted", className: "bg-red-100 text-red-800 ring-red-200" };
    case "renamed":
      return { label: "renamed", className: "bg-blue-100 text-blue-800 ring-blue-200" };
    default:
      return { label: "modified", className: "bg-gray-100 text-gray-700 ring-gray-200" };
  }
}

function statusDotClass(status: ParsedFile["status"]): string {
  // Sidebar uses a tiny dot rather than a full badge — same palette,
  // less visual weight in the dense file list.
  switch (status) {
    case "added":
      return "bg-emerald-500";
    case "deleted":
      return "bg-red-500";
    case "renamed":
      return "bg-blue-500";
    default:
      return "bg-amber-500";
  }
}

// Stable identity that survives renames (oldPath != path) without
// colliding when two files happen to share a final path component.
function fileKey(f: ParsedFile): string {
  return (f.oldPath ?? "") + "→" + f.path;
}

export function DiffViewer({ cardId }: { cardId: string }) {
  const [diff, setDiff] = useState<CardDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        const d = await getDiff(cardId);
        if (alive) setDiff(d);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [cardId]);

  const files = useMemo(() => parseDiff(diff?.raw ?? ""), [diff?.raw]);
  const totals = useMemo(() => {
    let a = 0;
    let d = 0;
    for (const f of files) {
      a += f.additions;
      d += f.deletions;
    }
    return { a, d };
  }, [files]);

  // Closed = explicitly collapsed. Default empty so freshly-loaded
  // diffs render fully expanded — matches GitHub PR behavior and the
  // previous single-column layout.
  const [closed, setClosed] = useState<Set<string>>(new Set());

  // Reset collapse state whenever the underlying file list changes
  // (e.g. switching to a different card mid-session).
  useEffect(() => {
    setClosed(new Set());
  }, [cardId]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);

  // useLayoutEffect so the first paint has the correct width and we
  // avoid a flash of narrow → wide layout when the drawer mounts at
  // its full width.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Map of file key → DOM node, populated by FileBlock via a callback
  // ref. Used by jumpTo() to scroll the diff column to a sidebar pick.
  const fileRefs = useRef<Map<string, HTMLDivElement | null>>(new Map());
  const setFileRef = useCallback((key: string, el: HTMLDivElement | null) => {
    if (el) fileRefs.current.set(key, el);
    else fileRefs.current.delete(key);
  }, []);

  const toggleFile = useCallback((key: string) => {
    setClosed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => setClosed(new Set()), []);
  const collapseAll = useCallback(() => {
    setClosed(new Set(files.map(fileKey)));
  }, [files]);

  const jumpTo = useCallback((key: string) => {
    // If the target is collapsed, open it first. The body needs a
    // paint cycle to mount before scrollIntoView can land on the
    // right offset — hence the rAF deferral. Without it the scroll
    // would target the still-collapsed (header-only) height.
    setClosed((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    requestAnimationFrame(() => {
      const el = fileRefs.current.get(key);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const allOpen = closed.size === 0;
  const allClosed = files.length > 0 && closed.size === files.length;
  const showSidebar = width >= SIDEBAR_BREAKPOINT && files.length > 0;
  const showEmptySidebar = width >= SIDEBAR_BREAKPOINT && files.length === 0;

  // The ref MUST stay mounted across the loading / error / empty
  // branches — earlier this component returned different JSX trees
  // before the container existed, so the useLayoutEffect ran once with
  // ref=null and never observed the real node. Result: `width` stayed
  // at 0 forever and the sidebar never appeared regardless of how wide
  // the drawer was. Wrapping every branch in the same outer div fixes
  // it (the ref binds on the very first render).
  if (error) {
    return (
      <div ref={containerRef}>
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-[12.5px] text-red-800">
          Failed to load diff: {error}
        </div>
      </div>
    );
  }
  if (loading) {
    return (
      <div ref={containerRef}>
        <div className="rounded-md border border-black/5 bg-[var(--bg-muted)] p-3 text-[12.5px] text-ink-subtle">
          Loading diff…
        </div>
      </div>
    );
  }
  const emptyDiffMessage = (
    <div className="rounded-md border border-dashed border-black/10 bg-white p-6 text-center text-[12.5px] text-ink-subtle">
      No diff yet. The worker hasn&apos;t made any changes against{" "}
      <span className="font-mono">origin/main</span>.
    </div>
  );

  const header = (
    <div className="flex items-center justify-between rounded-md border border-black/5 bg-[var(--bg-muted)] px-3 py-2 text-[12px] text-ink-muted">
      <span>
        {files.length} file{files.length === 1 ? "" : "s"} changed
      </span>
      <div className="flex items-center gap-3">
        <span className="font-mono">
          <span className="text-emerald-700">+{totals.a}</span>{" "}
          <span className="text-red-700">−{totals.d}</span>
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={expandAll}
            disabled={allOpen}
            title="Expand all"
            className={clsx(
              "rounded p-1 transition-colors",
              allOpen
                ? "cursor-default text-ink-subtle/40"
                : "text-ink-subtle hover:bg-black/5 hover:text-ink",
            )}
          >
            <ChevronsUpDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={collapseAll}
            disabled={allClosed}
            title="Collapse all"
            className={clsx(
              "rounded p-1 transition-colors",
              allClosed
                ? "cursor-default text-ink-subtle/40"
                : "text-ink-subtle hover:bg-black/5 hover:text-ink",
            )}
          >
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );

  const fileColumn = files.length > 0 ? (
    <div className="space-y-3">
      {files.map((f) => {
        const key = fileKey(f);
        return (
          <FileBlock
            key={key}
            file={f}
            open={!closed.has(key)}
            onToggle={() => toggleFile(key)}
            anchorRef={(el) => setFileRef(key, el)}
          />
        );
      })}
    </div>
  ) : (
    emptyDiffMessage
  );

  return (
    <div ref={containerRef} className="space-y-3">
      {header}
      {showSidebar || showEmptySidebar ? (
        <div
          className="grid items-start gap-4"
          style={{ gridTemplateColumns: "minmax(200px, 280px) 1fr" }}
        >
          {showSidebar ? (
            <FileTreeSidebar files={files} onJump={jumpTo} />
          ) : (
            <EmptyFileTreeSidebar />
          )}
          <div className="min-w-0">{fileColumn}</div>
        </div>
      ) : (
        fileColumn
      )}
    </div>
  );
}

function FileBlock({
  file,
  open,
  onToggle,
  anchorRef,
}: {
  file: ParsedFile;
  open: boolean;
  onToggle: () => void;
  anchorRef: (el: HTMLDivElement | null) => void;
}) {
  const badge = statusBadge(file.status);
  return (
    <div
      ref={anchorRef}
      // scroll-mt keeps a hair of breathing room when jumpTo lands on
      // this block — without it the sticky drawer header would clip
      // the file's title bar.
      className="scroll-mt-2 overflow-hidden rounded-md border border-black/10 bg-white"
    >
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-2 border-b border-black/5 bg-[var(--bg-muted)] px-3 py-2 text-left hover:bg-black/5"
      >
        {open ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        )}
        <FileText className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        <span className="flex-1 truncate font-mono text-[12px] text-ink">
          {file.oldPath && file.oldPath !== file.path ? (
            <>
              <span className="text-ink-subtle">{file.oldPath}</span>{" "}
              <span className="text-ink-subtle">→</span> {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        <span
          className={clsx(
            "shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
            badge.className,
          )}
        >
          {badge.label}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ink-muted">
          <span className="text-emerald-700">+{file.additions}</span>{" "}
          <span className="text-red-700">−{file.deletions}</span>
        </span>
      </button>
      {open &&
        (file.binary ? (
          <div className="px-3 py-3 text-[12px] italic text-ink-subtle">
            Binary file
          </div>
        ) : file.hunks.length === 0 ? (
          <div className="px-3 py-3 text-[12px] italic text-ink-subtle">
            No textual changes (mode / metadata only)
          </div>
        ) : (
          <table className="w-full border-collapse font-mono text-[12px] leading-[1.45]">
            <tbody>
              {file.hunks.map((h, hi) => (
                <Hunk key={hi} hunk={h} />
              ))}
            </tbody>
          </table>
        ))}
    </div>
  );
}

function Hunk({ hunk }: { hunk: ParsedHunk }) {
  return (
    <>
      <tr className="bg-blue-50/60">
        <td colSpan={3} className="px-3 py-1 text-[11.5px] text-blue-700">
          {hunk.header}
        </td>
      </tr>
      {hunk.lines.map((ln, i) => (
        <DiffLine key={i} line={ln} />
      ))}
    </>
  );
}

function DiffLine({ line }: { line: ParsedLine }) {
  const isAdd = line.marker === "+";
  const isDel = line.marker === "-";
  const isNoNl = line.marker === "\\";
  return (
    <tr
      className={clsx(
        isAdd && "bg-emerald-50",
        isDel && "bg-red-50",
        isNoNl && "bg-amber-50",
      )}
    >
      <td
        className={clsx(
          "select-none border-r border-black/5 px-2 py-px text-right align-top text-[10.5px] tabular-nums",
          isAdd ? "text-emerald-700" : isDel ? "text-red-700" : "text-ink-subtle",
        )}
        style={{ width: "1%", minWidth: 36 }}
      >
        {line.oldNo ?? ""}
      </td>
      <td
        className={clsx(
          "select-none border-r border-black/5 px-2 py-px text-right align-top text-[10.5px] tabular-nums",
          isAdd ? "text-emerald-700" : isDel ? "text-red-700" : "text-ink-subtle",
        )}
        style={{ width: "1%", minWidth: 36 }}
      >
        {line.newNo ?? ""}
      </td>
      <td
        className={clsx(
          "whitespace-pre-wrap break-all px-3 py-px",
          isAdd && "text-emerald-900",
          isDel && "text-red-900",
          isNoNl && "italic text-amber-800",
        )}
      >
        {(isAdd || isDel ? line.marker : " ") + line.text}
      </td>
    </tr>
  );
}

// --- Sidebar / folder tree -------------------------------------------------

type DirNode = {
  kind: "dir";
  name: string;
  path: string;
  children: TreeNode[];
};
type FileNode = {
  kind: "file";
  name: string;
  file: ParsedFile;
};
type TreeNode = DirNode | FileNode;

function buildTree(files: ParsedFile[]): DirNode {
  const root: DirNode = { kind: "dir", name: "", path: "", children: [] };
  for (const f of files) {
    const parts = f.path.split("/");
    let cur: DirNode = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i] ?? "";
      const path = parts.slice(0, i + 1).join("/");
      // Reuse an existing dir child if we've already seen this prefix,
      // otherwise create one. `?? []` patterns elsewhere in this file
      // guard against undefined; here we maintain the invariant that
      // every dir's `children` is initialized at construction time.
      let child = cur.children.find(
        (c): c is DirNode => c.kind === "dir" && c.name === name,
      );
      if (!child) {
        child = { kind: "dir", name, path, children: [] };
        cur.children.push(child);
      }
      cur = child;
    }
    const fname = parts[parts.length - 1] ?? f.path;
    cur.children.push({ kind: "file", name: fname, file: f });
  }
  // Sort: directories before files, then alphabetical within each
  // group. Matches GitHub's tree ordering and keeps the eye scanning
  // top-down for structure first, leaves second.
  const sortDir = (n: DirNode) => {
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const c of n.children) {
      if (c.kind === "dir") sortDir(c);
    }
  };
  sortDir(root);
  return root;
}

function FileTreeSidebar({
  files,
  onJump,
}: {
  files: ParsedFile[];
  onJump: (key: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  return (
    <aside className="sticky top-0 max-h-[calc(100vh-12rem)] overflow-y-auto rounded-md border border-black/10 bg-white">
      <div className="sticky top-0 border-b border-black/5 bg-[var(--bg-muted)] px-3 py-2 text-[10.5px] font-medium uppercase tracking-wider text-ink-subtle">
        Files
      </div>
      <div className="py-1">
        {tree.children.map((c) => (
          <TreeRow
            key={c.kind === "dir" ? "d:" + c.path : "f:" + fileKey(c.file)}
            node={c}
            depth={0}
            onJump={onJump}
          />
        ))}
      </div>
    </aside>
  );
}

function EmptyFileTreeSidebar() {
  return (
    <aside className="sticky top-0 max-h-[calc(100vh-12rem)] overflow-y-auto rounded-md border border-black/10 bg-white">
      <div className="sticky top-0 border-b border-black/5 bg-[var(--bg-muted)] px-3 py-2 text-[10.5px] font-medium uppercase tracking-wider text-ink-subtle">
        Files
      </div>
      <div className="px-3 py-3 text-[12px] italic text-ink-subtle">
        no changed files
      </div>
    </aside>
  );
}

function TreeRow({
  node,
  depth,
  onJump,
}: {
  node: TreeNode;
  depth: number;
  onJump: (key: string) => void;
}) {
  if (node.kind === "file") {
    return <FileRow file={node.file} name={node.name} depth={depth} onJump={onJump} />;
  }
  return <DirRow node={node} depth={depth} onJump={onJump} />;
}

function DirRow({
  node,
  depth,
  onJump,
}: {
  node: DirNode;
  depth: number;
  onJump: (key: string) => void;
}) {
  // GitHub-style single-child collapse: walk down through any chain of
  // directories where each has exactly one child that is itself a
  // directory, and render the joined name (`a/b/c`) as one row. Saves
  // horizontal space on deeply-nested generated paths and matches the
  // user's mental model of "this whole chain is just a wrapper".
  const segments: string[] = [node.name];
  let terminal: DirNode = node;
  while (
    terminal.children.length === 1 &&
    terminal.children[0]?.kind === "dir"
  ) {
    terminal = terminal.children[0] as DirNode;
    segments.push(terminal.name);
  }

  // Default closed — GitHub-style. User clicks chevrons to drill in.
  // Top-level (depth 0) starts open so the first level of paths is
  // visible without an extra click; deeper directories stay collapsed.
  const [open, setOpen] = useState(depth === 0);
  // Indent in increments of 12px per level. Tailwind's spacing scale
  // tops out before we'd need it for arbitrary depth, so use inline
  // style with a CSS calc to keep alignment predictable.
  const indent = depth * 12;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] text-ink hover:bg-black/5"
        style={{ paddingLeft: indent + 8 }}
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-ink-subtle" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-ink-subtle" />
        )}
        {open ? (
          <FolderOpen className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        ) : (
          <Folder className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
        )}
        <span className="truncate font-mono text-[11.5px] text-ink-muted">
          {segments.join("/")}
        </span>
      </button>
      {open &&
        terminal.children.map((c) => (
          <TreeRow
            key={c.kind === "dir" ? "d:" + c.path : "f:" + fileKey(c.file)}
            node={c}
            depth={depth + 1}
            onJump={onJump}
          />
        ))}
    </>
  );
}

function FileRow({
  file,
  name,
  depth,
  onJump,
}: {
  file: ParsedFile;
  name: string;
  depth: number;
  onJump: (key: string) => void;
}) {
  const indent = depth * 12;
  const key = fileKey(file);
  return (
    <button
      type="button"
      onClick={() => onJump(key)}
      className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[12px] hover:bg-black/5"
      style={{ paddingLeft: indent + 8 }}
      title={file.path}
    >
      <span
        className={clsx(
          "h-1.5 w-1.5 shrink-0 rounded-full",
          statusDotClass(file.status),
        )}
      />
      <FileText className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
      <span className="flex-1 truncate font-mono text-[11.5px] text-ink">
        {name}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] text-ink-muted">
        <span className="text-emerald-700">+{file.additions}</span>
        <span className="px-0.5">/</span>
        <span className="text-red-700">−{file.deletions}</span>
      </span>
    </button>
  );
}
