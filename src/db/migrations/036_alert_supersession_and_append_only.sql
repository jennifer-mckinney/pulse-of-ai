-- Migration 036: the owner's approval of methodology supersessions (PR #22
-- decision G1) and append-only enforcement of the governance tables (PR #22
-- principal #9, security L6).
--
-- 1. alert_resolution_approvals — additive, one row per alert_resolutions
--    row that a named person approved. kind 'superseded' marks an alert
--    closed because a LATER METHODOLOGY would not raise it, as distinct from
--    'resolved' (the condition cleared or was fixed). Jennifer's ruling G1
--    (2026-09-29): the alerts closed by migrations 028 (bias@1.3.0) and 032
--    (bias@1.4.0) are superseded by a methodology change, with Jennifer
--    McKinney as the named approver. No alert_resolutions row is edited: the
--    approval is a new row pointing at it, with the methodology version it
--    applied (taken from the resolution's own basis->>'methodology', so a
--    database that ran an earlier draft of 028 is linked too).
-- 2. alert_status — a view giving every alert one status: open, resolved
--    or superseded (with approver), for the dashboard and audits.
-- 3. Append-only: a BEFORE UPDATE OR DELETE trigger raises on
--    alert_resolutions, alert_resolution_approvals, source_gate_events,
--    source_terms_snapshots and methodology_errata. Documented as
--    append-only since they were created; now enforced. (TRUNCATE, used only
--    by the test harness, is not a row operation and is unaffected.)
-- Idempotent.

CREATE TABLE IF NOT EXISTS alert_resolution_approvals (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    resolution_id           UUID NOT NULL UNIQUE REFERENCES alert_resolutions(id),
    kind                    TEXT NOT NULL CHECK (kind IN ('superseded', 'resolved')),
    approved_by             TEXT NOT NULL,
    ruling_date             DATE NOT NULL,
    ruling                  TEXT NOT NULL,
    methodology_version_id  UUID REFERENCES methodology_versions(id),
    recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO alert_resolution_approvals (resolution_id, kind, approved_by, ruling_date, ruling, methodology_version_id)
SELECT r.id, 'superseded', 'Jennifer McKinney', DATE '2026-09-29',
       'PR #22 decision G1 (Jennifer McKinney, 2026-09-29): alerts closed by migrations 028/032 are superseded by a '
           || 'methodology change (' || COALESCE(r.basis->>'methodology', 'bias') || '), not resolved; Jennifer McKinney '
           || 'is the named approver. ADR 0001, "Decisions of 2026-09-29 (PR #22 review)".',
       COALESCE(r.methodology_version_id,
                (SELECT mv.id FROM methodology_versions mv
                 WHERE mv.component || '@' || mv.version = r.basis->>'methodology'))
FROM alert_resolutions r
WHERE r.resolved_by IN ('migration 028_bias_min_sample.sql', 'migration 032_bias_sample_rules.sql')
ON CONFLICT (resolution_id) DO NOTHING;

CREATE OR REPLACE VIEW alert_status AS
SELECT ae.id AS alert_id, ae.alert_type, ae.severity, ae.created_at, ae.resolved_at,
       CASE WHEN ae.resolved_at IS NULL THEN 'open'
            WHEN ap.kind = 'superseded' THEN 'superseded'
            ELSE 'resolved' END AS status,
       r.id AS resolution_id, r.resolved_by, r.resolution,
       ap.approved_by, ap.ruling_date,
       COALESCE(ap.methodology_version_id, r.methodology_version_id) AS methodology_version_id
FROM alert_events ae
LEFT JOIN alert_resolutions r ON r.alert_id = ae.id
LEFT JOIN alert_resolution_approvals ap ON ap.resolution_id = r.id;

CREATE OR REPLACE FUNCTION forbid_append_only_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is append-only: % is not allowed (PR #22; record a new row instead)', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['alert_resolutions', 'alert_resolution_approvals', 'source_gate_events',
                             'source_terms_snapshots', 'methodology_errata'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_append_only_change()',
                       t || '_append_only', t);
    END LOOP;
END $$;
