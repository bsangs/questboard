-- questboard SQLite schema.
-- Server is sole writer; dispatcher / UI read-only.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cards (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL,
  flavor          TEXT NOT NULL,
  priority        INTEGER NOT NULL,
  language        TEXT NOT NULL,
  scope           TEXT,
  estimated_loc   INTEGER,
  budget_minutes  INTEGER,
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  owner_pid       INTEGER,
  worktree        TEXT,
  wip_branch      TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  stuck_reason    TEXT,
  stuck_question  TEXT,
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  elapsed_seconds INTEGER NOT NULL DEFAULT 0,
  merged_sha      TEXT,
  done_at         TEXT,
  archived_at     TEXT,
  -- Helper liveness 3-strikes counter. Tracks consecutive ephemeral-helper
  -- deaths AT THE CURRENT STAGE. Resets on every status transition. When it
  -- reaches 3 the card is auto-cancelled instead of being revived again.
  -- See dispatcher StatsReporter + server recordHelperDeath().
  consecutive_deaths       INTEGER NOT NULL DEFAULT 0,
  consecutive_deaths_stage TEXT,
  -- Cached count of conversation comments (stuck/answer/resumed/review_note/note).
  -- Maintained by appendCommentRow + recomputed at bootstrap. UI list endpoint
  -- reads this so the badge doesn't show stale 0 on initial load.
  comment_count   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL,
  author    TEXT NOT NULL,
  kind      TEXT NOT NULL,
  body      TEXT NOT NULL
);

-- Audit log: state transitions, description edits, automatic events.
-- Mirrors history.jsonl on disk. Distinct from `comments` so the worker ↔
-- human conversation channel stays clean of audit noise.
CREATE TABLE IF NOT EXISTS history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id   TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ts        TEXT NOT NULL,
  author    TEXT NOT NULL,
  kind      TEXT NOT NULL,
  body      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_deps (
  card_id        TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  depends_on_id  TEXT NOT NULL REFERENCES cards(id),
  PRIMARY KEY (card_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS workers (
  pid             INTEGER PRIMARY KEY,
  card_id         TEXT NOT NULL REFERENCES cards(id),
  started_at      TEXT NOT NULL,
  last_heartbeat  TEXT NOT NULL,
  tokens_used     INTEGER NOT NULL DEFAULT 0
);

-- Hard-deleted cards are removed from `cards`, but their lifetime token
-- totals should remain in dashboard stats. This table is written just before
-- the card row is deleted.
CREATE TABLE IF NOT EXISTS deleted_card_token_totals (
  card_id       TEXT PRIMARY KEY,
  deleted_at    TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_status         ON cards(status);
CREATE INDEX IF NOT EXISTS idx_cards_priority       ON cards(priority, created_at);
CREATE INDEX IF NOT EXISTS idx_cards_status_prio    ON cards(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_card_ts     ON comments(card_id, ts);
CREATE INDEX IF NOT EXISTS idx_history_card_ts       ON history(card_id, ts);
CREATE INDEX IF NOT EXISTS idx_card_deps_depends_on ON card_deps(depends_on_id);

INSERT OR IGNORE INTO meta(key, value) VALUES ('next_card_id', '1');
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');
