import clsx from "clsx";
import type { HTMLAttributes, ReactNode } from "react";

export function Panel({
  className,
  children,
  interactive = false,
  selected = false,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={clsx(
        "rounded-md border border-border bg-surface text-ink shadow-tile",
        interactive &&
          "transition-shadow hover:border-border-strong hover:shadow-tileHover",
        selected && "border-emerald-300 bg-surface-selected ring-1 ring-emerald-300",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function Surface({
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div
      className={clsx("rounded-md border border-border bg-surface-muted", className)}
      {...props}
    >
      {children}
    </div>
  );
}
