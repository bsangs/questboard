"use client";

import { Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { patchConfig } from "@/lib/api";
import { useBoard } from "@/lib/state";
import type { BoardConfig } from "@/lib/types";
import { DraftTextArea, SettingsSection as Section, controlClassName } from "./shared";

type ConfigUpdate = (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;
type CommandsConfig = NonNullable<BoardConfig["commands"]>;
type MergeStep = CommandsConfig["merge"][number];
type StageId = keyof CommandsConfig["stages"];

const DEFAULT_COMMANDS_CONFIG: CommandsConfig = {
  merge: [
    {
      id: "checkout-base",
      label: "Checkout base",
      command: "git checkout {base_branch}",
      required: true,
    },
    {
      id: "fast-forward",
      label: "Fast-forward merge",
      command: "git merge --ff-only {wip_branch}",
      required: true,
    },
    {
    id: "delete-local-branch",
    label: "Delete local branch",
    command:
      "git worktree remove --force \"{worktree_path}\" 2>/dev/null || true; git branch -d {wip_branch}",
    required: false,
  },
  ],
  stages: {
    in_progress: { pre: null, post: null },
    ai_review: { pre: null, post: null },
    merging: { pre: null, post: null },
    stuck: { pre: null, post: null },
  },
};

const STAGE_COMMANDS: Array<{
  id: StageId;
  label: string;
}> = [
  { id: "in_progress", label: "In Progress" },
  { id: "ai_review", label: "AI Review" },
  { id: "merging", label: "Merging" },
  { id: "stuck", label: "Stuck" },
];

function makeStepId(): string {
  return `step-${Date.now().toString(36)}`;
}

function newStep(): MergeStep {
  return {
    id: makeStepId(),
    label: "New step",
    command: null,
    required: true,
  };
}

export function CommandsSettings({
  config,
  busy,
  update,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  busy: boolean;
  update: ConfigUpdate;
}) {
  const commands = config?.commands ?? DEFAULT_COMMANDS_CONFIG;
  const merge = commands.merge ?? DEFAULT_COMMANDS_CONFIG.merge;
  const stages = commands.stages ?? DEFAULT_COMMANDS_CONFIG.stages;
  const updateCommands = (patch: Partial<CommandsConfig>) =>
    update({ commands: { ...commands, ...patch } });
  const updateMerge = (next: MergeStep[]) => updateCommands({ merge: next });

  return (
    <>
      <Section title="Stage commands">
        <p className="mb-2 text-[11.5px] text-ink-subtle">
          Optional lifecycle commands. Blank commands are skipped. Failures
          are logged; use role prompts and shared env for verification policy.
        </p>
        <div className="space-y-3">
          {STAGE_COMMANDS.map((stage) => {
            const value = stages[stage.id] ?? { pre: null, post: null };
            return (
              <div key={stage.id} className="rounded border border-border-strong">
                <div className="flex items-center justify-between gap-3 px-3 py-2 text-[12.5px] font-semibold">
                  <span>{stage.label}</span>
                  <span className="font-mono text-[10.5px] font-medium text-ink-subtle">
                    PRE / POST
                  </span>
                </div>
                <div className="grid gap-2 border-t border-border p-3 md:grid-cols-2">
                  <CommandField
                    label="PRE"
                    value={value.pre ?? ""}
                    disabled={busy || !config}
                    onCommit={(v) =>
                      updateCommands({
                        stages: {
                          ...stages,
                          [stage.id]: {
                            ...value,
                            pre: v.trim() || null,
                          },
                        },
                      })
                    }
                  />
                  <CommandField
                    label="POST"
                    value={value.post ?? ""}
                    disabled={busy || !config}
                    onCommit={(v) =>
                      updateCommands({
                        stages: {
                          ...stages,
                          [stage.id]: {
                            ...value,
                            post: v.trim() || null,
                          },
                        },
                      })
                    }
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <details className="rounded border border-border-strong">
        <summary className="cursor-pointer px-3 py-2 text-[12.5px] font-semibold hover:bg-surface-muted">
          Advanced merge commands
        </summary>
        <MergeCommandList
          steps={merge}
          disabled={busy || !config}
          onChange={updateMerge}
        />
      </details>
    </>
  );
}

function MergeCommandList({
  steps,
  disabled,
  onChange,
}: {
  steps: MergeStep[];
  disabled: boolean;
  onChange: (steps: MergeStep[]) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MergeStep | null>(null);

  const edit = (step: MergeStep) => {
    setEditingId(step.id);
    setDraft({ ...step });
  };

  const insertAfter = (index: number) => {
    const step = newStep();
    onChange([...steps.slice(0, index + 1), step, ...steps.slice(index + 1)]);
    edit(step);
  };

  const remove = (id: string) => {
    onChange(steps.filter((step) => step.id !== id));
    if (editingId === id) {
      setEditingId(null);
      setDraft(null);
    }
  };

  const save = () => {
    if (!draft) return;
    const label = draft.label.trim();
    if (!label) return;
    onChange(
      steps.map((step) =>
        step.id === draft.id
          ? { ...draft, label, command: draft.command?.trim() || null }
          : step,
      ),
    );
    setEditingId(null);
    setDraft(null);
  };

  return (
    <div className="space-y-3 border-t border-border p-3">
      {steps.length === 0 && (
        <div className="rounded border border-dashed border-border-strong p-3 text-[12px] text-ink-subtle">
          No merge steps configured.
        </div>
      )}
      {steps.map((step, index) => {
        const editing = editingId === step.id && draft;
        return (
          <div key={step.id} className="rounded border border-border-strong bg-surface">
            {editing ? (
              <div className="space-y-2 p-3">
                <input
                  value={draft.label}
                  disabled={disabled}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  className={controlClassName("font-medium")}
                />
                <textarea
                  value={draft.command ?? ""}
                  disabled={disabled}
                  onChange={(e) =>
                    setDraft({ ...draft, command: e.target.value })
                  }
                  rows={3}
                  placeholder="blank = skip"
                  spellCheck={false}
                  className={controlClassName(
                    "resize-y p-2 font-mono text-[12px] leading-snug",
                  )}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-1.5 text-[11.5px] text-ink-muted">
                    <input
                      type="checkbox"
                      checked={draft.required}
                      disabled={disabled}
                      onChange={(e) =>
                        setDraft({ ...draft, required: e.target.checked })
                      }
                    />
                    required
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={disabled || !draft.label.trim()}
                      onClick={save}
                      className="rounded border border-border-strong px-2 py-1 text-[11.5px] font-medium hover:bg-surface-muted disabled:opacity-50"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setEditingId(null);
                        setDraft(null);
                      }}
                      className="rounded px-2 py-1 text-[11.5px] text-ink-muted hover:bg-surface-muted disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-[12.5px] font-semibold text-ink">
                      {step.label}
                    </div>
                    <div className="mt-0.5 text-[10.5px] uppercase text-ink-subtle">
                      {step.required ? "Required" : "Optional"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => edit(step)}
                      aria-label="Edit merge step"
                      className="rounded p-1.5 text-ink-muted hover:bg-surface-muted disabled:opacity-50"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => insertAfter(index)}
                      aria-label="Insert step after"
                      className="rounded p-1.5 text-ink-muted hover:bg-surface-muted disabled:opacity-50"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => remove(step.id)}
                      aria-label="Delete merge step"
                      className="rounded p-1.5 text-ink-muted hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                <pre className="mt-2 max-h-28 overflow-auto rounded border border-border bg-[var(--bg-muted)] p-2 font-mono text-[11.5px] leading-snug text-ink-muted">
                  {step.command?.trim() || "blank = skip"}
                </pre>
              </div>
            )}
          </div>
        );
      })}
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          const step = newStep();
          onChange([...steps, step]);
          edit(step);
        }}
        className="inline-flex items-center gap-1.5 rounded border border-border-strong px-2.5 py-1 text-[12px] font-medium hover:bg-surface-muted disabled:opacity-50"
      >
        <Plus className="h-3.5 w-3.5" /> Add step
      </button>
      <p className="text-[11.5px] text-ink-subtle">
        Supports <code>{"{base_branch}"}</code>, <code>{"{wip_branch}"}</code>,{" "}
        <code>{"{card_id}"}</code>, and <code>{"{worktree_path}"}</code>. Blank commands are skipped.
      </p>
    </div>
  );
}

function CommandField({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  onCommit: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10.5px] font-medium uppercase text-ink-subtle">
        {label}
      </span>
      <DraftTextArea
        value={value ?? ""}
        disabled={disabled}
        rows={2}
        placeholder="blank = skip"
        onCommit={onCommit}
      />
    </label>
  );
}
