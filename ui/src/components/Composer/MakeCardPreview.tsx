"use client";
/**
 * Inline preview gate for an intercepted `make_card` MCP tool_use.
 * The AI proposed a card; we let the user edit any field, then
 * Approve / Reject. Rejection optionally carries a free-text reason
 * that the server feeds back as a `tool_error` so the AI can pivot.
 *
 * v1 keeps the form lean: title, description, priority, flavor, scope,
 * deps. We don't expose `language` / `estimated_loc` / `budget_minutes`
 * here — server defaults are fine; user can edit on the card later.
 *
 * On a successful POST the server emits `composer_tool_resolved` which
 * the state slice consumes by removing the pending entry — this
 * component then unmounts naturally. We don't optimistically clear it
 * locally (the server is source of truth and may reject).
 */
import clsx from "clsx";
import { Check, Pencil, X } from "lucide-react";
import { useMemo, useState } from "react";
import { decideComposerTool } from "@/lib/composer";
import { useBoard } from "@/lib/state";
import type { CardFlavor, ComposerPendingToolUse } from "@/lib/types";

const FLAVORS: CardFlavor[] = ["feature", "bug", "refactor", "chore", "docs"];

/** Shape we expect inside `pending.input`. We narrow defensively. */
interface Proposed {
  title: string;
  description: string;
  priority: 1 | 2 | 3;
  flavor: CardFlavor;
  scope: string | null;
  deps: string[];
}

/** Best-effort coerce of arbitrary unknown to our Proposed shape. */
function readProposed(input: unknown): Proposed {
  const o =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const flavorRaw = typeof o.flavor === "string" ? o.flavor : "feature";
  const flavor: CardFlavor = (FLAVORS as string[]).includes(flavorRaw)
    ? (flavorRaw as CardFlavor)
    : "feature";
  const priorityRaw = o.priority;
  const priority: 1 | 2 | 3 =
    priorityRaw === 1 || priorityRaw === 2 || priorityRaw === 3
      ? priorityRaw
      : 2;
  return {
    title: typeof o.title === "string" ? o.title : "",
    description: typeof o.description === "string" ? o.description : "",
    priority,
    flavor,
    scope: typeof o.scope === "string" ? o.scope : null,
    deps: Array.isArray(o.deps)
      ? (o.deps.filter((d) => typeof d === "string") as string[])
      : [],
  };
}

interface Props {
  pending: ComposerPendingToolUse;
  threadId: string;
}

export function ComposerMakeCardPreview({ pending, threadId }: Props) {
  // The `?? []` MUST live OUTSIDE the zustand selector — see CardTile.tsx
  // for the canonical explanation (React #185 / new-array identity).
  const scopes = useBoard((s) => s.config?.scopes) ?? [];
  const pushToast = useBoard((s) => s.pushToast);

  const initial = useMemo(() => readProposed(pending.input), [pending.input]);

  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [priority, setPriority] = useState<1 | 2 | 3>(initial.priority);
  const [flavor, setFlavor] = useState<CardFlavor>(initial.flavor);
  const [scope, setScope] = useState<string | null>(initial.scope);
  const [depsText, setDepsText] = useState(initial.deps.join(", "));

  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);

  // Auto-detect "Edit & Approve" vs plain "Approve": if any field
  // diverged from the original AI proposal, we send `edited_input`.
  const edited =
    title !== initial.title ||
    description !== initial.description ||
    priority !== initial.priority ||
    flavor !== initial.flavor ||
    scope !== initial.scope ||
    depsText !== initial.deps.join(", ");

  const onApprove = async () => {
    if (!title.trim()) {
      pushToast({ kind: "error", message: "Title is required." });
      return;
    }
    setBusy(true);
    try {
      const deps = depsText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        // Server accepts either `0091` style ids or `#0` batch refs.
        .filter((s) => /^(?:\d{4}|#\d+)$/.test(s));
      const payload = {
        title: title.trim(),
        description,
        priority,
        flavor,
        scope,
        deps,
      };
      await decideComposerTool(threadId, {
        tool_use_id: pending.id,
        decision: "approve",
        edited_input: edited ? payload : undefined,
      });
      // No optimistic state clear — SSE composer_tool_resolved handles it.
    } catch (e) {
      pushToast({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const onReject = async () => {
    setBusy(true);
    try {
      await decideComposerTool(threadId, {
        tool_use_id: pending.id,
        decision: "reject",
        reason: rejectReason.trim() || undefined,
      });
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
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 text-[13px] shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-emerald-800">
          <Pencil className="h-3.5 w-3.5" /> make_card · awaiting approval
        </span>
        <span className="font-mono text-[10.5px] text-emerald-700/70">
          {pending.id.slice(0, 8)}
        </span>
      </div>

      <Field label="Title">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-full rounded border border-black/10 bg-white px-2 py-1 text-[13px] focus:border-ink focus:outline-none"
        />
      </Field>

      <Field label="Description">
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          className="w-full resize-y rounded border border-black/10 bg-white p-2 font-mono text-[12px] focus:border-ink focus:outline-none"
        />
      </Field>

      <div className="mt-2 grid grid-cols-3 gap-2">
        <Field label="Priority">
          <select
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) as 1 | 2 | 3)}
            className="w-full rounded border border-black/10 bg-white px-2 py-1 text-[12.5px] focus:border-ink focus:outline-none"
          >
            <option value={1}>P1</option>
            <option value={2}>P2</option>
            <option value={3}>P3</option>
          </select>
        </Field>
        <Field label="Flavor">
          <select
            value={flavor}
            onChange={(e) => setFlavor(e.target.value as CardFlavor)}
            className="w-full rounded border border-black/10 bg-white px-2 py-1 text-[12.5px] focus:border-ink focus:outline-none"
          >
            {FLAVORS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Scope">
          <select
            value={scope ?? ""}
            onChange={(e) => setScope(e.target.value || null)}
            className="w-full rounded border border-black/10 bg-white px-2 py-1 text-[12.5px] focus:border-ink focus:outline-none"
          >
            <option value="">(none)</option>
            {scopes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <div className="mt-2">
        <Field label="Deps" hint="4-digit ids or #N batch refs, comma-separated">
          <input
            value={depsText}
            onChange={(e) => setDepsText(e.target.value)}
            placeholder="0038, #0"
            className="w-full rounded border border-black/10 bg-white px-2 py-1 font-mono text-[12px] focus:border-ink focus:outline-none"
          />
        </Field>
      </div>

      {rejecting && (
        <div className="mt-2 rounded border border-red-200 bg-red-50/60 p-2">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-red-800">
            Rejection reason (optional)
          </div>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            placeholder="e.g. split this into two cards, one for the API and one for the UI"
            className="w-full resize-none rounded border border-red-200 bg-white p-1.5 text-[12.5px] focus:border-red-500 focus:outline-none"
          />
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        {!rejecting ? (
          <>
            <button
              type="button"
              onClick={() => setRejecting(true)}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> Reject
            </button>
            <button
              type="button"
              onClick={onApprove}
              disabled={busy || !title.trim()}
              className={clsx(
                "inline-flex items-center gap-1 rounded px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50",
                edited
                  ? "bg-amber-600 hover:bg-amber-700"
                  : "bg-emerald-600 hover:bg-emerald-700",
              )}
            >
              <Check className="h-3.5 w-3.5" />{" "}
              {edited ? "Edit & Approve" : "Approve"}
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                setRejecting(false);
                setRejectReason("");
              }}
              disabled={busy}
              className="rounded px-2 py-1 text-[12px] text-ink-muted hover:bg-black/5 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onReject}
              disabled={busy}
              className="inline-flex items-center gap-1 rounded bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              <X className="h-3.5 w-3.5" /> Send rejection
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="mt-2 block first:mt-0">
      <div className="mb-0.5 flex items-center justify-between text-[10.5px] font-medium uppercase tracking-wide text-ink-subtle">
        <span>{label}</span>
        {hint && <span className="text-[10px] normal-case">{hint}</span>}
      </div>
      {children}
    </label>
  );
}
