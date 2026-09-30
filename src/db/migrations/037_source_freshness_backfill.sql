-- Migration 037: source_stale for feeds that answer but store nothing new
-- (PR #22 principal P0-2).
--
-- Migration 033 added source_collection_state.last_new_post_at as NULL for
-- every existing row, and the evaluator fell back to last_success_at — which
-- every successful run refreshes — so a source answering 200 with nothing
-- new never went stale. Now:
--   1. freshness_anchor_at: a FIXED time the evaluator measures from when no
--      new post was ever recorded — the row's creation for new rows (column
--      default), this migration's time for existing rows. It never moves.
--   2. last_new_post_at is backfilled, where NULL, from the newest stored
--      post of the source (MAX(raw_posts.collected_at)); a value already set
--      is never changed.
-- Idempotent.
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS freshness_anchor_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE source_collection_state s
SET last_new_post_at = m.newest
FROM (SELECT source_id, MAX(collected_at) AS newest FROM raw_posts GROUP BY source_id) m
WHERE m.source_id = s.source_id
  AND s.last_new_post_at IS NULL
  AND m.newest IS NOT NULL;
