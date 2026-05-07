import { CommentKind } from "@questboard/core";
import { postCardEndpoint } from "./api.js";
import { printResponse, resolveTextOrFile } from "./util.js";

export interface CommentOpts {
  kind: string;
  body: string;
}

/**
 * POST /api/cards/:id/comments — append a generic comment to a card.
 * `--kind` is validated against the `CommentKind` zod enum from @questboard/core.
 * `--body` accepts either inline text or `@<path>` to read from disk.
 */
export async function cmdComment(opts: CommentOpts): Promise<void> {
  const parsedKind = CommentKind.safeParse(opts.kind);
  if (!parsedKind.success) {
    const allowed = CommentKind.options.join(", ");
    throw new Error(`--kind must be one of: ${allowed} (got "${opts.kind}")`);
  }
  const body = resolveTextOrFile(opts.body);
  if (!body.trim()) throw new Error("--body must not be empty");

  const result = await postCardEndpoint("comments", {
    kind: parsedKind.data,
    body,
  });
  printResponse(result);
}
