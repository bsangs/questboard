/**
 * Thin REST client for the questboard server.
 *
 * Base URL resolution (in order):
 *   1. NEXT_PUBLIC_API_BASE_URL      — preferred (cross-host deploys)
 *   2. NEXT_PUBLIC_BOARD_SERVER_URL  — legacy alias, kept for back-compat
 *   3. ""                            — same-origin (default)
 *
 * In single-host deploys leave both env vars unset; the UI talks to the
 * API at the same origin it was served from (Next dev or static SPA).
 * For split-host deploys set NEXT_PUBLIC_API_BASE_URL to the API URL at
 * build time and configure BOARD_CORS_ALLOWED_ORIGINS on the API host.
 */
import type {
  BoardConfig,
  Card,
  CardStage,
  Comment,
  HistoryEntry,
  CardSummary,
  BoardStats,
  CardDiff,
  CardFlavor,
  CardStatus,
  TranscriptMessage,
} from "./types";

function pickBaseUrl(): string {
  if (typeof process === "undefined") return "";
  const preferred = process.env.NEXT_PUBLIC_API_BASE_URL as string | undefined;
  if (preferred && preferred.length > 0) return preferred.replace(/\/+$/, "");
  const legacy = process.env.NEXT_PUBLIC_BOARD_SERVER_URL as string | undefined;
  if (legacy && legacy.length > 0) return legacy.replace(/\/+$/, "");
  return "";
}

/**
 * API base URL. Empty string means "same-origin": browser fetches with
 * leading-slash paths target whatever origin the page was served from.
 */
export const BOARD_SERVER_URL: string = pickBaseUrl();

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${BOARD_SERVER_URL}${path}`, {
    ...rest,
    headers: {
      Accept: "application/json",
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers || {}),
    },
    body: json !== undefined ? JSON.stringify(json) : (rest.body as BodyInit | undefined),
    cache: "no-store",
  });

  if (!res.ok) {
    let body: { error?: string; message?: string; details?: unknown } | null = null;
    try {
      body = await res.json();
    } catch {
      // not JSON; ignore
    }
    throw new ApiError(
      res.status,
      body?.message || body?.error || `HTTP ${res.status}`,
      body?.error,
      body?.details,
    );
  }

  // Some endpoints return 204 No Content.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── Cards ───────────────────────────────────────────────────────────────────

export const listCards = async (
  filter: { status?: CardStatus[]; priority?: 1 | 2 | 3 } = {},
): Promise<CardSummary[]> => {
  const qs = new URLSearchParams();
  if (filter.status?.length) qs.set("status", filter.status.join(","));
  if (filter.priority) qs.set("priority", String(filter.priority));
  const tail = qs.toString() ? `?${qs.toString()}` : "";
  // Server wraps the list in { total, cards } — unwrap. Tolerate raw arrays
  // for resilience in case the envelope ever changes.
  const res = await request<
    { total: number; cards: CardSummary[] } | CardSummary[]
  >(`/api/cards${tail}`);
  if (Array.isArray(res)) return res;
  return res?.cards ?? [];
};

export const getCard = async (
  id: string,
): Promise<{ card: Card; comments: Comment[]; history: HistoryEntry[] }> => {
  // Server returns a flat envelope: { id, archived, frontmatter, description,
  // comments, history, transcripts }. UI consumes the canonical Card shape
  // ({ frontmatter, description }), so adapt here. Tolerate the canonical
  // shape too in case the server is changed later. `history` is optional
  // for resilience against older servers.
  const raw = await request<
    | { card: Card; comments: Comment[]; history?: HistoryEntry[] }
    | {
        id: string;
        frontmatter: Card["frontmatter"];
        description: string;
        comments: Comment[];
        history?: HistoryEntry[];
      }
  >(`/api/cards/${id}`);
  if ("card" in raw) {
    return { card: raw.card, comments: raw.comments, history: raw.history ?? [] };
  }
  return {
    card: { frontmatter: raw.frontmatter, description: raw.description },
    comments: raw.comments,
    history: raw.history ?? [],
  };
};

export const getHistory = async (id: string): Promise<HistoryEntry[]> => {
  const res = await request<{ history: HistoryEntry[] } | HistoryEntry[]>(
    `/api/cards/${id}/history`,
  );
  return Array.isArray(res) ? res : res.history;
};

export const getStages = async (id: string): Promise<CardStage[]> => {
  const res = await request<{ stages: CardStage[] } | CardStage[]>(
    `/api/cards/${id}/stages`,
  );
  return Array.isArray(res) ? res : res.stages;
};

/**
 * Fetch one helper's transcript for a card. Pass `role`/`attempt` to pin
 * to a specific stage; omit both to let the server choose the active or
 * most recently finished stage. Returns `{ stage: null, messages: [] }`
 * when the card has no transcripts yet.
 */
export const getCardTranscript = async (
  id: string,
  opts: { role?: CardStage["role"]; attempt?: number } = {},
): Promise<{ stage: CardStage | null; messages: TranscriptMessage[] }> => {
  const qs = new URLSearchParams();
  if (opts.role) qs.set("role", opts.role);
  if (opts.attempt) qs.set("attempt", String(opts.attempt));
  const tail = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/cards/${id}/transcript${tail}`);
};

export const createCard = (input: {
  title: string;
  description: string;
  language?: string;
  priority?: 1 | 2 | 3;
  flavor?: CardFlavor;
  /** Scope id from BoardConfig.scopes. Omit / null = no scope. */
  scope?: string | null;
  deps?: string[];
}): Promise<{ id: string; status: CardStatus; created_at: string }> =>
  request("/api/cards", { method: "POST", json: input });

export const patchCard = (
  id: string,
  patch: Partial<{
    title: string;
    description: string;
    priority: 1 | 2 | 3;
    language: string;
    flavor: CardFlavor;
    /** Scope id from BoardConfig.scopes, or null to clear. */
    scope: string | null;
    deps: string[];
  }>,
): Promise<{ ok: true }> =>
  request(`/api/cards/${id}`, { method: "PATCH", json: patch });

export const deleteCard = (id: string): Promise<{ ok: true }> =>
  request(`/api/cards/${id}`, { method: "DELETE" });

// ─── Transitions (Human-driven) ─────────────────────────────────────────────

export const moveToReady = (id: string) =>
  request(`/api/cards/${id}/ready`, { method: "POST" });

/** Inverse of moveToReady: pull a `ready` card back to `backlog`. Only
 *  valid before the dispatcher claims it (status must still be "ready"). */
export const moveToBacklog = (id: string) =>
  request(`/api/cards/${id}/backlog`, { method: "POST" });

/** Drag back to Ready from any waiting/active column. Server resets
 *  runtime fields (owner_pid, stuck_reason, …) so the dispatcher can
 *  pick the card up again with a fresh worker. */
export const requeueCard = (id: string) =>
  request(`/api/cards/${id}/requeue`, { method: "POST" });

export const moveToAiReview = (id: string) =>
  request(`/api/cards/${id}/ai-review`, { method: "POST" });

export const approveCard = (id: string) =>
  request<{ status: "done"; merged_sha: string }>(`/api/cards/${id}/approve`, {
    method: "POST",
  });

export const reopenCard = (id: string) =>
  request(`/api/cards/${id}/reopen`, { method: "POST" });

export const cancelCard = (id: string, reason?: string) =>
  request(`/api/cards/${id}/cancel`, { method: "POST", json: { reason } });

// ─── Stuck-with-merged_sha recovery (drawer actions) ────────────────────────

/**
 * Manual retry of the user-configured post-build command. Card flips back
 * to `merging`; the server's runner classifies and retries from there.
 * 409 "no_merged_sha" / "no_post_build_cmd" / "post_build_active" if any
 * precondition fails.
 */
export const retryPostBuild = (id: string) =>
  request<{ status: "merging"; merged_sha: string }>(
    `/api/cards/${id}/retry-post-build`,
    { method: "POST" },
  );

/**
 * Force a stuck-with-merged_sha card into `done` (user override). Body
 * `reason` is appended as a `note` comment for audit. 409 if there's an
 * active post-build (user must stop it first).
 */
export const forceDoneCard = (id: string, reason?: string) =>
  request<{ status: "done"; merged_sha: string }>(
    `/api/cards/${id}/force-done`,
    { method: "POST", json: { reason } },
  );

/**
 * SIGTERM the active post-build for this card. The runner's exit handler
 * lands the card back in `stuck` (testing_failed). 409 if there's nothing
 * running for this card.
 */
export const stopPostBuild = (id: string) =>
  request<{ ok: true; killed_pid: number }>(
    `/api/cards/${id}/stop-post-build`,
    { method: "POST" },
  );

export const restoreCard = (id: string) =>
  request(`/api/cards/${id}/restore`, { method: "POST" });

export const archiveCards = (ids: string[]) =>
  request<{ archived: string[] }>(`/api/cards/archive`, {
    method: "POST",
    json: { ids },
  });

export const answerStuck = (id: string, body: string) =>
  request<{ status: "ready" }>(`/api/cards/${id}/answer`, {
    method: "POST",
    json: { body },
  });

export const addComment = (
  id: string,
  payload: { kind: Comment["kind"]; body: string },
) =>
  request<{ comment_id: string; ts: string }>(`/api/cards/${id}/comments`, {
    method: "POST",
    json: payload,
  });

// ─── Diff ───────────────────────────────────────────────────────────────────

export const getDiff = (id: string): Promise<CardDiff> =>
  request(`/api/cards/${id}/diff`);

// ─── Config ─────────────────────────────────────────────────────────────────

export const getConfig = (): Promise<BoardConfig> => request("/api/config");

export const patchConfig = async (
  patch: Partial<BoardConfig>,
): Promise<BoardConfig> => {
  // Server returns `{config, swept}`. Unwrap here so the caller gets the
  // canonical BoardConfig shape.
  const res = await request<
    { config: BoardConfig; swept?: string[] } | BoardConfig
  >("/api/config", { method: "POST", json: patch });
  return "config" in res ? res.config : res;
};

export const toggleAutoReview = () =>
  request<{ auto_review: boolean; swept_count: number }>(
    "/api/config/auto-review-toggle",
    { method: "POST" },
  );

// ─── Stats ──────────────────────────────────────────────────────────────────

export const getStats = (): Promise<BoardStats> => request("/api/stats");

// ─── Telegram test (optional) ───────────────────────────────────────────────

export const testTelegram = () =>
  request<{ ok: boolean }>(`/api/telegram/test`, { method: "POST" });

// ─── Base prompt ────────────────────────────────────────────────────────────

export const getBasePrompt = (): Promise<{ text: string }> =>
  request("/api/base-prompt");

export const setBasePrompt = (text: string): Promise<{ ok: true }> =>
  request("/api/base-prompt", { method: "POST", json: { text } });

// ─── System (folder picker, board root) ─────────────────────────────────────

export const getBoardRoot = (): Promise<{ boardRoot: string }> =>
  request("/api/system/board-root");

/**
 * Pop a native folder dialog on the developer's machine via the server.
 * Returns the picked folder as a project-relative path, or `null` when:
 *   - the user cancelled the dialog
 *   - the picker isn't available on this platform
 *   - the chosen folder lies outside BOARD_ROOT
 *
 * The boardRoot field is included so the caller can format helpful UI
 * strings ("/abs/path → relative-to-board") when the picker fails.
 */
export const pickFolder = (): Promise<
  | { cancelled: true }
  | { absolute: string; relative: string | null; boardRoot: string }
> => request("/api/system/folder-pick");

// ─── File listing (Composer @-mention picker) ───────────────────────────────

export interface FileListEntry {
  name: string;
  kind: "dir" | "file";
  /** Always project-root-relative POSIX. Empty for root entries' parents. */
  relpath: string;
}

/**
 * List directory entries at `path` (project-root-relative, POSIX). The
 * server hides well-known noise (node_modules, .git, dist, ...) so the
 * returned list is what you'd want to show in a picker.
 *
 * `q` is a case-insensitive substring filter on `name` at the given
 * path — non-recursive. `limit` defaults server-side to 200.
 */
export const listFiles = async (opts: {
  path?: string;
  q?: string;
  limit?: number;
}): Promise<{
  path: string;
  entries: FileListEntry[];
  truncated: boolean;
}> => {
  const qs = new URLSearchParams();
  if (opts.path != null) qs.set("path", opts.path);
  if (opts.q) qs.set("q", opts.q);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const tail = qs.toString() ? `?${qs.toString()}` : "";
  return request(`/api/files${tail}`);
};
