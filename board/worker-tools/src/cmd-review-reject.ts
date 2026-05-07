import { postCardEndpoint } from "./api.js";
import { printResponse, resolveTextOrFile } from "./util.js";

export interface ReviewRejectOpts {
  body: string;
}

/**
 * POST /api/cards/:id/reviewer-reject — reviewer-only. Server appends
 * a `kind=review_note` comment with the rejection text and transitions
 * ai_review → in_progress so a fresh worker picks the card up.
 *
 * `--body` accepts inline text or `@<path>`.
 */
export async function cmdReviewReject(opts: ReviewRejectOpts): Promise<void> {
  const body = resolveTextOrFile(opts.body);
  if (!body.trim()) throw new Error("--body must not be empty");
  const result = await postCardEndpoint("reviewer-reject", { comment_body: body });
  printResponse(result);
}
