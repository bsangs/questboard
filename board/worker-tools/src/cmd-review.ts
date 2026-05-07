import { postCardEndpoint } from "./api.js";
import { printResponse } from "./util.js";

export interface ReviewOpts {
  branch: string;
}

/**
 * POST /api/cards/:id/review — worker signals "code is on the WIP branch,
 * please route to review". Server transitions in_progress → human_review
 * (or → ai_review when auto_review is on).
 */
export async function cmdReview(opts: ReviewOpts): Promise<void> {
  if (!opts.branch?.trim()) throw new Error("--branch must not be empty");
  const result = await postCardEndpoint("review", { wip_branch: opts.branch });
  printResponse(result);
}
