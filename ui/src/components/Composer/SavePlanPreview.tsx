"use client";
/**
 * Inline preview gate for an intercepted `save_plan` MCP tool_use.
 * The AI proposed a plan doc (slug + title + markdown body); we let
 * the user edit anything, then Approve / Reject.
 *
 * The body editor is intentionally a plain `<textarea>` with monospace
 * font — a fancy markdown editor is v2. Most plan docs land in the
 * 100-500 line range and a textarea handles that fine.
 */
import clsx from "clsx";
import { Check, FileText, X } from "lucide-react";
import { useMemo, useState } from "react";
import { decideComposerTool } from "@/lib/composer";
import { useBoard } from "@/lib/state";
import type { ComposerPendingToolUse } from "@/lib/types";

interface Proposed {
  slug: string;
  title: string;
  body: string;
  scope: string | null;
}

function readProposed(input: unknown): Proposed {
  const o =
    input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return {
    slug: typeof o.slug === "string" ? o.slug : "",
    title: typeof o.title === "string" ? o.title : "",
    body: typeof o.body === "string" ? o.body : "",
    scope: typeof o.scope === "string" ? o.scope : null,
  };
}

interface Props {
  pending: ComposerPendingToolUse;
  threadId: string;
}

export function ComposerSavePlanPreview({ pending, threadId }: Props) {
  // `?? []` outside the selector — see CardTile.tsx note re: React #185.
  const scopes = useBoard((s) => s.config?.scopes) ?? [];
  const pushToast = useBoard((s) => s.pushToast);

  const initial = useMemo(() => readProposed(pending.input), [pending.input]);

  const [slug, setSlug] = useState(initial.slug);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [scope, setScope] = useState<string | null>(initial.scope);

  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [busy, setBusy] = useState(false);

  const edited =
    slug !== initial.slug ||
    title !== initial.title ||
    body !== initial.body ||
    scope !== initial.scope;

  // Slug constraint mirrors the SavePlanInput zod regex on the server.
  const slugValid = /^[a-z0-9][a-z0-9-]*$/.test(slug);

  const onApprove = async () => {
    if (!title.trim()) {
      pushToast({ kind: "error", message: "Title is required." });
      return;
    }
    if (!slugValid) {
      pushToast({
        kind: "error",
        message: "Slug must be lowercase ASCII / dashes (a-z, 0-9, -).",
      });
      return;
    }
    if (!body.trim()) {
      pushToast({ kind: "error", message: "Plan body cannot be empty." });
      return;
    }
    setBusy(true);
    try {
      const payload = {
        slug,
        title: title.trim(),
        body,
        scope,
      };
      await decideComposerTool(threadId, {
        tool_use_id: pending.id,
        decision: "approve",
        edited_input: edited ? payload : undefined,
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
    <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 text-[13px] shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-violet-800">
          <FileText className="h-3.5 w-3.5" /> save_plan · awaiting approval
        </span>
        <span className="font-mono text-[10.5px] text-violet-700/70">
          docs/plan/&lt;ts&gt;-{slug || "<slug>"}.md
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Title">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded border border-black/10 bg-white px-2 py-1 text-[13px] focus:border-ink focus:outline-none"
          />
        </Field>
        <Field
          label="Slug"
          hint={!slugValid ? "lowercase a-z / 0-9 / dashes" : undefined}
        >
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className={clsx(
              "w-full rounded border bg-white px-2 py-1 font-mono text-[12.5px] focus:outline-none",
              slugValid
                ? "border-black/10 focus:border-ink"
                : "border-red-300 focus:border-red-500",
            )}
          />
        </Field>
      </div>

      <Field label="Body (markdown)">
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={20}
          className="w-full resize-y rounded border border-black/10 bg-white p-2 font-mono text-[12px] leading-relaxed focus:border-ink focus:outline-none"
          spellCheck={false}
        />
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

      {rejecting && (
        <div className="mt-2 rounded border border-red-200 bg-red-50/60 p-2">
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-red-800">
            Rejection reason (optional)
          </div>
          <textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            placeholder="e.g. shorter; drop the migration section"
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
              disabled={busy || !title.trim() || !slugValid || !body.trim()}
              className={clsx(
                "inline-flex items-center gap-1 rounded px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50",
                edited
                  ? "bg-amber-600 hover:bg-amber-700"
                  : "bg-violet-600 hover:bg-violet-700",
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
        {hint && (
          <span className="text-[10px] normal-case text-red-700">{hint}</span>
        )}
      </div>
      {children}
    </label>
  );
}
