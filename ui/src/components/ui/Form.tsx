"use client";

import clsx from "clsx";
import { forwardRef } from "react";
import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

export const controlClassName = (className?: string) =>
  clsx(
    "w-full rounded-md border border-border-strong bg-surface px-2.5 py-1.5 text-[12.5px] text-ink shadow-sm",
    "placeholder:text-ink-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-[var(--focus)]",
    "disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-subtle",
    className,
  );

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} {...props} className={controlClassName(className)} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return <textarea ref={ref} {...props} className={controlClassName(className)} />;
});

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select({ className, ...props }, ref) {
  return <select ref={ref} {...props} className={controlClassName(className)} />;
});

export function Field({
  label,
  description,
  children,
  className,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx("block space-y-1.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[12.5px] font-semibold text-ink">{label}</span>
        {description && (
          <span className="text-[11.5px] text-ink-subtle">{description}</span>
        )}
      </div>
      {children}
    </label>
  );
}

export function Switch({
  checked,
  disabled,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onChange(!checked);
      }}
      className={clsx(
        "flex w-full items-center justify-between gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left shadow-sm",
        "transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      <span className="min-w-0">
        <span className="block text-[12.5px] font-medium text-ink">{label}</span>
        {description && (
          <span className="mt-0.5 block text-[11.5px] text-ink-subtle">
            {description}
          </span>
        )}
      </span>
      <span
        className={clsx(
          "relative h-4 w-7 shrink-0 rounded-full transition-colors",
          checked ? "bg-accent" : "bg-slate-300",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-3 w-3 rounded-full bg-surface shadow-sm transition-all",
            checked ? "left-3.5" : "left-0.5",
          )}
        />
      </span>
    </button>
  );
}
