"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { ImagePlus, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createCard } from "@/lib/api";
import {
  attachToUploadPool,
  promoteUploadPoolToCard,
  useAttachableTextarea,
} from "@/lib/attach";
import { useBoard } from "@/lib/state";
import type { CardFlavor } from "@/lib/types";
import clsx from "clsx";

const FLAVORS: CardFlavor[] = ["feature", "bug", "refactor", "chore", "docs"];

export function NewCardModal() {
  // Open state is global so an inline "+ New" button on the Backlog column
  // can pop the same dialog the top-bar trigger does.
  const open = useBoard((s) => s.newCardOpen);
  const setOpen = useBoard((s) => s.setNewCardOpen);
  const pushToast = useBoard((s) => s.pushToast);

  const config = useBoard((s) => s.config);
  const scopes = config?.scopes ?? [];
  const defaultScope = config?.default_scope ?? null;

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [language, setLanguage] = useState("");
  const [priority, setPriority] = useState<1 | 2 | 3>(2);
  const [flavor, setFlavor] = useState<CardFlavor>("feature");
  const [scope, setScope] = useState<string>(""); // "" = no scope
  const [depsText, setDepsText] = useState("");
  const [busy, setBusy] = useState(false);

  // Upload-pool token: minted on first attachment, kept stable across the
  // dialog's lifetime so paste-paste-paste accumulates into one pool dir.
  // Reset alongside other fields. On Create we POST /promote so the pool
  // directory's contents land in the new card's attachments dir.
  const [uploadToken, setUploadToken] = useState<string | null>(null);
  const descRef = useRef<HTMLTextAreaElement | null>(null);
  const descValueRef = useRef(description);
  descValueRef.current = description;

  // Pre-select the configured default scope every time the dialog opens.
  // Verify the id still exists in the current scopes list — a stale default
  // (scope was deleted) silently falls back to "(none)".
  useEffect(() => {
    if (!open) return;
    if (defaultScope && scopes.some((s) => s.id === defaultScope)) {
      setScope(defaultScope);
    }
  }, [open, defaultScope, scopes]);

  const reset = () => {
    setTitle("");
    setDescription("");
    setLanguage("");
    setPriority(2);
    setFlavor("feature");
    setScope(
      defaultScope && scopes.some((s) => s.id === defaultScope)
        ? defaultScope
        : "",
    );
    setDepsText("");
    // Drop the upload-pool token; the server's 24h sweep will GC the
    // orphaned files. Resetting on Cancel is fine — workers can't see
    // the pool, only the post-promote per-card dir.
    setUploadToken(null);
  };

  // Memo the uploader so it's stable across renders. Persists the token
  // back to state on first upload — subsequent uploads reuse it.
  const tokenRef = useRef<string | null>(null);
  tokenRef.current = uploadToken;
  const uploadDescImage = useCallback(async (file: File): Promise<string> => {
    const r = await attachToUploadPool(tokenRef.current, file);
    if (!tokenRef.current) {
      tokenRef.current = r.token;
      setUploadToken(r.token);
    }
    return r.markdown;
  }, []);

  const { onPaste, onDrop, onDragOver, pickFile, fileInputProps } =
    useAttachableTextarea(descRef, {
      upload: uploadDescImage,
      onError: (err) =>
        pushToast({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        }),
      getValue: () => descValueRef.current,
      onValueChange: (next) => setDescription(next),
    });

  const submit = async () => {
    if (!title.trim()) {
      pushToast({ kind: "error", message: "Title is required." });
      return;
    }
    setBusy(true);
    try {
      const deps = depsText
        .split(/[\s,]+/)
        .map((s) => s.replace(/^#/, "").trim())
        .filter((s) => /^\d{4}$/.test(s));

      const created = await createCard({
        title: title.trim(),
        description,
        priority,
        flavor,
        ...(scope ? { scope } : {}),
        ...(language.trim() ? { language: language.trim() } : {}),
        ...(deps.length ? { deps } : {}),
      });
      // Move pasted/dropped images out of the upload pool into the new
      // card's attachments dir. Without this, the description's
      // `attachments/<filename>` references point at files that get
      // swept by the 24h GC, leaving the new card with broken images.
      // We surface promote failures as a non-fatal warning — the card
      // itself was created successfully.
      const tok = tokenRef.current;
      if (tok) {
        try {
          await promoteUploadPoolToCard(tok, created.id);
        } catch (e) {
          pushToast({
            kind: "error",
            message:
              "Card created, but couldn't move pasted images: " +
              (e instanceof Error ? e.message : String(e)),
          });
        }
      }
      pushToast({
        kind: "success",
        message: `Created card-${created.id}`,
      });
      reset();
      setOpen(false);
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm hover:bg-black">
          <Plus className="h-3.5 w-3.5" /> New
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-black/30 animate-fadeIn" />
        <Dialog.Content
          aria-label="New card"
          className="fixed left-1/2 top-1/2 z-40 w-full max-w-[560px] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-black/10 bg-white shadow-xl animate-fadeIn"
        >
          <header className="flex items-center justify-between border-b border-black/5 px-5 py-3">
            <Dialog.Title className="text-[14px] font-semibold">
              New Card
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="Close"
                className="rounded p-1 text-ink-subtle hover:bg-black/5"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </header>

          <div className="space-y-3 p-5">
            <Field label="Title" required>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short, action-oriented summary"
                className="w-full rounded border border-black/10 px-2.5 py-1.5 text-[13px] focus:border-ink focus:outline-none"
                autoFocus
              />
            </Field>

            <Field label="Description">
              <div className="relative">
                <textarea
                  ref={descRef}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  onPaste={onPaste}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  rows={8}
                  placeholder={
                    "Markdown supported. Paste / drop images to attach. Include context, acceptance criteria, etc."
                  }
                  className="w-full resize-y rounded border border-black/10 p-2.5 font-mono text-[12.5px] focus:border-ink focus:outline-none"
                />
                {/* Hidden file input + paperclip button so clicking the
                    button triggers the picker. The button sits in the
                    bottom-right of the textarea so it doesn't take the
                    whole row's vertical space. */}
                <input {...fileInputProps} />
                <button
                  type="button"
                  onClick={pickFile}
                  className="absolute bottom-2 right-2 rounded p-1 text-ink-subtle hover:bg-black/5"
                  title="Attach image"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                </button>
              </div>
            </Field>

            <div className="grid grid-cols-3 gap-3">
              <Field label="Language">
                <input
                  value={language}
                  onChange={(e) => setLanguage(e.target.value)}
                  placeholder="auto"
                  className="w-full rounded border border-black/10 px-2.5 py-1.5 text-[13px] focus:border-ink focus:outline-none"
                />
              </Field>
              <Field label="Priority">
                <div className="flex gap-1">
                  {[1, 2, 3].map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setPriority(p as 1 | 2 | 3)}
                      className={`flex-1 rounded border px-2 py-1.5 text-[13px] font-medium ${
                        priority === p
                          ? "border-ink bg-ink text-white"
                          : "border-black/10 text-ink-muted hover:bg-black/5"
                      }`}
                    >
                      P{p}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="Flavor">
                <select
                  value={flavor}
                  onChange={(e) => setFlavor(e.target.value as CardFlavor)}
                  className="w-full rounded border border-black/10 px-2 py-1.5 text-[13px] focus:border-ink focus:outline-none"
                >
                  {FLAVORS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <Field
              label="Scope"
              hint={
                scopes.length === 0
                  ? "Manage scopes in Settings → Scopes."
                  : "Optional. Injects scope guidance into helper prompts."
              }
            >
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value)}
                disabled={scopes.length === 0}
                className={clsx(
                  "w-full rounded border border-black/10 px-2 py-1.5 text-[13px] focus:border-ink focus:outline-none",
                  scopes.length === 0 && "opacity-50",
                )}
              >
                <option value="">(none)</option>
                {scopes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Dependencies"
              hint="Card IDs (4-digit), comma or space separated."
            >
              <input
                value={depsText}
                onChange={(e) => setDepsText(e.target.value)}
                placeholder="e.g. 0038, 0040"
                className="w-full rounded border border-black/10 px-2.5 py-1.5 font-mono text-[12.5px] focus:border-ink focus:outline-none"
              />
            </Field>
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-black/5 px-5 py-3">
            <Dialog.Close asChild>
              <button className="rounded px-3 py-1.5 text-[12.5px] text-ink-muted hover:bg-black/5">
                Cancel
              </button>
            </Dialog.Close>
            <button
              onClick={submit}
              disabled={busy || !title.trim()}
              className="rounded bg-ink px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-black disabled:opacity-50"
            >
              {busy ? "Creating…" : "Create →"}
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 flex items-center justify-between text-[11.5px] font-medium uppercase tracking-wide text-ink-subtle">
        <span>
          {label}
          {required && <span className="text-red-500"> *</span>}
        </span>
        {hint && <span className="text-[10.5px] text-ink-subtle">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
