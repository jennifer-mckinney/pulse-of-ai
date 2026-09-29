-- Migration 018: the refused state (F10-5, ADR 0001 ruling 5).
--
-- A source that answers 401 / 403 / 451 (or a bot challenge), or whose
-- robots.txt disallows us, is REFUSED: it is not requested again on every
-- poll. The runner records the refusal here, skips the source through an
-- exponential cooldown (1 h, 2 h, 4 h, … capped at 24 h; one probe run when
-- a cooldown ends), writes one critical alert_events row
-- ('source_refused'), and clears the state on a successful probe or a
-- manual reset (env SOURCE_<SLUG>_RESET=<ISO date> newer than the refusal,
-- or `npm run source:reset -- <slug>`). GET /api/sources reports such a
-- source as 'blocked_by_source'; it never counts as online.
--
-- Additive and idempotent: ADD COLUMN IF NOT EXISTS only.

ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS access_denied_at     TIMESTAMPTZ;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS access_denied_status INTEGER;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS access_denied_kind   TEXT;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS refused_until        TIMESTAMPTZ;
ALTER TABLE source_collection_state ADD COLUMN IF NOT EXISTS refusal_count        INTEGER NOT NULL DEFAULT 0;
