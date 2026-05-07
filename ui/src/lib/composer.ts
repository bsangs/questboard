"use client";

/**
 * Composer REST client.
 *
 * Composer REST client. Mirrors the `cards`-style fetch idiom used in
 * `./api.ts` (no shared `request`
 * helper — composer endpoints are colocated in this file so future
 * tweaks stay scoped). Throws ApiError on non-2xx with the response
 * body's `message` (or `error`) field as the user-visible reason.
 */
import type {
  ComposerThread,
  ComposerThreadSummary,
} from "./types";
import { BOARD_SERVER_URL, ApiError } from "./api";

const BASE = `${BOARD_SERVER_URL}/api/composer`;

async function request<T>(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<T> {
  const { json, headers, ...rest } = init;
  const res = await fetch(`${BASE}${path}`, {
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
    // Capture the structured error envelope when present so callers can
    // surface a meaningful toast. Tolerate non-JSON responses (e.g. 502
    // from a proxy) by falling back to the HTTP status string.
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
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ─── Threads ─────────────────────────────────────────────────────────────────

export async function listComposerThreads(opts: {
  offset?: number;
  limit?: number;
  q?: string;
} = {}): Promise<{ total: number; threads: ComposerThreadSummary[] }> {
  const qs = new URLSearchParams();
  if (opts.offset != null) qs.set("offset", String(opts.offset));
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  if (opts.q) qs.set("q", opts.q);
  const tail = qs.toString() ? `?${qs.toString()}` : "";
  // Tolerate both an envelope and a raw array — same defensiveness used by
  // listCards in api.ts to survive a server shape change.
  const res = await request<
    { total: number; threads: ComposerThreadSummary[] } | ComposerThreadSummary[]
  >(`/threads${tail}`);
  if (Array.isArray(res)) return { total: res.length, threads: res };
  return res;
}

export async function createComposerThread(body: {
  cwd?: string | null;
  initial_message?: string;
}): Promise<{ thread_id: string }> {
  return request<{ thread_id: string }>(`/threads`, {
    method: "POST",
    json: body,
  });
}

export async function getComposerThread(id: string): Promise<ComposerThread> {
  return request<ComposerThread>(`/threads/${encodeURIComponent(id)}`);
}

export async function deleteComposerThread(id: string): Promise<void> {
  await request<void>(`/threads/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function patchComposerThread(
  id: string,
  patch: { title?: string; archived?: boolean },
): Promise<ComposerThreadSummary> {
  // Server may return the patched summary or `{summary}` envelope; accept
  // either to keep the caller side simple.
  const res = await request<
    ComposerThreadSummary | { summary: ComposerThreadSummary }
  >(`/threads/${encodeURIComponent(id)}`, {
    method: "PATCH",
    json: patch,
  });
  return "summary" in res ? res.summary : res;
}

export async function sendComposerMessage(
  threadId: string,
  text: string,
): Promise<void> {
  await request<void>(
    `/threads/${encodeURIComponent(threadId)}/messages`,
    { method: "POST", json: { text } },
  );
}

export async function stopComposerThread(threadId: string): Promise<void> {
  await request<void>(
    `/threads/${encodeURIComponent(threadId)}/stop`,
    { method: "POST" },
  );
}

/**
 * Hard-reset the composer worktree to origin/main. Server fetches origin,
 * resets the worktree, drops a system message in the transcript, and
 * broadcasts both `composer_message_appended` (the marker) and
 * `composer_thread_changed` (behind_main = 0). The UI doesn't need to do
 * anything with the response beyond surfacing errors — SSE updates the
 * store naturally.
 */
export async function syncComposerMain(threadId: string): Promise<{
  ok: true;
  before: string;
  after: string;
  added: number;
  behind_main: number;
}> {
  return request(
    `/threads/${encodeURIComponent(threadId)}/sync-main`,
    { method: "POST" },
  );
}

export async function decideComposerTool(
  threadId: string,
  body: {
    tool_use_id: string;
    decision: "approve" | "reject";
    edited_input?: unknown;
    reason?: string;
  },
): Promise<{ ok: true; result_ref?: string } | { ok: false; reason: string }> {
  return request(
    `/threads/${encodeURIComponent(threadId)}/tool-decisions`,
    { method: "POST", json: body },
  );
}
