"use client";

import clsx from "clsx";
import { useEffect } from "react";
import { getStats } from "@/lib/api";
import { useBoard } from "@/lib/state";

function fmtTokens(t: number): string {
  if (t < 1000) return String(t);
  if (t < 1_000_000) return `${(t / 1000).toFixed(1)}K`;
  return `${(t / 1_000_000).toFixed(2)}M`;
}

/**
 * Compact inline stats — meant to slot into the top header bar.
 * Shows only the metrics that aren't already in the workers/queued pills:
 * tokens(24h), done(1d), stuck(1d). Stays a single horizontal row so it
 * never overlaps the board.
 */
export function StatsPanel() {
  const stats = useBoard((s) => s.stats);
  const setStats = useBoard((s) => s.setStats);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await getStats();
        if (!cancelled) setStats(s);
      } catch {
        // Silent — stats are best-effort.
      }
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [setStats]);

  if (!stats) return null;

  const stuck = stats.alerts_24h?.stuck ?? 0;
  const done = stats.alerts_24h?.done ?? 0;
  const inTotal = stats.tokens_input_total ?? 0;
  const outTotal = stats.tokens_output_total ?? 0;

  return (
    <div className="hidden items-center gap-2 text-[12px] text-ink-muted md:flex">
      <Pill
        label="↓ total"
        value={fmtTokens(inTotal)}
        accent="bg-indigo-50 text-indigo-700"
      />
      <Pill
        label="↑ total"
        value={fmtTokens(outTotal)}
        accent="bg-indigo-50 text-indigo-700"
      />
      <Pill label="done(1d)" value={String(done)} />
      <Pill
        label="stuck(1d)"
        value={String(stuck)}
        accent={stuck > 0 ? "text-amber-700 bg-amber-50" : undefined}
      />
    </div>
  );
}

function Pill({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <span
      className={clsx(
        "rounded bg-gray-100 px-1.5 py-0.5 font-mono whitespace-nowrap",
        accent,
      )}
    >
      <span className="text-ink-subtle">{label}</span>{" "}
      <span className="text-ink">{value}</span>
    </span>
  );
}
