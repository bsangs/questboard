"use client";

import * as Dialog from "@radix-ui/react-dialog";
import clsx from "clsx";
import { Settings2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { patchConfig } from "@/lib/api";
import {
  normalizeSettingsSectionId,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settings";
import { useBoard } from "@/lib/state";
import { SettingsContent } from "./settings/SettingsContent";

const TABS = SETTINGS_SECTIONS;
const ACTIVE_TAB_LS_KEY = "questboard.settings.activeTab.v1";

function readSavedTab(): SettingsSectionId {
  if (typeof window === "undefined") return "general";
  try {
    const raw = window.localStorage.getItem(ACTIVE_TAB_LS_KEY);
    const normalized = normalizeSettingsSectionId(raw);
    if (normalized) return normalized;
  } catch {
    /* ignore */
  }
  return "general";
}

function persistTab(id: SettingsSectionId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ACTIVE_TAB_LS_KEY, id);
  } catch {
    /* ignore */
  }
}

export function SettingsDrawer({
  trigger,
  side = "right",
}: {
  trigger?: React.ReactNode;
  side?: "left" | "right";
}) {
  const [open, setOpen] = useState(false);
  const config = useBoard((s) => s.config);
  const setConfig = useBoard((s) => s.setConfig);
  const pushToast = useBoard((s) => s.pushToast);
  const stats = useBoard((s) => s.stats);
  const [busy, setBusy] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsSectionId>(() => readSavedTab());

  useEffect(() => {
    if (open) setActiveTab(readSavedTab());
  }, [open]);

  const switchTab = useCallback((id: SettingsSectionId) => {
    setActiveTab(id);
    persistTab(id);
  }, []);

  const update = useCallback(
    async (patch: Parameters<typeof patchConfig>[0]) => {
      setBusy(true);
      try {
        const next = await patchConfig(patch);
        setConfig(next);
      } catch (e) {
        pushToast({
          kind: "error",
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(false);
      }
    },
    [pushToast, setConfig],
  );

  const pushError = useCallback(
    (message: string) => pushToast({ kind: "error", message }),
    [pushToast],
  );

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        {trigger ?? (
          <button
            aria-label="Settings"
            className="rounded p-1.5 text-ink-muted hover:bg-surface-muted"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        )}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-30 bg-slate-950/20 animate-fadeIn" />
        <Dialog.Content
          aria-label="Settings"
          className={clsx(
            "fixed inset-y-0 z-40 flex flex-col bg-surface shadow-drawer animate-slideIn",
            side === "left"
              ? "left-14 w-[calc(100vw-3.5rem)] max-w-[760px] border-r border-border-strong"
              : "right-0 w-full max-w-[460px] border-l border-border-strong",
          )}
        >
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <Dialog.Title className="text-[14px] font-semibold">
              Settings
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                aria-label="Close"
                className="rounded p-1 text-ink-subtle hover:bg-surface-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </Dialog.Close>
          </header>

          <SettingsContent
            activeTab={activeTab}
            onTabChange={switchTab}
            config={config}
            stats={stats}
            busy={busy}
            update={update}
            pushError={pushError}
            pushToast={pushToast}
            setBusy={setBusy}
            setConfig={setConfig}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
