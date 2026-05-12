import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

type BadgeTone =
  | "neutral"
  | "red"
  | "amber"
  | "blue"
  | "green"
  | "slate";

const toneClass: Record<BadgeTone, string> = {
  neutral: "bg-surface-muted text-ink-muted ring-border",
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  amber: "bg-amber-50 text-amber-700 ring-amber-200",
  blue: "bg-cyan-50 text-cyan-800 ring-cyan-200",
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
};

export function Badge({
  tone = "neutral",
  mono = false,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <span
      className={clsx(
        "inline-flex min-w-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10.5px] font-medium ring-1 ring-inset",
        mono && "font-mono",
        toneClass[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
