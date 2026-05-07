/**
 * Card state-machine.
 *
 * Encodes which transitions are allowed and which actor (trigger) initiates each.
 * Server is responsible for enforcing this at API boundaries.
 */
import type { CardStatus } from "./types.js";

export type TransitionTrigger = "human" | "worker" | "reviewer" | "dispatcher" | "server";

export interface Transition {
  from: CardStatus;
  to: CardStatus;
  trigger: TransitionTrigger;
  /** Short identifier referenced from state-machine.md table. */
  id: string;
}

export const TRANSITIONS: ReadonlyArray<Transition> = [
  // §2 transitions
  { id: "T2", from: "backlog", to: "ready", trigger: "human" },
  // T2b: pull a card BACK from ready to backlog (human "I changed my mind"
  // before the dispatcher claims it). Mirror of T2; safe at any time the
  // card is still in `ready` because no worker has claimed it yet.
  { id: "T2b", from: "ready", to: "backlog", trigger: "human" },
  { id: "T3", from: "ready", to: "in_progress", trigger: "dispatcher" },
  { id: "T4", from: "in_progress", to: "stuck", trigger: "worker" },
  // Helpers (reviewer / merger) can also escalate to stuck via an explicit
  // STUCK marker in their final assistant message. Dispatcher routes this.
  { id: "T4r", from: "ai_review", to: "stuck", trigger: "reviewer" },
  { id: "T4m", from: "merging", to: "stuck", trigger: "dispatcher" },
  { id: "T5", from: "stuck", to: "ready", trigger: "server" }, // auto on kind=answer
  { id: "T6", from: "in_progress", to: "human_review", trigger: "worker" },
  // Approval flows now route through `merging` (Merger role does the actual
  // ff-merge + conflict resolution).
  { id: "T7", from: "human_review", to: "merging", trigger: "human" },
  { id: "T8", from: "human_review", to: "in_progress", trigger: "human" },
  { id: "T9", from: "human_review", to: "ai_review", trigger: "server" }, // auto_review ON
  { id: "T10", from: "human_review", to: "ai_review", trigger: "human" },
  { id: "T11", from: "ai_review", to: "merging", trigger: "reviewer" },
  { id: "T12", from: "ai_review", to: "in_progress", trigger: "reviewer" },
  // Merger transitions
  { id: "T11b", from: "merging", to: "done", trigger: "dispatcher" }, // Merger success
  { id: "T11c", from: "merging", to: "in_progress", trigger: "dispatcher" }, // Merger conflict-fail
  // T13 (any → cancelled) is handled separately below
  { id: "T14", from: "cancelled", to: "backlog", trigger: "human" },

  // ── Stuck-with-merged_sha recovery transitions ─────────────────────────────
  // These are guarded BOTH at this state-machine layer (canTransition) AND at
  // the server-side route handler (which inspects merged_sha to decide which
  // ones are actually legal for the card). See STUCK_TRANSITIONS below for the
  // single source of truth that the server / DnD / drawer all consult.
  //
  // T-stuck-merging: stuck → merging (manual retry-post-build). Only valid
  //   when the card's merged_sha is non-null — re-run the user-configured
  //   post-build command without re-spawning a worker.
  { id: "T-stuck-merging", from: "stuck", to: "merging", trigger: "human" },
  // T-stuck-done: stuck → done (force). Also only valid when merged_sha is
  //   non-null — the worker's code IS already on origin/main; the user is
  //   explicitly accepting that the post-build/deploy step won't pass.
  { id: "T-stuck-done", from: "stuck", to: "done", trigger: "human" },
  // T-done-cancelled: limited reopen escape from done. Cancels tracking; does
  //   NOT revert the merge. Used when work shipped but the card itself was
  //   wrong (duplicate, mis-scoped, etc.).
  { id: "T-done-cancelled", from: "done", to: "cancelled", trigger: "human" },
  // Generic re-queue: drag back to Ready from any waiting/blocked column.
  { id: "TR-h", from: "human_review", to: "ready", trigger: "human" },
  { id: "TR-a", from: "ai_review", to: "ready", trigger: "human" },
  { id: "TR-s", from: "stuck", to: "ready", trigger: "human" },
  { id: "TR-i", from: "in_progress", to: "ready", trigger: "human" },
  { id: "TR-m", from: "merging", to: "ready", trigger: "human" },

  // ff-merge failure recovery (§6.4) on the server side too (kept for
  // direct-merge fallback paths if any remain).
  { id: "T6.4-h", from: "human_review", to: "in_progress", trigger: "server" },
  { id: "T6.4-a", from: "ai_review", to: "in_progress", trigger: "server" },
];

export const ALL_NON_CANCELLED_STATES: ReadonlyArray<CardStatus> = [
  "backlog",
  "ready",
  "in_progress",
  "stuck",
  "human_review",
  "ai_review",
  "merging",
  "done",
];

export function canTransition(from: CardStatus, to: CardStatus, trigger: TransitionTrigger): boolean {
  // Cancel is allowed from anywhere (T13).
  if (to === "cancelled" && trigger === "human") return true;
  return TRANSITIONS.some((t) => t.from === from && t.to === to && t.trigger === trigger);
}

export function nextStates(from: CardStatus): CardStatus[] {
  const set = new Set<CardStatus>();
  for (const t of TRANSITIONS) if (t.from === from) set.add(t.to);
  // Cancel always allowed.
  set.add("cancelled");
  return [...set];
}

/** Transitions that the server may execute on behalf of "automatic" rules. */
export function isServerAutoTransition(t: Transition): boolean {
  return t.trigger === "server";
}

// ─── Stuck-card transition policy (single source of truth) ───────────────────
//
// `merged_sha` is THE signal that decides what a stuck card can become:
//
//   merged_sha == null →
//     The worker's code never landed on origin/main. The only sane recovery
//     is to put the card back into the queue so a fresh worker can take
//     another swing. (Retains current behavior.)
//
//   merged_sha != null →
//     The worker's code IS on origin/main; only a downstream step (post-
//     build, deploy gate, vercel push, …) failed. Sending this card back to
//     `ready` would re-spawn a worker on already-merged work → conflict /
//     no-op / data loss. Allowed recoveries instead are:
//       - retry the post-build (stuck → merging, server runs the configured
//         shell command again), or
//       - force the card to done (stuck → done, user's manual override —
//         e.g. "I deployed by hand").
//
// This table is consulted by:
//   - server route handlers (force-done / retry-post-build endpoints)
//   - server transitions.ts (ensureCanStuckTransition)
//   - UI Board.tsx (computeStuckTargets — drives DnD ALLOWED_DROPS)
//   - UI CardDrawer.tsx (status select options)
//
// Keep this list aligned with the TRANSITIONS rows above. Adding a new edge
// out of stuck means adding it here AND in TRANSITIONS.
export interface StuckTransitionPolicy {
  /** Targets allowed when card.frontmatter.merged_sha == null. */
  withoutMergedSha: ReadonlyArray<CardStatus>;
  /** Targets allowed when card.frontmatter.merged_sha != null. */
  withMergedSha: ReadonlyArray<CardStatus>;
}

export const STUCK_TRANSITIONS: StuckTransitionPolicy = {
  withoutMergedSha: ["ready"],
  // Note: NOT "ready" — re-queueing would re-spawn a worker on already-merged
  // work. The user must either retry the post-build or accept it as done.
  withMergedSha: ["merging", "done"],
};

/**
 * Resolve the set of valid next-status values for a stuck card given its
 * `merged_sha`. Pass `mergedSha === null` for "unknown" / not-yet-merged
 * cards (preserves the original ready-only behavior).
 */
export function nextStatesFromStuck(
  mergedSha: string | null,
): ReadonlyArray<CardStatus> {
  return mergedSha == null
    ? STUCK_TRANSITIONS.withoutMergedSha
    : STUCK_TRANSITIONS.withMergedSha;
}
