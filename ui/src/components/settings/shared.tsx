"use client";

import clsx from "clsx";
import { Plus, Trash2 } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import {
  Button,
  Field,
  IconButton,
  Select,
  Surface,
  Switch,
  controlClassName as uiControlClassName,
} from "@/components/ui";

export function controlClassName(className?: string): string {
  return uiControlClassName(className);
}

export function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase text-ink-subtle">
        {title}
      </h3>
      {children}
    </section>
  );
}

export function SettingsField({
  label,
  description,
  children,
}: {
  label: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Surface className="p-3">
      <Field label={label} description={description}>
        {children}
      </Field>
    </Surface>
  );
}

export function SelectControl({
  className,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <Select {...props} className={className} />;
}

export function DraftTextInput({
  value,
  disabled,
  onCommit,
  className,
}: {
  value: string;
  disabled: boolean;
  onCommit: (v: string) => void;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const lastServerValue = useRef(value);

  useEffect(() => {
    if (draft === lastServerValue.current) setDraft(value);
    lastServerValue.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const next = e.target.value.trim();
        if (next !== value) onCommit(next);
      }}
      disabled={disabled}
      className={clsx(controlClassName(), className)}
    />
  );
}

export function DraftTextArea({
  value,
  disabled,
  onCommit,
  rows = 4,
  placeholder,
}: {
  value: string;
  disabled: boolean;
  onCommit: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState(value);
  const lastServerValue = useRef(value);

  useEffect(() => {
    if (draft === lastServerValue.current) setDraft(value);
    lastServerValue.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const dirty = draft !== value;

  return (
    <>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={false}
        className={controlClassName("resize-y p-2 font-mono text-[12px] leading-snug")}
      />
      <div className="mt-1 flex items-center gap-2">
        <Button
          type="button"
          disabled={!dirty || disabled}
          onClick={() => onCommit(draft)}
          size="xs"
        >
          Save
        </Button>
        <Button
          type="button"
          disabled={!dirty || disabled}
          onClick={() => setDraft(value)}
          variant="ghost"
          size="xs"
        >
          Reset
        </Button>
      </div>
    </>
  );
}

export function StringListEditor({
  values,
  disabled,
  placeholder,
  onChange,
}: {
  values: string[];
  disabled: boolean;
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="space-y-2">
      {values.map((value, index) => (
        <div key={`${value}-${index}`} className="flex items-center gap-2">
          <input
            defaultValue={value}
            onBlur={(e) => {
              const next = [...values];
              next[index] = e.target.value;
              onChange(next.filter((item) => item.trim() !== ""));
            }}
            disabled={disabled}
            className={controlClassName("min-w-0 flex-1 font-mono text-[12px]")}
          />
          <IconButton
            type="button"
            disabled={disabled}
            onClick={() => onChange(values.filter((_, i) => i !== index))}
            label="Remove item"
            variant="ghost"
            size="xs"
            className="hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      ))}
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className={controlClassName("min-w-0 flex-1 font-mono text-[12px]")}
        />
        <Button
          type="button"
          disabled={disabled || !draft.trim()}
          onClick={() => {
            const value = draft.trim();
            if (!value || values.includes(value)) return;
            onChange([...values, value]);
            setDraft("");
          }}
          size="sm"
          icon={<Plus className="h-3.5 w-3.5" />}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return <Switch checked={checked} disabled={disabled} onChange={onChange} label={label} />;
}
