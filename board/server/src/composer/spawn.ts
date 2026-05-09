/**
 * Composer claude-process lifecycle.
 *
 * One long-lived `claude` per active thread, started lazily on the first
 * user message and shut down after IDLE_MS of no activity. State lives
 * only in this module's in-memory Map; the transcript on disk is the
 * durable record.
 *
 * Wire format:
 *   - claude is invoked with --input-format stream-json --output-format
 *     stream-json. stdin and stdout are NDJSON streams.
 *   - stdin user message:
 *       {"type":"user","message":{"role":"user",
 *        "content":[{"type":"text","text":"..."}]}}
 *   - stdin tool_result (after a make_card / save_plan gate resolves):
 *       {"type":"user","message":{"role":"user",
 *        "content":[{"type":"tool_result","tool_use_id":"...",
 *                    "content":"...","is_error":false}]}}
 *   - stdout assistant turn:
 *       {"type":"assistant","message":{"role":"assistant",
 *        "content":[{"type":"text","text":"..."}|{"type":"tool_use",...}],
 *        "usage":{"input_tokens":N,"output_tokens":M,...}},
 *        "session_id":"..."}
 *   - stdout result envelope ({"type":"result"}) marks the end of the turn.
 *
 * Replay-after-restart strategy: when the process is dead and we get a
 * new user message, we PREFER `claude --resume <session_id>` — claude
 * code restores the actual model context, so no replay preamble needs
 * to be sent. The session_id is captured from stream-json system/init
 * events and persisted on the thread summary.
 *
 * Fallback: when no session_id is recorded yet (first respawn, or the
 * previous resume attempt failed and cleared the id), we synthesize a
 * single "context dump" user message that summarizes prior turns and
 * prefix it onto the user's actual message. This is the path
 * `buildReplayPreamble` exists for.
 *
 * Worktrees: each thread gets a scratch worktree at
 * .questboard/worktrees/composer-<id>/, branch composer/thread-<id>.
 * Lazily created on first sendUserMessage so empty threads don't
 * pollute the worktree pool.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import {
  buildToolGuidanceSection,
  ComposerMessage,
  type ComposerMessage as ComposerMessageT,
  type ComposerThreadSummary,
} from "@questboard/core";
import { broadcast } from "../sse.js";
import { logger } from "../logger.js";
import { env } from "../env.js";
import { gitMain, runGit } from "../git.js";
import { getConfig } from "../config.js";
import {
  appendMessage,
  bumpUsage,
  composerThreadAttachmentsDir,
  getThread,
  patchThread,
} from "./threads.js";
import { mcpConfigPathFor } from "./mcp.js";
import { generateThreadTitle } from "./title.js";

export const IDLE_MS = 5 * 60_000;

// ─── Live process map ────────────────────────────────────────────────────────

interface LiveProc {
  threadId: string;
  child: ChildProcess;
  cwd: string;
  worktreePath: string | null;
  /** Buffer of any stdout text not yet split on a newline. */
  stdoutBuf: string;
  /** Reset on every chunk; idle timeout fires when no activity. */
  idleTimer: NodeJS.Timeout | null;
  /**
   * True between a stdin write (user message / tool_result re-injection)
   * and the next `result` event from claude. While true:
   *   - The idle timer is suppressed (a heavy turn can sit silently for
   *     many minutes on input parsing alone — must not be SIGTERM'd).
   *   - The UI is told a turn is in flight, so the typing indicator
   *     stays visible even between assistant chunks.
   */
  turnInFlight: boolean;
  /** Most recent claude session id (from system/init events). */
  sessionId: string | null;
  /** True if the process has emitted its first system/init line. */
  ready: boolean;
  /**
   * Non-null while we spawned with `--resume <id>` and have not yet seen
   * the first system/init event from claude. Cleared on init (resume
   * succeeded) — if the process exits while this is still set, treat it
   * as a resume failure: clear the persisted session_id so the NEXT
   * sendUserMessage falls back to the preamble path instead of looping
   * on a dead session id.
   */
  resumedFrom: string | null;
}

const live = new Map<string, LiveProc>();

function setStatus(threadId: string, status: ComposerThreadSummary["status"]): void {
  try {
    const summary = patchThread(threadId, { status });
    broadcast({ type: "composer_thread_changed", thread_id: threadId, summary });
  } catch (err) {
    logger.warn("composer_status_patch_failed", { threadId, err: String(err) });
  }
}

/**
 * Persist a claude-emitted session_id on the thread summary IFF it
 * differs from what's already stored. Idempotent — calling repeatedly
 * with the same id is a no-op (no meta write, no broadcast). Used
 * throughout the stream-event handler since claude tags every
 * assistant/system/result frame with session_id.
 */
function persistSessionIdIfChanged(threadId: string, sessionId: string): void {
  try {
    const cur = getThread(threadId);
    if (cur.session_id === sessionId) return;
    const summary = patchThread(threadId, { session_id: sessionId });
    broadcast({ type: "composer_thread_changed", thread_id: threadId, summary });
  } catch (err) {
    logger.warn("composer_session_id_persist_failed", { threadId, err: String(err) });
  }
}

function resetIdleTimer(p: LiveProc): void {
  if (p.idleTimer) clearTimeout(p.idleTimer);
  // Never arm the idle timer while a turn is in flight. The turn ends on
  // the `result` stream event (handled in handleStreamEvent), which calls
  // resetIdleTimer with turnInFlight=false to start the countdown.
  if (p.turnInFlight) {
    p.idleTimer = null;
    return;
  }
  p.idleTimer = setTimeout(() => {
    logger.info("composer_idle_shutdown", { threadId: p.threadId });
    void stopThread(p.threadId);
  }, IDLE_MS);
  // Don't keep the event loop alive just for the idle timer.
  p.idleTimer.unref?.();
}

// ─── Worktree lazy provisioning ──────────────────────────────────────────────

export function composerWorktreePath(threadId: string): string {
  return join(env.BOARD_WORKTREES, `composer-${threadId}`);
}
function composerBranch(threadId: string): string {
  return `composer/thread-${threadId}`;
}

/**
 * Count commits between the worktree's HEAD and origin/main.
 *
 * Returns the number of commits on origin/main that the worktree HEAD does
 * NOT contain — i.e. how far the scratch worktree is behind main. Returns
 * null if the worktree doesn't exist yet, or git failed for any reason
 * (rev-list under an unborn / detached HEAD, network-less fetch state, …).
 *
 * Cheap to call: a single `git rev-list --count`. Safe to call mid-turn —
 * just reads refs.
 */
export async function computeBehindMain(threadId: string): Promise<number | null> {
  const wt = composerWorktreePath(threadId);
  if (!existsSync(wt)) return null;
  try {
    const { stdout } = await runGit(wt, [
      "rev-list",
      "--count",
      "HEAD..origin/main",
    ]);
    const n = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (err) {
    logger.debug("composer_behind_main_failed", { threadId, err: String(err) });
    return null;
  }
}

/**
 * Hard-reset the composer worktree to origin/main.
 *
 * Steps:
 *   1. `git fetch origin main` from BOARD_ROOT — refresh the remote ref.
 *   2. Capture HEAD before reset (for the diff range in the system msg).
 *   3. `git reset --hard origin/main` inside the worktree.
 *   4. Capture HEAD after reset; compute commits added via rev-list.
 *
 * Returns the {before, after, added} triple so the caller can format a
 * transcript message. Throws on any git failure — callers surface this
 * to the UI as a toast.
 *
 * Intentionally NO idle / running guard: sync may run while a turn is in
 * flight. Worst case, claude reads files mid-turn and they swap under
 * it. That's acceptable for a scratch worktree.
 */
export async function syncWorktreeToMain(
  threadId: string,
): Promise<{ before: string; after: string; added: number }> {
  const wt = composerWorktreePath(threadId);
  if (!existsSync(wt)) {
    throw Object.assign(new Error(`composer worktree missing: ${threadId}`), {
      code: "worktree_missing",
    });
  }
  // Step 1: refresh origin/main from BOARD_ROOT (the worktree shares
  // the same .git/ via worktree linkage, so the fetched ref is visible
  // inside the worktree too).
  await gitMain(["fetch", "origin", "main"]);
  // Step 2: capture HEAD before — used to compute the diff range and to
  // include a short SHA in the transcript marker.
  const before = (await runGit(wt, ["rev-parse", "HEAD"])).stdout.trim();
  // Step 3: hard-reset to origin/main. This nukes any uncommitted edits
  // in the worktree, which is the intended UX — sync is a "throw away
  // local scratch and start fresh from main" affordance.
  await runGit(wt, ["reset", "--hard", "origin/main"]);
  // Step 4: HEAD after, plus the count of commits added (i.e. how many
  // commits main moved forward by since the worktree was last synced).
  const after = (await runGit(wt, ["rev-parse", "HEAD"])).stdout.trim();
  let added = 0;
  if (before && after && before !== after) {
    try {
      const { stdout } = await runGit(wt, [
        "rev-list",
        "--count",
        `${before}..${after}`,
      ]);
      const n = Number.parseInt(stdout.trim(), 10);
      if (Number.isFinite(n) && n >= 0) added = n;
    } catch (err) {
      logger.debug("composer_sync_count_failed", { threadId, err: String(err) });
    }
  }
  return { before, after, added };
}

async function ensureWorktree(threadId: string): Promise<string> {
  const wt = composerWorktreePath(threadId);
  if (existsSync(wt)) return wt;
  // git worktree add ../worktrees/composer-<id> -b composer/thread-<id>
  // Creating from main means the user's scratch starts at the latest
  // tip — same as worker worktrees. We DO NOT push this branch ever.
  mkdirSync(env.BOARD_WORKTREES, { recursive: true });
  const branch = composerBranch(threadId);
  // Pre-flight: if the branch already exists locally (orphaned from a
  // prior thread of the same id, vanishingly unlikely but cheap to handle),
  // delete it so `worktree add -b` doesn't fail.
  try {
    await gitMain(["branch", "-D", branch]);
  } catch {
    // Branch likely doesn't exist; that's the happy path.
  }
  await gitMain(["worktree", "add", wt, "-b", branch]);
  // Symlink the thread's attachments dir into the worktree so claude can
  // resolve the `attachments/<name>` paths the user pastes in markdown.
  // The UI rewrites `attachments/foo.png` → `/api/composer/threads/<id>/attachments/foo.png`
  // for browser display, but claude's Read tool resolves against cwd, so
  // it needs the real `attachments/` dir to exist relative to the worktree.
  // Best-effort: a symlink failure shouldn't break worktree creation —
  // the planning flow still works, claude just can't see images in this
  // thread.
  const attachmentsTarget = composerThreadAttachmentsDir(threadId);
  const attachmentsLink = join(wt, "attachments");
  if (!existsSync(attachmentsLink)) {
    // Ensure the target dir exists so the symlink resolves even before
    // the user pastes anything. `dir` type is the directory variant on
    // Windows; harmless on POSIX.
    mkdirSync(attachmentsTarget, { recursive: true });
    try {
      symlinkSync(attachmentsTarget, attachmentsLink, "dir");
    } catch (err) {
      logger.warn("composer_attachments_symlink_failed", {
        threadId,
        target: attachmentsTarget,
        err: String(err),
      });
    }
  }
  return wt;
}

async function cleanupComposerWorktree(threadId: string): Promise<void> {
  const wt = composerWorktreePath(threadId);
  if (existsSync(wt)) {
    try {
      await gitMain(["worktree", "remove", "--force", wt]);
    } catch (err) {
      logger.warn("composer_worktree_remove_failed", { threadId, err: String(err) });
    }
  }
  try {
    await gitMain(["worktree", "prune"]);
  } catch {
    /* ignore */
  }
  try {
    await gitMain(["branch", "-D", composerBranch(threadId)]);
  } catch {
    /* branch may not exist */
  }
}

// ─── Spawning ────────────────────────────────────────────────────────────────

const PROMPTS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  // dist/composer/spawn.js → questboard/board/prompts
  "..",
  "..",
  "..",
  "prompts",
);

const SYSTEM_PROMPT_PATH = resolve(PROMPTS_DIR, "composer.md");

const COMPOSER_ALLOWED_TOOLS = [
  "Bash",
  "Read",
  "Grep",
  "Glob",
  "mcp__composer__make_card",
  "mcp__composer__save_plan",
] as const;

function readToolGuidance(): string {
  const guidanceByTool: Record<string, string> = {};
  for (const tool of COMPOSER_ALLOWED_TOOLS) {
    const p = resolve(PROMPTS_DIR, "claude-code", "tool-guidance", `${tool}.md`);
    try {
      guidanceByTool[tool] = readFileSync(p, "utf8");
    } catch {
      /* Guidance is optional for each tool. */
    }
  }
  return buildToolGuidanceSection(guidanceByTool);
}

function readSystemPrompt(): string {
  // Resolve at spawn time (not import time) so a prompt edit lands without
  // a server restart. Best-effort: if the file is missing, fall back to a
  // minimal placeholder rather than crashing.
  let rolePrompt: string | null = null;
  for (const p of [SYSTEM_PROMPT_PATH]) {
    if (existsSync(p)) {
      try {
        rolePrompt = readFileSync(p, "utf8");
        break;
      } catch {
        /* try next */
      }
    }
  }
  if (rolePrompt === null) {
    logger.warn("composer_system_prompt_missing", { tried: SYSTEM_PROMPT_PATH });
    rolePrompt = "You are a planning partner inside an questboard Composer thread.";
  }

  const toolGuidance = readToolGuidance();
  if (!toolGuidance) return rolePrompt;
  return [
    "# Tool usage guidance",
    "",
    toolGuidance,
    "",
    "---",
    "",
    rolePrompt,
  ].join("\n");
}

async function spawnProc(
  threadId: string,
  opts?: { resumeSessionId?: string | null },
): Promise<LiveProc> {
  const summary = getThread(threadId);
  // Prefer the scratch worktree if/when it exists; spawn-time lazy create
  // is handled by sendUserMessage before this function is called.
  const cwd = composerWorktreePath(threadId);
  const usingWorktree = existsSync(cwd);
  const spawnCwd = usingWorktree ? cwd : (summary.cwd ? resolve(env.BOARD_ROOT, summary.cwd) : env.BOARD_ROOT);

  const mcpConfig = mcpConfigPathFor(threadId);
  const systemPrompt = readSystemPrompt();
  const resumeSessionId = opts?.resumeSessionId ?? null;

  const args = [
    "--print",
    "--bare",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "bypassPermissions",
    "--mcp-config",
    mcpConfig,
    "--strict-mcp-config",
    "--append-system-prompt",
    systemPrompt,
    // Whitelist the built-ins claude needs + the two MCP tools. Without
    // listing the MCP tools explicitly, the model sometimes refuses to
    // call them. Format: `mcp__<server-name>__<tool-name>`.
    //
    // Composer is a planning persona: it Reads + greps the codebase to
    // understand context, then proposes cards / plans via the MCP tools.
    // It MUST NOT mutate files directly — actual writes happen through
    // make_card / save_plan, which go through the user-approval gate.
    // We disallow Write / Edit / NotebookEdit as defense-in-depth so a
    // confused model can't bypass the gate by editing the worktree.
    "--allowed-tools",
    COMPOSER_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    "Write,Edit,NotebookEdit",
  ];
  if (resumeSessionId) {
    // Reattach to a prior claude-code session by id — restores the actual
    // model context (system prompt, tool history, accumulated state) so we
    // don't have to send a giant replay preamble. If the resume fails (the
    // session store was cleaned up, expired, etc.) the proc will exit
    // before emitting system/init; onExit detects that and clears the
    // persisted session_id so the next sendUserMessage falls back to the
    // preamble path.
    args.push("--resume", resumeSessionId);
  }

  const child = spawn("claude", args, {
    cwd: spawnCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      BOARD_ROOT: env.BOARD_ROOT,
      BOARD_DATA: env.BOARD_DATA,
      COMPOSER_THREAD_ID: threadId,
    },
  });
  if (typeof child.pid !== "number") {
    throw new Error(`composer claude spawn returned no pid for ${threadId}`);
  }

  const proc: LiveProc = {
    threadId,
    child,
    cwd: spawnCwd,
    worktreePath: usingWorktree ? cwd : null,
    stdoutBuf: "",
    idleTimer: null,
    turnInFlight: false,
    sessionId: null,
    ready: false,
    resumedFrom: resumeSessionId,
  };
  live.set(threadId, proc);

  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => onStdout(proc, chunk));
  child.stderr?.on("data", (chunk: string) => {
    // Keep claude's stderr noise out of the broadcast — log once at warn.
    logger.warn("composer_claude_stderr", { threadId, chunk: chunk.slice(0, 500) });
  });
  child.on("exit", (code, signal) => onExit(proc, code, signal));
  child.on("error", (err) => {
    logger.error("composer_claude_proc_error", { threadId, err: String(err) });
  });

  resetIdleTimer(proc);
  setStatus(threadId, "running");
  return proc;
}

// ─── Stdout NDJSON parsing ───────────────────────────────────────────────────

type StreamEvent =
  | { type: "system"; subtype?: string; session_id?: string }
  | {
      type: "assistant";
      message?: {
        content?: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: unknown }
        >;
        usage?: {
          input_tokens?: number;
          cache_creation_input_tokens?: number;
          cache_read_input_tokens?: number;
          output_tokens?: number;
        };
      };
      session_id?: string;
    }
  | {
      type: "user";
      message?: {
        content?: Array<{
          type: "tool_result";
          tool_use_id: string;
          content?: unknown;
          is_error?: boolean;
        }>;
      };
    }
  | { type: "result"; subtype?: string; session_id?: string }
  | { type: string; [k: string]: unknown };

function onStdout(proc: LiveProc, chunk: string): void {
  resetIdleTimer(proc);
  proc.stdoutBuf += chunk;
  let nl;
  while ((nl = proc.stdoutBuf.indexOf("\n")) !== -1) {
    const line = proc.stdoutBuf.slice(0, nl).trim();
    proc.stdoutBuf = proc.stdoutBuf.slice(nl + 1);
    if (!line) continue;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch (err) {
      logger.warn("composer_stdout_parse_fail", { threadId: proc.threadId, err: String(err) });
      continue;
    }
    handleStreamEvent(proc, ev);
  }
}

function handleStreamEvent(proc: LiveProc, ev: StreamEvent): void {
  switch (ev.type) {
    case "system": {
      // First line is always system/init. Capture session id (for future
      // --resume), mark ready so any queued sends fire, and clear the
      // resumedFrom probe — receiving system/init means the resume (if
      // any) succeeded.
      const sid = (ev as { session_id?: string }).session_id;
      if (sid) {
        proc.sessionId = sid;
        persistSessionIdIfChanged(proc.threadId, sid);
      }
      proc.resumedFrom = null;
      proc.ready = true;
      drainPendingSend(proc);
      return;
    }
    case "assistant": {
      // claude carries session_id on every assistant frame too. Catch any
      // mid-stream id changes (rare — but harmless to be defensive).
      const sid = (ev as { session_id?: string }).session_id;
      if (sid) {
        proc.sessionId = sid;
        persistSessionIdIfChanged(proc.threadId, sid);
      }
      const msg = (ev as { message?: { content?: unknown[]; usage?: Record<string, number> } }).message;
      if (!msg) return;
      const usage = msg.usage ?? {};
      // Per-turn input cost in claude-code includes regular + cache
      // creation + cache read tokens. Output is just generation. We sum
      // input components into a single counter for the sidebar chip.
      const inputTotal =
        (usage.input_tokens ?? 0) +
        (usage.cache_creation_input_tokens ?? 0) +
        (usage.cache_read_input_tokens ?? 0);
      const outputTotal = usage.output_tokens ?? 0;
      // One transcript line per content block: text → role=assistant text,
      // tool_use → role=assistant tool_use. Built-in tool calls (Read /
      // Edit / Bash) DO appear here — we record them so the UI can render
      // a tool card. Only make_card / save_plan are intercepted by the
      // MCP layer; built-ins flow through transparently.
      for (const block of msg.content ?? []) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
        if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) {
          const m = ComposerMessage.parse({
            id: makeMsgId(),
            ts: new Date().toISOString(),
            role: "assistant",
            text: b.text,
            usage: { input_tokens: 0, output_tokens: 0 },
          });
          appendMessage(proc.threadId, m);
          broadcast({ type: "composer_message_appended", thread_id: proc.threadId, message: m });
        } else if (b.type === "tool_use" && b.id && b.name) {
          // make_card / save_plan flow through MCP and are ALSO recorded
          // there (mcp.ts → composerMcpRoutes). We still record built-in
          // tool_use blocks here so the UI can render them.
          if (b.name === "make_card" || b.name === "save_plan") continue;
          const m = ComposerMessage.parse({
            id: b.id,
            ts: new Date().toISOString(),
            role: "assistant",
            tool_use: { id: b.id, name: b.name, input: b.input ?? {} },
          });
          appendMessage(proc.threadId, m);
          broadcast({ type: "composer_message_appended", thread_id: proc.threadId, message: m });
        }
      }
      // Persist usage on the assistant turn boundary, attached to a
      // marker message so per-turn cost is queryable later. We piggy-back
      // on the text message above when it exists; if the turn is purely
      // tool calls, emit a usage-only marker.
      if (inputTotal || outputTotal) {
        bumpUsage(proc.threadId, { input_tokens: inputTotal, output_tokens: outputTotal });
      }
      return;
    }
    case "user": {
      // Echoed user message (--replay-user-messages) or tool_result. We
      // don't enable replay, so this only fires for tool_result blocks
      // we ourselves injected. Record them so the UI can render the
      // tool's response under the originating tool card.
      const msg = (ev as { message?: { content?: unknown[] } }).message;
      for (const block of msg?.content ?? []) {
        if (!block || typeof block !== "object") continue;
        const b = block as { type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean };
        if (b.type !== "tool_result" || !b.tool_use_id) continue;
        const text =
          typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        const m = ComposerMessage.parse({
          id: makeMsgId(),
          ts: new Date().toISOString(),
          role: "user",
          tool_result: {
            tool_use_id: b.tool_use_id,
            content: text,
            is_error: !!b.is_error,
          },
        });
        appendMessage(proc.threadId, m);
        broadcast({ type: "composer_message_appended", thread_id: proc.threadId, message: m });
      }
      return;
    }
    case "result": {
      // End of a turn. Now (and only now) the idle timer should arm —
      // claude is genuinely sitting on its hands until the next user
      // message. (resetIdleTimer is a no-op while turnInFlight, so we
      // MUST clear the flag first.) Also broadcast the falling edge so
      // the UI can drop the typing indicator.
      const wasInFlight = proc.turnInFlight;
      proc.turnInFlight = false;
      resetIdleTimer(proc);
      if (wasInFlight) {
        broadcast({ type: "composer_turn_state", thread_id: proc.threadId, in_flight: false });
      }
      logger.debug("composer_turn_ended", {
        threadId: proc.threadId,
        sessionId: proc.sessionId,
      });
      return;
    }
    default:
      // Unknown event type — log at debug, don't choke. claude adds new
      // event types over time (e.g. partial_assistant) which we tolerate.
      logger.debug("composer_unknown_stream_event", {
        threadId: proc.threadId,
        type: ev.type,
      });
  }
}

let msgSeq = 0;
function makeMsgId(): string {
  msgSeq = (msgSeq + 1) & 0x7fffffff;
  return `m${Date.now().toString(36)}_${msgSeq.toString(36)}`;
}

function onExit(proc: LiveProc, code: number | null, signal: NodeJS.Signals | null): void {
  if (proc.idleTimer) clearTimeout(proc.idleTimer);
  // If the process died while still in-flight, drop the typing indicator
  // — the falling edge would normally come from a `result` event we'll
  // never receive.
  if (proc.turnInFlight) {
    proc.turnInFlight = false;
    broadcast({ type: "composer_turn_state", thread_id: proc.threadId, in_flight: false });
  }
  // Resume failure: spawned with --resume <id> but exited before claude
  // ever emitted a system/init event. The session id we tried to resume
  // is dead (cleaned up, expired, etc.) — clear the persisted id so the
  // NEXT sendUserMessage falls back to the preamble path. Without this
  // we'd loop forever, retrying --resume against the same dead id.
  if (proc.resumedFrom && !proc.ready) {
    logger.warn("composer_resume_failed", {
      threadId: proc.threadId,
      sessionId: proc.resumedFrom,
      code,
      signal,
    });
    try {
      const summary = patchThread(proc.threadId, { session_id: null });
      broadcast({ type: "composer_thread_changed", thread_id: proc.threadId, summary });
    } catch (err) {
      logger.warn("composer_resume_clear_failed", {
        threadId: proc.threadId,
        err: String(err),
      });
    }
  }
  live.delete(proc.threadId);
  logger.info("composer_proc_exit", { threadId: proc.threadId, code, signal });
  // System event in transcript so the UI can render a "process ended" line
  // with a Reconnect affordance (next user message respawns).
  try {
    const m = ComposerMessage.parse({
      id: makeMsgId(),
      ts: new Date().toISOString(),
      role: "system",
      text:
        signal === null && code === 0
          ? "[claude exited cleanly]"
          : `[claude exited code=${code ?? "null"} signal=${signal ?? "null"}]`,
    });
    appendMessage(proc.threadId, m);
    broadcast({ type: "composer_message_appended", thread_id: proc.threadId, message: m });
  } catch {
    /* swallow — exit-side errors shouldn't propagate */
  }
  setStatus(proc.threadId, "idle");
}

// ─── Pending-send queue (for messages that arrive before init) ───────────────

const pendingSends = new Map<string, string[]>();

function queueSend(threadId: string, line: string): void {
  const arr = pendingSends.get(threadId) ?? [];
  arr.push(line);
  pendingSends.set(threadId, arr);
}

function drainPendingSend(proc: LiveProc): void {
  const arr = pendingSends.get(proc.threadId);
  if (!arr || arr.length === 0) return;
  pendingSends.delete(proc.threadId);
  for (const line of arr) writeStdin(proc, line);
}

function writeStdin(proc: LiveProc, line: string): void {
  if (!proc.child.stdin || proc.child.stdin.destroyed) {
    logger.warn("composer_stdin_unavailable", { threadId: proc.threadId });
    return;
  }
  // Any stdin write means a turn is starting (or continuing, in the case
  // of a tool_result re-injection). Suppress the idle timer for the
  // duration; it re-arms on the next `result` event.
  const wasInFlight = proc.turnInFlight;
  proc.turnInFlight = true;
  if (proc.idleTimer) {
    clearTimeout(proc.idleTimer);
    proc.idleTimer = null;
  }
  // Broadcast the rising edge so the UI can latch the typing indicator.
  // Tool_result re-injection during the same turn is a no-op (already
  // in-flight), avoiding wasteful traffic.
  if (!wasInFlight) {
    broadcast({ type: "composer_turn_state", thread_id: proc.threadId, in_flight: true });
  }
  // We used to queue here when `proc.ready === false` (pre-`system/init`)
  // and drain on init. That deadlocked claude in `--print` stream-json
  // mode: claude emits `system/init` only AFTER it processes its first
  // stdin frame, but we wouldn't write the first frame until init
  // landed. Both sides waited forever, ↓0 ↑0 indefinitely.
  //
  // Just write immediately. Node's child stdin is a pipe — the kernel
  // buffers up to PIPE_BUF (16k on Darwin) before backpressuring, which
  // is plenty for a JSON line. Claude's reader is a streamed JSONL
  // parser; it handles input arriving before its own init.
  proc.child.stdin.write(line.endsWith("\n") ? line : line + "\n");
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function sendUserMessage(threadId: string, text: string): Promise<void> {
  // Lazy worktree create. If we've never spawned for this thread (or the
  // worktree was cleaned up), bring one up so claude has a scratch space.
  // Best-effort: a worktree-create failure shouldn't block the user — we
  // fall back to spawning in BOARD_ROOT.
  if (!live.has(threadId)) {
    try {
      await ensureWorktree(threadId);
    } catch (err) {
      logger.warn("composer_worktree_provision_failed", { threadId, err: String(err) });
    }
  }

  let proc = live.get(threadId);
  let isFirstUserMessage = false;
  let replayPreamble: string | null = null;
  if (!proc) {
    if (!canSpawn()) {
      throw Object.assign(
        new Error(`composer concurrency limit reached (${getConfig().composer_concurrency})`),
        { code: "concurrency_exhausted", status: 429 },
      );
    }
    isFirstUserMessage = isThreadEmpty(threadId);
    // Prefer --resume when we have a recorded session_id from a prior
    // claude run on this thread. claude restores the actual model context,
    // so no replay preamble is needed and we don't pay history-replay
    // tokens. Fall back to the preamble path when session_id is null
    // (first respawn before claude ever reported one, or the previous
    // resume attempt failed and onExit cleared the id).
    let resumeSessionId: string | null = null;
    try {
      resumeSessionId = getThread(threadId).session_id;
    } catch {
      resumeSessionId = null;
    }
    proc = await spawnProc(threadId, { resumeSessionId });
    if (!resumeSessionId) {
      // No session to resume → synthesize a context preamble that we'll
      // PREFIX onto the user's actual message in the same stdin frame
      // (rather than sending a separate dump frame, which claude was
      // treating as a standalone user message and narrating in its reply).
      replayPreamble = buildReplayPreamble(threadId);
    }
  }

  // Append to transcript first (so UI sees the user message immediately).
  // NOTE: we store the user's raw text here, not the combined preamble +
  // text — the preamble is purely a wire-level concern between us and
  // claude; the durable transcript only contains what the user typed.
  const userMsg = ComposerMessage.parse({
    id: makeMsgId(),
    ts: new Date().toISOString(),
    role: "user",
    text,
  });
  appendMessage(threadId, userMsg);
  broadcast({ type: "composer_message_appended", thread_id: threadId, message: userMsg });

  // Stream-json input frame. claude reads NDJSON lines from stdin.
  // When a respawn happened, prepend the preamble inside the SAME frame
  // so claude receives [context + new user message] as one cohesive
  // user turn, with the new message wrapped in a clear delimiter.
  const wireText = replayPreamble
    ? `${replayPreamble}<user_message>\n${text}\n</user_message>`
    : text;
  const frame = JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text: wireText }] },
  });
  writeStdin(proc, frame);

  // First user message → fire-and-forget title generation. We do this
  // BEFORE awaiting any response so the title can land while claude is
  // still thinking.
  if (isFirstUserMessage) {
    void generateThreadTitle(text)
      .then((title) => {
        try {
          const summary = patchThread(threadId, { title });
          broadcast({ type: "composer_thread_changed", thread_id: threadId, summary });
        } catch (err) {
          logger.warn("composer_title_persist_failed", { threadId, err: String(err) });
        }
      })
      .catch(() => {
        /* generateThreadTitle already swallows; safety net here. */
      });
  }
}

function isThreadEmpty(threadId: string): boolean {
  try {
    return getThread(threadId).message_count === 0;
  } catch {
    return false;
  }
}

/**
 * Build a context preamble that captures prior conversation when the
 * claude process has been respawned mid-thread (idle shutdown, server
 * restart, …). Returns null if there's no history yet (first-message
 * spawn, no preamble needed).
 *
 * Why a *preamble* (returned for the caller to combine with the user's
 * message) instead of a separate stdin frame: when sent as its own user
 * frame, claude treated the history dump as a fresh user request —
 * narrating "session restarted, here are the questions again" and
 * sometimes ignoring the actual next user message that followed. A
 * single combined frame, with the prior conversation framed as YOUR
 * past speech and the user's new message clearly delimited at the
 * bottom, removes the ambiguity.
 *
 * Wording avoids the words "session", "restart", "idle", "replay" —
 * those leak as user-facing narration ("세션이 재시작됐네요"). Frame it
 * as plain conversation continuity.
 */
function buildReplayPreamble(threadId: string): string | null {
  let history: ComposerMessageT[] = [];
  try {
    history = getThread(threadId).messages;
  } catch {
    return null;
  }
  if (history.length === 0) return null;

  // Find the index of the most recent assistant text turn so we can
  // mark it explicitly. Claude's failure mode without this marker:
  // re-asking questions it already asked, because the dump's last
  // assistant entry "looks like" something pending rather than already-said.
  let lastAssistantTextIdx = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const m = history[i];
    if (m && m.role === "assistant" && m.text) {
      lastAssistantTextIdx = i;
      break;
    }
  }

  const body: string[] = [];
  for (let i = 0; i < history.length; i += 1) {
    const m = history[i];
    if (!m) continue;
    const tag = i === lastAssistantTextIdx ? "ASSISTANT (your most recent turn)" : null;
    if (m.role === "user" && m.text) {
      body.push(`USER: ${m.text}`);
    } else if (m.role === "assistant" && m.text) {
      body.push(`${tag ?? "ASSISTANT"}: ${m.text}`);
    } else if (m.role === "assistant" && m.tool_use) {
      body.push(`ASSISTANT [tool_use ${m.tool_use.name}]: ${safeJSON(m.tool_use.input)}`);
    } else if (m.role === "user" && m.tool_result) {
      body.push(
        `TOOL_RESULT[${m.tool_result.tool_use_id}]${m.tool_result.is_error ? " (error)" : ""}: ${m.tool_result.content}`,
      );
    } else if (m.role === "system" && m.text) {
      body.push(`SYSTEM: ${m.text}`);
    }
  }

  // Hard-instruct the model: continue the conversation seamlessly.
  // Don't narrate the boundary — the user does NOT see this preamble,
  // and any acknowledgment of "context restored / session resumed"
  // shows up as confusing noise to them.
  return [
    "<conversation_so_far>",
    "Below is the conversation between you and the user up to this point.",
    "Everything marked ASSISTANT is something YOU previously said — do not repeat or re-ask any of it.",
    "The user's NEW message follows in <user_message> at the bottom.",
    "Respond to that new message directly, in continuity with the conversation.",
    "Do NOT preface your response with phrases like \"세션이 재시작됐네요\", \"session restarted\", \"let me reconfirm\", \"based on our prior conversation\", or any acknowledgment that a boundary occurred. Just continue.",
    "",
    ...body,
    "</conversation_so_far>",
    "",
  ].join("\n");
}

function safeJSON(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s.length > 2000 ? s.slice(0, 2000) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

export async function injectToolResult(
  threadId: string,
  toolUseId: string,
  content: string,
  isError: boolean,
): Promise<void> {
  const proc = live.get(threadId);
  if (!proc) {
    // Process is gone — nothing to deliver to. The pending was already
    // cleared by gate.ts; on next message claude re-spawns and the
    // history dump tells it what happened.
    logger.warn("composer_inject_no_proc", { threadId, toolUseId });
    return;
  }
  const frame = JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  });
  writeStdin(proc, frame);
}

export async function stopThread(threadId: string): Promise<void> {
  const proc = live.get(threadId);
  if (!proc) return;
  try {
    proc.child.kill("SIGINT");
  } catch (err) {
    logger.warn("composer_stop_failed", { threadId, err: String(err) });
  }
  // Don't await — onExit will fire when the process actually dies.
}

export async function killThread(threadId: string): Promise<void> {
  const proc = live.get(threadId);
  if (proc) {
    try {
      proc.child.kill("SIGKILL");
    } catch (err) {
      logger.warn("composer_kill_failed", { threadId, err: String(err) });
    }
    live.delete(threadId);
  }
  // Worktree + dir cleanup is best-effort — partial failures here
  // shouldn't block thread deletion.
  await cleanupComposerWorktree(threadId);
}

export function getProcessStatus(threadId: string): ComposerThreadSummary["status"] {
  return live.has(threadId) ? "running" : "idle";
}

export function canSpawn(): boolean {
  const cap = getConfig().composer_concurrency;
  return live.size < cap;
}

// Keep runGit referenced so future per-thread git ops can land here without
// re-importing. Tree-shaken in production builds.
export const _gitRunner = runGit;
