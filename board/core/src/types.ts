/**
 * questboard core types and schemas.
 */
import { z } from "zod";

// ─── Enums ───────────────────────────────────────────────────────────────────

export const CardStatus = z.enum([
  "backlog",
  "ready",
  "in_progress",
  "stuck",
  "human_review",
  "ai_review",
  // After approval (human OK or reviewer pass), the card sits in `merging`
  // while a Merger ephemeral worker runs ff-merge / conflict resolution
  // / final tests. Success → done. Conflict failure → in_progress (retry
  // by a fresh worker).
  "merging",
  "done",
  "cancelled",
]);
export type CardStatus = z.infer<typeof CardStatus>;

export const CardFlavor = z.enum(["feature", "bug", "refactor", "chore", "docs"]);
export type CardFlavor = z.infer<typeof CardFlavor>;

export const StuckReason = z.enum([
  "blocking",
  "checkpoint",
  "testing_failed",
  "resource_exhausted",
  "needs_split",
  "worker_failed",
  "worker_orphaned",
]);
export type StuckReason = z.infer<typeof StuckReason>;

export const CommentAuthor = z.enum(["human", "worker", "reviewer", "system"]);
export type CommentAuthor = z.infer<typeof CommentAuthor>;

export const CommentKind = z.enum([
  "stuck",
  "answer",
  "resumed",
  "review_note",
  // Informational note — any helper (worker/reviewer/merger) can post this
  // in their FINAL assistant message via a `## Notes` section. Posted as a
  // comment but does NOT change card status; the card still proceeds with
  // its main verdict (commit→review, PASS/REJECT, MERGED/FAILED).
  "note",
  // The two below are written to history.jsonl post-refactor, but stay in
  // CommentKind so legacy comments.jsonl entries (mixed pre-refactor) parse
  // cleanly through the same schema. Routing by file is done at the read
  // path via `isHistoryKind` / `isConversationKind`.
  "system_event",
  "description_updated",
]);
export type CommentKind = z.infer<typeof CommentKind>;

/** Kinds that belong in history.jsonl (audit log). */
export const HISTORY_KINDS = ["system_event", "description_updated"] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** Kinds that belong in comments.jsonl (worker ↔ human conversation). */
export const CONVERSATION_KINDS = ["stuck", "answer", "resumed", "review_note", "note"] as const;
export type ConversationKind = (typeof CONVERSATION_KINDS)[number];

export const isHistoryKind = (k: CommentKind): k is HistoryKind =>
  k === "system_event" || k === "description_updated";

export const isConversationKind = (k: CommentKind): k is ConversationKind =>
  k === "stuck" || k === "answer" || k === "resumed" || k === "review_note" || k === "note";

export const CardCreatedBy = z.enum(["human", "worker"]);
export type CardCreatedBy = z.infer<typeof CardCreatedBy>;

// ─── Frontmatter ─────────────────────────────────────────────────────────────

export const CardFrontmatter = z.object({
  id: z.string().regex(/^\d{4}$/),
  title: z.string().min(1),
  status: CardStatus,
  flavor: CardFlavor,
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  language: z.string().min(2).max(3), // ISO 639-1 (or fallback short codes)
  /** Optional Scope id (must match one of BoardConfig.scopes[].id). null = no scope. */
  scope: z.string().nullable().optional().default(null),
  deps: z.array(z.string().regex(/^\d{4}$/)).default([]),
  estimated_loc: z.number().int().nonnegative().nullable().optional(),
  budget_minutes: z.number().int().nonnegative().nullable().optional(),

  created_by: CardCreatedBy,
  created_at: z.string(),
  updated_at: z.string(),

  owner_pid: z.number().int().positive().nullable().default(null),
  worktree: z.string().nullable().default(null),
  wip_branch: z.string().nullable().default(null),

  attempts: z.number().int().nonnegative().default(0),
  stuck_reason: StuckReason.nullable().default(null),
  stuck_question: z.string().nullable().default(null),

  tokens_used: z.number().int().nonnegative().default(0),
  elapsed_seconds: z.number().int().nonnegative().default(0),

  /**
   * SHA of `origin/main` captured the moment the card transitioned into
   * `merging` (i.e. the base the merger was about to merge ON TOP OF).
   * Used to render the diff for `done` cards: ff merge means
   * `merge-base(origin/main, merged_sha) == merged_sha` post-merge, so
   * we need the pre-merge anchor to compute "what the worker added."
   * Null on cards created before this field shipped, or on cards that
   * never reached `merging`.
   */
  pre_merge_sha: z.string().nullable().default(null),
  merged_sha: z.string().nullable().default(null),
  done_at: z.string().nullable().default(null),
  archived_at: z.string().nullable().default(null),

  /**
   * Historical audit trail of post-build runs against this card. Kept so
   * cards created by older versions still parse and can show prior attempts:
   * timestamp, wall-clock duration, classification of the failure (or
   * "success"), and a short excerpt of the log tail used to classify.
   *
   * Capped at 20 entries (oldest dropped) so the frontmatter stays small
   * even on cards that hammered the same flaky deploy step many times.
   * Optional + default-empty so old card.md files parse cleanly.
   */
  post_build_attempts: z
    .array(
      z.object({
        ts: z.string(),
        duration_ms: z.number().int().nonnegative(),
        classification: z.enum(["success", "transient", "persistent", "unknown"]),
        reason_excerpt: z.string().default(""),
      }),
    )
    .default([]),
});
export type CardFrontmatter = z.infer<typeof CardFrontmatter>;

/** One row in `CardFrontmatter.post_build_attempts`. */
export type PostBuildAttempt = CardFrontmatter["post_build_attempts"][number];

/** Outcome of classifying a post-build failure (or success) by stderr/exit. */
export type PostBuildClassification =
  | "success"
  | "transient"
  | "persistent"
  | "unknown";

// Card = frontmatter + description body
export const Card = z.object({
  frontmatter: CardFrontmatter,
  description: z.string().default(""),
});
export type Card = z.infer<typeof Card>;

// ─── Comment ─────────────────────────────────────────────────────────────────

export const Comment = z.object({
  ts: z.string(),
  author: CommentAuthor,
  kind: CommentKind,
  body: z.string(),
});
export type Comment = z.infer<typeof Comment>;

/**
 * Audit-log entry. Same physical shape as Comment, but lives in
 * history.jsonl and only carries `system_event` / `description_updated`
 * kinds. Defined separately so producers can be type-checked without
 * leaking conversation kinds into the audit channel.
 */
export const HistoryEntry = z.object({
  ts: z.string(),
  author: CommentAuthor,
  kind: z.enum(HISTORY_KINDS),
  body: z.string(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

// ─── Worker (live tracking) ──────────────────────────────────────────────────

export const WorkerRow = z.object({
  pid: z.number().int().positive(),
  card_id: z.string().regex(/^\d{4}$/),
  started_at: z.string(),
  last_heartbeat: z.string(),
  tokens_used: z.number().int().nonnegative().default(0),
});
export type WorkerRow = z.infer<typeof WorkerRow>;

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * A "Scope" is a user-defined work-area tag (e.g. "Frontend", "Docs",
 * "Backend"). Each card optionally has one scope. The dispatcher injects
 * the scope's `description` into the spawn prompt of every helper for
 * that card so workers/reviewers/mergers see project-specific guidance.
 */
export const Scope = z.object({
  /** Stable id used in card frontmatter. lowercase ascii / dash. */
  id: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  /** Display label shown in UI. */
  label: z.string().min(1).max(60),
  /** Optional guidance prepended to the helper system prompt. */
  description: z.string().default(""),
  /**
   * Optional project-relative working directory for helpers spawned for
   * cards in this scope. When set, the dispatcher cd's into
   * `<worktree>/<cwd>` (workers) or `<boardRoot>/<cwd>` (reviewer/merger)
   * before running `claude`. Stored as a project-relative POSIX-style
   * path so it's portable across machines (e.g. `design-system` or
   * `questboard/ui/src`). null / empty = no override (use default cwd).
   */
  cwd: z.string().nullable().optional().default(null),
});
export type Scope = z.infer<typeof Scope>;

export const EnvVarName = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const RoleName = z.enum(["worker", "reviewer", "merger"]);
export type RoleName = z.infer<typeof RoleName>;

export const RoleEnvVar = z.object({
  name: EnvVarName,
  value: z.string().max(20_000).default(""),
});
export type RoleEnvVar = z.infer<typeof RoleEnvVar>;

export const RoleSecretEnvVar = z.object({
  name: EnvVarName,
  secret_ref: z.string().min(1).max(200),
});
export type RoleSecretEnvVar = z.infer<typeof RoleSecretEnvVar>;

export const RoleConfig = z.object({
  prompt_append: z.string().max(100_000).default(""),
});
export type RoleConfig = z.infer<typeof RoleConfig>;

export const RolesConfig = z.object({
  worker: RoleConfig.default({}),
  reviewer: RoleConfig.default({}),
  merger: RoleConfig.default({}),
});
export type RolesConfig = z.infer<typeof RolesConfig>;

export const EnvironmentConfig = z.object({
  env: z.array(RoleEnvVar).default([]),
  secret_env: z.array(RoleSecretEnvVar).default([]),
});
export type EnvironmentConfig = z.infer<typeof EnvironmentConfig>;

export const GitConfig = z.object({
  base_branch: z.string().min(1).max(160).default("main"),
  worker_branch_template: z
    .string()
    .min(1)
    .max(240)
    .default("worker/card-{card_id}"),
  worktree_template: z.string().min(1).max(240).default("card-{card_id}"),
  composer_worktree_template: z
    .string()
    .min(1)
    .max(240)
    .default("composer-{thread_id}"),
});
export type GitConfig = z.infer<typeof GitConfig>;

const ShellCommand = z.string().max(20_000).nullable();

export const MergeCommandStep = z.object({
  id: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9_-]*$/),
  label: z.string().min(1).max(80),
  command: ShellCommand.default(null),
  required: z.boolean().default(true),
});
export type MergeCommandStep = z.infer<typeof MergeCommandStep>;

const DEFAULT_MERGE_COMMAND_STEPS: MergeCommandStep[] = [
  {
    id: "checkout-base",
    label: "Checkout base",
    command: "git checkout {base_branch}",
    required: true,
  },
  {
    id: "fast-forward",
    label: "Fast-forward merge",
    command: "git merge --ff-only {wip_branch}",
    required: true,
  },
  {
    id: "delete-local-branch",
    label: "Delete local branch",
    command:
      "git worktree remove --force \"{worktree_path}\" 2>/dev/null || true; git branch -d {wip_branch}",
    required: false,
  },
];

const LEGACY_MERGE_COMMAND_LABELS: Record<string, string> = {
  fetch: "Fetch",
  checkout: "Checkout base",
  pull: "Pull base",
  ff_merge: "Fast-forward merge",
  push: "Push base",
  cleanup: "Cleanup branch",
  reset: "Reset on failure",
};

const LEGACY_DEFAULT_MERGE_COMMANDS: Record<string, string> = {
  fetch: "git fetch origin",
  checkout: "git checkout {base_branch}",
  pull: "git pull --ff-only origin {base_branch}",
  ff_merge: "git merge --ff-only origin/{wip_branch}",
  push: "git push origin {base_branch}",
  cleanup: "git push origin --delete {wip_branch}",
  reset: "git reset --hard origin/{base_branch}",
};

function normalizeMergeCommands(input: unknown): unknown {
  if (Array.isArray(input)) return input;
  if (!input || typeof input !== "object") return input;
  const record = input as Record<string, unknown>;
  const hasLegacyKey = Object.keys(LEGACY_MERGE_COMMAND_LABELS).some((key) =>
    Object.prototype.hasOwnProperty.call(record, key),
  );
  if (!hasLegacyKey) return undefined;
  const isOldDefault = Object.entries(LEGACY_DEFAULT_MERGE_COMMANDS).every(
    ([key, value]) => record[key] === value,
  );
  if (isOldDefault) return undefined;
  return Object.entries(LEGACY_MERGE_COMMAND_LABELS).map(([id, label]) => ({
    id,
    label,
    command: record[id] ?? null,
    required: id !== "cleanup",
  }));
}

export const MergeCommandsConfig = z.preprocess(
  normalizeMergeCommands,
  z.array(MergeCommandStep).default(DEFAULT_MERGE_COMMAND_STEPS),
);
export type MergeCommandsConfig = z.infer<typeof MergeCommandsConfig>;

export const StageCommandStage = z.enum([
  "in_progress",
  "ai_review",
  "merging",
  "stuck",
]);
export type StageCommandStage = z.infer<typeof StageCommandStage>;
export type StageCommandPhase = "pre" | "post";

export const StageCommand = z.object({
  pre: ShellCommand.default(null),
  post: ShellCommand.default(null),
});
export type StageCommand = z.infer<typeof StageCommand>;

export const StageCommandsConfig = z.object({
  in_progress: StageCommand.default({}),
  ai_review: StageCommand.default({}),
  merging: StageCommand.default({}),
  stuck: StageCommand.default({}),
});
export type StageCommandsConfig = z.infer<typeof StageCommandsConfig>;

export const CommandsConfig = z.object({
  merge: MergeCommandsConfig,
  stages: StageCommandsConfig.default({}),
});
export type CommandsConfig = z.infer<typeof CommandsConfig>;

export const NotificationEvent = z.enum([
  "card_stuck",
  "review_requested",
  "review_passed",
  "review_rejected",
  "merge_started",
  "merge_failed",
  "merge_done",
  "helper_crashed",
  "card_cancelled",
]);
export type NotificationEvent = z.infer<typeof NotificationEvent>;

export const NotificationsConfig = z.object({
  events: z
    .array(NotificationEvent)
    .default(["card_stuck", "review_requested", "merge_done", "helper_crashed"]),
});
export type NotificationsConfig = z.infer<typeof NotificationsConfig>;

export const FilesConfig = z.object({
  hidden_names: z
    .array(z.string().min(1).max(160))
    .default(["node_modules", ".git", ".next", "dist", "build", "out"]),
});
export type FilesConfig = z.infer<typeof FilesConfig>;

export const AuthConfig = z.object({
  bare_enabled: z.boolean().default(false),
  /** Derived server-side: true when ANTHROPIC_API_KEY is configured. */
  bare_available: z.boolean().optional(),
});
export type AuthConfig = z.infer<typeof AuthConfig>;

export const BoardConfig = z.object({
  version: z.number().int().positive().default(2),
  auto_review: z.boolean().default(false),
  concurrency_limit: z.number().int().positive().default(8),
  /**
   * User-controlled toggle: do we *want* Telegram notifications? Persisted
   * in `config.json`. Sending also requires `telegram_configured` (env-set
   * BOT_TOKEN+CHAT_ID); the server gates on BOTH.
   */
  telegram_enabled: z.boolean().default(false),
  /**
   * Derived (server-side, not persisted): true iff BOT_TOKEN+CHAT_ID env
   * vars are configured. UI uses this to show whether Telegram CAN send.
   */
  telegram_configured: z.boolean().optional(),
  /**
   * Derived (server-side, not persisted): true iff SECRET_KEY is present in
   * the runtime env, enabling encrypted role secret env creation.
   */
  secret_store_configured: z.boolean().optional(),
  /**
   * When true, the dispatcher loop skips ALL spawn rounds (worker, reviewer,
   * merger). Currently-running helpers continue until natural completion — we
   * never SIGTERM them on pause. Persisted, so a paused state survives server
   * restart; the user must explicitly flip it back to resume.
   */
  dispatch_paused: z.boolean().default(false),
  default_language: z.string().default("en"),
  /** User-managed list of scopes (work areas). */
  scopes: z.array(Scope).default([]),
  /**
   * Optional default scope id pre-selected when creating a new card. Must
   * match one of `scopes[].id` (or null = no default). Validated softly:
   * if the referenced scope is removed, the UI just falls back to "(none)".
   */
  default_scope: z.string().nullable().optional().default(null),
  /**
   * Max concurrent live `claude` processes for Composer threads. Soft
   * limit — threads themselves can exist without a process running
   * (idle/spun-down). When over the limit, the server queues the next
   * spawn until a slot frees. Default 3 keeps token spend bounded.
   */
  composer_concurrency: z.number().int().positive().default(3),
  git: GitConfig.default({}),
  commands: CommandsConfig.default({}),
  roles: RolesConfig.default({}),
  environment: EnvironmentConfig.default({}),
  auth: AuthConfig.default({}),
  notifications: NotificationsConfig.default({}),
  files: FilesConfig.default({}),
});
export type BoardConfig = z.infer<typeof BoardConfig>;

// ─── Composer ────────────────────────────────────────────────────────────────
//
// Composer = "Claude Code in the UI". A thread is a long-running chat with
// claude-code-in-stream-json, its own scratch worktree, and access to two
// MCP tools (`make_card`, `save_plan`) that go through a UI approval gate
// before actually creating cards / writing plan docs.
//
// The thread shape lives on disk at `cards/_composer/<thread-id>/meta.json`;
// the transcript is appended to `cards/_composer/<thread-id>/transcript.jsonl`
// (one JSON line per assistant turn / tool use / tool result / user message).

export const ComposerMessageRole = z.enum(["user", "assistant", "system"]);
export type ComposerMessageRole = z.infer<typeof ComposerMessageRole>;

/**
 * One transcript entry. Mirrors the parts of claude-code's stream-json
 * shape that we actually surface to the UI.
 */
export const ComposerMessage = z.object({
  id: z.string(),                  // monotonic per-thread (ulid or seq)
  ts: z.string(),
  role: ComposerMessageRole,
  /** Plain markdown chunks. Multiple per turn for tool-interspersed turns. */
  text: z.string().optional(),
  /** Tool call (Read / Edit / Bash / Write / make_card / save_plan / ...). */
  tool_use: z
    .object({
      id: z.string(),
      name: z.string(),
      input: z.unknown(),
    })
    .optional(),
  /** Result of a tool call. References the tool_use id above. */
  tool_result: z
    .object({
      tool_use_id: z.string(),
      content: z.string(),
      is_error: z.boolean().default(false),
    })
    .optional(),
  /**
   * Per-turn token usage as reported by claude-code (input +
   * cache_creation + cache_read = the row's input cost; output =
   * actual generation). Stored on every assistant turn so we can
   * compute lifetime totals and render per-turn cost.
   */
  usage: z
    .object({
      input_tokens: z.number().int().nonnegative().default(0),
      output_tokens: z.number().int().nonnegative().default(0),
    })
    .optional(),
});
export type ComposerMessage = z.infer<typeof ComposerMessage>;

/**
 * A make_card / save_plan tool call that's been intercepted and is
 * waiting for the user to Approve / Edit / Reject in the UI. Stored
 * separately so we don't lose pending decisions across server restart.
 */
export const ComposerPendingToolUse = z.object({
  id: z.string(),                          // matches ComposerMessage.tool_use.id
  thread_id: z.string(),
  name: z.enum(["make_card", "save_plan"]),
  input: z.unknown(),                      // original AI-proposed payload
  edited_input: z.unknown().optional(),    // user edits (preview), if any
  created_at: z.string(),
  /** Initially "pending". Approved/rejected = removed from the queue. */
  status: z.enum(["pending"]).default("pending"),
});
export type ComposerPendingToolUse = z.infer<typeof ComposerPendingToolUse>;

/**
 * What this thread ultimately produced. Multiple cards can stack; a
 * thread can also have produced one or more plan docs. Used for the
 * sidebar's "outcome" chip.
 */
export const ComposerOutcome = z.object({
  card_ids: z.array(z.string().regex(/^\d{4}$/)).default([]),
  plan_paths: z.array(z.string()).default([]),    // project-relative
});
export type ComposerOutcome = z.infer<typeof ComposerOutcome>;

export const ComposerProcessStatus = z.enum([
  "idle",         // no claude process attached
  "running",      // claude process alive, may be streaming
  "awaiting",     // tool_use pending user decision
  "error",        // last spawn died unexpectedly
]);
export type ComposerProcessStatus = z.infer<typeof ComposerProcessStatus>;

/** Sidebar / list summary. Full transcript loaded on demand. */
export const ComposerThreadSummary = z.object({
  id: z.string(),                         // ulid-ish, lowercase
  title: z.string(),                      // auto-generated from first msg
  created_at: z.string(),
  updated_at: z.string(),
  message_count: z.number().int().nonnegative().default(0),
  /** Lifetime input + output across every turn in this thread. */
  input_tokens: z.number().int().nonnegative().default(0),
  output_tokens: z.number().int().nonnegative().default(0),
  /** Working directory the spawned claude saw. Defaults to BOARD_ROOT. */
  cwd: z.string().nullable().default(null),
  status: ComposerProcessStatus.default("idle"),
  outcome: ComposerOutcome.default({ card_ids: [], plan_paths: [] }),
  /** True once user explicitly archives. v1: just hides from default sort. */
  archived: z.boolean().default(false),
  /**
   * Most recent claude-code session id (from stream-json system/init or
   * assistant events). Used to invoke `claude --resume <session_id>` on
   * respawn so we restore the actual model context instead of replaying
   * a synthesized history dump. Null until claude has emitted at least
   * one session_id, or after a resume failure clears it.
   */
  session_id: z.string().nullable().default(null),
  /**
   * Number of commits the composer worktree is behind origin/main.
   * Computed lazily by the server (on thread load and after sync-main).
   * Null = not yet computed (or compute failed). 0 = up to date. >0
   * means main has moved forward and the worktree's snapshot is stale;
   * the UI shows a "Sync" affordance to hard-reset to origin/main.
   */
  behind_main: z.number().int().nonnegative().nullable().default(null),
});
export type ComposerThreadSummary = z.infer<typeof ComposerThreadSummary>;

/** Full thread payload — summary + transcript + any pending tool uses. */
export const ComposerThread = ComposerThreadSummary.extend({
  messages: z.array(ComposerMessage).default([]),
  pending: z.array(ComposerPendingToolUse).default([]),
});
export type ComposerThread = z.infer<typeof ComposerThread>;

// ─── MCP tool I/O — make_card / save_plan ────────────────────────────────────
//
// These schemas double as (a) the MCP tool input definitions claude
// receives, (b) the over-the-wire shape between the UI preview and the
// server's commit endpoint, and (c) zod validators on the server.
// Same source of truth either way → no drift.

export const MakeCardInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().default(""),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  flavor: CardFlavor.default("feature"),
  /** Optional scope id; must match BoardConfig.scopes[].id or null. */
  scope: z.string().nullable().default(null),
  language: z.string().min(2).max(3).optional(),
  /**
   * deps may reference EITHER an existing card id (`"0091"`) OR another
   * card from the same Composer batch by zero-based index (`"#0"`,
   * `"#1"`). Server resolves `#N` references in commit order.
   */
  deps: z.array(z.string().regex(/^(?:\d{4}|#\d+)$/)).default([]),
  estimated_loc: z.number().int().nonnegative().nullable().optional(),
  budget_minutes: z.number().int().nonnegative().nullable().optional(),
});
export type MakeCardInput = z.infer<typeof MakeCardInput>;

export const SavePlanInput = z.object({
  /** Becomes filename slug. Lowercase ascii / dashes only. */
  slug: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(200),
  /** Full markdown body. Frontmatter prepended by the server. */
  body: z.string().min(1),
  /** Optional scope tag for the plan doc's frontmatter. */
  scope: z.string().nullable().default(null),
});
export type SavePlanInput = z.infer<typeof SavePlanInput>;

// ─── SSE event payloads ──────────────────────────────────────────────────────

export const SseEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("card_created"), card_id: z.string() }),
  z.object({ type: z.literal("card_updated"), card_id: z.string() }),
  z.object({ type: z.literal("card_status_changed"), card_id: z.string(), from: CardStatus, to: CardStatus }),
  z.object({ type: z.literal("card_archived"), card_id: z.string() }),
  // Server emits this when a card moves to `cancelled` so the dispatcher can SIGTERM
  // the running worker. Distinct from `card_status_changed` so dispatchers can
  // subscribe selectively.
  z.object({ type: z.literal("card_cancel_requested"), card_id: z.string() }),
  z.object({ type: z.literal("comment_added"), card_id: z.string(), comment: Comment }),
  z.object({ type: z.literal("history_added"), card_id: z.string(), entry: HistoryEntry }),
  z.object({
    type: z.literal("worker_heartbeat"),
    card_id: z.string(),
    pid: z.number(),
    role: z.enum(["worker", "reviewer", "merger"]).nullable(),
    tokens_used: z.number(),
    elapsed_seconds: z.number(),
    worker_input_tokens: z.number(),
    worker_output_tokens: z.number(),
    reviewer_input_tokens: z.number(),
    reviewer_output_tokens: z.number(),
    merger_input_tokens: z.number(),
    merger_output_tokens: z.number(),
  }),
  z.object({ type: z.literal("worker_started"), card_id: z.string(), pid: z.number() }),
  z.object({ type: z.literal("worker_ended"), card_id: z.string(), pid: z.number(), exit_code: z.number() }),
  z.object({ type: z.literal("config_changed"), config: BoardConfig }),
  // ── Composer events ────────────────────────────────────────────────────
  // Thread metadata changed (created / renamed / status flip / outcome
  // updated / deleted). Carries summary so the sidebar can patch in place
  // without a separate refetch. `deleted: true` signals removal.
  z.object({
    type: z.literal("composer_thread_changed"),
    thread_id: z.string(),
    summary: ComposerThreadSummary.optional(),
    deleted: z.boolean().optional(),
  }),
  // A new transcript message landed (streamed assistant chunk, tool use,
  // tool result, or echoed user message). The UI appends to its in-memory
  // transcript. For long assistant turns the server may emit this multiple
  // times with `partial: true` then a final non-partial event.
  z.object({
    type: z.literal("composer_message_appended"),
    thread_id: z.string(),
    message: ComposerMessage,
    partial: z.boolean().optional(),
  }),
  // make_card / save_plan tool_use was intercepted; UI should render the
  // preview gate. Carries the AI-proposed input verbatim so the user can
  // see/edit before approving.
  z.object({
    type: z.literal("composer_tool_pending"),
    thread_id: z.string(),
    pending: ComposerPendingToolUse,
  }),
  // Pending tool was Approved (committed), Edited+Approved, or Rejected.
  // Approved sends a real result back to claude; Rejected sends a tool_error
  // with the user's reason so the AI can retry / pivot.
  z.object({
    type: z.literal("composer_tool_resolved"),
    thread_id: z.string(),
    tool_use_id: z.string(),
    decision: z.enum(["approved", "rejected"]),
    /** Card id assigned (for make_card) or plan path written (save_plan). */
    result_ref: z.string().optional(),
  }),
  // Turn boundary signal. `in_flight` flips true on every stdin write
  // (user message / tool_result re-injection) and false on the next
  // `result` event from claude. UI uses this to drive the typing
  // indicator — the prior heuristic ("last message role !== assistant")
  // hides the indicator as soon as the first assistant chunk lands,
  // even though claude may still be mid-turn for many minutes on a
  // heavy context. This event is the authoritative signal.
  z.object({
    type: z.literal("composer_turn_state"),
    thread_id: z.string(),
    in_flight: z.boolean(),
  }),
]);
export type SseEvent = z.infer<typeof SseEvent>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

export const padCardId = (n: number): string => String(n).padStart(4, "0");
export const isCardId = (s: string): boolean => /^\d{4}$/.test(s);
