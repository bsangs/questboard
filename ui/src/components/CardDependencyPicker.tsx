"use client";

import clsx from "clsx";
import { Plus, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { COLUMNS, useBoard } from "@/lib/state";
import type { CardSummary, CardStatus } from "@/lib/types";
import { IconButton, Input } from "./ui";

const STATUS_LABEL = new Map<CardStatus, string>(
  COLUMNS.map((column) => [column.id, column.label]),
);

function normalizeDeps(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = raw.replace(/^#|^card-/i, "").trim();
    if (!/^\d{4}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function cardMatches(card: CardSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [card.id, `card-${card.id}`, card.title, card.status, card.scope]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .includes(q);
}

export function CardDependencyPicker({
  value,
  onChange,
  currentCardId,
  disabled,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  currentCardId?: string;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const cardsById = useBoard((s) => s.cards);
  const scopes = useBoard((s) => s.config?.scopes) ?? [];
  const selected = useMemo(() => normalizeDeps(value), [value]);
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const scopeLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const scope of scopes) map.set(scope.id, scope.label);
    return map;
  }, [scopes]);

  const availableCards = useMemo(
    () =>
      Object.values(cardsById)
        .filter((card) => card.id !== currentCardId)
        .filter((card) => !selectedSet.has(card.id))
        .filter((card) => cardMatches(card, query))
        .sort(
          (a, b) =>
            a.priority - b.priority ||
            a.status.localeCompare(b.status) ||
            b.updated_at.localeCompare(a.updated_at),
        )
        .slice(0, 12),
    [cardsById, currentCardId, query, selectedSet],
  );

  const add = (id: string) => {
    if (disabled || id === currentCardId || selectedSet.has(id)) return;
    onChange([...selected, id]);
    setQuery("");
  };

  const remove = (id: string) => {
    if (disabled) return;
    onChange(selected.filter((dep) => dep !== id));
  };

  return (
    <div className={clsx("space-y-2", disabled && "opacity-60")}>
      <div className="flex flex-wrap gap-1.5">
        {selected.length === 0 ? (
          <span className="text-[12px] text-ink-subtle">No dependencies selected.</span>
        ) : (
          selected.map((id) => {
            const card = cardsById[id];
            return (
              <span
                key={id}
                className="inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-surface-muted px-1.5 py-1 text-[11.5px]"
              >
                <span className="shrink-0 font-mono text-ink-muted">card-{id}</span>
                <span className="truncate text-ink-subtle">
                  {card?.title ?? "not visible on board"}
                </span>
                <IconButton
                  label={`Remove card-${id} dependency`}
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  className="h-5 w-5 border-0"
                  onClick={() => remove(id)}
                >
                  <X className="h-3 w-3" />
                </IconButton>
              </span>
            );
          })
        )}
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-subtle" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          disabled={disabled}
          placeholder="Filter available dependencies"
          className="h-8 pl-8 text-[12.5px]"
          aria-label="Filter available dependency cards"
        />
      </div>

      <div className="max-h-44 overflow-y-auto rounded-md border border-border bg-surface">
        {availableCards.length === 0 ? (
          <div className="px-3 py-4 text-center text-[12px] text-ink-subtle">
            No available cards.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {availableCards.map((card) => {
              const scopeLabel = card.scope
                ? scopeLabels.get(card.scope) ?? card.scope
                : null;
              return (
                <button
                  key={card.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => add(card.id)}
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] disabled:cursor-not-allowed"
                >
                  <span className="rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">
                    {card.id}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-ink">
                      {card.title}
                    </span>
                    <span className="block truncate text-[11px] text-ink-subtle">
                      {STATUS_LABEL.get(card.status) ?? card.status}
                      {scopeLabel ? ` · ${scopeLabel}` : ""}
                    </span>
                  </span>
                  <Plus className="h-3.5 w-3.5 shrink-0 text-ink-subtle" />
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
