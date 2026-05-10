/**
 * Card REST endpoints. Names follow the user spec for this build.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  db,
  getCardRow,
  listAllCards,
  listAllDepsAndBlocked,
  listDeps,
  upsertCardRow,
} from "../db.js";
import {
  cardExistsOnDisk,
  listTranscripts,
  readCard,
  readComments,
  readHistory,
  writeCardAtomic,
} from "../files.js";
import {
  appendComment,
  archiveCards,
  cancelCard,
  claimCard,
  createCard,
  patchCard,
  recordHelperDeath,
  reopenCard,
  restoreCard,
  reviewerReject,
  approveToMerging,
  mergerComplete,
  mergerFailed,
  requeueCard,
  retryPostBuild,
  forceDoneFromStuck,
  stopPostBuild,
  transitionBacklogToReady,
  moveToBacklog,
  transitionToAiReview,
  transitionToHumanReview,
  transitionToStuck,
  noDiffComplete,
  TransitionError,
} from "../transitions.js";
import {
  recordHeartbeat,
  registerHelper,
  registerWorker,
  unregisterWorker,
} from "../workers.js";

const CardIdParam = z.object({ id: z.string().regex(/^\d{4}$/) });

const CreateBody = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  language: z.string().optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  deps: z.array(z.string().regex(/^\d{4}$/)).optional(),
  flavor: z.enum(["feature", "bug", "refactor", "chore", "docs"]).optional(),
  scope: z.string().nullable().optional(),
  estimated_loc: z.number().int().nonnegative().optional(),
  budget_minutes: z.number().int().nonnegative().optional(),
});

const PatchBody = z.object({
  title: z.string().min(1).optional(),
  description: z.string().optional(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
  language: z.string().min(2).max(3).optional(),
  flavor: z.enum(["feature", "bug", "refactor", "chore", "docs"]).optional(),
  scope: z.string().nullable().optional(),
  deps: z.array(z.string().regex(/^\d{4}$/)).optional(),
});

const ClaimBody = z.object({
  pid: z.number().int().positive(),
  worktree: z.string().optional(),
  wip_branch: z.string().optional(),
});

const HeartbeatBody = z.object({
  pid: z.number().int().positive(),
  role: z.enum(["worker", "reviewer", "merger"]).optional(),
  tokens_used: z.number().int().nonnegative(),
  role_input_tokens: z.number().int().nonnegative().optional(),
  role_output_tokens: z.number().int().nonnegative().optional(),
  transcript: z.string().optional(),
  elapsed_seconds: z.number().int().nonnegative(),
});

const StuckBody = z.object({
  stuck_reason: z.enum([
    "blocking",
    "checkpoint",
    "testing_failed",
    "resource_exhausted",
    "needs_split",
    "worker_failed",
    "worker_orphaned",
  ]),
  // Accept null in addition to string|undefined: dispatcher's
  // reportStuck sends `stuck_question ?? null` so the body always has
  // the field. Without `nullable()` zod rejects with "Expected string,
  // received null" → reportStuck throws → routeExit fails → card stays
  // in_progress with zombie owner_pid → spawn loop.
  stuck_question: z.string().nullable().optional(),
  comment_body: z.string().optional(),
  /**
   * Helper-role attribution for the stuck comment. Defaults to "worker" on
   * the server side. Dispatcher passes "reviewer" / "system" when the
   * stuck originates from a reviewer / merger session respectively.
   */
  author: z.enum(["worker", "reviewer", "system"]).optional(),
});

const ReviewBody = z.object({ wip_branch: z.string().optional() });
const RejectBody = z.object({ comment_body: z.string().min(1) });
const CancelBody = z.object({ reason: z.string().optional() });
const ArchiveBatchBody = z.object({ ids: z.array(z.string().regex(/^\d{4}$/)).min(1) });
const ExitBody = z.object({
  pid: z.number().int().positive(),
  exit_code: z.number().int().nullable().optional(),
  signal: z.string().nullable().optional(),
});
const ListQuery = z.object({
  status: z.string().optional(),
  priority: z.coerce.number().int().optional(),
  owner: z.string().optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

function handleError(err: unknown, reply: import("fastify").FastifyReply): void {
  if (err instanceof TransitionError) {
    reply.code(err.status).send({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof z.ZodError) {
    reply.code(400).send({ error: "bad_request", message: "validation failed", details: err.flatten() });
    return;
  }
  const e = err as Error & { code?: string };
  reply.code(500).send({ error: e.code ?? "internal", message: e.message });
}

export async function cardsRoutes(app: FastifyInstance): Promise<void> {
  // ── List ──────────────────────────────────────────────────────────────────
  app.get("/api/cards", async (req, reply) => {
    try {
      const q = ListQuery.parse(req.query);
      let rows = listAllCards();
      if (q.status) {
        const set = new Set(q.status.split(",").map((s) => s.trim()).filter(Boolean));
        rows = rows.filter((r) => set.has(r.status));
      }
      if (q.priority != null) rows = rows.filter((r) => r.priority === q.priority);
      if (q.owner != null) {
        if (q.owner === "null") rows = rows.filter((r) => r.owner_pid == null);
        else rows = rows.filter((r) => String(r.owner_pid) === q.owner);
      }
      const offset = q.offset ?? 0;
      const limit = q.limit ?? 200;
      const slice = rows.slice(offset, offset + limit);
      // Batch-resolve deps + blocked_by for every card in the slice. Done in
      // a single SQL roundtrip (LEFT JOIN cards) instead of N listDeps calls,
      // and we filter the maps to the slice so unrelated cards' deps don't
      // get serialized. blocked_by is THE field CardTile reads to render
      // the "blocked by #NNNN" chip — without it the chip is permanently
      // dark even when the dispatcher correctly refuses to spawn.
      const { deps: depsMap, blockedBy: blockedMap } = listAllDepsAndBlocked();
      const { isPostBuildActive } = await import("../post-build.js");
      reply.send({
        total: rows.length,
        cards: slice.map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          flavor: r.flavor,
          priority: r.priority,
          language: r.language,
          scope: r.scope ?? null,
          owner_pid: r.owner_pid,
          attempts: r.attempts,
          tokens_used: r.tokens_used ?? 0,
          elapsed_seconds: r.elapsed_seconds ?? 0,
          created_at: r.created_at,
          updated_at: r.updated_at,
          stuck_reason: r.stuck_reason,
          stuck_question: r.stuck_question,
          // merged_sha drives DnD / drawer policy on stuck cards. Plumbed
          // through to summaries so the UI doesn't have to fetch the full
          // card to decide which targets are valid.
          merged_sha: r.merged_sha ?? null,
          // True iff there's a live post-build process for this card.
          // Drives the "Stop post-build" affordance + retry-disabled pill.
          post_build_active: isPostBuildActive(r.id),
          comment_count: r.comment_count ?? 0,
          worker_input_tokens: r.worker_input_tokens ?? 0,
          worker_output_tokens: r.worker_output_tokens ?? 0,
          reviewer_input_tokens: r.reviewer_input_tokens ?? 0,
          reviewer_output_tokens: r.reviewer_output_tokens ?? 0,
          merger_input_tokens: r.merger_input_tokens ?? 0,
          merger_output_tokens: r.merger_output_tokens ?? 0,
          deps: depsMap.get(r.id) ?? [],
          blocked_by: blockedMap.get(r.id) ?? [],
        })),
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Get single (full payload) ─────────────────────────────────────────────
  app.get("/api/cards/:id", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const { card, archived } = readCard(id);
      const comments = readComments(id, archived);
      const history = readHistory(id, archived);
      const transcripts = archived ? [] : listTranscripts(id);
      const deps = listDeps(id);
      reply.send({
        id,
        archived,
        frontmatter: { ...card.frontmatter, deps },
        description: card.description,
        comments,
        history,
        transcripts,
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Stages (per-transcript activity timeline) ────────────────────────────
  app.get("/api/cards/:id/stages", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const { listStages } = await import("../stages.js");
      const stages = listStages(id);
      reply.send({ stages });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── History (audit log) ──────────────────────────────────────────────────
  app.get("/api/cards/:id/history", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const { archived } = readCard(id);
      const history = readHistory(id, archived);
      reply.send({ history });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Create ────────────────────────────────────────────────────────────────
  app.post("/api/cards", async (req, reply) => {
    try {
      const body = CreateBody.parse(req.body);
      const card = await createCard(body);
      reply.code(201).send({
        id: card.frontmatter.id,
        status: card.frontmatter.status,
        created_at: card.frontmatter.created_at,
        language: card.frontmatter.language,
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Patch (description / metadata) ────────────────────────────────────────
  app.patch("/api/cards/:id", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = PatchBody.parse(req.body);
      const card = await patchCard(id, body);
      reply.send({ id, status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });
  // Alias: POST is also accepted (user spec) for description edit.
  app.post("/api/cards/:id", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = PatchBody.parse(req.body);
      const card = await patchCard(id, body);
      reply.send({ id, status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Delete (only backlog/ready) ───────────────────────────────────────────
  app.delete("/api/cards/:id", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const row = getCardRow(id);
      if (!row) return reply.code(404).send({ error: "card_not_found" });
      if (row.status !== "backlog" && row.status !== "ready") {
        return reply.code(409).send({ error: "bad_status", message: "delete only allowed in backlog/ready; use /cancel" });
      }
      // Hard-remove file folder + sql rows (cascade via FK).
      const { rmSync } = await import("node:fs");
      const { join } = await import("node:path");
      const { env } = await import("../env.js");
      rmSync(join(env.CARDS_DIR, id), { recursive: true, force: true });
      db.prepare("DELETE FROM cards WHERE id = ?").run(id);
      // Broadcast so the UI removes the card from the board immediately.
      // Reusing `card_archived` since the UI already wires it to
      // removeCard(); the server side never produces a duplicate event
      // for the same card here (we just hard-deleted it).
      const { broadcast } = await import("../sse.js");
      broadcast({ type: "card_archived", card_id: id });
      reply.send({ ok: true });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── State-transition endpoints (named per user spec) ──────────────────────

  app.post("/api/cards/:id/ready", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await transitionBacklogToReady(id);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // Inverse of /ready: pull a card BACK from ready into backlog. Only
  // valid while status === "ready" (no worker has claimed it yet); for
  // any other status the user must use /requeue + a separate edit.
  app.post("/api/cards/:id/backlog", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await moveToBacklog(id);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/claim", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = ClaimBody.parse(req.body);
      const card = await claimCard(id, body.pid, { worktree: body.worktree, wip_branch: body.wip_branch });
      registerWorker(body.pid, id);
      reply.send({ status: card.frontmatter.status, claimed_at: card.frontmatter.updated_at });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // POST /api/cards/:id/heartbeat — driven by the dispatcher's stats loop,
  // which polls each live worker's transcript file for cumulative tokens
  // + elapsed and POSTs them here. The worker process itself does not call
  // this route.
  //
  // The newer `recordWorkerActivity()` helper in util/activity-tracker.ts
  // is the eventual replacement (per-turn delta from stream-json), but
  // since the worker spawn lives in the dispatcher package (cross-package
  // boundary), the HTTP path is what bridges dispatcher → server today.
  app.post("/api/cards/:id/heartbeat", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = HeartbeatBody.parse(req.body);
      recordHeartbeat(
        id,
        body.pid,
        body.tokens_used,
        body.elapsed_seconds,
        body.role,
        body.role_input_tokens,
        body.role_output_tokens,
        body.transcript,
      );
      reply.send({ ok: true });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/stuck", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = StuckBody.parse(req.body);
      const card = await transitionToStuck(id, body);
      // worker exits; remove from live workers table if present.
      if (card.frontmatter.owner_pid == null) {
        db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
      }
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/review", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = ReviewBody.parse(req.body ?? {});
      const card = await transitionToHumanReview(id, body);
      db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/no-diff-complete", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = ReviewBody.parse(req.body ?? {});
      const card = await noDiffComplete(id, body.wip_branch ?? null);
      db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
      reply.send({ status: card.frontmatter.status, merged_sha: card.frontmatter.merged_sha });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/approve", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await approveToMerging(id, "human");
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/reopen", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await reopenCard(id);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/ai-review", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await transitionToAiReview(id, "human");
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/reviewer-pass", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await approveToMerging(id, "reviewer");
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Merger completes / fails ─────────────────────────────────────────────
  // Called by the dispatcher after the Merger ephemeral worker exits.
  app.post("/api/cards/:id/merger-complete", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = z.object({ merged_sha: z.string().min(7) }).parse(req.body);
      const card = await mergerComplete(id, body.merged_sha);
      reply.send({ status: card.frontmatter.status, merged_sha: body.merged_sha });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Server-side fast-forward merge pre-attempt ──────────────────────────
  // Called by the dispatcher BEFORE it would otherwise spawn the Claude
  // merger. Tries `git merge --ff-only origin/<wip_branch>` directly; on
  // success runs install (only if the lockfile changed) + the discovered
  // typecheck/build/test gates, then pushes and routes the card through
  // the same `mergerComplete` path the spawn-merger flow uses. Mergers
  // are strictly serial — the module owns its own in-process mutex, the
  // dispatcher's own gate is the SQL workers row.
  //
  // Returns:
  //   { ok: true, merged_sha, status, ran }
  //   { ok: false, reason, fallback_to_merger, ran }
  // The dispatcher inspects `fallback_to_merger` to decide whether to
  // spawn the regular Claude merger as a fallback.
  app.post("/api/cards/:id/try-ff-merge", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const row = getCardRow(id);
      if (!row) {
        reply.code(404).send({ error: "card_not_found" });
        return;
      }
      if (row.status !== "merging") {
        reply.code(409).send({
          error: "bad_status",
          message: `try-ff-merge requires status=merging, got ${row.status}`,
        });
        return;
      }
      const { tryFfMerge } = await import("../merger/ff-merge.js");
      const result = await tryFfMerge(id);
      reply.send(result);
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/merger-failed", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = z.object({ reason: z.string().min(1) }).parse(req.body);
      const card = await mergerFailed(id, body.reason);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Register a non-worker helper (reviewer / merger) ─────────────────────
  // Used by the dispatcher in place of /claim for roles that should not
  // flip the card's status. Inserts a `workers` row (for stats + orphan
  // detection) and updates `cards.owner_pid` (for UI badges).
  app.post("/api/cards/:id/register-helper", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = z
        .object({
          pid: z.number().int().positive(),
          role: z.enum(["reviewer", "merger"]),
        })
        .parse(req.body);
      registerHelper(body.pid, id);
      reply.send({ ok: true, role: body.role });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Helper death (3-strikes-out) ─────────────────────────────────────────
  // Dispatcher StatsReporter calls this when it finds a helper PID dead AND
  // the dispatcher's own exit handler isn't going to recover it. The server
  // either:
  //   - increments the per-stage counter and drops the workers row so the
  //     dispatcher can revive a fresh helper next tick (status unchanged), or
  //   - if this would be the 3rd consecutive death at the same stage,
  //     auto-cancels the card with a comment + system_event.
  app.post("/api/cards/:id/helper-died", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = z
        .object({ stage: z.enum(["worker", "reviewer", "merger"]) })
        .parse(req.body);
      const result = await recordHelperDeath(id, body.stage);
      reply.send(result);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Stuck-with-merged_sha recovery endpoints ─────────────────────────────
  // Each one targets a card that's stuck with merged_sha set — i.e. the
  // worker's code IS already on origin/main but a downstream step (post-
  // build, deploy gate) failed. See state-machine STUCK_TRANSITIONS for
  // why we forbid the usual stuck → ready route in this case.

  // Manual retry of the configured post-build command. Flips status back
  // to merging and runs the bash command again; the runner's classifier +
  // auto-retry pipeline takes over from there.
  app.post("/api/cards/:id/retry-post-build", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await retryPostBuild(id);
      reply.send({
        status: card.frontmatter.status,
        merged_sha: card.frontmatter.merged_sha,
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // User declares the card done despite the failed post-build — common
  // when they deployed by hand or accept a one-off flake. merged_sha is
  // preserved for audit. Body.reason becomes a `note` comment.
  app.post("/api/cards/:id/force-done", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = z
        .object({ reason: z.string().max(2000).optional() })
        .parse(req.body ?? {});
      const card = await forceDoneFromStuck(id, body.reason);
      reply.send({
        status: card.frontmatter.status,
        merged_sha: card.frontmatter.merged_sha,
      });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // SIGTERM the active post-build for a card. The runner's exit handler
  // will land the card in stuck (testing_failed) once the process is
  // reaped. Returns 409 if there's nothing running.
  app.post("/api/cards/:id/stop-post-build", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const pid = await stopPostBuild(id);
      if (pid == null) {
        reply.code(409).send({
          error: "post_build_inactive",
          message: "no active post-build for this card",
        });
        return;
      }
      reply.send({ ok: true, killed_pid: pid });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Generic re-queue: drag back to Ready from any waiting column ─────────
  app.post("/api/cards/:id/requeue", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await requeueCard(id);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/reviewer-reject", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = RejectBody.parse(req.body);
      const card = await reviewerReject(id, body.comment_body);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Worker exit reporting (dispatcher → server) ──────────────────────────
  // Maps worker exit codes used by the dispatcher:
  //   0  → success (worker should already have called /review or /stuck)
  //   10 → stuck (worker already called /stuck; just unregister)
  //   20 → self-failure: mark card stuck (worker_failed) if still in_progress
  //   30 → claim conflict: nothing to do
  //   other / null (signaled): treat as worker_failed if still in_progress
  app.post("/api/cards/:id/exit", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = ExitBody.parse(req.body);
      // Unregister the live worker row no matter what.
      unregisterWorker(body.pid);
      // ALWAYS clear owner_pid when the owning helper exits — even when we
      // don't transition the status. Without this, the card sits as
      // status=in_progress + owner_pid=<dead pid> + no workers row, which
      // makes the dispatcher's nextWorkerRevivable spam-spawn workers
      // whose claim all bounce off "already_claimed by <zombie>". Match
      // by pid so a stale /exit for an old pid can't clobber a freshly-
      // claimed card.
      //
      // CRITICAL: claimCard / loadCard read from card.md (file), NOT from
      // the SQLite mirror. So clearing only the SQL row leaves card.md
      // with the zombie pid → claim still rejects. We have to rewrite
      // card.md too.
      try {
        const loc = cardExistsOnDisk(id);
        if (loc.active || loc.archived) {
          const { card } = readCard(id);
          if (
            card.frontmatter.owner_pid === body.pid &&
            card.frontmatter.status !== "done" &&
            card.frontmatter.status !== "cancelled"
          ) {
            const next: typeof card = {
              ...card,
              frontmatter: {
                ...card.frontmatter,
                owner_pid: null,
                updated_at: new Date().toISOString(),
              },
            };
            await writeCardAtomic(id, next, loc.archived);
            upsertCardRow(next.frontmatter, next.frontmatter.deps);
          }
        }
      } catch (err) {
        // Best-effort. If we can't clear, at least the SQL fallback below
        // keeps the dashboard accurate; the dispatcher's spawn loop
        // would still be a problem but that's bounded by the
        // 3-strikes counter at this point.
        const e = err as Error;
        // Use error logger via reply.log if available, else stderr.
        process.stderr.write(
          `[/exit] clear owner_pid (file) failed for ${id}: ${e.message}\n`,
        );
      }
      // Belt-and-suspenders SQL update — covers any race where readCard
      // failed but the SQL row still has the zombie pid.
      db.prepare(
        "UPDATE cards SET owner_pid = NULL WHERE id = ? AND owner_pid = ?",
      ).run(id, body.pid);
      const row = getCardRow(id);
      const code = body.exit_code;
      const stillInProgress = row?.status === "in_progress";
      if (stillInProgress && (code === 20 || code == null || (typeof code === "number" && code !== 0 && code !== 10 && code !== 30))) {
        await transitionToStuck(id, {
          stuck_reason: "worker_failed",
          stuck_question: null,
          comment_body: `Worker exited unexpectedly (code=${code ?? "null"}, signal=${body.signal ?? "null"}).`,
        });
      }
      reply.send({ ok: true });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/cancel", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const body = CancelBody.parse(req.body ?? {});
      const card = await cancelCard(id, body.reason);
      // Notify dispatcher: SSE channel is shared.
      db.prepare("DELETE FROM workers WHERE card_id = ?").run(id);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  app.post("/api/cards/:id/restore", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const card = await restoreCard(id);
      reply.send({ status: card.frontmatter.status });
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Batch archive (state-machine.md T15) ──────────────────────────────────
  app.post("/api/cards/archive", async (req, reply) => {
    try {
      const body = ArchiveBatchBody.parse(req.body);
      const result = await archiveCards(body.ids);
      reply.send(result);
    } catch (err) {
      handleError(err, reply);
    }
  });

  // ── Transcript (read-only stream of one helper's run) ─────────────────────
  // Read-only view of a single transcript file. With no query, picks the
  // "interesting" stage: the active one (worker for in_progress, reviewer
  // for ai_review, merger for merging) or — when no helper is running —
  // the most recently ended stage on the card. Pass role + attempt to
  // pin to a specific past stint (e.g. worker-1 after a stuck → ready
  // bounce already produced worker-2).
  //
  // The Composer route file holds the live SSE-driven path; for these
  // ephemeral helper transcripts we just re-parse on every fetch and let
  // the UI re-poll on `worker_heartbeat`. Files are small enough (<1 MB
  // typical) that this stays cheap; no byte-offset cursoring in v1.
  app.get("/api/cards/:id/transcript", async (req, reply) => {
    try {
      const { id } = CardIdParam.parse(req.params);
      const Q = z.object({
        role: z.enum(["worker", "reviewer", "merger"]).optional(),
        attempt: z.coerce.number().int().positive().optional(),
      });
      const q = Q.parse(req.query ?? {});
      const { listStages, findTranscriptPath, parseTranscriptMessages } =
        await import("../stages.js");
      const stages = listStages(id);
      if (stages.length === 0) {
        reply.send({ stage: null, messages: [] });
        return;
      }
      // Resolve the target stage. Explicit role+attempt wins; otherwise
      // pick by current card status, falling back to the latest stage.
      let target: (typeof stages)[number] | null = null;
      if (q.role && q.attempt) {
        target =
          stages.find((s) => s.role === q.role && s.attempt === q.attempt) ?? null;
      }
      if (!target) {
        const row = getCardRow(id);
        const prefer: Record<string, "worker" | "reviewer" | "merger" | undefined> = {
          in_progress: "worker",
          stuck: "worker",
          ai_review: "reviewer",
          human_review: "reviewer",
          merging: "merger",
        };
        const role = row ? prefer[row.status] : undefined;
        if (role) {
          // Latest stint of the preferred role.
          for (let i = stages.length - 1; i >= 0; i--) {
            const s = stages[i];
            if (s && s.role === role) {
              target = s;
              break;
            }
          }
        }
        // Final fallback: most recent stage of any role.
        if (!target) target = stages[stages.length - 1] ?? null;
      }
      if (!target) {
        reply.send({ stage: null, messages: [] });
        return;
      }
      const path = findTranscriptPath(id, target.role, target.attempt);
      const messages = path ? parseTranscriptMessages(path) : [];
      reply.send({ stage: target, messages });
    } catch (err) {
      handleError(err, reply);
    }
  });
}
