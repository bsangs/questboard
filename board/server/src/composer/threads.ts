/**
 * Composer thread persistence.
 *
 * Source of truth: filesystem under `<BOARD_DATA>/cards/_composer/<id>/`:
 *   - meta.json         — ComposerThreadSummary, atomic temp+rename writes
 *   - transcript.jsonl  — append-only ComposerMessage rows
 *   - pending.jsonl     — append-only pending records and resolution markers
 *
 * Why filesystem and not SQLite: same reason cards live as files —
 * makes data git-trackable+diff-able, and survives DB reset. Composer
 * data is gitignored (under data/) so we don't pollute history, but the
 * shape is identical to cards on purpose.
 *
 * All writes are append-or-rename so a crashed server can't corrupt
 * the meta. pending.jsonl uses BOTH "pending" rows (recordPending) AND
 * "resolved" rows (clearPending) — replayPendingFromDisk() folds them
 * to a live set on boot.
 */
import {
  ComposerMessage,
  ComposerThreadSummary,
  type ComposerOutcome,
  type ComposerPendingToolUse,
  type ComposerThread,
} from "@questboard/core";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { env } from "../env.js";
import { logger } from "../logger.js";

// ─── Layout ──────────────────────────────────────────────────────────────────

const COMPOSER_ROOT = join(env.CARDS_DIR, "_composer");
mkdirSync(COMPOSER_ROOT, { recursive: true });

function dirOf(id: string): string {
  return join(COMPOSER_ROOT, id);
}
function metaPath(id: string): string {
  return join(dirOf(id), "meta.json");
}
function transcriptPath(id: string): string {
  return join(dirOf(id), "transcript.jsonl");
}
function pendingPath(id: string): string {
  return join(dirOf(id), "pending.jsonl");
}

// ─── ID allocation ───────────────────────────────────────────────────────────

/**
 * Allocate a fresh thread id. Lowercase, sortable enough for our needs:
 * `<base36 timestamp>-<8 hex>` — collisions only happen if two creates
 * land in the same millisecond AND the random suffix collides, which is
 * vanishingly improbable for a workbench feature.
 */
export function newThreadId(): string {
  return Date.now().toString(36) + randomBytes(4).toString("hex");
}

// ─── Atomic meta writes ──────────────────────────────────────────────────────

async function writeMetaAtomic(id: string, meta: ComposerThreadSummary): Promise<void> {
  const dir = dirOf(id);
  mkdirSync(dir, { recursive: true });
  const target = metaPath(id);
  const tmp = `${target}.tmp`;
  const content = JSON.stringify(meta, null, 2) + "\n";
  const fh = await fsOpen(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  renameSync(tmp, target);
}

function writeMetaAtomicSync(id: string, meta: ComposerThreadSummary): void {
  const dir = dirOf(id);
  mkdirSync(dir, { recursive: true });
  const target = metaPath(id);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(meta, null, 2) + "\n", "utf8");
  renameSync(tmp, target);
}

function readMeta(id: string): ComposerThreadSummary {
  const raw = readFileSync(metaPath(id), "utf8");
  return ComposerThreadSummary.parse(JSON.parse(raw));
}

// ─── JSONL helpers ───────────────────────────────────────────────────────────

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const out: T[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // tolerate a partial trailing write — the rest of the file is still valid.
    }
  }
  return out;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function listThreadSummaries(opts?: {
  offset?: number;
  limit?: number;
  q?: string;
}): { total: number; threads: ComposerThreadSummary[] } {
  if (!existsSync(COMPOSER_ROOT)) return { total: 0, threads: [] };
  const ids = readdirSync(COMPOSER_ROOT).filter((n) => {
    try {
      return statSync(join(COMPOSER_ROOT, n)).isDirectory() && existsSync(metaPath(n));
    } catch {
      return false;
    }
  });
  const all: ComposerThreadSummary[] = [];
  for (const id of ids) {
    try {
      all.push(readMeta(id));
    } catch (err) {
      logger.warn("composer_meta_unreadable", { id, err: String(err) });
    }
  }
  // Filter by query if given (case-insensitive title match).
  const q = opts?.q?.toLowerCase().trim();
  const filtered = q
    ? all.filter((t) => t.title.toLowerCase().includes(q))
    : all;
  // Sort: non-archived first, then by updated_at desc.
  filtered.sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0;
  });
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? filtered.length;
  return { total: filtered.length, threads: filtered.slice(offset, offset + limit) };
}

export function getThread(id: string): ComposerThread {
  if (!existsSync(metaPath(id))) {
    throw Object.assign(new Error(`composer thread not found: ${id}`), {
      code: "thread_not_found",
    });
  }
  const summary = readMeta(id);
  const messages = readJsonl<unknown>(transcriptPath(id))
    .map((m) => {
      const parsed = ComposerMessage.safeParse(m);
      return parsed.success ? parsed.data : null;
    })
    .filter((m): m is import("@questboard/core").ComposerMessage => m !== null);
  const pending = replayPendingFromDisk(id);
  return { ...summary, messages, pending };
}

/**
 * Read pending.jsonl and fold pending vs resolved markers into the live set.
 * Each "pending" line is a ComposerPendingToolUse; each "resolved" line is
 * `{ resolved: true, tool_use_id }`. Resolutions remove the matching pending.
 */
export function replayPendingFromDisk(id: string): ComposerPendingToolUse[] {
  if (!existsSync(pendingPath(id))) return [];
  const live = new Map<string, ComposerPendingToolUse>();
  for (const raw of readJsonl<{ resolved?: boolean; tool_use_id?: string } & ComposerPendingToolUse>(
    pendingPath(id),
  )) {
    if (raw && raw.resolved && raw.tool_use_id) {
      live.delete(raw.tool_use_id);
      continue;
    }
    if (raw && raw.id && raw.name) {
      live.set(raw.id, raw as ComposerPendingToolUse);
    }
  }
  return [...live.values()];
}

export function createThread(opts: { cwd: string | null }): ComposerThreadSummary {
  const id = newThreadId();
  const now = new Date().toISOString();
  const summary: ComposerThreadSummary = {
    id,
    title: "Untitled",
    created_at: now,
    updated_at: now,
    message_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    cwd: opts.cwd ?? null,
    status: "idle",
    outcome: { card_ids: [], plan_paths: [] },
    archived: false,
    session_id: null,
    behind_main: null,
  };
  writeMetaAtomicSync(id, summary);
  return summary;
}

export function deleteThread(id: string): void {
  const dir = dirOf(id);
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

export function patchThread(
  id: string,
  patch: Partial<Pick<ComposerThreadSummary, "title" | "archived" | "status" | "session_id" | "behind_main">>,
): ComposerThreadSummary {
  const cur = readMeta(id);
  const next: ComposerThreadSummary = {
    ...cur,
    ...patch,
    updated_at: new Date().toISOString(),
  };
  writeMetaAtomicSync(id, next);
  return next;
}

export function appendMessage(threadId: string, message: ComposerMessage): void {
  const dir = dirOf(threadId);
  if (!existsSync(dir)) {
    throw Object.assign(new Error(`composer thread not found: ${threadId}`), {
      code: "thread_not_found",
    });
  }
  appendFileSync(transcriptPath(threadId), JSON.stringify(message) + "\n", "utf8");
  // Bump message_count + updated_at (best-effort — meta corruption shouldn't
  // block the transcript write that's already done).
  try {
    const cur = readMeta(threadId);
    const next: ComposerThreadSummary = {
      ...cur,
      message_count: cur.message_count + 1,
      updated_at: new Date().toISOString(),
    };
    writeMetaAtomicSync(threadId, next);
  } catch (err) {
    logger.warn("composer_meta_bump_failed", { threadId, err: String(err) });
  }
}

export function recordPending(threadId: string, pending: ComposerPendingToolUse): void {
  const dir = dirOf(threadId);
  mkdirSync(dir, { recursive: true });
  appendFileSync(pendingPath(threadId), JSON.stringify(pending) + "\n", "utf8");
}

export function clearPending(threadId: string, toolUseId: string): void {
  const dir = dirOf(threadId);
  if (!existsSync(dir)) return;
  appendFileSync(
    pendingPath(threadId),
    JSON.stringify({ resolved: true, tool_use_id: toolUseId, ts: new Date().toISOString() }) + "\n",
    "utf8",
  );
}

export function bumpOutcome(threadId: string, patch: Partial<ComposerOutcome>): void {
  const cur = readMeta(threadId);
  const next: ComposerThreadSummary = {
    ...cur,
    outcome: {
      card_ids: [...cur.outcome.card_ids, ...(patch.card_ids ?? [])],
      plan_paths: [...cur.outcome.plan_paths, ...(patch.plan_paths ?? [])],
    },
    updated_at: new Date().toISOString(),
  };
  writeMetaAtomicSync(threadId, next);
}

export function bumpUsage(
  threadId: string,
  delta: { input_tokens: number; output_tokens: number },
): void {
  try {
    const cur = readMeta(threadId);
    const next: ComposerThreadSummary = {
      ...cur,
      input_tokens: cur.input_tokens + (delta.input_tokens || 0),
      output_tokens: cur.output_tokens + (delta.output_tokens || 0),
      updated_at: new Date().toISOString(),
    };
    writeMetaAtomicSync(threadId, next);
  } catch (err) {
    // Same rationale as appendMessage: usage stats are nice-to-have, never
    // block the live stream on a meta write.
    logger.warn("composer_usage_bump_failed", { threadId, err: String(err) });
  }
}

/** Read transcript.jsonl as raw text (debug endpoint). */
export function readTranscriptRaw(id: string): string {
  if (!existsSync(transcriptPath(id))) return "";
  return readFileSync(transcriptPath(id), "utf8");
}

/** Internal: expose the on-disk paths for spawn.ts (mcp-config etc). */
export const composerPaths = {
  root: COMPOSER_ROOT,
  dirOf,
  metaPath,
  transcriptPath,
  pendingPath,
};

/**
 * Absolute path to the per-thread attachments directory. Kept in this
 * module so the layout (cards/_composer/<id>/attachments) lives next
 * to the rest of the thread-folder layout.
 */
export function composerThreadAttachmentsDir(id: string): string {
  return join(dirOf(id), "attachments");
}

/**
 * Existence check used by the attachments route. We don't want the
 * attachments endpoints to depend on getThread() (which throws and
 * wraps in zod), so this is a thin existsSync over the meta file.
 */
export function composerThreadExists(id: string): boolean {
  return existsSync(metaPath(id));
}

// Async-only writer used by tests / future replay tooling. Kept exported
// so callers that DO want fsync semantics can opt in.
export { writeMetaAtomic };
