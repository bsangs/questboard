/**
 * Filesystem layer. Handles card.md (atomic temp+rename), comments.jsonl
 * (append-only, line-buffered), archive moves, and transcript cleanup.
 *
 * Server is the sole writer to .questboard/data/. UI / dispatcher / workers
 * go through the REST API.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { open as fsOpen } from "node:fs/promises";
import { join, dirname } from "node:path";
import { env } from "./env.js";
import { parseCardMd, serializeCardMd, isHistoryKind, isConversationKind } from "@questboard/core";
import type { Card, Comment, HistoryEntry } from "@questboard/core";

mkdirSync(env.CARDS_DIR, { recursive: true });
mkdirSync(env.ARCHIVE_DIR, { recursive: true });

export function cardDir(id: string, archived = false): string {
  return join(archived ? env.ARCHIVE_DIR : env.CARDS_DIR, id);
}

export function cardMdPath(id: string, archived = false): string {
  return join(cardDir(id, archived), "card.md");
}

export function commentsPath(id: string, archived = false): string {
  return join(cardDir(id, archived), "comments.jsonl");
}

export function historyPath(id: string, archived = false): string {
  return join(cardDir(id, archived), "history.jsonl");
}

export function transcriptsDir(id: string): string {
  return join(cardDir(id, false), "transcripts");
}

/** Returns true if a card folder exists in cards/ (active). */
export function cardExistsOnDisk(id: string): { active: boolean; archived: boolean } {
  return {
    active: existsSync(cardMdPath(id, false)),
    archived: existsSync(cardMdPath(id, true)),
  };
}

/** Read and parse card.md. Throws if missing or invalid frontmatter. */
export function readCard(id: string): { card: Card; archived: boolean } {
  const loc = cardExistsOnDisk(id);
  if (loc.active) return { card: parseCardMd(readFileSync(cardMdPath(id, false), "utf8")), archived: false };
  if (loc.archived) return { card: parseCardMd(readFileSync(cardMdPath(id, true), "utf8")), archived: true };
  throw Object.assign(new Error(`card not found: ${id}`), { code: "card_not_found" });
}

/** Atomic write via temp + rename + fsync of the directory. */
export async function writeCardAtomic(id: string, card: Card, archived = false): Promise<void> {
  const dir = cardDir(id, archived);
  mkdirSync(dir, { recursive: true });
  const target = cardMdPath(id, archived);
  const tmp = `${target}.tmp`;
  const content = serializeCardMd(card);
  // Write temp file with fsync, then rename.
  const fh = await fsOpen(tmp, "w");
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  renameSync(tmp, target);
  // Best-effort: fsync the directory to make rename durable.
  try {
    const dh = await fsOpen(dir, "r");
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    /* directory fsync is non-essential and unsupported on some platforms */
  }
}

/** Append one comment line. Uses appendFileSync — atomic at the line level on POSIX. */
export function appendCommentToFile(id: string, c: Comment, archived = false): void {
  const dir = cardDir(id, archived);
  mkdirSync(dir, { recursive: true });
  const path = commentsPath(id, archived);
  appendFileSync(path, JSON.stringify(c) + "\n", "utf8");
}

/** Append one history entry line. Same atomicity guarantees as comments. */
export function appendHistoryToFile(id: string, e: HistoryEntry, archived = false): void {
  const dir = cardDir(id, archived);
  mkdirSync(dir, { recursive: true });
  const path = historyPath(id, archived);
  appendFileSync(path, JSON.stringify(e) + "\n", "utf8");
}

/** Internal: read raw jsonl lines from a path, ignoring malformed lines. */
function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

/**
 * Read worker ↔ human conversation. Filters OUT history kinds so legacy
 * cards (where comments.jsonl was the catch-all) display cleanly.
 */
export function readComments(id: string, archived = false): Comment[] {
  const all = readJsonl<Comment>(commentsPath(id, archived));
  return all.filter((c) => isConversationKind(c.kind));
}

/**
 * Read audit log. Reads history.jsonl AND scans comments.jsonl for legacy
 * entries (system_event / description_updated written before the split),
 * so existing cards don't lose their audit trail. Sorted by ts ASC.
 */
export function readHistory(id: string, archived = false): HistoryEntry[] {
  const fromHistory = readJsonl<HistoryEntry>(historyPath(id, archived));
  const fromCommentsLegacy = readJsonl<HistoryEntry>(commentsPath(id, archived)).filter(
    (e) => isHistoryKind(e.kind),
  );
  const merged = [...fromHistory, ...fromCommentsLegacy];
  merged.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return merged;
}

/** List transcript filenames (relative names only). */
export function listTranscripts(id: string): string[] {
  const dir = transcriptsDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".jsonl.gz"));
}

/** Move cards/<id>/ to archive/<id>/, deleting transcripts/. */
export function moveCardToArchive(id: string): void {
  const src = cardDir(id, false);
  const dst = cardDir(id, true);
  if (!existsSync(src)) throw new Error(`cannot archive missing card: ${id}`);
  // Drop transcripts before move.
  const tdir = transcriptsDir(id);
  if (existsSync(tdir)) rmSync(tdir, { recursive: true, force: true });
  mkdirSync(dirname(dst), { recursive: true });
  renameSync(src, dst);
}

/** List active card ids (folders under cards/). */
export function listActiveCardIds(): string[] {
  if (!existsSync(env.CARDS_DIR)) return [];
  return readdirSync(env.CARDS_DIR)
    .filter((n) => /^\d{4}$/.test(n))
    .filter((n) => statSync(join(env.CARDS_DIR, n)).isDirectory());
}

/** List archived card ids (folders under archive/). */
export function listArchivedCardIds(): string[] {
  if (!existsSync(env.ARCHIVE_DIR)) return [];
  return readdirSync(env.ARCHIVE_DIR)
    .filter((n) => /^\d{4}$/.test(n))
    .filter((n) => statSync(join(env.ARCHIVE_DIR, n)).isDirectory());
}

/** Best-effort revert of a card.md to a snapshotted previous content. */
export function revertCardMd(id: string, prevContent: string, archived = false): void {
  const target = cardMdPath(id, archived);
  try {
    writeFileSync(target, prevContent, "utf8");
  } catch {
    /* swallow: caller logs */
  }
}

/** Snapshot current on-disk card.md text (for revert). Returns null if missing. */
export function snapshotCardMd(id: string, archived = false): string | null {
  const target = cardMdPath(id, archived);
  if (!existsSync(target)) return null;
  return readFileSync(target, "utf8");
}
