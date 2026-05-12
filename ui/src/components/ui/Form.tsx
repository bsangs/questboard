"use client";

import clsx from "clsx";
import { Check, ChevronDown } from "lucide-react";
import {
  Children,
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ChangeEvent,
  InputHTMLAttributes,
  OptionHTMLAttributes,
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

interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

function readOptions(children: ReactNode): SelectOption[] {
  return Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const props = child.props as OptionHTMLAttributes<HTMLOptionElement>;
      const value =
        props.value === undefined ? String(props.children ?? "") : String(props.value);
      return {
        value,
        label: props.children,
        disabled: !!props.disabled,
      };
    });
}

function withFieldA11y(
  children: ReactNode,
  controlId: string,
  labelId: string,
): ReactNode {
  let attached = false;
  return Children.map(children, (child) => {
    if (attached || !isValidElement<Record<string, unknown>>(child)) {
      return child;
    }
    attached = true;
    const patch: Record<string, unknown> = {};
    if (child.props.id == null) patch.id = controlId;
    if (
      child.props["aria-label"] == null &&
      child.props["aria-labelledby"] == null
    ) {
      patch["aria-labelledby"] = labelId;
    }
    return cloneElement(child, patch);
  });
}

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement>
>(function Select(
  {
    className,
    children,
    value,
    defaultValue,
    onChange,
    disabled,
    name,
    required,
    id,
    title,
    "aria-label": ariaLabel,
    "aria-labelledby": ariaLabelledBy,
  },
  ref,
) {
  const generatedId = useId();
  const listboxId = `${id ?? generatedId}-listbox`;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const rootAutoWidth = /\bw-auto\b/.test(String(className ?? ""));
  const options = useMemo(() => readOptions(children), [children]);
  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState(() =>
    String(defaultValue ?? options[0]?.value ?? ""),
  );
  const [open, setOpen] = useState(false);
  const selectedValue = String(isControlled ? value ?? "" : internalValue);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === selectedValue),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const selected = options.find((option) => option.value === selectedValue);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    setActiveIndex(selectedIndex);
  }, [selectedIndex]);

  const commit = (next: string) => {
    if (disabled || next === selectedValue) {
      setOpen(false);
      return;
    }
    if (!isControlled) setInternalValue(next);
    onChange?.({
      target: { value: next },
      currentTarget: { value: next },
    } as ChangeEvent<HTMLSelectElement>);
    setOpen(false);
  };

  const moveActive = (delta: number) => {
    if (options.length === 0) return;
    let next = activeIndex;
    for (let i = 0; i < options.length; i += 1) {
      next = (next + delta + options.length) % options.length;
      if (!options[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  return (
    <div
      ref={rootRef}
      className={clsx("relative", rootAutoWidth ? "inline-block w-auto" : "w-full")}
    >
      <select
        ref={ref}
        id={id}
        value={selectedValue}
        onChange={onChange ?? (() => {})}
        disabled={disabled}
        name={name}
        required={required}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      >
        {children}
      </select>
      <button
        type="button"
        role="combobox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-activedescendant={
          open ? `${listboxId}-option-${activeIndex}` : undefined
        }
        disabled={disabled}
        title={title}
        className={clsx(
          controlClassName(
            clsx(
              "flex min-h-8 items-center justify-between gap-2 pr-8 text-left transition-colors",
              "hover:bg-surface-muted active:-translate-y-px",
              open && "border-accent ring-2 ring-[var(--focus)]",
              className,
            ),
          ),
          "relative",
        )}
        onClick={() => {
          if (!disabled) setOpen((v) => !v);
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            moveActive(1);
            return;
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
            moveActive(-1);
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            setOpen(false);
            return;
          }
          if ((event.key === "Enter" || event.key === " ") && open) {
            event.preventDefault();
            const option = options[activeIndex];
            if (option && !option.disabled) commit(option.value);
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected?.label ?? selectedValue}
        </span>
        <ChevronDown
          className={clsx(
            "pointer-events-none absolute right-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-60 w-full min-w-[180px] overflow-y-auto rounded-md border border-border-strong bg-surface p-1 shadow-[0_18px_44px_-28px_rgba(15,23,42,0.75)]"
        >
          {options.map((option, index) => {
            const selectedOption = option.value === selectedValue;
            const active = index === activeIndex;
            return (
              <button
                key={option.value}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={selectedOption}
                disabled={option.disabled}
                className={clsx(
                  "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12.5px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)]",
                  option.disabled
                    ? "cursor-not-allowed text-ink-subtle/60"
                    : active
                      ? "bg-accent-soft text-ink"
                      : "text-ink hover:bg-surface-muted",
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => commit(option.value)}
              >
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {selectedOption ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-accent-strong" />
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

export function Field({
  label,
  description,
  hint,
  required = false,
  children,
  className,
}: {
  label: string;
  description?: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const controlId = `${id}-control`;
  const help = description ?? hint;
  return (
    <div className={clsx("block space-y-1.5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span id={labelId} className="text-[12.5px] font-semibold text-ink">
          {label}
          {required && <span className="text-red-500"> *</span>}
        </span>
        {help && (
          <span className="text-[11.5px] text-ink-subtle">{help}</span>
        )}
      </div>
      {withFieldA11y(children, controlId, labelId)}
    </div>
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
