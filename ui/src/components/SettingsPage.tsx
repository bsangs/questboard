"use client";

import { ArrowLeft, Settings2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getConfig, getStats, patchConfig } from "@/lib/api";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "@/lib/settings";
import { useBoard } from "@/lib/state";
import { AppHeader, AppRail, AppShell, HeaderLink, RailLink } from "./patterns";
import { SettingsContent } from "./settings/SettingsContent";
import { Toaster } from "./Toaster";

export function SettingsPage({ section }: { section: SettingsSectionId }) {
  const router = useRouter();
  const config = useBoard((s) => s.config);
  const setConfig = useBoard((s) => s.setConfig);
  const stats = useBoard((s) => s.stats);
  const setStats = useBoard((s) => s.setStats);
  const pushToast = useBoard((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((next) => {
        if (!cancelled) setConfig(next);
      })
      .catch((e) => {
        if (!cancelled) {
          pushToast({
            kind: "error",
            message: e instanceof Error ? e.message : String(e),
          });
        }
      });
    getStats()
      .then((next) => {
        if (!cancelled) setStats(next);
      })
      .catch(() => {
        /* best effort */
      });
    return () => {
      cancelled = true;
    };
  }, [pushToast, setConfig, setStats]);

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

  const activeLabel =
    SETTINGS_SECTIONS.find((item) => item.id === section)?.label ?? "Settings";

  return (
    <AppShell>
      <div className="flex min-h-0 flex-1">
      <AppRail>
        <RailLink href="/" label="Back to board">
          <ArrowLeft className="h-4 w-4" />
        </RailLink>
        <div className="mt-2 inline-flex h-9 w-9 items-center justify-center rounded-md border border-accent bg-accent-soft text-accent-strong">
          <Settings2 className="h-4 w-4" />
        </div>
      </AppRail>

      <main className="flex min-w-0 flex-1 flex-col">
        <AppHeader className="sticky top-0">
          <div>
            <h1 className="text-[14px] font-semibold">Settings</h1>
            <div className="mt-0.5 text-[12px] text-ink-subtle">
              {activeLabel}
            </div>
          </div>
          <HeaderLink href="/">Board</HeaderLink>
        </AppHeader>

        <SettingsContent
          activeTab={section}
          onTabChange={(id) => router.push(`/settings/${id}`)}
          config={config}
          stats={stats}
          busy={busy}
          update={update}
          pushError={pushError}
          pushToast={pushToast}
          setBusy={setBusy}
          setConfig={setConfig}
        />
      </main>
      </div>
      <Toaster />
    </AppShell>
  );
}
