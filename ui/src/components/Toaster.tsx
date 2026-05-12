"use client";

import clsx from "clsx";
import { X } from "lucide-react";
import { useBoard } from "@/lib/state";

export function Toaster() {
  const toasts = useBoard((s) => s.toasts);
  const dismiss = useBoard((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "pointer-events-auto flex max-w-md items-start gap-3 rounded-md border px-3 py-2 text-[12.5px] shadow-popover animate-fadeIn",
            t.kind === "error" &&
              "border-red-200 bg-red-50 text-red-800",
            t.kind === "success" &&
              "border-emerald-200 bg-emerald-50 text-emerald-900",
            t.kind === "info" && "border-border bg-surface text-ink",
          )}
          role="status"
        >
          <span className="flex-1">{t.message}</span>
          <button
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
            className="-mr-1 rounded p-0.5 text-ink-subtle hover:bg-surface-muted"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
