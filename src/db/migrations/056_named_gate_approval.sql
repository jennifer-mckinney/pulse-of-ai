-- Migration 056: named approval of gate openings and the correlation gate
-- record (PR #22 decision G5, Jennifer McKinney 2026-09-29; principal #19;
-- security L6; grumpy L14 / L16).
--
-- 1. source_gate_events gains two additive columns:
--      approved_by  the GATE_APPROVED_BY value ("Name YYYY-MM-DD") under
--                   which a gated route opened, or which authorised a
--                   database kill-switch change / refusal reset;
--      routes       the route ids open when the event was recorded.
--    Existing rows keep NULL (never back-filled or edited).
-- 2. A new event, 'refusal_reset' (security L6: clearing a refusal was not
--    recorded). The CHECK is replaced by one listing it.
-- 3. The operator events ('enabled', 'disabled', 'refusal_reset') must name
--    an approver in the "Name YYYY-MM-DD" form (security L6: the actor comes
--    from the approved config, not a self-asserted $USER). NOT VALID: rows
--    written before this migration are not rechecked, new rows are.
-- 4. correlation_gate_events: every change of the correlation DPIA gate
--    (src/pipeline/correlation-gate.js) with its status, reason, DPIA
--    reference and who — recorded by the worker's scheduler (principal #19).
--    Append-only, enforced by the same trigger as the other governance
--    tables (migration 036).
-- Idempotent.

ALTER TABLE source_gate_events ADD COLUMN IF NOT EXISTS approved_by TEXT;
ALTER TABLE source_gate_events ADD COLUMN IF NOT EXISTS routes TEXT[];

DO $$
DECLARE c TEXT;
BEGIN
    FOR c IN SELECT conname FROM pg_constraint
             WHERE conrelid = 'source_gate_events'::regclass AND contype = 'c'
               AND pg_get_constraintdef(oid) LIKE '%seeded_active%' LOOP
        EXECUTE format('ALTER TABLE source_gate_events DROP CONSTRAINT %I', c);
    END LOOP;
END $$;
ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_event_check
    CHECK (event IN ('enabled', 'disabled', 'seeded_active', 'gate_opened', 'gate_closed', 'refusal_reset'));

ALTER TABLE source_gate_events DROP CONSTRAINT IF EXISTS source_gate_events_named_approval;
ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_named_approval
    CHECK (event NOT IN ('enabled', 'disabled', 'refusal_reset')
           OR (approved_by IS NOT NULL AND approved_by ~ '^\S.*\S \d{4}-\d{2}-\d{2}$' AND actor = approved_by)) NOT VALID;

CREATE TABLE IF NOT EXISTS correlation_gate_events (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    status       TEXT NOT NULL,
    enabled      BOOLEAN NOT NULL,
    reason       TEXT NOT NULL,
    dpia_ref     TEXT,
    actor        TEXT NOT NULL,
    approved_by  TEXT,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_correlation_gate_events_time ON correlation_gate_events (occurred_at DESC);

DROP TRIGGER IF EXISTS correlation_gate_events_append_only ON correlation_gate_events;
CREATE TRIGGER correlation_gate_events_append_only BEFORE UPDATE OR DELETE ON correlation_gate_events
    FOR EACH ROW EXECUTE FUNCTION forbid_append_only_change();
