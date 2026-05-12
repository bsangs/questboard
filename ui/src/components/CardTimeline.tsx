/**
 * Curated, grouped timeline of one card's lifecycle. The History tab is
 * a flat audit log; this view collapses the same data into "attempt"
 * groups (each spawn of worker / reviewer / merger plus the post-build
 * runs that followed) so the user can read what happened at a glance.
 *
 * Data sources (all already fetched by the drawer):
 *   - stages   ← /api/cards/:id/stages           (one row per spawn)
 *   - history  ← card.history                    (system_event entries)
 *   - comments ← card.comments                   (notes, stuck, …)
 *   - attempts ← card.frontmatter.post_build_attempts (audit trail)
 *
 * Grouping rule: each WORKER stage starts a new "Attempt N" group; reviewer
 * + merger + post-build rows that follow up to the next worker spawn all
 * belong to the same group. Cards that never had a worker (rare — direct
 * cancel, e.g.) fall under "Untracked".
 */
"use client";

import clsx from "clsx";
import type {
  CardStage,
  Comment,
  HistoryEntry,
  PostBuildAttempt,
} from "@/lib/types";

type TimelineRow =
  | { kind: "stage"; stage: CardStage }
  | { kind: "post_build"; attempt: PostBuildAttempt; index: number }
  | { kind: "history"; entry: HistoryEntry }
  | { kind: "comment"; comment: Comment };

interface AttemptGroup {
  /** "Attempt N" or "Untracked" for orphan rows. */
  label: string;
  /** Earliest timestamp in the group, used for chronological ordering. */
  startedAt: string;
  rows: TimelineRow[];
}

const STAGE_LABEL: Record<CardStage["role"], string> = {
  worker: "worker",
  reviewer: "ai_review",
  merger: "merger",
};

function fmtElapsed(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtDuration(ms: number): string {
  return fmtElapsed(Math.round(ms / 1000));
}

function fmtClock(iso: string): string {
  try {
    const d = new Date(iso);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(
      2,
      "0",
    )}:${String(d.getSeconds()).padStart(2, "0")}`;
  } catch {
    return iso;
  }
}

/**
 * Bucket every event into attempt groups. Worker spawns delimit groups;
 * everything in between (and trailing) joins the most recent worker group.
 * Rows from before the first worker fall into "Untracked".
 */
function buildGroups({
  stages,
  history,
  comments,
  attempts,
}: {
  stages: CardStage[];
  history: HistoryEntry[];
  comments: Comment[];
  attempts: PostBuildAttempt[];
}): AttemptGroup[] {
  // Materialize all rows with a sortable timestamp, then sweep.
  const all: { ts: string; row: TimelineRow }[] = [];
  for (const s of stages) all.push({ ts: s.started_at, row: { kind: "stage", stage: s } });
  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i]!;
    all.push({
      ts: a.ts,
      row: { kind: "post_build", attempt: a, index: i + 1 },
    });
  }
  for (const h of history) {
    // Skip super-noisy system events that the stage rows already imply.
    if (
      h.body.startsWith("status: ") ||
      h.body.startsWith("revive: ") ||
      h.body.startsWith("helper_revived")
    ) {
      // Keep only the meaningful ones — status events around stuck/done
      // tell the user "this is where the stage ended". The verbose ones
      // (in_progress → stuck etc.) are already implied by the stage row.
      if (
        !/→ stuck|→ done|→ cancelled|→ ready \(requeue\)|merger reported|MERGED|sha=/.test(
          h.body,
        )
      ) {
        continue;
      }
    }
    all.push({ ts: h.ts, row: { kind: "history", entry: h } });
  }
  for (const c of comments) {
    // Show worker/reviewer/human commentary; suppress purely-mechanical
    // resumed pings to keep the timeline readable.
    if (c.kind === "resumed") continue;
    all.push({ ts: c.ts, row: { kind: "comment", comment: c } });
  }

  all.sort((a, b) => a.ts.localeCompare(b.ts));

  const groups: AttemptGroup[] = [];
  let current: AttemptGroup | null = null;
  let workerCount = 0;

  for (const item of all) {
    if (item.row.kind === "stage" && item.row.stage.role === "worker") {
      workerCount++;
      current = {
        label: `Attempt ${workerCount}`,
        startedAt: item.ts,
        rows: [item.row],
      };
      groups.push(current);
      continue;
    }
    if (!current) {
      // Pre-worker rows (rare — direct cancel, manual card creation note).
      current = { label: "Untracked", startedAt: item.ts, rows: [] };
      groups.push(current);
    }
    current.rows.push(item.row);
  }

  return groups;
}

const CLASS_TONE: Record<PostBuildAttempt["classification"], string> = {
  success: "text-emerald-700",
  transient: "text-amber-700",
  persistent: "text-red-700",
  unknown: "text-ink-muted",
};

const CLASS_LABEL: Record<PostBuildAttempt["classification"], string> = {
  success: "OK",
  transient: "TRANSIENT",
  persistent: "PERSISTENT",
  unknown: "UNKNOWN",
};

const STAGE_TONE: Record<CardStage["role"], string> = {
  worker: "text-emerald-700",
  reviewer: "text-amber-700",
  merger: "text-blue-700",
};

function StageRow({ stage }: { stage: CardStage }) {
  const out = stage.output_tokens ?? 0;
  const inn = stage.input_tokens ?? 0;
  return (
    <div className="grid grid-cols-[80px_1fr_auto] items-baseline gap-2 font-mono text-[12px]">
      <span className="text-ink-subtle">{fmtClock(stage.started_at)}</span>
      <span>
        <span className={clsx("font-semibold", STAGE_TONE[stage.role])}>
          {STAGE_LABEL[stage.role]}#{stage.attempt}
        </span>
        <span className="ml-2 text-ink-muted">
          {fmtElapsed(stage.elapsed_seconds)}
        </span>
      </span>
      <span className="tabular-nums text-ink-subtle">
        ↓{Math.round(inn / 1000)}K · ↑{Math.round(out / 1000)}K
      </span>
    </div>
  );
}

function PostBuildRow({
  attempt,
  index,
}: {
  attempt: PostBuildAttempt;
  index: number;
}) {
  return (
    <div className="grid grid-cols-[80px_1fr_auto] items-baseline gap-2 font-mono text-[12px]">
      <span className="text-ink-subtle">{fmtClock(attempt.ts)}</span>
      <span>
        <span className="font-semibold text-blue-700">post-build #{index}</span>
        <span className="ml-2 text-ink-muted">
          {fmtDuration(attempt.duration_ms)}
        </span>
        <span className={clsx("ml-2", CLASS_TONE[attempt.classification])}>
          → {CLASS_LABEL[attempt.classification]}
        </span>
        {attempt.reason_excerpt && (
          <span className="ml-2 truncate text-ink-subtle" title={attempt.reason_excerpt}>
            {attempt.reason_excerpt}
          </span>
        )}
      </span>
      <span />
    </div>
  );
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  return (
    <div className="grid grid-cols-[80px_1fr_auto] items-baseline gap-2 font-mono text-[11.5px] text-ink-muted">
      <span className="text-ink-subtle">{fmtClock(entry.ts)}</span>
      <span className="truncate" title={entry.body}>
        {entry.body}
      </span>
      <span />
    </div>
  );
}

function CommentRow({ comment }: { comment: Comment }) {
  // Truncate long bodies in the timeline; the Comments tab carries the full
  // markdown render. We aim for at-a-glance "what was said".
  const oneLine = comment.body.replace(/\s+/g, " ").trim();
  const short = oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
  return (
    <div className="grid grid-cols-[80px_1fr_auto] items-baseline gap-2 text-[12px]">
      <span className="font-mono text-ink-subtle">{fmtClock(comment.ts)}</span>
      <span>
        <span className="font-mono text-[11px] text-ink-muted">
          {comment.author}:{comment.kind}
        </span>
        <span className="ml-2 italic text-ink-muted" title={comment.body}>
          “{short}”
        </span>
      </span>
      <span />
    </div>
  );
}

export interface CardTimelineProps {
  stages: CardStage[];
  history: HistoryEntry[];
  comments: Comment[];
  postBuildAttempts: PostBuildAttempt[];
}

export function CardTimeline({
  stages,
  history,
  comments,
  postBuildAttempts,
}: CardTimelineProps) {
  const groups = buildGroups({
    stages,
    history,
    comments,
    attempts: postBuildAttempts,
  });

  if (groups.length === 0) {
    return (
      <div className="text-[12.5px] text-ink-subtle">
        Nothing has happened on this card yet.
      </div>
    );
  }

  return (
    <ol className="space-y-4">
      {groups.map((g, i) => (
        <li
          key={`${i}-${g.startedAt}`}
          className="rounded-md border border-border bg-surface"
        >
          <div className="flex items-baseline justify-between border-b border-border px-3 py-1.5">
            <span className="text-[11.5px] font-semibold uppercase text-ink">
              {g.label}
            </span>
            <span className="font-mono text-[11px] text-ink-subtle">
              {fmtClock(g.startedAt)}
            </span>
          </div>
          <div className="space-y-1 px-3 py-2">
            {g.rows.map((row, j) => {
              switch (row.kind) {
                case "stage":
                  return <StageRow key={`s-${j}`} stage={row.stage} />;
                case "post_build":
                  return (
                    <PostBuildRow
                      key={`pb-${j}`}
                      attempt={row.attempt}
                      index={row.index}
                    />
                  );
                case "history":
                  return <HistoryRow key={`h-${j}`} entry={row.entry} />;
                case "comment":
                  return <CommentRow key={`c-${j}`} comment={row.comment} />;
              }
            })}
          </div>
        </li>
      ))}
    </ol>
  );
}
