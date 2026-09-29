-- Migration 020: a database-backed kill switch per source (F10-10).
--
-- Env kill switches (SOURCE_<SLUG>_ENABLED, COLLECTORS_DISABLED,
-- COLLECTORS_ENABLED) apply only when a container is RECREATED
-- (`docker compose up -d worker web`). A takedown must apply at once, in
-- every process: `npm run source:disable -- <slug> --reason "<why>"` sets
-- collection_disabled_at, which the runner checks before every run and
-- GET /api/sources reports as 'disabled'. `npm run source:enable -- <slug>`
-- clears it.
--
-- Additive and idempotent.

ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS collection_disabled_at     TIMESTAMPTZ;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS collection_disabled_reason TEXT;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS collection_disabled_by     TEXT;
