/**
 * Attachment storage for cards, composer threads, and the brand-new-card
 * upload pool.
 *
 * Layout (all paths under env.BOARD_DATA):
 *   - cards/<id>/attachments/<filename>            — per-card
 *   - cards/_composer/<thread-id>/attachments/<filename>  — composer thread
 *   - _uploads/<token>/<filename>                  — temp pool used by the
 *     NewCardModal and the Composer draft mode (no card/thread id yet).
 *     `promoteUploadPoolToCard` / `promoteUploadPoolToComposer` move these
 *     into the right per-id directory once the card or thread exists.
 *
 * Filenames are sanitized to a `[a-zA-Z0-9._-]` charset and prefixed with
 * a unix-ms timestamp so paste-pasted "image.png" never collides with a
 * previous one. SVGs are accepted but pre-screened for the obvious
 * dangerous constructs (`<script>`, `on*=`, `javascript:`, external href);
 * anything that smells suspicious is rejected outright. We don't run a
 * full DOM-based sanitizer because the surface here is "user uploads to
 * their own board" — the cost-benefit doesn't justify the dep.
 *
 * No size limit, no downscaling — explicit user opt-out.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { env } from "./env.js";
import { logger } from "./logger.js";

// ─── Constants ───────────────────────────────────────────────────────────────

/** MIME whitelist. Anything else → 415. */
export const ALLOWED_MIME = new Set<string>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

/** Map of mime → typical extension. Used only as a hint when the upload's
 *  filename is missing/extension-less; we always prefer the user's own
 *  extension when present. */
const MIME_DEFAULT_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
};

const UPLOADS_ROOT = join(env.BOARD_DATA, "_uploads");
const COMPOSER_ROOT = join(env.CARDS_DIR, "_composer");

mkdirSync(UPLOADS_ROOT, { recursive: true });

// ─── Errors ──────────────────────────────────────────────────────────────────

export class AttachmentError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ─── Filename sanitization ───────────────────────────────────────────────────

/**
 * Strip path separators, restrict to a safe charset, prefix with unix-ms
 * to avoid collisions on duplicate uploads of the same name. Always
 * returns a non-empty string; if the original name is unusable we fall
 * back to a random suffix derived from the mime.
 */
export function sanitizeFilename(rawName: string, mime: string): string {
  const stem = basename(rawName || "").trim();
  // Strip control chars + replace anything outside [a-zA-Z0-9._-] with `_`.
  // Collapse repeated underscores so "Screen Shot 2025-01-01 at.png"
  // doesn't become a wall of underscores.
  let cleaned = stem
    .normalize("NFKC")
    .replace(/[\x00-\x1f]/g, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+/, "") // never start with a dot or underscore
    .slice(0, 96); // hard cap

  if (!cleaned || cleaned === "." || cleaned === "..") {
    const ext = MIME_DEFAULT_EXT[mime] ?? "bin";
    cleaned = `image.${ext}`;
  } else if (!/\.[a-zA-Z0-9]+$/.test(cleaned)) {
    // Filename has no extension — append a sensible one based on mime.
    const ext = MIME_DEFAULT_EXT[mime];
    if (ext) cleaned = `${cleaned}.${ext}`;
  }

  return `${Date.now()}-${cleaned}`;
}

// ─── SVG safety pre-screen ───────────────────────────────────────────────────

/** Cheap, conservative regex pre-screen. Reject if any obvious script /
 *  active-content vector is present. We err on the side of rejection. */
export function isSvgSafe(text: string): boolean {
  if (/<\s*script\b/i.test(text)) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false; // onload=, onclick=, …
  if (/javascript\s*:/i.test(text)) return false;
  // External raster references — disallow to avoid phone-home.
  if (/<\s*image\b[^>]*\bhref\s*=/i.test(text)) return false;
  if (/<\s*image\b[^>]*xlink:href\s*=/i.test(text)) return false;
  // <foreignObject> can carry HTML/script — block.
  if (/<\s*foreignObject\b/i.test(text)) return false;
  return true;
}

// ─── Directory helpers ───────────────────────────────────────────────────────

export function cardAttachmentsDir(cardId: string): string {
  return join(env.CARDS_DIR, cardId, "attachments");
}

export function composerAttachmentsDir(threadId: string): string {
  return join(COMPOSER_ROOT, threadId, "attachments");
}

export function uploadPoolDir(token: string): string {
  return join(UPLOADS_ROOT, token);
}

/** Validate a token from a URL parameter. Random hex by construction;
 *  reject anything that isn't 16-64 lowercase hex chars to keep callers
 *  from path-traversing into siblings. */
export function isValidUploadToken(token: string): boolean {
  return /^[a-f0-9]{16,64}$/.test(token);
}

export function newUploadToken(): string {
  return randomBytes(16).toString("hex");
}

// ─── Core write ──────────────────────────────────────────────────────────────

interface SaveOpts {
  /** Original filename from the multipart part. */
  filename: string;
  /** MIME from the multipart part (must be in ALLOWED_MIME). */
  mime: string;
  /** Raw bytes. */
  buffer: Buffer;
}

interface SaveResult {
  /** The sanitized on-disk filename. */
  filename: string;
  /** Absolute filesystem path. */
  absPath: string;
}

/**
 * Validate + sanitize + write to `targetDir/<sanitized-filename>`. Caller
 * decides where the file lands (per-card / per-thread / upload pool).
 */
export function saveAttachment(targetDir: string, opts: SaveOpts): SaveResult {
  if (!ALLOWED_MIME.has(opts.mime)) {
    throw new AttachmentError(
      415,
      "unsupported_media_type",
      `Unsupported MIME type: ${opts.mime}. Allowed: ${[...ALLOWED_MIME].join(", ")}`,
    );
  }

  // SVG safety pre-screen — done here so every save path is covered
  // (per-card, per-thread, upload pool).
  if (opts.mime === "image/svg+xml") {
    const text = opts.buffer.toString("utf8");
    if (!isSvgSafe(text)) {
      throw new AttachmentError(
        400,
        "unsafe_svg",
        "SVG contains scripts, event handlers, external references, or other dangerous constructs",
      );
    }
  }

  const filename = sanitizeFilename(opts.filename, opts.mime);
  mkdirSync(targetDir, { recursive: true });
  const abs = join(targetDir, filename);
  // writeFileSync with no `flag` defaults to "w" (truncate-or-create);
  // collisions are vanishingly unlikely thanks to the unix-ms prefix.
  writeFileSync(abs, opts.buffer);
  return { filename, absPath: abs };
}

// ─── Promote uploads pool → card / composer ──────────────────────────────────

/**
 * Move all files from `_uploads/<token>/` into the destination dir
 * (creating it if needed). Idempotent: missing token-dir is fine. Removes
 * the empty pool dir on success.
 */
function promotePool(token: string, destDir: string): { moved: string[] } {
  if (!isValidUploadToken(token)) {
    throw new AttachmentError(400, "bad_token", `Invalid upload token: ${token}`);
  }
  const src = uploadPoolDir(token);
  if (!existsSync(src)) return { moved: [] };
  mkdirSync(destDir, { recursive: true });
  const moved: string[] = [];
  for (const name of readdirSync(src)) {
    // Defensive: skip anything that resolves outside the pool dir.
    if (name.includes("/") || name.includes("\\")) continue;
    const from = join(src, name);
    const to = join(destDir, name);
    try {
      renameSync(from, to);
      moved.push(name);
    } catch (err) {
      logger.warn("attachment_promote_failed", {
        token,
        name,
        err: String(err),
      });
    }
  }
  // Best-effort dir cleanup; leaving it behind would only show up in the
  // boot-time sweep anyway.
  try {
    rmSync(src, { recursive: true, force: true });
  } catch {
    /* swallow */
  }
  return { moved };
}

export function promoteUploadPoolToCard(
  token: string,
  cardId: string,
): { moved: string[] } {
  return promotePool(token, cardAttachmentsDir(cardId));
}

export function promoteUploadPoolToComposer(
  token: string,
  threadId: string,
): { moved: string[] } {
  return promotePool(token, composerAttachmentsDir(threadId));
}

// ─── Sweep stale pool dirs (boot-time best-effort) ───────────────────────────

const SWEEP_AGE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * One-shot pass: delete any `_uploads/<token>/` whose mtime is older
 * than SWEEP_AGE_MS. Called from main.ts on boot. Logs counts for
 * observability; never throws.
 */
export function sweepStaleUploads(): { swept: number } {
  if (!existsSync(UPLOADS_ROOT)) return { swept: 0 };
  let swept = 0;
  const now = Date.now();
  let entries: string[];
  try {
    entries = readdirSync(UPLOADS_ROOT);
  } catch {
    return { swept: 0 };
  }
  for (const name of entries) {
    const dir = join(UPLOADS_ROOT, name);
    try {
      const st = statSync(dir);
      if (!st.isDirectory()) continue;
      if (now - st.mtimeMs > SWEEP_AGE_MS) {
        rmSync(dir, { recursive: true, force: true });
        swept++;
      }
    } catch {
      /* skip */
    }
  }
  if (swept > 0) {
    logger.info("uploads_swept", { count: swept });
  }
  return { swept };
}

/** Verify a saved attachment exists and is inside the right directory.
 *  Returns the absolute path on success, throws AttachmentError otherwise. */
export function resolveAttachmentPath(
  baseDir: string,
  name: string,
): string {
  // basename() defangs any "../" attempts in the URL param.
  const safe = basename(name);
  if (!safe || safe !== name) {
    throw new AttachmentError(400, "bad_name", `Invalid attachment name: ${name}`);
  }
  const abs = join(baseDir, safe);
  if (!existsSync(abs)) {
    throw new AttachmentError(404, "not_found", `Attachment not found: ${name}`);
  }
  return abs;
}

/** Best-effort delete of an attachment file. Returns true if a file was
 *  removed, false if it didn't exist. */
export function deleteAttachment(baseDir: string, name: string): boolean {
  const safe = basename(name);
  if (!safe || safe !== name) {
    throw new AttachmentError(400, "bad_name", `Invalid attachment name: ${name}`);
  }
  const abs = join(baseDir, safe);
  if (!existsSync(abs)) return false;
  rmSync(abs, { force: true });
  return true;
}

/** Return a content-type header value for a saved attachment based on its
 *  extension. Falls back to `application/octet-stream` for the unknown. */
export function contentTypeForFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}
