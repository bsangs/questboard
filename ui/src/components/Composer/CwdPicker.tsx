"use client";

/**
 * Cwd input popover for the [Composer ▼] split-button.
 *
 * Right-half of the trigger drops this popover; the user edits the
 * working directory (defaults to BOARD_ROOT) then submits to open the
 * modal with a fresh client-only draft pre-populated with that cwd.
 * No server thread is created until the user actually sends their
 * first message — see Input.tsx draft-mode branch.
 */

import { Folder } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getBoardRoot, pickFolder } from "@/lib/api";
import { useBoard } from "@/lib/state";

interface Props {
  onClose: () => void;
}

export function CwdPicker({ onClose }: Props) {
  const setComposerOpen = useBoard((s) => s.setComposerOpen);
  const setComposerActive = useBoard((s) => s.setComposerActive);
  const setComposerDraft = useBoard((s) => s.setComposerDraft);
  const pushToast = useBoard((s) => s.pushToast);

  const [cwd, setCwd] = useState<string>("");
  const [boardRoot, setBoardRoot] = useState<string>("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Load BOARD_ROOT to pre-fill the input. We treat the empty-string
  // value as "use board root" (which is also the server's default), so
  // the boardRoot read is purely cosmetic — surfaces the resolved path
  // in the placeholder. Failure is non-fatal; the input just stays
  // empty and the server falls back to BOARD_ROOT.
  useEffect(() => {
    let alive = true;
    getBoardRoot()
      .then((res) => {
        if (alive) setBoardRoot(res.boardRoot);
      })
      .catch(() => {
        // ignore
      });
    inputRef.current?.focus();
    return () => {
      alive = false;
    };
  }, []);

  // Submit doesn't hit the server anymore — it just opens the modal
  // with a fresh draft carrying the chosen cwd. The server thread is
  // created lazily on first send (Input.tsx onSend draft branch).
  const submit = useCallback(() => {
    const trimmed = cwd.trim();
    setComposerActive(null);
    setComposerDraft({ cwd: trimmed || null });
    setComposerOpen(true);
    onClose();
  }, [cwd, onClose, setComposerActive, setComposerDraft, setComposerOpen]);

  const onPick = async () => {
    try {
      const res = await pickFolder();
      if ("cancelled" in res) return;
      // Server returns relative-to-BOARD_ROOT, or null if outside.
      if (res.relative != null) {
        setCwd(res.relative);
      } else {
        pushToast({
          kind: "info",
          message: "Pick a folder inside BOARD_ROOT.",
        });
      }
    } catch {
      // Folder picker may be unavailable in headless setups — silently
      // ignore and let the user type the path.
    }
  };

  return (
    <div className="w-72 rounded-md border border-black/10 bg-white p-3 shadow-lg">
      <div className="mb-1 text-[11.5px] font-medium uppercase tracking-wide text-ink-subtle">
        Working directory
      </div>
      <p className="mb-2 text-[11px] text-ink-subtle">
        Where claude runs. Leave blank to use board root.
      </p>
      <div className="flex gap-1.5">
        <input
          ref={inputRef}
          value={cwd}
          onChange={(e) => setCwd(e.target.value)}
          placeholder={boardRoot || "(board root)"}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onClose();
          }}
          className="min-w-0 flex-1 rounded border border-black/10 px-2 py-1 font-mono text-[12px] focus:border-ink focus:outline-none"
        />
        <button
          onClick={onPick}
          aria-label="Pick folder"
          title="Pick folder"
          className="shrink-0 rounded border border-black/10 px-1.5 py-1 text-ink-muted hover:bg-black/5"
        >
          <Folder className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <button
          onClick={onClose}
          className="rounded px-2 py-1 text-[11.5px] text-ink-muted hover:bg-black/5"
        >
          Cancel
        </button>
        <button
          onClick={submit}
          className="rounded bg-ink px-2.5 py-1 text-[11.5px] font-medium text-white hover:bg-black"
        >
          Open →
        </button>
      </div>
    </div>
  );
}
