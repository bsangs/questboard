/**
 * Worker spawn — the dispatcher prepares the worktree, reads the card body,
 * inlines it as the spawn message, and starts a `claude -p` child rooted
 * INSIDE the worktree. Workers never touch the server, never run git
 * worktree commands, never read .questboard/data/.
 *
 * The system prompt the worker sees is `questboard/board/prompts/worker.md`
 * passed via `--append-system-prompt` (read-as-string; the file-form flag
 * is not exposed by the CLI's --help).
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseCardMd, isConversationKind, type Comment } from "@questboard/core";
import type { DispatcherConfig } from "./config.js";
import type { QueueCandidate } from "./queue.js";
import {
  diffStatAgainstMain,
  listPriorWipCommits,
  prepareWorktree,
} from "./git.js";
// TODO(X-srv): these utilities are slated to live under
// `questboard/board/server/src/util/`. The dispatcher is in a separate
// package, so once X-srv lands them we'll either re-export them through
// @questboard/core or land a thin local copy under `./util/`. Until then,
// the local stubs below are best-effort no-ops so worker spawn keeps
// functioning end-to-end.
import {
  discoverCommands,
  type DiscoveredCommands,
} from "./util/command-discovery.js";
import { runInstall } from "./util/install.js";
import {
  composeSystemPrompt,
  readBasePrompt,
  readMergerPostBuildCmd,
  readScope,
  readToolGuidance,
} from "./context.js";

const WORKER_ALLOWED_TOOLS = ["Bash", "Read", "Write", "Edit", "Grep", "Glob"] as const;
const REVIEWER_ALLOWED_TOOLS = ["Bash", "Read", "Grep", "Glob"] as const;
const MERGER_ALLOWED_TOOLS = ["Bash", "Read", "Edit", "Grep", "Glob"] as const;

export type WorkerRole = "worker" | "reviewer" | "merger";

export interface LiveTokenTotals {
  /** Cumulative input/cache tokens spent by this helper run. */
  input: number;
  /** Cumulative output tokens spent by this helper run. */
  output: number;
  /** Current context-window size: input/cache tokens for the latest model call. */
  context: number;
  exact: boolean;
  stream?: LiveTokenStreamState;
}

interface TokenUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

interface LiveTokenStreamState {
  settledInput: number;
  settledOutput: number;
  lastContext: number;
  currentUsage: TokenUsage | null;
}

interface StreamUsageEvent {
  type?: string;
  message?: { usage?: TokenUsage };
  usage?: TokenUsage;
  event?: {
    type?: string;
    message?: { usage?: TokenUsage };
    usage?: TokenUsage;
  };
}

export interface SpawnedWorker {
  pid: number;
  child: ChildProcess;
  cardId: string;
  attempt: number;
  startedAt: string;
  transcriptPath: string;
  /** Worktree the dispatcher prepared for this run. (For reviewer the
   *  cwd is BOARD_ROOT; this still references the worker branch's tree.) */
  worktreePath: string;
  /** Branch the worker is committing on. */
  wipBranch: string;
  /** What kind of process this is. Drives exit-handler routing. */
  role: WorkerRole;
  /** Live token totals accumulated from claude stream-json usage frames. */
  liveTokens: LiveTokenTotals;
  /**
   * Set the moment the exit handler starts running (i.e. child.on("exit")
   * fired). Stays null while the worker is alive. Used by StatsReporter to
   * detect a routeExit() that's been hung for too long — without this,
   * `active.has(card)` would suppress the stats fallback forever.
   */
  exitStartedAt: number | null;
}

function nextAttempt(transcriptsDir: string): number {
  try {
    const files = fs.readdirSync(transcriptsDir).filter((f) => f.endsWith(".jsonl"));
    return files.length + 1;
  } catch {
    return 1;
  }
}

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "Z");
}

function totalsFromUsage(usage: TokenUsage): LiveTokenTotals {
  return {
    input:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    output: usage.output_tokens ?? 0,
    context:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    exact: true,
  };
}

function createLiveTokenTotals(): LiveTokenTotals {
  return { input: 0, output: 0, context: 0, exact: false };
}

function streamState(tokens: LiveTokenTotals): LiveTokenStreamState {
  if (!tokens.stream) {
    tokens.stream = {
      settledInput: 0,
      settledOutput: 0,
      lastContext: 0,
      currentUsage: null,
    };
  }
  return tokens.stream;
}

function mergeUsage(prev: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    input_tokens:
      next.input_tokens != null && next.input_tokens > 0
        ? next.input_tokens
        : prev.input_tokens,
    cache_creation_input_tokens:
      next.cache_creation_input_tokens != null && next.cache_creation_input_tokens > 0
        ? next.cache_creation_input_tokens
        : prev.cache_creation_input_tokens,
    cache_read_input_tokens:
      next.cache_read_input_tokens != null && next.cache_read_input_tokens > 0
        ? next.cache_read_input_tokens
        : prev.cache_read_input_tokens,
    output_tokens: next.output_tokens ?? prev.output_tokens,
  };
}

function usageHasTokens(usage: TokenUsage): boolean {
  return (
    (usage.input_tokens ?? 0) > 0 ||
    (usage.cache_creation_input_tokens ?? 0) > 0 ||
    (usage.cache_read_input_tokens ?? 0) > 0 ||
    (usage.output_tokens ?? 0) > 0
  );
}

function refreshDisplayedLiveTokens(tokens: LiveTokenTotals): void {
  const state = streamState(tokens);
  const current = state.currentUsage ? totalsFromUsage(state.currentUsage) : null;
  tokens.input = state.settledInput + (current?.input ?? 0);
  tokens.output = state.settledOutput + (current?.output ?? 0);
  tokens.context = current?.context ?? state.lastContext;
  tokens.exact = tokens.exact || tokens.input > 0 || tokens.output > 0;
}

function replaceLiveTokensWithUsage(tokens: LiveTokenTotals, usage: TokenUsage): void {
  const next = totalsFromUsage(usage);
  const state = streamState(tokens);
  state.settledInput = next.input;
  state.settledOutput = next.output;
  state.lastContext = tokens.context || state.lastContext || next.context;
  state.currentUsage = null;
  tokens.input = next.input;
  tokens.output = next.output;
  tokens.context = state.lastContext;
  tokens.exact = true;
}

function applyStreamUsageEvent(tokens: LiveTokenTotals, event: NonNullable<StreamUsageEvent["event"]>): void {
  const state = streamState(tokens);
  if (event.type === "message_start") {
    state.currentUsage = event.message?.usage
      ? mergeUsage({}, event.message.usage)
      : {};
    refreshDisplayedLiveTokens(tokens);
    return;
  }
  if (event.type === "message_delta" && event.usage) {
    state.currentUsage = mergeUsage(state.currentUsage ?? {}, event.usage);
    refreshDisplayedLiveTokens(tokens);
    return;
  }
  if (event.type === "message_stop") {
    if (state.currentUsage && usageHasTokens(state.currentUsage)) {
      const current = totalsFromUsage(state.currentUsage);
      state.settledInput += current.input;
      state.settledOutput += current.output;
      state.lastContext = current.context;
      state.currentUsage = null;
      refreshDisplayedLiveTokens(tokens);
    }
  }
}

function addLiveTokensFromLine(tokens: LiveTokenTotals, line: string): void {
  if (!line.trim()) return;
  let parsed: StreamUsageEvent;
  try {
    parsed = JSON.parse(line) as StreamUsageEvent;
  } catch {
    return;
  }
  if (parsed.type === "stream_event" && parsed.event) {
    applyStreamUsageEvent(tokens, parsed.event);
    return;
  }
  if (parsed.type !== "result") return;
  const usage = parsed.usage;
  if (!usage) return;
  if (parsed.type === "result") {
    // The final result frame is the authoritative run total. It replaces any
    // partial stream totals observed while the helper was still running.
    replaceLiveTokensWithUsage(tokens, usage);
    return;
  }
}

export function refreshLiveTokensFromTranscript(
  transcriptPath: string,
  liveTokens: LiveTokenTotals,
): void {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return;
  }
  const next = createLiveTokenTotals();
  for (const line of raw.split(/\r?\n/)) {
    addLiveTokensFromLine(next, line);
  }
  liveTokens.input = next.input;
  liveTokens.output = next.output;
  liveTokens.context = next.context;
  liveTokens.exact = next.exact;
  liveTokens.stream = next.stream;
}

function observeStreamJsonTranscript(
  child: ChildProcess,
  transcriptPath: string,
  liveTokens: LiveTokenTotals,
): void {
  let offset = 0;
  let buffered = "";

  const readNewBytes = () => {
    let size: number;
    try {
      size = fs.statSync(transcriptPath).size;
    } catch {
      return;
    }
    if (size < offset) {
      offset = 0;
      buffered = "";
    }
    if (size === offset) return;

    const len = size - offset;
    const buf = Buffer.allocUnsafe(len);
    let fd: number | null = null;
    try {
      fd = fs.openSync(transcriptPath, "r");
      fs.readSync(fd, buf, 0, len, offset);
    } catch {
      return;
    } finally {
      if (fd !== null) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
    offset = size;
    buffered += buf.toString("utf8");

    let nl: number;
    while ((nl = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      addLiveTokensFromLine(liveTokens, line);
    }
  };

  const listener = () => readNewBytes();
  fs.watchFile(transcriptPath, { interval: 1_000 }, listener);
  child.on("exit", () => {
    readNewBytes();
    addLiveTokensFromLine(liveTokens, buffered);
    buffered = "";
    fs.unwatchFile(transcriptPath, listener);
  });
}

/** Read shared card conversation from comments.jsonl (conversation kinds only). */
function readConversation(commentsFile: string): Comment[] {
  if (!fs.existsSync(commentsFile)) return [];
  const out: Comment[] = [];
  for (const line of fs.readFileSync(commentsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const c = JSON.parse(line) as Comment;
      if (isConversationKind(c.kind)) out.push(c);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function fmtTs(iso: string): string {
  // Show as "YYYY-MM-DD HH:mm" in UTC for prompt readability.
  try {
    return iso.replace("T", " ").replace(/:\d{2}\.\d{3}Z$/, "");
  } catch {
    return iso;
  }
}

function speakerLabel(c: Comment): string {
  // For review_note we surface the reviewer's perspective with no language
  // marker — review_note bodies are already in the card's language.
  switch (c.kind) {
    case "stuck":
      return "worker";
    case "answer":
      return c.author === "human" ? "human" : c.author;
    case "resumed":
      return "system";
    case "review_note":
      return "reviewer";
    default:
      return c.author;
  }
}

/**
 * Format prior conversation as "## Conversation so far". Returns empty
 * string if there's nothing useful to show — workers don't need an empty
 * header.
 */
function formatConversationSection(comments: Comment[]): string {
  if (comments.length === 0) return "";
  const lines: string[] = [
    "## Conversation so far",
    "",
    "Each entry is a message or note from a prior worker, reviewer, merger,",
    "human, or the system. Read these in order before deciding what to do next.",
    "The latest message is usually the most relevant.",
    "",
  ];
  for (const c of comments) {
    lines.push(`— [${speakerLabel(c)}, ${fmtTs(c.ts)}] —`);
    lines.push(c.body.trimEnd());
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

/**
 * Resolve a spawn cwd given a base directory (worktree for workers, board
 * root for reviewer/merger) and an optional scope-defined cwd. The scope
 * cwd is treated as a project-relative path; it's resolved against the
 * base and the result must remain INSIDE the base. If validation fails
 * (escapes base, missing dir, not a dir), the function logs a warning to
 * stdout (PM2 picks it up) and returns the base unchanged so spawning
 * still succeeds with safe defaults.
 *
 * Project-stored values are POSIX-style; OS-specific separators inside
 * the user-supplied string are tolerated by `path.resolve`.
 */
function resolveSpawnCwd(args: {
  base: string;
  scopeCwd: string | null | undefined;
  cardId: string;
  role: WorkerRole;
}): string {
  const { base, scopeCwd, cardId, role } = args;
  if (!scopeCwd) return base;

  // Reject absolute paths that aren't already under base — server should
  // store relatives, but be defensive in case someone hand-edited config.
  const candidate = path.isAbsolute(scopeCwd)
    ? scopeCwd
    : path.resolve(base, scopeCwd);

  const rel = path.relative(base, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "scope_cwd_outside_base",
        card_id: cardId,
        role,
        scope_cwd: scopeCwd,
        base,
        message: "scope.cwd resolves outside base — using base instead",
      }) + "\n",
    );
    return base;
  }

  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "scope_cwd_missing",
        card_id: cardId,
        role,
        scope_cwd: scopeCwd,
        resolved: candidate,
        message: "scope.cwd does not exist — using base instead",
      }) + "\n",
    );
    return base;
  }
  if (!stat.isDirectory()) {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "scope_cwd_not_dir",
        card_id: cardId,
        role,
        scope_cwd: scopeCwd,
        resolved: candidate,
        message: "scope.cwd is not a directory — using base instead",
      }) + "\n",
    );
    return base;
  }
  return candidate;
}

/**
 * Render the "## Previous attempts" section for an attempt > 1 spawn. Pulls
 * prior wip-commits off `origin/<wipBranch>`, computes a diff stat for
 * each, and appends the most recent reviewer feedback (if any). Returns
 * "" on attempt 1 or when no prior commits exist.
 *
 * The goal is for the worker to see what its predecessors tried before
 * stalling — so it doesn't blindly redo the same approach. We deliberately
 * keep the section tight (sha + subject + diff stat + last reviewer note)
 * rather than dumping full diffs; full diffs are too noisy and the worker
 * can read them itself if it wants.
 */
async function formatPreviousAttemptsSection(args: {
  attempt: number;
  boardRoot: string;
  wipBranch: string;
  comments: Comment[];
  baseBranch?: string | null;
}): Promise<string> {
  if (args.attempt <= 1) return "";
  const commits = await listPriorWipCommits(args.boardRoot, args.wipBranch, args.baseBranch);
  if (commits.length === 0) return "";

  // Most recent reviewer feedback: prefer the last `review_note` (rejection
  // body) — that's the canonical channel for reviewer feedback in this
  // schema. Fall back to the last `stuck` body if no reviewer entry exists.
  let reviewerFeedback: { ts: string; body: string } | null = null;
  let stuckFallback: { ts: string; body: string } | null = null;
  for (let i = args.comments.length - 1; i >= 0; i--) {
    const c = args.comments[i];
    if (!c) continue;
    if (!reviewerFeedback && c.kind === "review_note") {
      reviewerFeedback = { ts: c.ts, body: c.body };
    }
    if (!stuckFallback && c.kind === "stuck") {
      stuckFallback = { ts: c.ts, body: c.body };
    }
    if (reviewerFeedback && stuckFallback) break;
  }

  const lines: string[] = [
    "## Previous attempts",
    "",
    "Earlier attempts at this card committed `wip:` snapshots before stalling",
    "or being rejected. Read these before deciding your approach — don't",
    "blindly redo what's already been tried.",
    "",
  ];
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    if (!c) continue;
    lines.push(`### Attempt ${i + 1} — ${c.sha} ${c.subject}`);
    lines.push("");
    const stat = await diffStatAgainstMain(args.boardRoot, c.sha, 12, args.baseBranch);
    if (stat) {
      lines.push("```");
      lines.push(stat);
      lines.push("```");
    } else {
      lines.push("(diff stat unavailable)");
    }
    lines.push("");
  }

  const feedback = reviewerFeedback ?? stuckFallback;
  if (feedback) {
    lines.push(
      reviewerFeedback
        ? "### Most recent reviewer feedback"
        : "### Most recent stuck reason",
    );
    lines.push("");
    lines.push(feedback.body.trimEnd());
    lines.push("");
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

function buildSpawnMessage(card: {
  id: string;
  title: string;
  cardMd: string;
  comments: Comment[];
  previousAttempts: string;
}): string {
  const conversation = formatConversationSection(card.comments);
  return [
    `# Card ${card.id}: ${card.title}`,
    "",
    "You are working inside this card's git worktree (it's your current",
    "working directory). The branch is already checked out and your job is",
    "to satisfy the card description below, then commit your work and exit.",
    "You do NOT need to read card.md or comments.jsonl — the relevant content",
    "is already inlined here.",
    "",
    "## Card",
    "",
    card.cardMd.trim() || "(empty card.md)",
    "",
    conversation,
    card.previousAttempts,
    "When you're done: `git add -A && git commit -m \"<conventional message>\"`,",
    "then exit. The dispatcher will push the branch and request review.",
    "",
    "If you cannot finish without a human decision, write your question as the",
    "final assistant message and end it with a `STUCK: <one-line reason>`",
    "marker on its own line. The dispatcher will commit any in-flight work,",
    "push the branch, and surface your question on the card.",
  ]
    .filter((s, i, arr) => !(s === "" && arr[i - 1] === "")) // collapse double-blanks
    .join("\n");
}


export async function spawnWorker(
  card: QueueCandidate,
  cfg: DispatcherConfig,
): Promise<SpawnedWorker> {
  const transcriptsDir = path.join(cfg.cardsDir, card.id, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const attempt = nextAttempt(transcriptsDir);
  const ts = fileTimestamp();
  const transcriptPath = path.join(transcriptsDir, `${ts}-attempt-${attempt}.jsonl`);

  // Read card body so we can inline title + description as the spawn prompt.
  // Worker never touches .questboard/data/ itself.
  const cardMd = fs.readFileSync(path.join(cfg.cardsDir, card.id, "card.md"), "utf8");
  const parsed = parseCardMd(cardMd);

  // Prepare worktree (or reuse on resumption). Worker branches use
  // worker/card-<id>.
  const wipBranch = `worker/card-${card.id}`;
  const wt = await prepareWorktree({
    boardRoot: cfg.boardRoot,
    worktreesDir: cfg.worktreesDir,
    cardId: card.id,
    branch: wipBranch,
    baseBranch: cfg.baseBranch,
  });

  // Surface orphan-resume on the card so the human can see WHY a fresh
  // worker is starting from non-empty state. We post via the regular
  // comments endpoint with kind=system_event (audit channel, not
  // conversation noise). Best-effort — failure here MUST NOT block spawn.
  if (wt.resumedFromRemote) {
    try {
      const url = `${cfg.serverUrl}/api/cards/${card.id}/comments`;
      const body = JSON.stringify({
        author: "system",
        kind: "system_event",
        body: `respawn: resumed from origin/${wipBranch} (${
          wt.resumedCommitsAhead ?? 0
        } commit${wt.resumedCommitsAhead === 1 ? "" : "s"} preserved)`,
      });
      // No await — fire-and-forget; the dispatcher must not stall here.
      void fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  const rolePrompt = fs.readFileSync(cfg.promptPath, "utf8");
  const scope = readScope(cfg, parsed.frontmatter.scope ?? null);
  const promptText = composeSystemPrompt({
    basePrompt: readBasePrompt(cfg),
    scopeDescription: scope?.description ?? "",
    toolGuidance: readToolGuidance(cfg, WORKER_ALLOWED_TOOLS),
    rolePrompt,
  });
  const conversation = readConversation(
    path.join(cfg.cardsDir, card.id, "comments.jsonl"),
  );

  // Discover commands BEFORE rendering the spawn message — the env vars
  // we set below let the worker shell out without re-deriving the package
  // manager. Discovery is a sync filesystem read; cheap.
  const commands: DiscoveredCommands = discoverCommands(wt.worktreePath);

  // Run install BEFORE spawning the worker. Fresh worktrees never have
  // node_modules, so any worker that touches a JS/TS dep would fail
  // first-step. Best-effort: log failures but don't abort the spawn —
  // the worker can self-heal if needed.
  if (commands.installCmd) {
    const result = await runInstall({
      cwd: wt.worktreePath,
      installCmd: commands.installCmd,
      log: (e) =>
        process.stdout.write(
          JSON.stringify({ ts: new Date().toISOString(), card_id: card.id, ...e }) + "\n",
        ),
    });
    if (result.error) {
      process.stdout.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: "install_warning",
          card_id: card.id,
          message: `pre-spawn install reported errors (continuing): ${result.error}`,
          exit_code: result.exitCode,
        }) + "\n",
      );
    }
  }

  const previousAttempts = await formatPreviousAttemptsSection({
    attempt,
    boardRoot: cfg.boardRoot,
    wipBranch,
    comments: conversation,
    baseBranch: cfg.baseBranch,
  });

  const spawnMessage = buildSpawnMessage({
    id: card.id,
    title: parsed.frontmatter.title,
    cardMd,
    comments: conversation,
    previousAttempts,
  });
  const spawnCwd = resolveSpawnCwd({
    base: wt.worktreePath,
    scopeCwd: scope?.cwd,
    cardId: card.id,
    role: "worker",
  });

  const args: string[] = [
    "-p",
    // `--bare` only when running in bare auth mode; in session mode we let
    // claude pick up the user's interactive login session. See AuthMode.
    ...(cfg.authMode === "bare" ? ["--bare"] : []),
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    promptText,
    "--allowed-tools",
    WORKER_ALLOWED_TOOLS.join(","),
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    spawnMessage,
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // In session mode we forward NO ANTHROPIC_* env so the child uses claude's
    // login session. In bare mode we forward only what's actually set —
    // ANTHROPIC_BASE_URL is optional even in bare mode (claude defaults to
    // its built-in base URL when only the API key is present).
    ...(cfg.anthropicBaseUrl != null ? { ANTHROPIC_BASE_URL: cfg.anthropicBaseUrl } : {}),
    ...(cfg.anthropicApiKey != null ? { ANTHROPIC_API_KEY: cfg.anthropicApiKey } : {}),
    BOARD_ROOT: cfg.boardRoot,
    BOARD_SERVER_URL: cfg.serverUrl,
    BOARD_DATA: cfg.boardData,
    BOARD_WORKTREES: cfg.worktreesDir,
    CARD_ID: card.id,
    ATTEMPT: String(attempt),
    // Per-project commands discovered from the worktree's lockfile +
    // package.json. Empty strings are intentional ("no such command")
    // so the worker can `[ -n "$BOARD_TEST_CMD" ]`-guard cleanly.
    BOARD_INSTALL_CMD: commands.installCmd ?? "",
    BOARD_TEST_CMD: commands.testCmd ?? "",
    BOARD_BUILD_CMD: commands.buildCmd ?? "",
    BOARD_TYPECHECK_CMD: commands.typecheckCmd ?? "",
  };

  // Open the transcript file ONCE and pass the raw fd to stdio. The child
  // gets its own dup'd fd via fork/exec — when the dispatcher dies our copy
  // of the fd closes but the child's keeps writing. With "pipe" + .pipe()
  // the file descriptor on the read side belongs to our process; if we die,
  // the child's next stdout write hits EPIPE and the worker is killed.
  const transcriptFd = fs.openSync(transcriptPath, "a");

  let child: ChildProcess;
  try {
    child = spawn("claude", args, {
      cwd: spawnCwd,
      env,
      stdio: ["ignore", transcriptFd, transcriptFd],
      // Own process group so SIGINT/SIGTERM to dispatcher (pm2 restart)
      // doesn't propagate. Combined with the fd-stdio above, the worker
      // truly survives a dispatcher restart.
      detached: true,
    });
  } finally {
    // Parent's fd is no longer needed regardless of spawn success.
    try { fs.closeSync(transcriptFd); } catch { /* ignore */ }
  }

  const liveTokens = createLiveTokenTotals();
  observeStreamJsonTranscript(child, transcriptPath, liveTokens);

  if (typeof child.pid !== "number") {
    throw new Error(`[dispatcher] spawn returned no pid for card ${card.id}`);
  }

  // Don't keep the dispatcher event loop tied to the child — let dispatcher
  // exit cleanly on SIGTERM while the worker keeps running.
  child.unref();

  return {
    pid: child.pid,
    child,
    cardId: card.id,
    attempt,
    role: "worker",
    liveTokens,
    startedAt: new Date().toISOString(),
    transcriptPath,
    worktreePath: wt.worktreePath,
    wipBranch,
    exitStartedAt: null,
  };
}

// ─── Reviewer spawn ─────────────────────────────────────────────────────────

/**
 * Run a git command and capture stdout. Returns null on failure (e.g. the
 * branch hasn't been pushed yet, or fetch is offline). The reviewer message
 * builder treats null as "context unavailable" and includes a placeholder
 * — we never want to fail spawn just because diff hydration hiccuped.
 */
const execFileAsync = promisify(execFile);

async function gitCapture(
  cwd: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
    });
    return String(stdout);
  } catch {
    return null;
  }
}

interface ReviewerGitContext {
  base: string;
  branchRef: string;
  commits: string | null;
  diffStat: string | null;
  nameStatus: string | null;
  diff: string | null;
}

/**
 * Pre-compute commits + diff for the reviewer so it doesn't have to run any
 * git commands itself (it's read-only — no Write/Edit/Bash-for-git).
 *
 * Best-effort: any step failure returns null for that field so the reviewer
 * still spawns with whatever context we did manage to gather.
 */
async function gatherReviewerGitContext(
  boardRoot: string,
  wipBranch: string,
): Promise<ReviewerGitContext> {
  await gitCapture(boardRoot, ["fetch", "origin"]);

  const base =
    (await gitCapture(boardRoot, ["rev-parse", "--verify", "--quiet", "origin/main"])) !== null
      ? "origin/main"
      : (await gitCapture(boardRoot, ["rev-parse", "--verify", "--quiet", "main"])) !== null
        ? "main"
        : "HEAD~1";
  const branchRef =
    (await gitCapture(boardRoot, ["rev-parse", "--verify", "--quiet", `origin/${wipBranch}`])) !== null
      ? `origin/${wipBranch}`
      : wipBranch;

  const range = `${base}...${branchRef}`;
  const commits = await gitCapture(boardRoot, [
    "log",
    `${base}..${branchRef}`,
    "--oneline",
  ]);
  const diffStat = await gitCapture(boardRoot, ["diff", "--stat", range]);
  const nameStatus = await gitCapture(boardRoot, ["diff", "--name-status", range]);
  const diff = await gitCapture(boardRoot, ["diff", range]);

  return { base, branchRef, commits, diffStat, nameStatus, diff };
}

function contextDisplayPath(filePath: string): string {
  return filePath;
}

function writeReviewerContextFiles(args: {
  boardRoot: string;
  cardsDir: string;
  cardId: string;
  attempt: number;
  gitCtx: ReviewerGitContext;
}): { summaryPath: string; commitsPath: string; diffPath: string } {
  const dir = path.join(args.cardsDir, args.cardId, "review-context");
  fs.mkdirSync(dir, { recursive: true });

  const prefix = `attempt-${args.attempt}`;
  const summaryPath = path.join(dir, `${prefix}-summary.md`);
  const commitsPath = path.join(dir, `${prefix}-commits.txt`);
  const diffPath = path.join(dir, `${prefix}-diff.patch`);

  const commits = args.gitCtx.commits ?? "";
  const diff = args.gitCtx.diff ?? "";
  fs.writeFileSync(commitsPath, commits, "utf8");
  fs.writeFileSync(diffPath, diff, "utf8");

  const summary = [
    `# Review context for card ${args.cardId}`,
    "",
    `Base ref: ${args.gitCtx.base}`,
    `Branch ref: ${args.gitCtx.branchRef}`,
    "",
    "## Changed files",
    "",
    "```",
    args.gitCtx.nameStatus?.trimEnd() || "(unavailable)",
    "```",
    "",
    "## Diff stat",
    "",
    "```",
    args.gitCtx.diffStat?.trimEnd() || "(unavailable)",
    "```",
    "",
    "## Context files",
    "",
    `- Commits: ${contextDisplayPath(commitsPath)}`,
    `- Full diff: ${contextDisplayPath(diffPath)}`,
    "",
  ].join("\n");
  fs.writeFileSync(summaryPath, summary, "utf8");

  return { summaryPath, commitsPath, diffPath };
}

function buildReviewerMessage(args: {
  id: string;
  title: string;
  cardMd: string;
  wipBranch: string;
  comments: Comment[];
  boardRoot: string;
  gitCtx: ReviewerGitContext;
  summaryPath: string;
  commitsPath: string;
  diffPath: string;
}): string {
  const conversation = formatConversationSection(args.comments);
  const commitsBody =
    args.gitCtx.commits === null
      ? "(unable to compute — git fetch/log failed; treat as context unavailable)"
      : args.gitCtx.commits.trim() === ""
        ? "(no commits beyond the base ref)"
        : args.gitCtx.commits.trimEnd();
  const nameStatusBody = args.gitCtx.nameStatus?.trimEnd() || "(unavailable)";
  const diffStatBody = args.gitCtx.diffStat?.trimEnd() || "(unavailable)";
  return [
    `# Card ${args.id}: ${args.title} — REVIEW`,
    "",
    "You are reviewing the code changes prepared by a worker. The branch is",
    `\`${args.wipBranch}\`. The card metadata, prior conversation, commit list,`,
    "changed-file summary, and review context file paths are below. You are",
    "read-only by design and do not need to run any git commands.",
    "",
    "## Card",
    "",
    args.cardMd.trim() || "(empty card.md)",
    "",
    conversation,
    "## Commits",
    "",
    "```",
    commitsBody,
    "```",
    "",
    "## Changed files",
    "",
    "```",
    nameStatusBody,
    "```",
    "",
    "## Diff stat",
    "",
    "```",
    diffStatBody,
    "```",
    "",
    "## Review context files",
    "",
    "The full diff is stored in a runtime file instead of being inlined into",
    "this prompt. Read the summary first, then inspect the full diff or relevant",
    "source files as needed before deciding.",
    "",
    `- Summary: ${contextDisplayPath(args.summaryPath)}`,
    `- Commits: ${contextDisplayPath(args.commitsPath)}`,
    `- Full diff: ${contextDisplayPath(args.diffPath)}`,
    "",
    "Judge the changes against the card description's intent (and the prior",
    "conversation, if any), and write your verdict as your final assistant",
    "message:",
    "",
    "- Last line: `VERDICT: PASS` or `VERDICT: REJECT` (uppercase, exact).",
    "- For REJECT, list specific `file:line` issues and the fix direction.",
    "- For PASS, optionally list non-blocking notes.",
    "- If you genuinely cannot decide and need a human, emit `VERDICT: STUCK`",
    "  on the last line with the question/blocker spelled out above it.",
    "",
    "Then exit. The dispatcher will turn your verdict into either a merge,",
    "a rejection comment + reopen, or a human-escalation.",
  ]
    .filter((s, i, arr) => !(s === "" && arr[i - 1] === ""))
    .join("\n");
}

export async function spawnReviewer(
  card: import("./queue.js").QueueCandidate,
  cfg: DispatcherConfig,
): Promise<SpawnedWorker> {
  const transcriptsDir = path.join(cfg.cardsDir, card.id, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const attempt = nextAttempt(transcriptsDir);
  const ts = fileTimestamp();
  const transcriptPath = path.join(transcriptsDir, `${ts}-attempt-${attempt}-review.jsonl`);

  const cardMd = fs.readFileSync(path.join(cfg.cardsDir, card.id, "card.md"), "utf8");
  const parsed = parseCardMd(cardMd);
  const wipBranch = `worker/card-${card.id}`;

  const reviewerPromptPath = path.join(cfg.promptsDir, "reviewer.md");
  const rolePrompt = fs.readFileSync(reviewerPromptPath, "utf8");
  const scope = readScope(cfg, parsed.frontmatter.scope ?? null);
  const promptText = composeSystemPrompt({
    basePrompt: readBasePrompt(cfg),
    scopeDescription: scope?.description ?? "",
    toolGuidance: readToolGuidance(cfg, REVIEWER_ALLOWED_TOOLS),
    rolePrompt,
  });
  const conversation = readConversation(
    path.join(cfg.cardsDir, card.id, "comments.jsonl"),
  );

  // Pre-compute commits + diff server-side so the reviewer doesn't need any
  // git access. Large payloads are written to runtime files and referenced from
  // the prompt so the claude argv stays small.
  const gitCtx = await gatherReviewerGitContext(cfg.boardRoot, wipBranch);
  const reviewerContext = writeReviewerContextFiles({
    boardRoot: cfg.boardRoot,
    cardsDir: cfg.cardsDir,
    cardId: card.id,
    attempt,
    gitCtx,
  });

  const spawnMessage = buildReviewerMessage({
    id: card.id,
    title: parsed.frontmatter.title,
    cardMd,
    wipBranch,
    comments: conversation,
    boardRoot: cfg.boardRoot,
    gitCtx,
    summaryPath: reviewerContext.summaryPath,
    commitsPath: reviewerContext.commitsPath,
    diffPath: reviewerContext.diffPath,
  });
  const spawnCwd = resolveSpawnCwd({
    base: cfg.boardRoot,
    scopeCwd: scope?.cwd,
    cardId: card.id,
    role: "reviewer",
  });

  const args: string[] = [
    "-p",
    // See spawnWorker for auth-mode rationale.
    ...(cfg.authMode === "bare" ? ["--bare"] : []),
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    promptText,
    "--allowed-tools",
    // Reviewer is read-only — no Write/Edit so it can't accidentally commit.
    REVIEWER_ALLOWED_TOOLS.join(","),
    // Defense in depth: even though the allowed-tools list above doesn't
    // include any mutating tools, claude has been known to surface them
    // anyway under permissive permission modes. Explicitly deny mutation
    // tools so the read-only persona is enforced at the tool layer too.
    "--disallowedTools",
    "Write,Edit,NotebookEdit",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    spawnMessage,
  ];

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // See spawnWorker for auth-mode rationale.
    ...(cfg.anthropicBaseUrl != null ? { ANTHROPIC_BASE_URL: cfg.anthropicBaseUrl } : {}),
    ...(cfg.anthropicApiKey != null ? { ANTHROPIC_API_KEY: cfg.anthropicApiKey } : {}),
    BOARD_ROOT: cfg.boardRoot,
    BOARD_SERVER_URL: cfg.serverUrl,
    BOARD_DATA: cfg.boardData,
    BOARD_WORKTREES: cfg.worktreesDir,
    CARD_ID: card.id,
    WIP_BRANCH: wipBranch,
    ATTEMPT: String(attempt),
  };

  // See spawnWorker for rationale: fd-stdio + detached + unref so the
  // reviewer survives a dispatcher restart without SIGPIPE.
  const transcriptFd = fs.openSync(transcriptPath, "a");

  let child: ChildProcess;
  try {
    child = spawn("claude", args, {
      // Reviewer reads diff from main repo (no worktree). Scope.cwd may
      // narrow this to a subdir of boardRoot.
      cwd: spawnCwd,
      env,
      stdio: ["ignore", transcriptFd, transcriptFd],
      detached: true,
    });
  } finally {
    try { fs.closeSync(transcriptFd); } catch { /* ignore */ }
  }

  const liveTokens = createLiveTokenTotals();
  observeStreamJsonTranscript(child, transcriptPath, liveTokens);

  if (typeof child.pid !== "number") {
    throw new Error(`[dispatcher] reviewer spawn returned no pid for card ${card.id}`);
  }

  child.unref();

  return {
    pid: child.pid,
    child,
    cardId: card.id,
    attempt,
    role: "reviewer",
    liveTokens,
    startedAt: new Date().toISOString(),
    transcriptPath,
    worktreePath: cfg.boardRoot, // reviewer cwd
    wipBranch,
    exitStartedAt: null,
  };
}

// ─── Merger spawn ───────────────────────────────────────────────────────────

function buildMergerMessage(args: {
  id: string;
  title: string;
  description: string;
  wipBranch: string;
  comments: Comment[];
}): string {
  const conversation = formatConversationSection(args.comments);
  return [
    `# Card ${args.id}: ${args.title} — MERGE`,
    "",
    "You are merging the worker's branch into main. Your CWD is the main",
    "repo root. The worker's branch is `" + args.wipBranch + "`.",
    "",
    "## Description (for context)",
    "",
    args.description.trim() || "(no description)",
    "",
    conversation,
    "## Your job (in order)",
    "",
    "1. `git fetch origin`",
    "2. `git checkout main && git pull --ff-only origin main` (you must be on",
    "   main; never push from another branch).",
    "3. `git merge --ff-only origin/" + args.wipBranch + "`. If ff-merge fails:",
    "   - Try `git merge origin/" + args.wipBranch + "` and resolve any",
    "     conflicts (preserve the worker's intent; main wins on truly",
    "     unrelated drift).",
    "   - Run typecheck + tests after resolution. If they fail, abort:",
    "     `git merge --abort` and exit with FAIL.",
    "4. `git push origin main`",
    "5. `git push origin --delete " + args.wipBranch + "` (clean up).",
    "",
    "## Verdict (final assistant message)",
    "",
    "On success:",
    "  Last line MUST be exactly: `MERGED: <sha>` where <sha> is the new",
    "  origin/main HEAD short sha (`git rev-parse --short=12 HEAD`).",
    "",
    "On failure:",
    "  Last line MUST start with: `FAILED: <one-line reason>`",
    "  Then exit. The dispatcher routes the card back to in_progress for a",
    "  fresh worker attempt.",
    "",
    "Hard rules: never force-push main, never amend main commits, never edit",
    "files except to resolve conflicts.",
  ].join("\n");
}

export async function spawnMerger(
  card: import("./queue.js").QueueCandidate,
  cfg: DispatcherConfig,
): Promise<SpawnedWorker> {
  const transcriptsDir = path.join(cfg.cardsDir, card.id, "transcripts");
  fs.mkdirSync(transcriptsDir, { recursive: true });

  const attempt = nextAttempt(transcriptsDir);
  const ts = fileTimestamp();
  const transcriptPath = path.join(transcriptsDir, `${ts}-attempt-${attempt}-merge.jsonl`);

  const cardMd = fs.readFileSync(path.join(cfg.cardsDir, card.id, "card.md"), "utf8");
  const parsed = parseCardMd(cardMd);
  const wipBranch = `worker/card-${card.id}`;

  const mergerPromptPath = path.join(cfg.promptsDir, "merger.md");
  const rolePrompt = fs.readFileSync(mergerPromptPath, "utf8");
  const scope = readScope(cfg, parsed.frontmatter.scope ?? null);
  const promptText = composeSystemPrompt({
    basePrompt: readBasePrompt(cfg),
    scopeDescription: scope?.description ?? "",
    toolGuidance: readToolGuidance(cfg, MERGER_ALLOWED_TOOLS),
    rolePrompt,
  });
  const conversation = readConversation(
    path.join(cfg.cardsDir, card.id, "comments.jsonl"),
  );
  const spawnMessage = buildMergerMessage({
    id: card.id,
    title: parsed.frontmatter.title,
    description: parsed.description,
    wipBranch,
    comments: conversation,
  });
  const spawnCwd = resolveSpawnCwd({
    base: cfg.boardRoot,
    scopeCwd: scope?.cwd,
    cardId: card.id,
    role: "merger",
  });

  const args: string[] = [
    "-p",
    // See spawnWorker for auth-mode rationale.
    ...(cfg.authMode === "bare" ? ["--bare"] : []),
    "--permission-mode",
    "bypassPermissions",
    "--append-system-prompt",
    promptText,
    "--allowed-tools",
    MERGER_ALLOWED_TOOLS.join(","),
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--verbose",
    spawnMessage,
  ];

  // Read the user-configured post-build command from config.json on each
  // spawn so changes via Settings → Merger take effect without a restart.
  const postBuildCmd = readMergerPostBuildCmd(cfg);

  // Discover the project's package manager + standard scripts and surface
  // them as env vars. The merger prompt expects the same names a worker
  // sees (install/test/build/typecheck) so it can run e.g. a final
  // `$BOARD_BUILD_CMD` post-conflict-resolution without re-deriving the
  // toolchain. Discovery runs from the merger's cwd (BOARD_ROOT, possibly
  // narrowed by scope.cwd) — the cwd contains the project's lockfile +
  // package.json, which is what `discoverCommands` keys off.
  const cmds = discoverCommands(spawnCwd);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // See spawnWorker for auth-mode rationale.
    ...(cfg.anthropicBaseUrl != null ? { ANTHROPIC_BASE_URL: cfg.anthropicBaseUrl } : {}),
    ...(cfg.anthropicApiKey != null ? { ANTHROPIC_API_KEY: cfg.anthropicApiKey } : {}),
    BOARD_ROOT: cfg.boardRoot,
    BOARD_SERVER_URL: cfg.serverUrl,
    BOARD_DATA: cfg.boardData,
    BOARD_WORKTREES: cfg.worktreesDir,
    CARD_ID: card.id,
    WIP_BRANCH: wipBranch,
    ATTEMPT: String(attempt),
    // Only inject the env var when the user actually configured a command,
    // so the merger prompt's "if set and non-empty" check is unambiguous.
    ...(postBuildCmd !== null
      ? { BOARD_MERGER_POST_BUILD_CMD: postBuildCmd }
      : {}),
    // Discovery util returns null for any command it couldn't pin down
    // (e.g. no package.json, missing script). Inject only the ones we
    // actually have so the merger prompt's "if set and non-empty" check
    // is consistent with $BOARD_MERGER_POST_BUILD_CMD above.
    ...(cmds.installCmd !== null ? { BOARD_INSTALL_CMD: cmds.installCmd } : {}),
    ...(cmds.testCmd !== null ? { BOARD_TEST_CMD: cmds.testCmd } : {}),
    ...(cmds.buildCmd !== null ? { BOARD_BUILD_CMD: cmds.buildCmd } : {}),
    ...(cmds.typecheckCmd !== null ? { BOARD_TYPECHECK_CMD: cmds.typecheckCmd } : {}),
  };

  // See spawnWorker for rationale: fd-stdio + detached + unref so the
  // merger survives a dispatcher restart without SIGPIPE.
  const transcriptFd = fs.openSync(transcriptPath, "a");

  let child: ChildProcess;
  try {
    child = spawn("claude", args, {
      // Merger runs in main repo root by default; scope.cwd may narrow it.
      cwd: spawnCwd,
      env,
      stdio: ["ignore", transcriptFd, transcriptFd],
      detached: true,
    });
  } finally {
    try { fs.closeSync(transcriptFd); } catch { /* ignore */ }
  }

  const liveTokens = createLiveTokenTotals();
  observeStreamJsonTranscript(child, transcriptPath, liveTokens);

  if (typeof child.pid !== "number") {
    throw new Error(`[dispatcher] merger spawn returned no pid for card ${card.id}`);
  }

  child.unref();

  return {
    pid: child.pid,
    child,
    cardId: card.id,
    attempt,
    role: "merger",
    liveTokens,
    startedAt: new Date().toISOString(),
    transcriptPath,
    worktreePath: cfg.boardRoot,
    wipBranch,
    exitStartedAt: null,
  };
}
