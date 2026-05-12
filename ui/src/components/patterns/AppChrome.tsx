import clsx from "clsx";
import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  return <div className="flex h-screen flex-col bg-bg text-ink">{children}</div>;
}

export function AppHeader({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={clsx(
        "sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b border-border bg-surface/88 px-4 backdrop-blur md:gap-4 md:px-5",
        className,
      )}
    >
      {children}
    </header>
  );
}

export function AppRail({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={clsx(
        "flex w-14 shrink-0 flex-col items-center border-r border-border bg-surface/72 py-3 backdrop-blur",
        className,
      )}
    >
      {children}
    </aside>
  );
}

export function RailLink({
  href,
  label,
  children,
  className,
}: {
  href: string;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className={clsx(
        "inline-flex h-9 w-9 items-center justify-center rounded-md border border-transparent text-ink-muted",
        "transition-colors hover:border-border hover:bg-surface-muted hover:text-ink",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function HeaderLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={clsx(
        "inline-flex h-8 items-center justify-center rounded-md border border-border-strong bg-surface px-2.5 text-[12px] font-medium text-ink-muted shadow-sm",
        "transition-colors hover:bg-surface-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        className,
      )}
    >
      {children}
    </Link>
  );
}

export function SideNavButton({
  active,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={clsx(
        "rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        active
          ? "bg-accent-soft text-accent-strong ring-1 ring-inset ring-accent"
          : "text-ink-muted hover:bg-surface-muted hover:text-ink",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
