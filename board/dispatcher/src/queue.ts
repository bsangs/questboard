/**
 * Queue: pick the next ready card whose deps are all done, ordered by
 * priority asc + created_at asc (state-machine.md §4.2). Excludes any card
 * that has an unfinished dependency (§4.4).
 *
 * Concurrency cap is enforced by the caller — this module just answers
 * "what's the best candidate right now?" given the live SQLite snapshot.
 */
import type { Database as DBType } from "better-sqlite3";

export interface QueueCandidate {
  id: string;
  title: string;
  language: string;
  priority: number;
  attempts: number;
  status: string;
}

interface CardRow {
  id: string;
  title: string;
  language: string;
  priority: number;
  attempts: number;
  status: string;
  unresolved_deps: number;
}

const READY_QUERY = `
  SELECT
    c.id, c.title, c.language, c.priority, c.attempts, c.status,
    COALESCE((
      SELECT COUNT(*)
      FROM card_deps d
      JOIN cards parent ON parent.id = d.depends_on_id
      WHERE d.card_id = c.id AND parent.status != 'done'
    ), 0) AS unresolved_deps
  FROM cards c
  WHERE c.status = 'ready'
  ORDER BY c.priority ASC, c.created_at ASC, c.id ASC
`;

const COUNT_RUNNING = `SELECT COUNT(*) AS n FROM workers`;
const COUNT_RUNNING_BY_STATUS = `
  SELECT COUNT(*) AS n
  FROM workers w
  JOIN cards c ON c.id = w.card_id
  WHERE c.status = ?
`;

/**
 * Number of currently-tracked workers (per the workers table — server is
 * the writer, but its count is authoritative for cap enforcement).
 */
export function countRunningWorkers(db: DBType): number {
  const row = db.prepare(COUNT_RUNNING).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

export function countRunningByStatus(db: DBType, status: string): number {
  const row = db
    .prepare(COUNT_RUNNING_BY_STATUS)
    .get(status) as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * Yield ready cards in queue order, skipping those with unresolved deps.
 * Returns up to `limit` rows so the caller can spawn multiple in one tick
 * when slots are free.
 */
export function nextSpawnable(db: DBType, limit: number): QueueCandidate[] {
  if (limit <= 0) return [];
  const rows = db.prepare(READY_QUERY).all() as CardRow[];
  const out: QueueCandidate[] = [];
  for (const r of rows) {
    if (r.unresolved_deps > 0) continue;
    out.push({
      id: r.id,
      title: r.title,
      language: r.language,
      priority: r.priority,
      attempts: r.attempts,
      status: r.status,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Cards in ai_review that don't already have a worker tracked. */
const REVIEWABLE_QUERY = `
  SELECT
    c.id, c.title, c.language, c.priority, c.attempts, c.status,
    0 AS unresolved_deps
  FROM cards c
  WHERE c.status = 'ai_review'
    AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.card_id = c.id)
  ORDER BY c.priority ASC, c.created_at ASC, c.id ASC
`;

export function nextReviewable(db: DBType, limit: number): QueueCandidate[] {
  if (limit <= 0) return [];
  const rows = db.prepare(REVIEWABLE_QUERY).all() as CardRow[];
  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    title: r.title,
    language: r.language,
    priority: r.priority,
    attempts: r.attempts,
    status: r.status,
  }));
}

/**
 * Worker-revivable: cards stuck in `in_progress` whose helper has died with
 * NO live `workers` row to claim them. Normally an in_progress card has a
 * live worker; this query exists so the 3-strikes auto-revive path can
 * pick the card up on the next spawn round after StatsReporter dropped
 * the workers row. The card stays in_progress throughout — the consecutive_
 * deaths counter on the cards table tracks how many revives have been
 * attempted at this stage.
 */
const WORKER_REVIVABLE_QUERY = `
  SELECT
    c.id, c.title, c.language, c.priority, c.attempts, c.status,
    0 AS unresolved_deps
  FROM cards c
  WHERE c.status = 'in_progress'
    -- Defensive: claimCard only allows revive when owner_pid IS NULL,
    -- so picking up a card whose owner_pid is still set just bounces
    -- spawned workers off "already_claimed by <zombie>". The server's
    -- /exit endpoint and recovery path both clear owner_pid on death,
    -- but if either ever drifts we don't want to spam-spawn here.
    AND c.owner_pid IS NULL
    AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.card_id = c.id)
  ORDER BY c.priority ASC, c.created_at ASC, c.id ASC
`;

export function nextWorkerRevivable(db: DBType, limit: number): QueueCandidate[] {
  if (limit <= 0) return [];
  const rows = db.prepare(WORKER_REVIVABLE_QUERY).all() as CardRow[];
  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    title: r.title,
    language: r.language,
    priority: r.priority,
    attempts: r.attempts,
    status: r.status,
  }));
}

/**
 * True if there is a live `workers` row for any card currently in `merging`
 * — i.e. a merger is already running somewhere. Mergers are STRICTLY SERIAL
 * regardless of concurrency cap (see main.ts trySpawnRound merger round).
 * This catches both:
 *   - a merger this dispatcher just spawned (registerHelper wrote the row),
 *   - a merger inherited from a previous dispatcher generation (recovery).
 */
const MERGER_ACTIVE_QUERY = `
  SELECT 1 AS x
  FROM workers w
  JOIN cards c ON c.id = w.card_id
  WHERE c.status = 'merging'
  LIMIT 1
`;

export function isAnyMergerActive(db: DBType): boolean {
  const row = db.prepare(MERGER_ACTIVE_QUERY).get() as { x: number } | undefined;
  return row != null;
}

/** Cards waiting in the merging column with no active merger. */
const MERGEABLE_QUERY = `
  SELECT
    c.id, c.title, c.language, c.priority, c.attempts, c.status,
    0 AS unresolved_deps
  FROM cards c
  WHERE c.status = 'merging'
    AND NOT EXISTS (SELECT 1 FROM workers w WHERE w.card_id = c.id)
  ORDER BY c.priority ASC, c.created_at ASC, c.id ASC
`;

export function nextMergeable(db: DBType, limit: number): QueueCandidate[] {
  if (limit <= 0) return [];
  const rows = db.prepare(MERGEABLE_QUERY).all() as CardRow[];
  return rows.slice(0, limit).map((r) => ({
    id: r.id,
    title: r.title,
    language: r.language,
    priority: r.priority,
    attempts: r.attempts,
    status: r.status,
  }));
}
