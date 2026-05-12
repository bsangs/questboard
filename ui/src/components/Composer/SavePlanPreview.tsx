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
import { Button, Input, Select, Textarea } from "@/components/ui";

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
    <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 text-[13px] shadow-sm">
      <div className="mb-2 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold uppercase text-amber-800">
          <FileText className="h-3.5 w-3.5" /> save_plan · awaiting approval
        </span>
        <span className="font-mono text-[10.5px] text-amber-700/70">
          docs/plan/&lt;ts&gt;-{slug || "<slug>"}.md
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Field label="Title">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="text-[13px]"
          />
        </Field>
        <Field
          label="Slug"
          hint={!slugValid ? "lowercase a-z / 0-9 / dashes" : undefined}
        >
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            className={clsx(
              "font-mono text-[12.5px]",
              slugValid
                ? "border-border-strong focus:border-ink"
                : "border-red-300 focus:border-red-500",
            )}
          />
        </Field>
      </div>

      <Field label="Body (markdown)">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={20}
          className="resize-y p-2 font-mono text-[12px] leading-relaxed"
          spellCheck={false}
        />
      </Field>

      <Field label="Scope">
        <Select
          value={scope ?? ""}
          onChange={(e) => setScope(e.target.value || null)}
          className="text-[12.5px]"
        >
          <option value="">(none)</option>
          {scopes.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </Field>

      {rejecting && (
        <div className="mt-2 rounded border border-red-200 bg-red-50/60 p-2">
          <div className="mb-1 text-[11px] font-medium uppercase text-red-800">
            Rejection reason (optional)
          </div>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            rows={2}
            placeholder="e.g. shorter; drop the migration section"
            className="resize-none border-red-200 p-1.5 text-[12.5px] focus:border-red-500"
          />
        </div>
      )}

      <div className="mt-3 flex items-center justify-end gap-2">
        {!rejecting ? (
          <>
            <Button
              type="button"
              onClick={() => setRejecting(true)}
              disabled={busy}
              variant="ghost"
              size="xs"
              className="text-red-700 hover:bg-red-50"
              icon={<X className="h-3.5 w-3.5" />}
            >
              Reject
            </Button>
            <Button
              type="button"
              onClick={onApprove}
              disabled={busy || !title.trim() || !slugValid || !body.trim()}
              variant="primary"
              size="xs"
              className="bg-amber-600 hover:bg-amber-700"
              icon={<Check className="h-3.5 w-3.5" />}
            >
              {edited ? "Edit & Approve" : "Approve"}
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              onClick={() => {
                setRejecting(false);
                setRejectReason("");
              }}
              disabled={busy}
              variant="ghost"
              size="xs"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={onReject}
              disabled={busy}
              variant="danger"
              size="xs"
              icon={<X className="h-3.5 w-3.5" />}
            >
              Send rejection
            </Button>
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
      <div className="mb-0.5 flex items-center justify-between text-[10.5px] font-medium uppercase text-ink-subtle">
        <span>{label}</span>
        {hint && (
          <span className="text-[10px] normal-case text-red-700">{hint}</span>
        )}
      </div>
      {children}
    </label>
  );
}
