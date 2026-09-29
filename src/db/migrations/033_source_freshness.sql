-- Migration 033: source freshness (PR #10 review P10-8).
--
-- source_collection_state.last_new_post_at — when the source last stored a
-- NEW post (set by the runner, src/collectors/state.js saveOutcome). The
-- source-health evaluator (src/collectors/source-health.js, run with every
-- cycle close in the worker) compares it with the registry's per-source
-- expectedNewWithinHours and opens a 'source_stale' alert; it also opens
-- 'source_failing' (consecutive failures) and makes sure a refused source
-- has its 'source_refused' alert, and resolves each when the condition
-- clears. Additive; existing rows start NULL (the evaluator then uses the
-- last success as the reference, never inventing a date).

ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS last_new_post_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_alerts_open_source ON alert_events (alert_type, source_id) WHERE resolved_at IS NULL;
