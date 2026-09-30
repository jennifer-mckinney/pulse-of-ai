-- Migration 050: the external watchdog (PR #22 principal #12, Jennifer's
-- decision "watchdog + dashboard + email").
--
-- Every other alert is evaluated INSIDE the worker, so a dead worker used to
-- stop all alerting. The watchdog (scripts/watchdog.js, compose service
-- `watchdog`) runs in its own container, polls GET /api/health and records
-- what it finds here:
--
-- 1. uq_alerts_open_watchdog — at most ONE open alert per watchdog condition
--    (alert_type 'watchdog_<condition>', source_table 'watchdog'), enforced by
--    the database: the watchdog inserts with ON CONFLICT DO NOTHING and closes
--    a cleared condition with an audited alert_resolutions record, like the
--    per-source alerts of migration 038.
-- 2. watchdog_state — one row, overwritten by every poll: when the watchdog
--    last polled, and whether e-mail alerting is configured. /api/health
--    reports it ("email alerting not configured" when SMTP is unset); the web
--    process itself never holds the SMTP settings.
-- 3. watchdog_notifications — append-only log of every e-mail decision (sent,
--    failed, rate-limited, not configured), one row per attempt. On restart
--    the watchdog re-sends an "opened" e-mail only for an open alert that has
--    no delivered or deliberately-skipped notification.
-- Idempotent.

CREATE UNIQUE INDEX IF NOT EXISTS uq_alerts_open_watchdog
    ON alert_events (alert_type)
    WHERE resolved_at IS NULL AND source_table = 'watchdog';

CREATE TABLE IF NOT EXISTS watchdog_state (
    id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    started_at          TIMESTAMPTZ NOT NULL,
    last_poll_at        TIMESTAMPTZ NOT NULL,
    poll_interval_s     INTEGER NOT NULL CHECK (poll_interval_s > 0),
    health_reachable    BOOLEAN NOT NULL,
    open_conditions     JSONB NOT NULL DEFAULT '[]'::jsonb,
    email_configured    BOOLEAN NOT NULL,
    email_status        TEXT NOT NULL,
    last_email_at       TIMESTAMPTZ,
    last_email_error    TEXT,
    config_errors       JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS watchdog_notifications (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_id     UUID REFERENCES alert_events(id),
    condition    TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('opened', 'cleared')),
    outcome      TEXT NOT NULL CHECK (outcome IN ('sent', 'failed', 'rate_limited', 'not_configured')),
    recipients   INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_watchdog_notifications_alert ON watchdog_notifications (alert_id, kind);

-- Append-only, like the other audit tables (migration 036).
DROP TRIGGER IF EXISTS watchdog_notifications_append_only ON watchdog_notifications;
CREATE TRIGGER watchdog_notifications_append_only BEFORE UPDATE OR DELETE ON watchdog_notifications
    FOR EACH ROW EXECUTE FUNCTION forbid_append_only_change();
