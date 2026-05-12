import clsx from "clsx";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button, IconButton } from "@/components/ui";

export function SelectionBar({
  count,
  onClear,
  children,
  className,
}: {
  count: number;
  onClear: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] shadow-popover",
        className,
      )}
    >
      <IconButton label="Clear selection" size="xs" onClick={onClear}>
        <X className="h-3.5 w-3.5" />
      </IconButton>
      <span className="whitespace-nowrap font-medium text-ink">
        <span className="font-mono">{count}</span> selected
      </span>
      <div className="ml-1 flex items-center gap-1.5">{children}</div>
    </div>
  );
}

export function SelectionModeToolbar({
  count,
  active,
  onEnter,
  onExit,
  onToggleAll,
  allSelected,
  action,
}: {
  count: number;
  active: boolean;
  onEnter: () => void;
  onExit: () => void;
  onToggleAll: () => void;
  allSelected: boolean;
  action: ReactNode;
}) {
  if (!active) {
    return (
      <Button variant="secondary" size="xs" onClick={onEnter}>
        Select
      </Button>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <IconButton label="Exit selection mode" size="xs" onClick={onExit}>
        <X className="h-3.5 w-3.5" />
      </IconButton>
      <span className="whitespace-nowrap text-[11px] font-medium text-ink">
        {count} selected
      </span>
      <Button variant="secondary" size="xs" onClick={onToggleAll} className="ml-auto">
        {allSelected ? "Unselect all" : "Select all"}
      </Button>
      {action}
    </div>
  );
}
