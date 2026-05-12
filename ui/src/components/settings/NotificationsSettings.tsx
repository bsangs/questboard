"use client";

import { Send } from "lucide-react";
import { patchConfig, testTelegram } from "@/lib/api";
import { useBoard } from "@/lib/state";
import type { BoardConfig } from "@/lib/types";
import { SettingsSection, Toggle } from "./shared";

type ConfigUpdate = (patch: Parameters<typeof patchConfig>[0]) => Promise<void>;

const NOTIFICATION_EVENTS: Array<{
  id: NonNullable<BoardConfig["notifications"]>["events"][number];
  label: string;
}> = [
  { id: "card_stuck", label: "Card stuck" },
  { id: "review_requested", label: "Review requested" },
  { id: "review_passed", label: "Review passed" },
  { id: "review_rejected", label: "Review rejected" },
  { id: "merge_started", label: "Merge started" },
  { id: "merge_failed", label: "Merge failed" },
  { id: "merge_done", label: "Merge done" },
  { id: "helper_crashed", label: "Helper crashed" },
  { id: "card_cancelled", label: "Card cancelled" },
];

export function NotificationsSettings({
  config,
  busy,
  update,
  pushToast,
  setBusy,
}: {
  config: ReturnType<typeof useBoard.getState>["config"];
  busy: boolean;
  update: ConfigUpdate;
  pushToast: ReturnType<typeof useBoard.getState>["pushToast"];
  setBusy: (v: boolean) => void;
}) {
  return (
    <>
      <SettingsSection title="Telegram">
        <div className="text-ink-muted">
          Env:{" "}
          <span className="font-mono text-ink">
            {config?.telegram_configured ? "configured" : "not set"}
          </span>
        </div>
        <div className="mt-2">
          <Toggle
            checked={!!config?.telegram_enabled}
            onChange={(v) => update({ telegram_enabled: v })}
            label="Send Telegram alerts"
          />
        </div>
        <button
          onClick={async () => {
            setBusy(true);
            try {
              await testTelegram();
              pushToast({
                kind: "success",
                message: "Test message sent.",
              });
            } catch (e) {
              pushToast({
                kind: "error",
                message: e instanceof Error ? e.message : String(e),
              });
            } finally {
              setBusy(false);
            }
          }}
          disabled={
            busy ||
            !config?.telegram_configured ||
            !config?.telegram_enabled
          }
          className="mt-2 inline-flex items-center gap-1.5 rounded border border-border-strong px-2.5 py-1 text-[12px] font-medium text-ink hover:bg-surface-muted disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" /> Send test message
        </button>
        <p className="mt-2 text-[11.5px] text-ink-subtle">
          Configure <code>BOT_TOKEN</code> and <code>CHAT_ID</code> in
          <code className="mx-1">.questboard/.env</code>.
        </p>
      </SettingsSection>

      <SettingsSection title="Notification events">
        <div className="grid grid-cols-1 gap-1.5 md:grid-cols-2 xl:grid-cols-3">
          {NOTIFICATION_EVENTS.map((event) => {
            const checked = !!config?.notifications?.events.includes(event.id);
            return (
              <label
                key={event.id}
                className="flex items-center gap-2 rounded border border-border px-2 py-1.5 text-[12.5px]"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy || !config}
                  onChange={(e) => {
                    const cur = config?.notifications?.events ?? [];
                    const events = e.target.checked
                      ? Array.from(new Set([...cur, event.id]))
                      : cur.filter((id) => id !== event.id);
                    update({
                      notifications: {
                        ...(config?.notifications ?? {}),
                        events,
                      },
                    });
                  }}
                />
                {event.label}
              </label>
            );
          })}
        </div>
      </SettingsSection>
    </>
  );
}
