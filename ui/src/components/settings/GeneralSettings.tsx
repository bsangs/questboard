"use client";

import { patchConfig } from "@/lib/api";
import { LANGUAGE_OPTIONS } from "@/lib/languages";
import { useBoard } from "@/lib/state";
import { Select } from "@/components/ui";
import { BasePromptSettings } from "./BasePromptSettings";
import { SettingsSection as Section, Toggle } from "./shared";

type ConfigUpdate = (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;

export function GeneralSettings({
  config,
  stats,
  busy,
  update,
  pushError,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  stats: ReturnType<typeof useBoard.getState>["stats"];
  busy: boolean;
  update: ConfigUpdate;
  pushError: (message: string) => void;
}) {
  const bareAvailable = !!config?.auth?.bare_available;
  return (
    <>
      <Section title="Auto-review default">
        <Toggle
          checked={!!config?.auto_review}
          disabled={busy || !config}
          onChange={(v) => update({ auto_review: v })}
          label="Send human_review cards to AI Review automatically"
        />
      </Section>

      <Section title="Concurrency">
        <div className="text-ink-muted">
          Active workers:{" "}
          <span className="font-mono text-ink">
            {stats?.active_workers ?? "-"}
          </span>{" "}
          /{" "}
          <span className="font-mono">
            {config?.concurrency_limit ?? "-"}
          </span>
        </div>
        <div className="mt-2">
          <input
            type="number"
            min={1}
            step={1}
            value={config?.concurrency_limit ?? 8}
            disabled={busy || !config}
            onChange={(e) =>
              update({ concurrency_limit: Math.max(1, Number(e.target.value) || 1) })
            }
            className="w-28 rounded border border-border-strong px-2 py-1 font-mono text-[12.5px]"
          />
          <p className="mt-1 text-[11.5px] text-ink-subtle">
            Stored in config only.
          </p>
        </div>
      </Section>

      <Section title="Bare auth">
        <div className="mb-2 text-ink-muted">
          Anthropic env:{" "}
          <span className="font-mono text-ink">
            {bareAvailable ? "configured" : "not set"}
          </span>
        </div>
        <Toggle
          checked={bareAvailable && !!config?.auth?.bare_enabled}
          disabled={busy || !config || !bareAvailable}
          onChange={(v) =>
            update({ auth: { ...(config?.auth ?? {}), bare_enabled: v } })
          }
          label="Use bare mode when Anthropic env is configured"
        />
        {!bareAvailable && (
          <p className="mt-1 text-[11.5px] text-ink-subtle">
            Set ANTHROPIC_API_KEY in the runtime env to enable this toggle.
          </p>
        )}
      </Section>

      <Section title="Default scope">
        <p className="mb-2 text-[11.5px] text-ink-subtle">
          Pre-selected when creating a new card.
        </p>
        <Select
          value={config?.default_scope ?? ""}
          disabled={busy || !config || (config?.scopes ?? []).length === 0}
          onChange={(e) => update({ default_scope: e.target.value || null })}
          className="text-[12.5px] disabled:opacity-50"
        >
          <option value="">(none)</option>
          {(config?.scopes ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </Select>
      </Section>

      <Section title="Default language">
        <Select
          value={config?.default_language ?? "en"}
          disabled={busy || !config}
          onChange={(e) => update({ default_language: e.target.value })}
          className="text-[12.5px] disabled:opacity-50"
        >
          {LANGUAGE_OPTIONS.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-[11.5px] text-ink-subtle">
          Stored as ISO 639-1; shown here as language names.
        </p>
      </Section>

      <BasePromptSettings pushError={pushError} />
    </>
  );
}
