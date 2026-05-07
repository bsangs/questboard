import { postCardEndpoint } from "./api.js";
import { printResponse } from "./util.js";

/**
 * POST /api/cards/:id/reviewer-pass — reviewer-only. Server performs
 * ff-only merge to main, transitions to `done`, fires Telegram alert.
 */
export async function cmdReviewPass(): Promise<void> {
  const result = await postCardEndpoint("reviewer-pass", {});
  printResponse(result);
}
