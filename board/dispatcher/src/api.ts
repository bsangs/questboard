/**
 * REST client for talking to the questboard server.
 *
 * The dispatcher is the SOLE actor that calls server card APIs. Workers do
 * not talk to the server directly — the dispatcher claims, reports stuck,
 * pushes branches, and posts /review on their behalf.
 */
import type { StuckReason } from "@questboard/core";
import type { WorkerRole } from "./spawn.js";

interface PostResult {
  status: number;
  body: unknown;
}

/**
 * Hard timeout on every server call. The server is on localhost and a
 * normal /stuck or /comment finishes in well under a second; if a call
 * is still pending after 30s the server is genuinely stuck. Without a
 * timeout, a single wedged HTTP call hangs routeExit forever, which
 * leaves the card in `in_progress` while the worker is already dead —
 * we observed exactly this on card 0025.
 */
const HTTP_TIMEOUT_MS = 30_000;

export class ServerApi {
  constructor(private readonly baseUrl: string) {}

  private async post(pathname: string, body: unknown): Promise<PostResult> {
    const res = await fetch(this.baseUrl + pathname, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    let parsed: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  }

  /**
   * Same as `post` but throws on any non-2xx response. Use for endpoints
   * where a silent 4xx/5xx would leave the system in a wedged state —
   * e.g. /stuck, /review, /merger-complete. We previously had reportStuck
   * silently swallow a 409 illegal-transition and the card would stay
   * `in_progress` while the worker was already gone, making
   * nextWorkerRevivable spam-spawn forever (card 0081).
   */
  private async postOrThrow(
    pathname: string,
    body: unknown,
  ): Promise<PostResult> {
    const res = await this.post(pathname, body);
    if (res.status >= 400) {
      throw new Error(
        `${pathname} failed: ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res;
  }

  /**
   * Dispatcher-driven claim (state-machine.md T3 trigger=dispatcher). Called
   * right after spawning a worker so the card flips to in_progress.
   */
  async claimForWorker(
    cardId: string,
    pid: number,
    attempt: number,
    worktree: string,
    wipBranch: string,
  ): Promise<PostResult> {
    const res = await this.post(`/api/cards/${cardId}/claim`, {
      pid,
      attempt,
      worktree,
      wip_branch: wipBranch,
    });
    if (res.status >= 400) {
      throw new Error(`claim failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res;
  }

  /**
   * Register a reviewer / merger helper. Inserts a `workers` row WITHOUT
   * doing a status transition (reviewer keeps card in ai_review, merger
   * keeps it in merging). Needed so StatsReporter and orphan detection can
   * see them.
   */
  async registerHelper(
    cardId: string,
    pid: number,
    role: "reviewer" | "merger",
  ): Promise<PostResult> {
    const res = await this.post(`/api/cards/${cardId}/register-helper`, { pid, role });
    if (res.status >= 400) {
      throw new Error(`register-helper failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res;
  }

  /**
   * Worker exited — the dispatcher has decided the card moves to stuck.
   * Used for: worker_failed (non-zero or no-commits exit), worker_orphaned
   * (transcript-hang), and the worker's own "I need a human" exits where
   * the dispatcher captures the question from the transcript.
   */
  async reportStuck(
    cardId: string,
    stuckReason: StuckReason,
    commentBody: string,
    stuckQuestion?: string,
    author?: "worker" | "reviewer" | "system",
  ): Promise<PostResult> {
    return this.postOrThrow(`/api/cards/${cardId}/stuck`, {
      stuck_reason: stuckReason,
      stuck_question: stuckQuestion ?? null,
      comment_body: commentBody,
      author,
    });
  }

  /**
   * Append a non-blocking informational comment (`kind="note"`) on behalf
   * of a helper. Status is unchanged; this is purely a comment append.
   * Used by the dispatcher's exit handler when a helper's final assistant
   * message contains a `## Notes` section.
   */
  async appendNote(
    cardId: string,
    author: "worker" | "reviewer" | "system",
    body: string,
  ): Promise<PostResult> {
    return this.post(`/api/cards/${cardId}/comments`, {
      kind: "note",
      author,
      body,
    });
  }

  /**
   * Worker pushed commits — transition to human_review (or ai_review if
   * server's auto_review toggle is on; the server decides).
   */
  async reportReview(cardId: string, wipBranch: string): Promise<PostResult> {
    return this.postOrThrow(`/api/cards/${cardId}/review`, { wip_branch: wipBranch });
  }

  /** Worker completed with no remaining diff because the branch is already merged. */
  async noDiffComplete(cardId: string, wipBranch: string): Promise<PostResult> {
    return this.postOrThrow(`/api/cards/${cardId}/no-diff-complete`, {
      wip_branch: wipBranch,
    });
  }

  /**
   * Periodic stats heartbeat. The dispatcher derives tokens/elapsed from the
   * worker's transcript (the worker itself never calls the server) and
   * pushes the running totals so the UI can show live progress.
   */
  async reportHeartbeat(
    cardId: string,
    pid: number,
    tokensUsed: number,
    elapsedSeconds: number,
    role?: WorkerRole,
    roleInputTokens?: number,
    roleOutputTokens?: number,
    transcript?: string,
  ): Promise<PostResult> {
    return this.post(`/api/cards/${cardId}/heartbeat`, {
      pid,
      ...(role ? { role } : {}),
      tokens_used: tokensUsed,
      elapsed_seconds: elapsedSeconds,
      ...(roleInputTokens != null ? { role_input_tokens: roleInputTokens } : {}),
      ...(roleOutputTokens != null ? { role_output_tokens: roleOutputTokens } : {}),
      ...(transcript ? { transcript } : {}),
    });
  }

  /** Reviewer verdict: pass — routes the card to merging. */
  async reviewerPass(cardId: string): Promise<PostResult> {
    return this.postOrThrow(`/api/cards/${cardId}/reviewer-pass`, {});
  }

  /** Merger success — server transitions to done with the merged sha. */
  async mergerComplete(cardId: string, mergedSha: string): Promise<PostResult> {
    return this.postOrThrow(`/api/cards/${cardId}/merger-complete`, {
      merged_sha: mergedSha,
    });
  }

  /** Merger failure — server routes the card back to in_progress. */
  async mergerFailed(cardId: string, reason: string): Promise<PostResult> {
    return this.postOrThrow(`/api/cards/${cardId}/merger-failed`, { reason });
  }

  /**
   * Server-side fast-forward merge pre-attempt. Called before the
   * dispatcher would otherwise spawn a Claude merger. The server tries
   * configured fast-forward merge command directly; on success it pushes
   * and routes the card through the normal `mergerComplete` path.
   *
   * The HTTP timeout for this call is generous because configured shell
   * commands can take minutes. We override the default 30s timeout with
   * 30 minutes so the dispatcher doesn't time out on a slow merge path.
   *
   * Response shape:
   *   { ok: true, merged_sha, status, ran }
   *   { ok: false, reason, fallback_to_merger, ran }
   *
   * `fallback_to_merger=true` means the caller SHOULD spawn the regular
   * Claude merger (e.g. ff was not possible, or a gate failed and might
   * be a real merge conflict). `false` means the merge already happened
   * but a follow-up step (the card transition) failed — spawning a
   * merger would re-push or fail trying.
   */
  async tryFfMerge(cardId: string): Promise<{
    ok: boolean;
    merged_sha?: string;
    status?: string;
    reason?: string;
    fallback_to_merger?: boolean;
    ran?: string[];
  }> {
    const res = await fetch(this.baseUrl + `/api/cards/${cardId}/try-ff-merge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      // 30 minutes — long enough for a slow configured merge path.
      signal: AbortSignal.timeout(30 * 60_000),
    });
    let parsed: unknown = null;
    const text = await res.text();
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (res.status >= 400) {
      throw new Error(
        `try-ff-merge failed: ${res.status} ${JSON.stringify(parsed)}`,
      );
    }
    return parsed as {
      ok: boolean;
      merged_sha?: string;
      status?: string;
      reason?: string;
      fallback_to_merger?: boolean;
      ran?: string[];
    };
  }

  /** Reviewer verdict: reject — server appends comment and reopens to in_progress. */
  async reviewerReject(cardId: string, commentBody: string): Promise<PostResult> {
    return this.postOrThrow(`/api/cards/${cardId}/reviewer-reject`, {
      comment_body: commentBody,
    });
  }

  /**
   * 3-strikes-out helper liveness check. Called by StatsReporter when it
   * spots a helper PID dead AND the dispatcher's own exit handler isn't
   * going to recover it (silent crash). The server increments a per-stage
   * counter, drops the workers row, and either:
   *   - returns `{ action: "revive" }` (status unchanged → next spawn
   *     round picks the card up with a fresh helper), or
   *   - returns `{ action: "cancelled" }` after 3 consecutive deaths at
   *     the same stage (server has already transitioned to cancelled and
   *     posted both a comment and a system_event).
   *   - returns `{ action: "noop" }` if the card has already moved on
   *     (e.g. status flipped between the dead-pid detection and our call).
   */
  async helperDied(
    cardId: string,
    stage: "worker" | "reviewer" | "merger",
  ): Promise<{ action: "noop" | "revive" | "cancelled"; count: number; status: string }> {
    const res = await this.post(`/api/cards/${cardId}/helper-died`, { stage });
    if (res.status >= 400) {
      throw new Error(`helper-died failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body as {
      action: "noop" | "revive" | "cancelled";
      count: number;
      status: string;
    };
  }

  /** Used by recovery / exit handlers — mostly bookkeeping. */
  async reportExit(
    cardId: string,
    pid: number,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<PostResult> {
    return this.post(`/api/cards/${cardId}/exit`, {
      pid,
      exit_code: exitCode,
      signal,
    });
  }
}
