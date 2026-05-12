"use client";

import clsx from "clsx";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "soft";
type ButtonSize = "xs" | "sm" | "md";

const variantClass: Record<ButtonVariant, string> = {
  primary:
    "border-transparent bg-ink text-white shadow-sm hover:bg-slate-900 disabled:bg-ink/50",
  secondary:
    "border-border-strong bg-surface text-ink shadow-sm hover:bg-surface-muted",
  ghost:
    "border-transparent bg-transparent text-ink-muted hover:bg-surface-muted hover:text-ink",
  danger:
    "border-transparent bg-red-600 text-white shadow-sm hover:bg-red-700 disabled:bg-red-300",
  soft:
    "border-border bg-surface-muted text-ink-muted hover:bg-surface hover:text-ink",
};

const sizeClass: Record<ButtonSize, string> = {
  xs: "h-7 px-2 text-[11px]",
  sm: "h-8 px-2.5 text-[12px]",
  md: "h-9 px-3 text-[12.5px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant = "secondary",
    size = "sm",
    icon,
    children,
    type = "button",
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        variantClass[variant],
        sizeClass[size],
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton(
    {
      className,
      label,
      variant = "ghost",
      size = "sm",
      type = "button",
      children,
      ...props
    },
    ref,
  ) {
  const box = size === "xs" ? "h-7 w-7" : size === "sm" ? "h-8 w-8" : "h-9 w-9";
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={props.title ?? label}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-md border transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        variantClass[variant],
        box,
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
  },
);
