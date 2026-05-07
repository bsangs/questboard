"use client";

/**
 * Image-attachment helpers.
 *
 * Three storage targets share the same upload surface:
 *   - per-card:        POST /api/cards/:id/attachments
 *   - per-thread:      POST /api/composer/threads/:id/attachments
 *   - upload pool:     POST /api/uploads          (token-scoped temp dir)
 *
 * The upload pool is the bridge for "I'm typing in NewCardModal /
 * Composer draft mode and the destination card/thread doesn't exist
 * yet". On the eventual create call, the UI POSTs `/promote` (or the
 * composer equivalent) so the temp files move into the right per-id
 * directory; the markdown text the user typed (`![](attachments/foo)`)
 * resolves correctly afterward.
 *
 * The hook `useAttachableTextarea` wires three input vectors at once —
 * paste, drop, and a file-picker — into the same upload + insert path,
 * so callers don't have to duplicate the logic across NewCardModal,
 * CardDrawer, the comments box, the stuck reply, and the Composer.
 */
import { useCallback, useEffect, useRef, type RefObject } from "react";
import { ApiError, BOARD_SERVER_URL } from "./api";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Allowed image MIME types — must mirror the server-side ALLOWED_MIME. */
const ALLOWED_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

export interface AttachResult {
  /** Path to embed in markdown — always `attachments/<filename>` so the
   *  Markdown renderer can rewrite it consistently. For pool uploads,
   *  this is `_uploads/<token>/<filename>` until promotion. */
  markdown: string;
  /** Absolute URL the server will serve the file at — for previews. */
  url: string;
  /** Sanitized filename the server actually stored. */
  filename: string;
}

export interface AttachToUploadPoolResult extends AttachResult {
  token: string;
}

// ─── Internals ───────────────────────────────────────────────────────────────

async function postFile(
  url: string,
  file: File,
): Promise<{
  path: string;
  url: string;
  filename: string;
  token?: string;
}> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const res = await fetch(url, { method: "POST", body: fd, cache: "no-store" });
  if (!res.ok) {
    let body: { error?: string; message?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    throw new ApiError(
      res.status,
      body?.message || body?.error || `HTTP ${res.status}`,
      body?.error,
    );
  }
  return res.json();
}

function ensureAllowed(file: File): void {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new ApiError(
      415,
      `Unsupported image type: ${file.type || "unknown"}. Allowed: png/jpg/gif/webp/svg.`,
      "unsupported_media_type",
    );
  }
}

// ─── Public uploader fns ─────────────────────────────────────────────────────

/** Upload a file to a card's attachments dir. Returns the markdown path. */
export async function attachToCard(
  cardId: string,
  file: File,
): Promise<AttachResult> {
  ensureAllowed(file);
  const json = await postFile(
    `${BOARD_SERVER_URL}/api/cards/${cardId}/attachments`,
    file,
  );
  return {
    markdown: `attachments/${json.filename}`,
    url: `${BOARD_SERVER_URL}${json.url.startsWith("/") ? json.url : "/" + json.url}`,
    filename: json.filename,
  };
}

/**
 * Upload a file to the temp pool. Pass `token = null` on the first
 * upload for a session; the server mints a token. Subsequent uploads
 * reuse the same token to keep all files in one pool dir.
 */
export async function attachToUploadPool(
  token: string | null,
  file: File,
): Promise<AttachToUploadPoolResult> {
  ensureAllowed(file);
  const url = token
    ? `${BOARD_SERVER_URL}/api/uploads?token=${encodeURIComponent(token)}`
    : `${BOARD_SERVER_URL}/api/uploads`;
  const json = await postFile(url, file);
  if (!json.token) {
    // Server contract guarantees a token on /api/uploads — defend against
    // a misbehaving response.
    throw new ApiError(500, "Upload response missing token", "bad_response");
  }
  return {
    token: json.token,
    // Once promoted, the bytes will live at `attachments/<filename>` in
    // the card/thread dir. The Markdown renderer rewrites this same
    // path correctly even before promotion (it falls back to the
    // upload-pool URL when there's no card id yet) — but the typed
    // string we INSERT into the textarea needs to be `attachments/...`
    // so the post-promotion render is correct.
    markdown: `attachments/${json.filename}`,
    url: `${BOARD_SERVER_URL}${json.url.startsWith("/") ? json.url : "/" + json.url}`,
    filename: json.filename,
  };
}

/**
 * Upload to a Composer thread's attachments dir. When `threadId` is
 * null the request goes to the upload pool — caller must remember the
 * token and call `promoteUploadPoolToComposer` after the thread is
 * created.
 */
export async function attachToComposer(
  threadId: string | null,
  file: File,
  poolToken: string | null = null,
): Promise<AttachResult & { token?: string }> {
  ensureAllowed(file);
  if (threadId) {
    const json = await postFile(
      `${BOARD_SERVER_URL}/api/composer/threads/${encodeURIComponent(threadId)}/attachments`,
      file,
    );
    return {
      markdown: `attachments/${json.filename}`,
      url: `${BOARD_SERVER_URL}${json.url.startsWith("/") ? json.url : "/" + json.url}`,
      filename: json.filename,
    };
  }
  const pool = await attachToUploadPool(poolToken, file);
  return { ...pool, token: pool.token };
}

/** Promote pool → card. Called by NewCardModal after createCard. */
export async function promoteUploadPoolToCard(
  token: string,
  cardId: string,
): Promise<{ moved: string[] }> {
  const res = await fetch(
    `${BOARD_SERVER_URL}/api/uploads/${encodeURIComponent(token)}/promote`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card_id: cardId }),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    let body: { error?: string; message?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    throw new ApiError(
      res.status,
      body?.message || body?.error || `HTTP ${res.status}`,
      body?.error,
    );
  }
  return res.json();
}

/** Promote pool → composer thread. Called by Composer Input after the
 *  draft turns into a real thread. */
export async function promoteUploadPoolToComposer(
  token: string,
  threadId: string,
): Promise<{ moved: string[] }> {
  const res = await fetch(
    `${BOARD_SERVER_URL}/api/composer/threads/${encodeURIComponent(threadId)}/promote-uploads`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
    },
  );
  if (!res.ok) {
    let body: { error?: string; message?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      // not JSON
    }
    throw new ApiError(
      res.status,
      body?.message || body?.error || `HTTP ${res.status}`,
      body?.error,
    );
  }
  return res.json();
}

// ─── React hook: paste / drop / picker → upload + insert ─────────────────────

/**
 * Tells the hook where to send each file. Callers return a markdown
 * snippet (e.g. `attachments/foo.png`) — usually by calling one of the
 * `attachTo*` functions above and returning the `.markdown` field.
 *
 * The async return lets callers await the upload before inserting; on
 * reject the hook surfaces the error via `onError`.
 */
export type AttachUploader = (file: File) => Promise<string>;

export interface UseAttachableTextareaOpts {
  /** Strategy: how to upload each file and produce the markdown to insert. */
  upload: AttachUploader;
  /** Called when an upload fails — typically a toast. */
  onError?: (err: unknown) => void;
  /** Called every time the textarea's value should change to `next`. The
   *  caller is responsible for the actual `setState`; we don't poke the
   *  DOM directly because controlled inputs would fight us. */
  onValueChange: (next: string, opts: { caretPos: number }) => void;
  /** Read the current textarea value. We don't take it as a prop because
   *  a freshly-pasted/dropped file inside an async upload would race a
   *  prop snapshot. */
  getValue: () => string;
  /** Disable everything (e.g. while busy or disabled). Default: false. */
  disabled?: boolean;
}

/**
 * Wire paste / drag-drop / picker to a textarea. Returns:
 *   - {paste, drop, dragOver}: handlers to spread on the textarea / wrapper
 *   - {pickFile}: imperative trigger for a file-picker click
 *   - {fileInputProps}: props to spread onto a hidden `<input type=file>`
 */
export function useAttachableTextarea(
  textareaRef: RefObject<HTMLTextAreaElement>,
  opts: UseAttachableTextareaOpts,
): {
  onPaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  onDragOver: (e: React.DragEvent<HTMLTextAreaElement>) => void;
  pickFile: () => void;
  fileInputProps: {
    ref: RefObject<HTMLInputElement>;
    type: "file";
    accept: string;
    style: React.CSSProperties;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  };
} {
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Stash callbacks in refs so the returned handlers don't recreate on
  // every render — important because the textarea would otherwise lose
  // focus / re-attach listeners under React 18 strict mode.
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const insertAtCaret = useCallback((markdown: string) => {
    const ta = textareaRef.current;
    const cur = optsRef.current.getValue();
    const start = ta?.selectionStart ?? cur.length;
    const end = ta?.selectionEnd ?? cur.length;
    // Only pad with newlines when we're NOT already at a line boundary.
    // Earlier we always wrapped with `\n…\n` — that fired even if the
    // cursor was at the start of an empty input or the end of an empty
    // line, leaving an unwanted leading blank line. Now we look at the
    // surrounding chars and add a newline only if it's missing.
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    const needsLeading = before.length > 0 && !before.endsWith("\n");
    const needsTrailing = after.length > 0 && !after.startsWith("\n");
    const block =
      (needsLeading ? "\n" : "") +
      `![image](${markdown})` +
      (needsTrailing ? "\n" : "");
    const next = before + block + after;
    const caret = start + block.length;
    optsRef.current.onValueChange(next, { caretPos: caret });
    // Restore caret on next paint — controlled-input updates have to
    // settle before selectionStart sticks.
    requestAnimationFrame(() => {
      const t = textareaRef.current;
      if (!t) return;
      t.focus();
      try {
        t.setSelectionRange(caret, caret);
      } catch {
        // Some browsers throw if the textarea isn't visible — harmless.
      }
    });
  }, [textareaRef]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      if (optsRef.current.disabled) return;
      const list = Array.from(files);
      const images = list.filter((f) => f.type.startsWith("image/"));
      if (images.length === 0) return;
      // Upload in parallel — backend has no global lock and order
      // doesn't matter for the user's mental model (they pasted them
      // simultaneously). We DO insert them in order via Promise.all
      // resolution order.
      const uploads = images.map((f) => optsRef.current.upload(f));
      const results = await Promise.allSettled(uploads);
      for (const r of results) {
        if (r.status === "fulfilled") {
          insertAtCaret(r.value);
        } else {
          optsRef.current.onError?.(r.reason);
        }
      }
    },
    [insertAtCaret],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(e.clipboardData?.items ?? []);
      const files: File[] = [];
      for (const it of items) {
        if (it.kind === "file") {
          const f = it.getAsFile();
          if (f && f.type.startsWith("image/")) files.push(f);
        }
      }
      if (files.length === 0) return;
      // Prevent the default paste only when we caught at least one
      // image — otherwise typing/text paste should pass through.
      e.preventDefault();
      void handleFiles(files);
    },
    [handleFiles],
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLTextAreaElement>) => {
      const dt = e.dataTransfer;
      if (!dt || dt.files.length === 0) return;
      e.preventDefault();
      void handleFiles(dt.files);
    },
    [handleFiles],
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLTextAreaElement>) => {
    // Required: without preventDefault on dragover, the browser treats
    // the drop as a navigation and doesn't fire onDrop.
    if (e.dataTransfer?.types?.includes("Files")) {
      e.preventDefault();
    }
  }, []);

  const pickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        void handleFiles(files);
      }
      // Reset so picking the same file twice still fires onChange.
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [handleFiles],
  );

  return {
    onPaste,
    onDrop,
    onDragOver,
    pickFile,
    fileInputProps: {
      ref: fileInputRef,
      type: "file",
      accept: "image/png,image/jpeg,image/webp,image/gif,image/svg+xml",
      style: { display: "none" },
      onChange: onFileChange,
    },
  };
}
