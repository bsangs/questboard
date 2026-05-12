"use client";

import { patchConfig } from "@/lib/api";
import { useBoard } from "@/lib/state";
import { SettingsSection, StringListEditor } from "./shared";

type ConfigUpdate = (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;

export function FilesSettings({
  config,
  busy,
  update,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  busy: boolean;
  update: ConfigUpdate;
}) {
  return (
    <SettingsSection title="Ignored files">
      <p className="mb-2 text-[11.5px] text-ink-subtle">
        Names hidden from file pickers and explorer-style lists.
      </p>
      <StringListEditor
        values={config?.files?.hidden_names ?? []}
        disabled={busy || !config}
        placeholder="name"
        onChange={(hidden_names) =>
          update({ files: { ...(config?.files ?? {}), hidden_names } })
        }
      />
    </SettingsSection>
  );
}
