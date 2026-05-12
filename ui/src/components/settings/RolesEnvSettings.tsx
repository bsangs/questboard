"use client";

import { Copy, Eye, EyeOff, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { createSecretEnv, deleteSecretEnv, patchConfig } from "@/lib/api";
import { useBoard } from "@/lib/state";
import type { BoardConfig, RoleName } from "@/lib/types";
import { DraftTextArea, SettingsSection } from "./shared";

type ConfigUpdate = (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;

const ROLE_NAMES: RoleName[] = ["worker", "reviewer", "merger"];

const DEFAULT_ROLES_CONFIG: NonNullable<BoardConfig["roles"]> = {
  worker: { prompt_append: "" },
  reviewer: { prompt_append: "" },
  merger: { prompt_append: "" },
};

const DEFAULT_ENVIRONMENT_CONFIG: NonNullable<BoardConfig["environment"]> = {
  env: [],
  secret_env: [],
};

export function RolesEnvSettings({
  config,
  busy,
  update,
  pushToast,
  setBusy,
  setConfig,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  busy: boolean;
  update: ConfigUpdate;
  pushToast: ReturnType<typeof useBoard.getState>["pushToast"];
  setBusy: (v: boolean) => void;
  setConfig: ReturnType<typeof useBoard.getState>["setConfig"];
}) {
  const roles = config?.roles ?? DEFAULT_ROLES_CONFIG;
  const environment = config?.environment ?? DEFAULT_ENVIRONMENT_CONFIG;

  const updateRole = (
    role: RoleName,
    patch: Partial<NonNullable<BoardConfig["roles"]>[RoleName]>,
  ) =>
    update({
      roles: {
        ...roles,
        [role]: { ...roles[role], ...patch },
      },
    });

  const updateEnvironment = (
    patch: Partial<NonNullable<BoardConfig["environment"]>>,
  ) => update({ environment: { ...environment, ...patch } });

  const createSecret = async (input: { name: string; value: string }) => {
    setBusy(true);
    try {
      const next = await createSecretEnv(input);
      setConfig(next);
      pushToast({ kind: "success", message: "Secret env created." });
    } catch (e) {
      pushToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  const removeSecret = async (name: string) => {
    setBusy(true);
    try {
      const next = await deleteSecretEnv(name);
      setConfig(next);
      pushToast({ kind: "success", message: "Secret env deleted." });
    } catch (e) {
      pushToast({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      {ROLE_NAMES.map((role) => (
        <SettingsSection key={role} title={`${role} prompt`}>
          <p className="mb-2 text-[11.5px] text-ink-subtle">
            Custom prompt is appended after the built-in {role} prompt.
          </p>
          <DraftTextArea
            value={roles[role].prompt_append ?? ""}
            disabled={busy || !config}
            rows={5}
            placeholder={`Additional ${role} instructions...`}
            onCommit={(v) => updateRole(role, { prompt_append: v })}
          />
        </SettingsSection>
      ))}
      <SettingsSection title="Shared helper env">
        <p className="mb-2 text-[11.5px] text-ink-subtle">
          These variables are shared by worker, reviewer, and merger helpers.
          Choose normal or secret only when creating a new variable.
        </p>
        <UnifiedEnvManager
          env={environment.env}
          secretEnv={environment.secret_env}
          secretStoreEnabled={!!config?.secret_store_configured}
          disabled={busy || !config}
          onEnvChange={(env) => updateEnvironment({ env })}
          onCreateSecret={createSecret}
          onDeleteSecret={removeSecret}
          pushToast={pushToast}
        />
      </SettingsSection>
    </div>
  );
}

function UnifiedEnvManager({
  env,
  secretEnv,
  secretStoreEnabled,
  disabled,
  onEnvChange,
  onCreateSecret,
  onDeleteSecret,
  pushToast,
}: {
  env: NonNullable<BoardConfig["environment"]>["env"];
  secretEnv: NonNullable<BoardConfig["environment"]>["secret_env"];
  secretStoreEnabled: boolean;
  disabled: boolean;
  onEnvChange: (env: NonNullable<BoardConfig["environment"]>["env"]) => void;
  onCreateSecret: (input: { name: string; value: string }) => void;
  onDeleteSecret: (name: string) => void;
  pushToast: ReturnType<typeof useBoard.getState>["pushToast"];
}) {
  const [draftName, setDraftName] = useState("");
  const [draftValue, setDraftValue] = useState("");
  const [draftSecret, setDraftSecret] = useState(false);
  const existingNames = new Set([
    ...env.map((item) => item.name),
    ...secretEnv.map((item) => item.name),
  ]);

  return (
    <div className="space-y-3">
      {env.map((item, index) => (
        <EnvVarRow
          key={`${item.name}-${index}`}
          item={item}
          disabled={disabled}
          onPatch={(patch) => {
            const next = [...env];
            next[index] = { ...item, ...patch };
            onEnvChange(next);
          }}
          onRemove={() => onEnvChange(env.filter((_, i) => i !== index))}
          onCopy={(value) => {
            void navigator.clipboard?.writeText(value);
            pushToast({ kind: "success", message: "Copied." });
          }}
        />
      ))}
      {secretEnv.map((secret) => (
        <SecretEnvRow
          key={secret.name}
          name={secret.name}
          disabled={disabled}
          onDelete={() => onDeleteSecret(secret.name)}
        />
      ))}
      <div className="rounded border border-dashed border-border-strong p-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <input
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            placeholder="NAME"
            disabled={disabled}
            className="w-28 rounded border border-border-strong px-2 py-1 font-mono text-[12px]"
          />
          <input
            type={draftSecret ? "password" : "text"}
            value={draftValue}
            onChange={(e) => setDraftValue(e.target.value)}
            placeholder="value"
            disabled={disabled}
            className="min-w-0 flex-1 rounded border border-border-strong px-2 py-1 font-mono text-[12px]"
          />
          <label className="flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-ink-muted">
            <input
              type="checkbox"
              checked={draftSecret}
              disabled={disabled || !secretStoreEnabled}
              onChange={(e) => setDraftSecret(e.target.checked)}
            />
            secret
          </label>
          <button
            type="button"
            disabled={
              disabled ||
              !draftName ||
              (draftSecret && (!draftValue || !secretStoreEnabled))
            }
            onClick={() => {
              const name = draftName.trim();
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
              if (existingNames.has(name)) return;
              if (draftSecret) onCreateSecret({ name, value: draftValue });
              else onEnvChange([...env, { name, value: draftValue }]);
              setDraftName("");
              setDraftValue("");
              setDraftSecret(false);
            }}
            className="inline-flex items-center gap-1 rounded border border-border-strong px-2 py-1 text-[12px] font-medium hover:bg-surface-muted disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" /> Add
          </button>
        </div>
        <p className="mt-1 text-[10.5px] text-ink-subtle">
          Secret mode is only available when <code>SECRET_KEY</code> is set.
        </p>
      </div>
    </div>
  );
}

function EnvVarRow({
  item,
  disabled,
  onPatch,
  onRemove,
  onCopy,
}: {
  item: NonNullable<BoardConfig["environment"]>["env"][number];
  disabled: boolean;
  onPatch: (patch: Partial<typeof item>) => void;
  onRemove: () => void;
  onCopy: (value: string) => void;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded border border-border-strong p-2">
      <input
        defaultValue={item.name}
        onBlur={(e) => {
          const name = e.target.value.trim();
          if (name && name !== item.name) onPatch({ name });
        }}
        disabled={disabled}
        className="w-28 rounded border border-border-strong px-2 py-1 font-mono text-[12px]"
      />
      <input
        type={visible ? "text" : "password"}
        defaultValue={item.value}
        onBlur={(e) => {
          if (e.target.value !== item.value) onPatch({ value: e.target.value });
        }}
        disabled={disabled}
        className="min-w-0 flex-1 rounded border border-border-strong px-2 py-1 font-mono text-[12px]"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        disabled={disabled}
        aria-label={visible ? "Hide value" : "Reveal value"}
        className="rounded p-1 text-ink-muted hover:bg-surface-muted disabled:opacity-50"
      >
        {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => onCopy(item.value)}
        disabled={disabled}
        aria-label="Copy value"
        className="rounded p-1 text-ink-muted hover:bg-surface-muted disabled:opacity-50"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove env"
        className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function SecretEnvRow({
  name,
  disabled,
  onDelete,
}: {
  name: string;
  disabled: boolean;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded border border-border-strong p-2">
      <span className="w-28 font-mono text-[12px]">{name}</span>
      <span className="min-w-0 flex-1 font-mono text-[12px] text-ink-subtle">
        ********
      </span>
      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10.5px] text-ink-muted">
        secret
      </span>
      <button
        type="button"
        disabled={disabled}
        onClick={onDelete}
        aria-label="Delete secret env"
        className="rounded p-1 text-ink-muted hover:bg-red-50 hover:text-red-700 disabled:opacity-50"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
