import clsx from "clsx";
import type { ReactNode } from "react";

type Tone = "neutral" | "blue" | "green" | "amber" | "red" | "slate";

const toneClass: Record<Tone, string> = {
  neutral: "bg-surface-muted text-ink-muted ring-border",
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  blue: "bg-blue-50 text-blue-700 ring-blue-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
};

export function MetricPill({
  label,
  value,
  tone = "neutral",
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  tone?: Tone;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium ring-1 ring-inset",
        toneClass[tone],
        className,
      )}
    >
      {icon}
      <span className="text-current/70">{label}</span>
      <span className="font-mono text-ink">{value}</span>
    </span>
  );
}
