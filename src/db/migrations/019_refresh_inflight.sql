-- Migration 019: one POST /api/refresh collection in flight (F10-8).
--
-- The route answers 409 with the running job_id while a refresh job is
-- running; this partial unique index makes that hold across web processes
-- too (a concurrent second INSERT fails instead of starting a second run).
-- Refresh rows left 'running' by a crash before this migration are closed
-- first, keeping the newest, so the index can be built.
--
-- Additive: no row is deleted.

UPDATE processing_jobs p
SET status = 'failed',
    error_details = COALESCE(p.error_details || E'\n', '') || 'closed by migration 019: superseded by a newer running refresh job',
    completed_at = NOW()
WHERE p.triggered_by = 'api' AND p.status = 'running'
  AND p.id <> (SELECT id FROM processing_jobs
               WHERE triggered_by = 'api' AND status = 'running'
               ORDER BY started_at DESC, id DESC LIMIT 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_processing_jobs_api_running
    ON processing_jobs ((triggered_by))
    WHERE triggered_by = 'api' AND status = 'running';
