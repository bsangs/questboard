import { StuckReason } from "@questboard/core";
import { postCardEndpoint } from "./api.js";
import { printResponse, resolveTextOrFile } from "./util.js";

export interface StuckOpts {
  reason: string;
  question: string;
}

/**
 * POST /api/cards/:id/stuck — escalate to human. Server transitions
 * in_progress → stuck, drops owner_pid, appends the question as a
 * `kind=stuck` comment, and fires Telegram alert.
 *
 * `--question` accepts inline text or `@<path>`.
 */
export async function cmdStuck(opts: StuckOpts): Promise<void> {
  const parsedReason = StuckReason.safeParse(opts.reason);
  if (!parsedReason.success) {
    const allowed = StuckReason.options.join(", ");
    throw new Error(`--reason must be one of: ${allowed} (got "${opts.reason}")`);
  }
  const question = resolveTextOrFile(opts.question);
  if (!question.trim()) throw new Error("--question must not be empty");

  const result = await postCardEndpoint("stuck", {
    stuck_reason: parsedReason.data,
    stuck_question: question,
    comment_body: question,
  });
  printResponse(result);
}
