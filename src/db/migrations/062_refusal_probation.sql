-- Migration 062: refusal probation and refusal response headers
-- (diagnosis 2026-09-30, Pew Research Center; Jennifer's ruling
-- "Probation + log headers (Recommended)", ADR 0001 dated note 2026-09-30).
--
-- 1. source_collection_state.probation_until — a successful probe after a
--    refusal cooldown ends the refused state but NO LONGER zeroes
--    refusal_count: the source is on probation until this time (24 h after
--    the probe). A refusal during probation continues the count (so the
--    cooldown escalates 1 h → 2 h → … → 24 h as ADR 0001 designed); only
--    24 h without a refusal decays the count to 0. Before this, one clean
--    probe reset the count, and a publisher that lets a few requests through
--    before refusing kept us at a 1 h cooldown forever.
-- 2. source_collection_state.access_denied_headers — the allow-listed,
--    scrubbed response headers of the latest refusal (server, date,
--    retry-after, cache / edge request ids …; never Set-Cookie, auth or any
--    body — src/collectors/http.js refusalHeaders), so operators can tell
--    which layer refused. Cleared with the refused state.
-- 3. source_runs.response_headers — the same headers on the run row that
--    recorded the refusal (history per refusal). NULL on every other run.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS only; no existing row
-- is rewritten (a source already on refusal_count > 0 keeps its count; with
-- probation_until NULL it decays on the next successful run, as before).

ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS probation_until       TIMESTAMPTZ;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS access_denied_headers JSONB;
ALTER TABLE source_runs             ADD COLUMN IF NOT EXISTS response_headers      JSONB;
