"use client";

// Re-export domain types from @questboard/core. Use `type` imports so the UI
// does not have a runtime dependency on zod schemas. (Runtime parsing can be
// added selectively in api.ts if needed.)
export type {
  Card,
  CardFrontmatter,
  CardStatus,
  CardFlavor,
  StuckReason,
  PostBuildAttempt,
  PostBuildClassification,
  Comment,
  CommentAuthor,
  CommentKind,
  HistoryEntry,
  HistoryKind,
  BoardConfig,
  RoleName,
  SseEvent,
  Scope,
  WorkerRow,
  ComposerMessage,
  // Transcript rows for the read-only Transcript tab on the card drawer.
  // Same shape as ComposerMessage (text / tool_use / tool_result / usage),
  // but the server parses them out of raw claude-code stream-json files
  // (worker/reviewer/merger transcripts), not out of a Composer thread.
  // Re-exported under a domain name so UI call sites don't have to know
  // the storage shape happens to coincide.
  ComposerMessage as TranscriptMessage,
  ComposerMessageRole,
  ComposerPendingToolUse,
  ComposerOutcome,
  ComposerProcessStatus,
  ComposerThread,
  ComposerThreadSummary,
  MakeCardInput,
  SavePlanInput,
} from "@questboard/core";

// UI-only summary type for list/board view (matches `GET /api/cards`).
export interface CardSummary {
  id: string;
  title: string;
  status: import("@questboard/core").CardStatus;
  flavor: import("@questboard/core").CardFlavor;
  priority: 1 | 2 | 3;
  language: string;
  /** Scope id (matches one of BoardConfig.scopes[].id). null = no scope. */
  scope?: string | null;
  created_at: string;
  updated_at: string;
  owner_pid: number | null;
  attempts: number;
  stuck_reason: import("@questboard/core").StuckReason | null;
  stuck_question: string | null;
  /** Current context-window tokens for the active/latest helper, not input+output usage. */
  tokens_used: number;
  elapsed_seconds: number;
  /**
   * SHA pushed to origin/main when the merger finished. Non-null means the
   * card's code is already shipped — the UI uses this to decide which DnD
   * targets / drawer actions are valid for stuck cards (single source of
   * truth: STUCK_TRANSITIONS in @questboard/core).
   */
  merged_sha?: string | null;
  comment_count?: number;
  /**
   * Per-role lifetime output_tokens. Summed across every transcript file
   * for this card (cumulative work produced, not current context size).
   * Server recomputes on every heartbeat; backfilled at bootstrap so old
   * cards have non-zero values once their next heartbeat fires (or on
   * server restart).
   */
  worker_input_tokens?: number;
  worker_output_tokens?: number;
  reviewer_input_tokens?: number;
  reviewer_output_tokens?: number;
  merger_input_tokens?: number;
  merger_output_tokens?: number;
  deps?: string[];
  blocked_by?: string[]; // unresolved deps
  queued?: boolean; // ready but no spawn slot
  /** Internal flag — frontmatter parse failed. */
  broken?: boolean;
}

export interface BoardStats {
  active_workers: number;
  queued_cards: number;
  tokens_24h: number;
  /**
   * Lifetime sum of input + output tokens across every card (archived
   * included). Survives archive. Kept for back-compat; the split fields
   * below give the input/output breakdown.
   */
  tokens_total: number;
  tokens_input_total?: number;
  tokens_output_total?: number;
  alerts_24h: {
    stuck: number;
    human_review: number;
    worker_failed: number;
    done: number;
  };
  concurrency_limit: number;
}

export interface CardDiff {
  raw: string;
  files: Array<{
    path: string;
    additions: number;
    deletions: number;
    hunks?: Array<{ header: string; lines: string[] }>;
  }>;
}

export type StageRole = "worker" | "reviewer" | "merger";
export interface CardStage {
  transcript: string;
  role: StageRole;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  elapsed_seconds: number | null;
  context_tokens: number;
  input_tokens?: number;
  output_tokens: number;
}
