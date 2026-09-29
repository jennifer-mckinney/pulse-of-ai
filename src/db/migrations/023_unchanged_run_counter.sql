-- Migration 023: no source_runs row for a run that changed nothing (G10-12).
--
-- At a 2-3 minute cadence over ~31 sources, most runs are 304 Not Modified
-- or fetch nothing new: ~18k source_runs rows a day that say "nothing
-- happened". Such a run (ok, nothing fetched or new, no error) is now
-- counted on the source's state row instead of inserted. Every run that
-- fetched, stored, failed or was refused still writes its source_runs row.
-- (Retention and daily rollups of source_runs are Part 2, P10-9.)
--
-- Additive and idempotent.

ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS unchanged_runs    BIGINT NOT NULL DEFAULT 0;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS last_unchanged_at TIMESTAMPTZ;
