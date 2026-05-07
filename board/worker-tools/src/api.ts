/**
 * Tiny fetch wrapper for the questboard server.
 *
 * Reads BOARD_SERVER_URL + CARD_ID from the env (the dispatcher sets these
 * when spawning workers). Both can be overridden by CLI flags handled in
 * main.ts before any command runs.
 */

export interface ApiContext {
  serverUrl: string;
  cardId: string;
}

let context: ApiContext | null = null;

export function configureApi(opts: Partial<ApiContext>): void {
  const serverUrl = opts.serverUrl ?? process.env.BOARD_SERVER_URL ?? "";
  const cardId = opts.cardId ?? process.env.CARD_ID ?? "";

  if (!serverUrl) {
    throw new Error(
      "BOARD_SERVER_URL is not set. Pass --server <url> or export BOARD_SERVER_URL."
    );
  }
  if (!cardId) {
    throw new Error("CARD_ID is not set. Pass --card <id> or export CARD_ID.");
  }
  if (!/^\d{4}$/.test(cardId)) {
    throw new Error(`CARD_ID must be a 4-digit zero-padded string (got "${cardId}")`);
  }

  context = { serverUrl: serverUrl.replace(/\/+$/, ""), cardId };
}

export function getCardId(): string {
  if (!context) throw new Error("API not configured. Call configureApi() first.");
  return context.cardId;
}

/**
 * POST a JSON body to a card-scoped endpoint and return the parsed JSON.
 * `path` is appended after `/api/cards/:id/`, e.g. `claim`, `heartbeat`.
 *
 * Throws on non-2xx. The thrown error includes status code + response body
 * so the caller's stderr message is actionable.
 */
export async function postCardEndpoint<T = unknown>(
  path: string,
  body: Record<string, unknown>
): Promise<T> {
  if (!context) throw new Error("API not configured. Call configureApi() first.");

  const url = `${context.serverUrl}/api/cards/${context.cardId}/${path.replace(/^\/+/, "")}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Network error talking to ${url}: ${msg}`);
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText} from POST ${url}\n${text || "(empty body)"}`
    );
  }

  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Server returned non-JSON 2xx — return raw text wrapped.
    return { raw: text } as unknown as T;
  }
}
