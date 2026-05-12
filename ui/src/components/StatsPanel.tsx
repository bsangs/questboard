"use client";

import { useEffect } from "react";
import { getStats } from "@/lib/api";
import { useBoard } from "@/lib/state";
import { MetricPill } from "./patterns";

function fmtTokens(t: number): string {
  if (t < 1000) return String(t);
  if (t < 1_000_000) return `${(t / 1000).toFixed(1)}K`;
  return `${(t / 1_000_000).toFixed(2)}M`;
}

/**
 * Compact inline stats — meant to slot into the top header bar.
 * Shows only lifetime token metrics. Workers/queued live in Board.tsx so the
 * header stays compact.
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

  const inTotal = stats.tokens_input_total ?? 0;
  const outTotal = stats.tokens_output_total ?? 0;
  const allTotal = stats.tokens_total ?? inTotal + outTotal;

  return (
    <div className="hidden items-center gap-2 text-[12px] text-ink-muted md:flex">
      <Pill
        label="Σ total"
        value={fmtTokens(allTotal)}
        tone="slate"
      />
      <Pill
        label="↓ total"
        value={fmtTokens(inTotal)}
        tone="blue"
      />
      <Pill
        label="↑ total"
        value={fmtTokens(outTotal)}
        tone="blue"
      />
    </div>
  );
}

function Pill({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "blue" | "green" | "amber" | "red" | "slate";
}) {
  return <MetricPill label={label} value={value} tone={tone} />;
}
