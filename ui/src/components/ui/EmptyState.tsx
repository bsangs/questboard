import clsx from "clsx";
import type { ReactNode } from "react";

export function EmptyState({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={clsx(
        "flex min-h-24 items-center justify-center px-4 text-center text-[12px] text-ink-subtle",
        className,
      )}
    >
      {children}
    </div>
  );
}
