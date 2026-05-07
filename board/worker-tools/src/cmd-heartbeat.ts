import { postCardEndpoint } from "./api.js";
import { printResponse, toPositiveInt } from "./util.js";

export interface HeartbeatOpts {
  tokens: string;
  elapsed: string;
}

/**
 * POST /api/cards/:id/heartbeat — keep-alive ping. The dispatcher uses
 * last_heartbeat to detect orphaned workers.
 */
export async function cmdHeartbeat(opts: HeartbeatOpts): Promise<void> {
  const tokens_used = toPositiveInt("tokens", opts.tokens);
  const elapsed_seconds = toPositiveInt("elapsed", opts.elapsed);
  const result = await postCardEndpoint("heartbeat", {
    tokens_used,
    elapsed_seconds,
  });
  printResponse(result);
}
