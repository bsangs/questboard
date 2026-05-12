"use client";

import { patchConfig } from "@/lib/api";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/lib/settings";
import { useBoard } from "@/lib/state";
import { SideNavButton } from "@/components/patterns";
import { CommandsSettings } from "./CommandsSettings";
import { FilesSettings } from "./FilesSettings";
import { GeneralSettings } from "./GeneralSettings";
import { GitSettings } from "./GitSettings";
import { NotificationsSettings } from "./NotificationsSettings";
import { RolesEnvSettings } from "./RolesEnvSettings";
import { ScopesSettings } from "./ScopesSettings";

const TABS = SETTINGS_SECTIONS;
type ConfigUpdate = (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;

export function SettingsContent({
  activeTab,
  onTabChange,
  config,
  stats,
  busy,
  update,
  pushError,
  pushToast,
  setBusy,
  setConfig,
}: {
  activeTab: SettingsSectionId;
  onTabChange: (id: SettingsSectionId) => void;
  config: ReturnType<typeof useBoard.getState>["config"];
  stats: ReturnType<typeof useBoard.getState>["stats"];
  busy: boolean;
  update: ConfigUpdate;
  pushError: (message: string) => void;
  pushToast: ReturnType<typeof useBoard.getState>["pushToast"];
  setBusy: (v: boolean) => void;
  setConfig: ReturnType<typeof useBoard.getState>["setConfig"];
}) {
  return (
    <div className="flex min-h-0 flex-1">
      <nav
        role="tablist"
        aria-label="Settings sections"
        className="flex w-44 shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-2"
      >
        {TABS.map((t) => {
          const active = activeTab === t.id;
          return (
            <SideNavButton
              key={t.id}
              role="tab"
              aria-selected={active}
              aria-controls={`settings-panel-${t.id}`}
              id={`settings-tab-${t.id}`}
              onClick={() => onTabChange(t.id)}
              active={active}
            >
              {t.label}
            </SideNavButton>
          );
        })}
      </nav>

      <div className="min-w-0 flex-1 overflow-y-auto p-5 text-[13px]">
        {activeTab === "general" && (
          <TabPanel id="general">
            <GeneralSettings
              config={config}
              stats={stats}
              busy={busy}
              update={update}
              pushError={pushError}
            />
          </TabPanel>
        )}

        {activeTab === "git" && (
          <TabPanel id="git">
            <GitSettings config={config} busy={busy} update={update} />
          </TabPanel>
        )}

        {activeTab === "commands" && (
          <TabPanel id="commands">
            <CommandsSettings config={config} busy={busy} update={update} />
          </TabPanel>
        )}

        {activeTab === "roles" && (
          <TabPanel id="roles">
            <RolesEnvSettings
              config={config}
              busy={busy}
              update={update}
              pushToast={pushToast}
              setBusy={setBusy}
              setConfig={setConfig}
            />
          </TabPanel>
        )}

        {activeTab === "files" && (
          <TabPanel id="files">
            <FilesSettings config={config} busy={busy} update={update} />
          </TabPanel>
        )}

        {activeTab === "scopes" && (
          <TabPanel id="scopes">
            <ScopesSettings config={config} busy={busy} update={update} />
          </TabPanel>
        )}

        {activeTab === "notifications" && (
          <TabPanel id="notifications">
            <NotificationsSettings
              config={config}
              busy={busy}
              update={update}
              pushToast={pushToast}
              setBusy={setBusy}
            />
          </TabPanel>
        )}
      </div>
    </div>
  );
}

function TabPanel({
  id,
  children,
}: {
  id: SettingsSectionId;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`settings-panel-${id}`}
      aria-labelledby={`settings-tab-${id}`}
      className="space-y-5"
    >
      {children}
    </div>
  );
}
