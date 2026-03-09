-- Migration 003: Bias & Ethics Tables
-- Bias assessments run automatically at the end of every processing job.
-- All violations are recorded and surfaced via GET /api/health and GET /api/bias/latest.
-- alert_events drives the traffic light status indicator on the dashboard.

CREATE TABLE bias_assessments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id          UUID NOT NULL REFERENCES processing_jobs(id),
    assessment_type TEXT NOT NULL,                  -- 'demographic_parity' | 'equalized_odds' | 'location_concentration' | 'source_concentration' | 'negative_dominance'
    group_field     TEXT NOT NULL,                  -- 'location' | 'platform' | 'source_category' | 'language'
    group_value     TEXT NOT NULL,                  -- e.g., 'San Francisco' | 'reddit' | 'social'
    metric_name     TEXT NOT NULL,                  -- e.g., 'share_of_total_posts' | 'sentiment_parity_diff'
    metric_value    REAL NOT NULL,
    threshold       REAL NOT NULL,                  -- from methodology_versions.config
    is_violation    BOOLEAN NOT NULL DEFAULT FALSE,
    severity        TEXT,                           -- 'warning' | 'critical' (null if not a violation)
    evidence        JSONB,                          -- supporting counts and context for the assessment
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bias_job        ON bias_assessments(job_id);
CREATE INDEX idx_bias_type       ON bias_assessments(assessment_type);
-- Partial index: fast lookup of violations only — most common query pattern for health endpoint
CREATE INDEX idx_bias_violations ON bias_assessments(created_at DESC)
    WHERE is_violation = TRUE;

-- Alert events: written when a bias violation or system health issue is detected.
-- Acknowledged/resolved by operators; unresolved alerts appear in GET /api/health.
CREATE TABLE alert_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_type      TEXT NOT NULL,                  -- 'bias_violation' | 'data_quality' | 'model_health' | 'source_offline'
    severity        TEXT NOT NULL,                  -- 'info' | 'warning' | 'critical'
    source_table    TEXT,                           -- 'bias_assessments' | 'processing_jobs'
    source_id       UUID,                           -- FK reference (not enforced — cross-table)
    details         JSONB,                          -- context for dashboard display
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Partial index: only unresolved alerts matter for the health endpoint
CREATE INDEX idx_alerts_unresolved ON alert_events(severity, created_at DESC)
    WHERE resolved_at IS NULL;
CREATE INDEX idx_alerts_type       ON alert_events(alert_type);
