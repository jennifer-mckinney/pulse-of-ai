-- Migration 022: the ingest methodology version recorded per post (G10-11).
--
-- The audit receipt showed the LATEST ingest version for every post, so a
-- post stored under ingest@1.1.0 was described with 1.3.0's redaction
-- rules. raw_posts.ingest_mv_id now records the version the post was
-- stored under (collectors and the demo population set it at insert). Rows
-- stored before this migration keep NULL and the receipt resolves the
-- ingest version effective at their collected_at (lineage 'inferred').
--
-- Additive: no existing row is updated.

ALTER TABLE raw_posts ADD COLUMN IF NOT EXISTS ingest_mv_id UUID REFERENCES methodology_versions(id);
