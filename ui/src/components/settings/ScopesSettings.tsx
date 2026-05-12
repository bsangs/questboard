"use client";

import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { patchConfig, pickFolder } from "@/lib/api";
import { useBoard } from "@/lib/state";
import type { Scope } from "@/lib/types";
import { SettingsSection as Section } from "./shared";

type ConfigUpdate = (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;

export function ScopesSettings({
  config,
  busy,
  update,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  busy: boolean;
  update: ConfigUpdate;
}) {
  return (
    <Section title="Scopes (work areas)">
      <p className="mb-2 text-[11.5px] text-ink-subtle">
        Define work areas. When a card has a scope, the scope's description
        is injected into the helper system prompt.
      </p>
      <ScopeManager
        scopes={config?.scopes ?? []}
        disabled={busy || !config}
        onChange={(scopes) => update({ scopes })}
      />
    </Section>
  );
}

function ScopeManager({
  scopes,
  disabled,
  onChange,
}: {
  scopes: Scope[];
  disabled: boolean;
  onChange: (next: Scope[]) => void;
}) {
  const [draftId, setDraftId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const pushToast = useBoard((s) => s.pushToast);

  const updateScope = (i: number, patch: Partial<Scope>) => {
    const copy = [...scopes];
    copy[i] = { ...scopes[i], ...patch };
    onChange(copy);
  };

  return (
    <div className="space-y-2">
      {scopes.map((s, i) => (
        <ScopeRow
          key={s.id}
          scope={s}
          disabled={disabled}
          onPatch={(patch) => updateScope(i, patch)}
          onRemove={() => onChange(scopes.filter((x) => x.id !== s.id))}
          onPickError={(m) => pushToast({ kind: "error", message: m })}
        />
      ))}

      <div className="rounded border border-dashed border-border-strong p-2">
        <div className="flex gap-2">
          <input
            value={draftId}
            onChange={(e) => setDraftId(e.target.value)}
            placeholder="id (e.g. frontend)"
            disabled={disabled}
            className="w-32 rounded border border-border-strong px-2 py-1 font-mono text-[12px]"
          />
          <input
            value={draftLabel}
            onChange={(e) => setDraftLabel(e.target.value)}
            placeholder="Label"
            disabled={disabled}
            className="flex-1 rounded border border-border-strong px-2 py-1 text-[12.5px]"
          />
          <button
            onClick={() => {
              const id = draftId.trim().toLowerCase();
              const label = draftLabel.trim();
              if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !label) return;
              if (scopes.some((s) => s.id === id)) return;
              onChange([...scopes, { id, label, description: "", cwd: null }]);
              setDraftId("");
              setDraftLabel("");
            }}
            disabled={disabled || !draftId || !draftLabel}
            className="inline-flex items-center gap-1 rounded border border-border-strong px-2 py-1 text-[12px] font-medium hover:bg-surface-muted disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
      </div>
    </div>
  );
}

function ScopeRow({
  scope: s,
  disabled,
  onPatch,
  onRemove,
  onPickError,
}: {
  scope: Scope;
  disabled: boolean;
  onPatch: (patch: Partial<Scope>) => void;
  onRemove: () => void;
  onPickError: (m: string) => void;
}) {
  const [cwdDraft, setCwdDraft] = useState<string>(s.cwd ?? "");
  const lastServerCwd = useRef<string>(s.cwd ?? "");
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    const next = s.cwd ?? "";
    if (cwdDraft === lastServerCwd.current) {
      setCwdDraft(next);
    }
    lastServerCwd.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.cwd]);

  const commitCwd = (raw: string) => {
    const trimmed = raw.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next !== (s.cwd ?? null)) onPatch({ cwd: next });
  };

  const onPick = async () => {
    setPicking(true);
    try {
      const res = await pickFolder();
      if ("cancelled" in res) return;
      if (res.relative == null) {
        onPickError(
          `Folder ${res.absolute} is outside BOARD_ROOT (${res.boardRoot}). Pick something inside.`,
        );
        return;
      }
      setCwdDraft(res.relative);
      onPatch({ cwd: res.relative });
    } catch (e) {
      onPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="rounded border border-border-strong p-2">
      <div className="flex items-center gap-2">
        <span className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-[11px]">
          {s.id}
        </span>
        <input
          defaultValue={s.label}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== s.label) onPatch({ label: v });
          }}
          disabled={disabled}
          className="flex-1 rounded border border-border-strong px-2 py-1 text-[12.5px]"
        />
        <button
          onClick={onRemove}
          disabled={disabled}
          aria-label="Remove scope"
          className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-700"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        defaultValue={s.description}
        placeholder="Guidance injected into helper system prompt for this scope..."
        onBlur={(e) => {
          const v = e.target.value;
          if (v !== s.description) onPatch({ description: v });
        }}
        disabled={disabled}
        rows={3}
        className="mt-1.5 w-full resize-y rounded border border-border-strong p-1.5 text-[12px]"
      />
      <div className="mt-1.5">
        <label className="mb-1 block text-[10.5px] font-medium uppercase text-ink-subtle">
          Working directory (cwd)
        </label>
        <div className="flex gap-1.5">
          <input
            value={cwdDraft}
            onChange={(e) => setCwdDraft(e.target.value)}
            onBlur={(e) => commitCwd(e.target.value)}
            placeholder="(default: worktree / board root)"
            disabled={disabled || picking}
            className="flex-1 rounded border border-border-strong px-2 py-1 font-mono text-[11.5px]"
          />
          <button
            onClick={onPick}
            disabled={disabled || picking}
            aria-label="Pick folder"
            title="Pick folder..."
            className="inline-flex items-center gap-1 rounded border border-border-strong px-2 py-1 text-[11.5px] font-medium hover:bg-surface-muted disabled:opacity-50"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {picking ? "..." : "Pick..."}
          </button>
        </div>
        <p className="mt-1 text-[10.5px] text-ink-subtle">
          Project-relative path. When set, helpers cd into this subfolder of
          the worktree (worker) or board root (reviewer/merger).
        </p>
      </div>
    </div>
  );
}
