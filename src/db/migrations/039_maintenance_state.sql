-- Migration 039: maintenance runs are visible (PR #22 principal P0-1,
-- grumpy #6).
--
-- The repeatable maintenance jobs (src/workers/maintenance.worker.js) used
-- to swallow a failing step and complete, so a broken text-retention run
-- looked healthy. Now a failing step fails the BullMQ job AND every run
-- records its outcome here, one row per task ('retention', 'daily'):
-- /api/health reports the last successful run, and the watchdog
-- (scripts/watchdog.js) alerts when it is too old.
--
-- One row per task, overwritten by each run: this is current state, not an
-- audit record (the job history is in BullMQ; retention itself logs every
-- change to data_retention_log). Idempotent.
CREATE TABLE IF NOT EXISTS maintenance_state (
    task            TEXT PRIMARY KEY,
    last_run_at     TIMESTAMPTZ NOT NULL,
    last_ok_at      TIMESTAMPTZ,
    last_failed_at  TIMESTAMPTZ,
    last_error      TEXT,
    last_steps      JSONB NOT NULL DEFAULT '{}'::jsonb
);
