import { postCardEndpoint } from "./api.js";
import { printResponse, toPositiveInt } from "./util.js";

export interface ClaimOpts {
  pid: string;
  attempt: string;
}

/**
 * POST /api/cards/:id/claim — atomically take ownership of a ready card.
 * Returns 200 on success, 409 if another worker already owns it.
 */
export async function cmdClaim(opts: ClaimOpts): Promise<void> {
  const pid = toPositiveInt("pid", opts.pid);
  const attempt = toPositiveInt("attempt", opts.attempt);
  const result = await postCardEndpoint("claim", { pid, attempt });
  printResponse(result);
}
