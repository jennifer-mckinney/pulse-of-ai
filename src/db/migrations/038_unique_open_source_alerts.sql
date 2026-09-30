-- Migration 038: at most ONE open alert per (type, source), enforced by the
-- database (PR #22 principal #6, grumpy #13).
--
-- The source-health evaluator and the refusal path opened alerts with
-- INSERT … WHERE NOT EXISTS, which is not atomic under READ COMMITTED: two
-- overlapping evaluations (a slow cycle close, or a second worker replica)
-- could both insert. Now:
--   1. duplicates already open are closed first — the OLDEST open alert of
--      each (type, source) stays open; each later duplicate gets an
--      alert_resolutions row saying which alert it duplicated, and
--      resolved_at. Nothing is deleted.
--   2. a UNIQUE partial index makes a second open alert impossible; the code
--      inserts with ON CONFLICT DO NOTHING (src/collectors/source-alerts.js).
-- Idempotent.
WITH ranked AS (
    SELECT id, alert_type, source_id,
           ROW_NUMBER() OVER (PARTITION BY alert_type, source_id ORDER BY created_at, id) AS rn
    FROM alert_events
    WHERE resolved_at IS NULL AND source_table = 'data_sources' AND source_id IS NOT NULL
),
dups AS (
    SELECT r.id,
           (SELECT k.id FROM ranked k WHERE k.alert_type = r.alert_type AND k.source_id = r.source_id AND k.rn = 1) AS kept
    FROM ranked r WHERE r.rn > 1
),
recorded AS (
    INSERT INTO alert_resolutions (alert_id, resolved_by, resolution, basis)
    SELECT d.id, 'migration 038_unique_open_source_alerts.sql',
           'Duplicate of open alert ' || d.kept::text || ', opened by overlapping evaluations (PR #22 principal #6); '
               || 'the original stays open.',
           jsonb_build_object('kept_alert_id', d.kept)
    FROM dups d
    ON CONFLICT (alert_id) DO NOTHING
    RETURNING alert_id
)
UPDATE alert_events ae SET resolved_at = NOW()
FROM recorded r WHERE ae.id = r.alert_id AND ae.resolved_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_source
    ON alert_events (alert_type, source_id)
    WHERE resolved_at IS NULL AND source_table = 'data_sources' AND source_id IS NOT NULL;
