"use client";

import { useEffect, useMemo, useState } from "react";
import { createGitBranch, getGitBranches, patchConfig } from "@/lib/api";
import { useBoard } from "@/lib/state";
import type { BoardConfig } from "@/lib/types";
import {
  DraftTextInput,
  SelectControl,
  SettingsField,
  SettingsSection as Section,
} from "./shared";

type ConfigUpdate = (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;

const DEFAULT_GIT_CONFIG: NonNullable<BoardConfig["git"]> = {
  base_branch: "main",
  worker_branch_template: "worker/card-{card_id}",
  worktree_template: "card-{card_id}",
  composer_worktree_template: "composer-{thread_id}",
};
const CREATE_BRANCH_VALUE = "__questboard_create_branch__";

type BranchState = {
  current: string | null;
  branches: string[];
  loading: boolean;
  error: string | null;
};

export function GitSettings({
  config,
  busy,
  update,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  busy: boolean;
  update: ConfigUpdate;
}) {
  const git = config?.git ?? DEFAULT_GIT_CONFIG;
  const [branchState, setBranchState] = useState<BranchState>({
    current: null,
    branches: [],
    loading: true,
    error: null,
  });
  const [createMode, setCreateMode] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const updateGit = (patch: Partial<NonNullable<BoardConfig["git"]>>) =>
    update({ git: { ...git, ...patch } });
  const selectedBranch = git?.base_branch ?? "main";
  const branchOptions = useMemo(() => {
    return Array.from(
      new Set(
        [selectedBranch, branchState.current, ...branchState.branches].filter(
          (branch): branch is string => !!branch,
        ),
      ),
    );
  }, [branchState.branches, branchState.current, selectedBranch]);

  useEffect(() => {
    let cancelled = false;
    setBranchState((prev) => ({ ...prev, loading: true, error: null }));
    getGitBranches()
      .then((res) => {
        if (!cancelled) {
          setBranchState({
            current: res.current,
            branches: res.branches,
            loading: false,
            error: null,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setBranchState((prev) => ({
            ...prev,
            loading: false,
            error: err instanceof Error ? err.message : String(err),
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const createBranch = async () => {
    const name = createName.trim();
    if (!name) return;
    setCreatingBranch(true);
    setCreateError(null);
    try {
      const res = await createGitBranch(name);
      setBranchState((prev) => ({
        ...prev,
        branches: Array.from(new Set([...prev.branches, res.branch])),
      }));
      await updateGit({ base_branch: res.branch });
      setCreateName("");
      setCreateMode(false);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingBranch(false);
    }
  };

  return (
    <>
      <Section title="Branches">
        <SettingsField
          label="Base branch"
          description={
            branchState.loading
              ? "Loading branches"
              : branchState.current
                ? `Current: ${branchState.current}`
                : "Current branch unavailable"
          }
        >
          <SelectControl
            value={selectedBranch}
            disabled={busy || !config}
            onChange={(e) => {
              const value = e.target.value;
              if (value === CREATE_BRANCH_VALUE) {
                setCreateMode(true);
                setCreateError(null);
                return;
              }
              setCreateMode(false);
              updateGit({ base_branch: value || "main" });
            }}
            className="font-mono"
          >
            {branchOptions.map((branch) => (
              <option key={branch} value={branch}>
                {branch === branchState.current ? `${branch} (current)` : branch}
              </option>
            ))}
            <option value={CREATE_BRANCH_VALUE}>Create branch...</option>
          </SelectControl>
          {createMode && (
            <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                value={createName}
                disabled={busy || !config || creatingBranch}
                onChange={(e) => setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createBranch();
                  }
                  if (e.key === "Escape") {
                    setCreateMode(false);
                    setCreateName("");
                    setCreateError(null);
                  }
                }}
                placeholder="new-branch-name"
                className="min-w-0 flex-1 rounded border border-border-strong bg-surface px-2 py-1 font-mono text-[12.5px] disabled:opacity-50"
              />
              <button
                type="button"
                disabled={
                  busy || !config || creatingBranch || createName.trim() === ""
                }
                onClick={() => void createBranch()}
                className="rounded border border-border-strong px-2.5 py-1 text-[12px] font-medium hover:bg-surface-muted disabled:opacity-50"
              >
                {creatingBranch ? "Creating..." : "Create"}
              </button>
              <button
                type="button"
                disabled={creatingBranch}
                onClick={() => {
                  setCreateMode(false);
                  setCreateName("");
                  setCreateError(null);
                }}
                className="rounded px-2.5 py-1 text-[12px] text-ink-muted hover:bg-surface-muted disabled:opacity-50"
              >
                Cancel
              </button>
            </div>
          )}
          {createMode && (
            <p className="mt-1 text-[11.5px] text-ink-subtle">
              Creates a local branch at the current HEAD without checking it out.
            </p>
          )}
          {branchState.error && (
            <p className="mt-1 text-[11.5px] text-red-700">
              Could not load branch list: {branchState.error}
            </p>
          )}
          {createError && (
            <p className="mt-1 text-[11.5px] text-red-700">{createError}</p>
          )}
        </SettingsField>
      </Section>

      <Section title="Templates">
        <div className="grid gap-3">
          <SettingsField
            label="Worker branch template"
            description={
              <>
                Supports <code>{"{card_id}"}</code>
              </>
            }
          >
            <DraftTextInput
              value={git?.worker_branch_template ?? "worker/card-{card_id}"}
              disabled={busy || !config}
              onCommit={(v) =>
                updateGit({ worker_branch_template: v || "worker/card-{card_id}" })
              }
              className="font-mono"
            />
          </SettingsField>
          <SettingsField label="Worktree template">
            <DraftTextInput
              value={git?.worktree_template ?? "card-{card_id}"}
              disabled={busy || !config}
              onCommit={(v) =>
                updateGit({ worktree_template: v || "card-{card_id}" })
              }
              className="font-mono"
            />
          </SettingsField>
          <SettingsField label="Composer worktree template">
            <DraftTextInput
              value={git?.composer_worktree_template ?? "composer-{thread_id}"}
              disabled={busy || !config}
              onCommit={(v) =>
                updateGit({
                  composer_worktree_template: v || "composer-{thread_id}",
                })
              }
              className="font-mono"
            />
          </SettingsField>
        </div>
      </Section>
    </>
  );
}
