"use client";
/**
 * Composer input — auto-grow textarea, send button, stop button while
 * a process is streaming, mention autocomplete (`@` files / `#` cards),
 * and paste / drop / pick image attachments that actually upload.
 *
 * Mention autocomplete:
 *   - `@` triggers the file-tree picker rooted at the thread's cwd (or
 *     BOARD_ROOT). Users navigate folders by clicking; selecting a file
 *     inserts `@<relpath> ` into the textarea.
 *   - `#` triggers the card picker (id-prefix or title substring).
 *     Selecting inserts `@card-<id> ` — the canonical token the server
 *     resolver expects. We trigger on `#` for the human-friendly UX
 *     while keeping the wire format stable.
 *
 * Image attach:
 *   Replaces the v1 "insert filename token" hack. Paste, drop, or
 *   click-to-pick uploads via `useAttachableTextarea` → for an existing
 *   thread the file goes straight to that thread's attachments dir;
 *   for a draft (no thread yet) it goes into the upload pool, and on
 *   first send we promote the pool to the freshly-created thread so
 *   `attachments/foo.png` resolves correctly.
 */
import clsx from "clsx";
import { ImagePlus, Send, Square } from "lucide-react";
import {
  KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  attachToComposer,
  promoteUploadPoolToComposer,
  useAttachableTextarea,
} from "@/lib/attach";
import {
  createComposerThread,
  getComposerThread,
  sendComposerMessage,
  stopComposerThread,
} from "@/lib/composer";
import { useBoard } from "@/lib/state";
import {
  ComposerMentionAutocomplete,
  fileModeNavigateRef,
  fileModeUpRef,
  type MentionItem,
  type MentionKind,
} from "./MentionAutocomplete";
import { MentionHighlightOverlay } from "./MentionHighlight";

interface Props {
  /**
   * `null` = draft mode: the first send promotes the client-only draft
   * into a persisted thread via POST /api/composer/threads with the
   * typed text as `initial_message`. From the second message onward
   * Input is mounted with the real id and behaves normally.
   */
  threadId: string | null;
}

const MAX_TEXTAREA_LINES = 10;
/** Approximate single-line height matching `text-[13px] leading-relaxed`. */
const LINE_HEIGHT_PX = 20;

export function ComposerInput({ threadId }: Props) {
  const active = useBoard((s) => s.composerActive);
  const draft = useBoard((s) => s.composerDraft);
  const setComposerActive = useBoard((s) => s.setComposerActive);
  const upsertComposerThread = useBoard((s) => s.upsertComposerThread);
  const pushToast = useBoard((s) => s.pushToast);

  const isDraft = threadId === null;

  // Disable send while:
  //  (a) any pending tool gate is open for THIS thread (force resolve first), or
  //  (b) status is `awaiting` (server says we're mid-decision)
  // Draft mode never has pending/awaiting — there's no server thread
  // yet, so the input is always sendable when non-empty.
  const pendingCount =
    !isDraft && active?.id === threadId ? active.pending.length : 0;
  const status =
    !isDraft && active?.id === threadId ? active.status : "idle";
  const sendDisabled = pendingCount > 0 || status === "awaiting";
  const showStop = status === "running";

  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  // Track textarea scrollTop so the highlight overlay can mirror it.
  // Updated via the textarea's onScroll handler — the mirror has
  // overflow:hidden, so we translate its content rather than scroll it.
  const [scrollTop, setScrollTop] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // Track current value via ref so the upload hook's async callbacks
  // don't capture a stale snapshot.
  const valueRef = useRef(value);
  valueRef.current = value;

  // Mention autocomplete state. We track the trigger char's position so
  // on select we can splice the chosen token over the partial query.
  const [mentionAnchor, setMentionAnchor] = useState<{
    /** Index of the trigger char (`@` or `#`) in `value`. */
    start: number;
    /** Which trigger fired — drives the dropdown's mode. */
    kind: MentionKind;
  } | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionItemsRef = useRef<MentionItem[]>([]);

  // Upload-pool token: minted on first attachment in draft mode, kept
  // stable across the input's lifetime so paste-paste-paste accumulates
  // into one pool dir. On send-as-first-message we promote the pool to
  // the created thread so `attachments/foo` resolves correctly.
  const [uploadPoolToken, setUploadPoolToken] = useState<string | null>(null);
  const uploadPoolTokenRef = useRef<string | null>(null);
  uploadPoolTokenRef.current = uploadPoolToken;

  /** Re-measure the textarea on every change. */
  const autoresize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const max = LINE_HEIGHT_PX * MAX_TEXTAREA_LINES + 16; // padding budget
    ta.style.height = `${Math.min(ta.scrollHeight, max)}px`;
    ta.style.overflowY = ta.scrollHeight > max ? "auto" : "hidden";
  }, []);

  useEffect(() => {
    autoresize();
  }, [value, autoresize]);

  /**
   * Rescan `value` around the caret to decide whether the user is mid
   * mention. The most recent `@` or `#` before the cursor counts only
   * if (a) it has no whitespace between it and the cursor and (b) it
   * sits at start-of-string or is preceded by whitespace, so we don't
   * fire inside emails (`a@b.com`) or hex literals (`#fff`).
   */
  const updateMentionState = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const caret = ta.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const lastAt = before.lastIndexOf("@");
    const lastHash = before.lastIndexOf("#");
    // Pick whichever trigger sits later in the string — they're
    // mutually exclusive within one mention.
    const at = Math.max(lastAt, lastHash);
    if (at < 0) {
      setMentionAnchor(null);
      return;
    }
    const kind: MentionKind = at === lastAt ? "file" : "card";
    const tail = before.slice(at + 1);
    if (/\s/.test(tail)) {
      // whitespace landed — user has moved past the mention.
      setMentionAnchor(null);
      return;
    }
    const charBefore = at === 0 ? "" : before[at - 1];
    if (charBefore && !/\s/.test(charBefore)) {
      // mid-word trigger (email, hex color, etc.) — not a mention.
      setMentionAnchor(null);
      return;
    }
    setMentionAnchor((prev) =>
      prev && prev.start === at && prev.kind === kind
        ? prev
        : { start: at, kind },
    );
    setMentionQuery(tail);
    setMentionIndex(0);
  }, [value]);

  const onChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    // Defer mention scan one frame so selectionStart is up-to-date.
    queueMicrotask(updateMentionState);
  };

  /**
   * File-mode navigation hook. The dropdown asked us to change dirs;
   * we clear whatever the user typed after the trigger char so the
   * next keystrokes filter the new directory cleanly. We don't
   * insert the path into the textarea — the user can keep navigating
   * or eventually pick a file (which inserts the full relpath).
   */
  const onMentionNavigate = useCallback(
    (_relpath: string) => {
      if (!mentionAnchor) return;
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? value.length;
      const before = value.slice(0, mentionAnchor.start + 1); // keep `@`
      const after = value.slice(caret);
      const next = `${before}${after}`;
      setValue(next);
      setMentionQuery("");
      // Restore caret right after the trigger char.
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        const pos = mentionAnchor.start + 1;
        t.focus();
        t.setSelectionRange(pos, pos);
      });
    },
    [mentionAnchor, value],
  );

  const insertMention = useCallback(
    (item: MentionItem) => {
      if (!mentionAnchor) return;
      // Dirs don't insert — they navigate the file dropdown. Defer to
      // the dropdown's own handler via the module-level ref bridge.
      if (item.kind === "dir") {
        fileModeNavigateRef.current?.(item);
        return;
      }
      const ta = textareaRef.current;
      const caret = ta?.selectionStart ?? value.length;
      const before = value.slice(0, mentionAnchor.start);
      const after = value.slice(caret);
      const next = `${before}${item.insert}${after}`;
      setValue(next);
      setMentionAnchor(null);
      // Restore caret to right after the inserted token.
      requestAnimationFrame(() => {
        const t = textareaRef.current;
        if (!t) return;
        const pos = before.length + item.insert.length;
        t.focus();
        t.setSelectionRange(pos, pos);
      });
    },
    [mentionAnchor, value],
  );

  const onSend = useCallback(async () => {
    if (sendDisabled || busy) return;
    const text = valueRef.current.trim();
    if (!text) return;
    setBusy(true);
    try {
      if (isDraft) {
        // First send for a draft = create the persisted thread with the
        // typed text as `initial_message` (server normalizes this into
        // the first user message). Then refetch the full thread so the
        // chat surface gets the canonical transcript + status, and swap
        // it into `composerActive`.
        const { thread_id } = await createComposerThread({
          cwd: draft?.cwd ?? null,
          initial_message: text,
        });
        // Promote any pool uploads BEFORE rendering the message so the
        // markdown image refs resolve on first paint. Failure here is
        // surfaced but not fatal — the user can re-attach.
        const tok = uploadPoolTokenRef.current;
        if (tok) {
          try {
            await promoteUploadPoolToComposer(tok, thread_id);
          } catch (err) {
            pushToast({
              kind: "error",
              message:
                "Created thread, but couldn't move pasted images: " +
                (err instanceof Error ? err.message : String(err)),
            });
          }
          setUploadPoolToken(null);
          uploadPoolTokenRef.current = null;
        }
        const full = await getComposerThread(thread_id);
        upsertComposerThread({
          id: full.id,
          title: full.title,
          created_at: full.created_at,
          updated_at: full.updated_at,
          message_count: full.message_count,
          input_tokens: full.input_tokens,
          output_tokens: full.output_tokens,
          cwd: full.cwd,
          status: full.status,
          outcome: full.outcome,
          archived: full.archived,
          session_id: full.session_id,
          behind_main: full.behind_main,
        });
        setComposerActive(full);
      } else {
        await sendComposerMessage(threadId, text);
      }
      setValue("");
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    draft,
    isDraft,
    pushToast,
    sendDisabled,
    setComposerActive,
    threadId,
    upsertComposerThread,
  ]);

  const onStop = useCallback(async () => {
    if (!threadId) return;
    try {
      await stopComposerThread(threadId);
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [pushToast, threadId]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // ── Mention dropdown wiring ────────────────────────────────────
    if (mentionAnchor) {
      const items = mentionItemsRef.current;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionIndex((i) => Math.min(items.length - 1, i + 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMentionAnchor(null);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        if (items.length > 0) {
          e.preventDefault();
          insertMention(items[mentionIndex] ?? items[0]);
          return;
        }
      }
      // Backspace at empty query in file mode → go up one directory
      // instead of deleting the trigger char.
      if (
        e.key === "Backspace" &&
        mentionAnchor.kind === "file" &&
        mentionQuery === "" &&
        fileModeUpRef.current
      ) {
        e.preventDefault();
        fileModeUpRef.current();
        return;
      }
    }

    // ── Send (Enter without shift) ─────────────────────────────────
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void onSend();
    }
  };

  // ── Real attachment upload ────────────────────────────────────────
  // The uploader closure is stable across renders via refs so the hook
  // doesn't tear down its listeners on every keystroke.
  const uploadAttachment = useCallback(
    async (file: File): Promise<string> => {
      const r = await attachToComposer(
        threadId,
        file,
        uploadPoolTokenRef.current,
      );
      // Draft mode: server mints a pool token on the first upload and
      // we reuse it for subsequent uploads in the same draft session.
      if (!threadId && r.token && !uploadPoolTokenRef.current) {
        uploadPoolTokenRef.current = r.token;
        setUploadPoolToken(r.token);
      }
      return r.markdown;
    },
    [threadId],
  );

  const { onPaste, onDrop, onDragOver, pickFile, fileInputProps } =
    useAttachableTextarea(textareaRef, {
      upload: uploadAttachment,
      onError: (err) =>
        pushToast({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      getValue: () => valueRef.current,
      onValueChange: (next) => setValue(next),
      disabled: sendDisabled,
    });

  // Memoize to keep MentionAutocomplete from re-running its effect on
  // every keystroke when the items list is stable.
  const handleMentionItems = useMemo(
    () => (items: MentionItem[]) => {
      mentionItemsRef.current = items;
      // Clamp the highlighted index when the items list shrinks past it.
      setMentionIndex((i) => (i >= items.length ? 0 : i));
    },
    [],
  );

  // For file-mode initial path, prefer the active thread's cwd → draft
  // cwd → BOARD_ROOT (empty string). Recomputed cheaply on each render.
  const initialFilePath =
    (active?.id === threadId ? active?.cwd : null) ?? draft?.cwd ?? "";

  return (
    <div className="relative">
      {mentionAnchor && (
        <ComposerMentionAutocomplete
          kind={mentionAnchor.kind}
          query={mentionQuery}
          selectedIndex={mentionIndex}
          onItemsChange={handleMentionItems}
          onSelect={insertMention}
          onNavigate={onMentionNavigate}
          initialPath={initialFilePath}
        />
      )}

      <div
        className={clsx(
          "flex items-end gap-2 rounded-md border bg-white px-2.5 py-2 transition-colors",
          sendDisabled
            ? "border-amber-200 bg-amber-50/40"
            : "border-black/10 focus-within:border-ink",
        )}
      >
        {/*
          Mention highlight: a layered mirror div renders styled tokens
          underneath the textarea, while the textarea itself paints its
          own text transparent (caret stays visible via `caret-ink`).
          The wrapper is the flex child (was `flex-1` on the textarea);
          textarea + overlay sit absolute/relative inside it and share
          identical text metrics so glyph positions agree exactly.
        */}
        <div className="relative flex-1">
          <MentionHighlightOverlay value={value} scrollTop={scrollTop} />
          <textarea
            ref={textareaRef}
            value={value}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onClick={updateMentionState}
            onKeyUp={updateMentionState}
            onPaste={onPaste}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
            rows={1}
            placeholder={
              sendDisabled
                ? "Resolve the pending decision above to continue…"
                : "Message Composer · @ for files · # for cards · ↵ to send · ⇧↵ for newline"
            }
            disabled={sendDisabled}
            // text-transparent + caret-ink: hide our own glyphs (the
            // overlay paints them) while keeping the caret visible.
            // overflow-wrap:anywhere matches the overlay's wrap rule.
            className="relative block min-h-[24px] w-full resize-none bg-transparent text-[13px] leading-relaxed text-transparent caret-ink placeholder:text-ink-subtle focus:outline-none disabled:cursor-not-allowed"
            style={{
              maxHeight: LINE_HEIGHT_PX * MAX_TEXTAREA_LINES + 16,
              overflowWrap: "anywhere",
            }}
          />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {/* Hidden file picker — clicked by the paperclip button via
              the hook's `pickFile`. The hook's `fileInputProps` already
              includes `style={display:"none"}` so visual layout is
              unaffected. */}
          <input {...fileInputProps} />
          <button
            type="button"
            onClick={() => pickFile()}
            disabled={sendDisabled}
            className="rounded p-1 text-ink-subtle hover:bg-black/5 disabled:opacity-40"
            title="Attach image (paste / drop also supported)"
          >
            <ImagePlus className="h-4 w-4" />
          </button>

          {showStop ? (
            <button
              type="button"
              onClick={onStop}
              className="inline-flex items-center gap-1 rounded bg-red-600 px-2 py-1 text-[12px] font-medium text-white hover:bg-red-700"
              title="Stop the running process"
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onSend}
              disabled={sendDisabled || busy || !value.trim()}
              className="inline-flex items-center gap-1 rounded bg-ink px-2.5 py-1 text-[12px] font-medium text-white hover:bg-black disabled:opacity-50"
              title={sendDisabled ? "Resolve pending decision first" : "Send (↵)"}
            >
              <Send className="h-3.5 w-3.5" /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
