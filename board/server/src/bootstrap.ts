/**
 * Bootstrap: rebuild SQLite from the filesystem source-of-truth on startup.
 * - Truncate cards / comments / card_deps.
 * - Read every active and archived card.md, ingest into cards.
 * - Stream comments.jsonl into comments table.
 * - Re-seed meta.next_card_id to max(id)+1.
 *
 * Per data-model.md §5.3, the SQLite file is just a query cache.
 */
import {
  db,
  truncateAll,
  bootstrapUpsertCardRow,
  appendCommentRow,
  appendHistoryRow,
  pruneCardsNotIn,
  recomputeCommentCounts,
  updateCardTokenTotals,
} from "./db.js";
import { listActiveCardIds, listArchivedCardIds, readCard, readComments, readHistory } from "./files.js";
import { logger } from "./logger.js";
import { getCardTokenTotals } from "./stages.js";

export function bootstrapFromFs(): {
  active: number;
  archived: number;
  comments: number;
  history: number;
} {
  let active = 0;
  let archived = 0;
  let commentCount = 0;
  let historyCount = 0;

  const fn = db.transaction(() => {
    // Defer FK checks until commit. Inside a transaction, plain
    // `foreign_keys = OFF` is a no-op; `defer_foreign_keys` is the official
    // SQLite knob. By commit time we'll have re-ingested from the filesystem
    // so referential integrity is restored.
    db.pragma("defer_foreign_keys = ON");
    truncateAll();
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("1", "next_card_id");

    const seenIds = new Set<string>();
    const ingest = (id: string, isArchive: boolean) => {
      try {
        const { card } = readCard(id);
        bootstrapUpsertCardRow(card.frontmatter, card.frontmatter.deps);
        seenIds.add(id);
        // readComments / readHistory each filter by kind, so legacy
        // comments.jsonl entries land in the correct table even though
        // both files are read.
        const comments = readComments(id, isArchive);
        for (const c of comments) appendCommentRow(id, c);
        commentCount += comments.length;
        const history = readHistory(id, isArchive);
        for (const h of history) appendHistoryRow(id, h);
        historyCount += history.length;
        // Backfill per-role token totals from transcripts. Archived cards
        // keep their transcripts inside the archive folder, but
        // transcriptsDir() is rooted at CARDS_DIR; if the dir is missing
        // getCardTokenTotals returns zeros, which is the right answer for
        // any card with no transcript history.
        try {
          updateCardTokenTotals(id, getCardTokenTotals(id));
        } catch (err) {
          logger.error("bootstrap_token_totals_failed", { id, err: String(err) });
        }
        if (isArchive) archived++;
        else active++;
      } catch (err) {
        logger.error("bootstrap_card_load_failed", { id, archived: isArchive, err: String(err) });
      }
    };

    for (const id of listActiveCardIds()) ingest(id, false);
    for (const id of listArchivedCardIds()) ingest(id, true);

    // Prune any cards whose card.md was removed off-disk while we were
    // down. Without this, deleted cards stay in SQLite forever.
    pruneCardsNotIn(seenIds);

    // Reseed next_card_id.
    const row = db.prepare("SELECT MAX(CAST(id AS INTEGER)) AS m FROM cards").get() as
      | { m: number | null }
      | undefined;
    const next = (row?.m ?? 0) + 1;
    db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(String(next), "next_card_id");

    // Recompute the cached comment_count column from the freshly-ingested
    // comments table so the list endpoint shows accurate badges on first load.
    recomputeCommentCounts();
  });

  fn();
  logger.info("bootstrap_complete", { active, archived, comments: commentCount, history: historyCount });
  return { active, archived, comments: commentCount, history: historyCount };
}
