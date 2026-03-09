-- Migration 002: Audit Tables
-- Every inference (sentiment, relevance, discourse, demographics) is recorded here.
-- These tables are INSERT-only — the immutable decision trail.
-- decision_audit_log is the source of truth for GET /api/audit/:post_id.

-- Master decision audit log: one row per inference per post
CREATE TABLE decision_audit_log (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id             UUID NOT NULL REFERENCES raw_posts(id),
    job_id                  UUID NOT NULL REFERENCES processing_jobs(id),
    methodology_version_id  UUID NOT NULL REFERENCES methodology_versions(id),
    decision_type           TEXT NOT NULL,          -- 'sentiment' | 'relevance' | 'discourse' | 'topic' | 'demographic'
    model_name              TEXT NOT NULL,          -- snapshot of methodology_versions.model_name at time of inference
    input_hash              TEXT NOT NULL,          -- SHA-256(input text) — traceable but not reversible
    output                  JSONB NOT NULL,         -- full scored output (no PII)
    confidence              REAL,                   -- 0.0–1.0; null if not applicable
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_post     ON decision_audit_log(raw_post_id);
CREATE INDEX idx_audit_job      ON decision_audit_log(job_id);
CREATE INDEX idx_audit_type     ON decision_audit_log(decision_type);
CREATE INDEX idx_audit_created  ON decision_audit_log(created_at DESC);
CREATE INDEX idx_audit_version  ON decision_audit_log(methodology_version_id);

-- Derived sentiment result — fast lookup for dashboard queries
-- Always linked to a decision_audit_log row for full traceability
CREATE TABLE sentiment_results (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id         UUID NOT NULL REFERENCES raw_posts(id),
    audit_id            UUID NOT NULL REFERENCES decision_audit_log(id),
    score               REAL NOT NULL,              -- AFINN raw integer sum
    comparative         REAL NOT NULL,              -- score / token_count (length-normalized)
    indicator           TEXT NOT NULL,              -- 'positive' | 'neutral' | 'negative'
    positive_words      TEXT[],
    negative_words      TEXT[],
    token_count         INTEGER,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sentiment_post       ON sentiment_results(raw_post_id);
CREATE INDEX idx_sentiment_indicator  ON sentiment_results(indicator);
CREATE INDEX idx_sentiment_created    ON sentiment_results(created_at DESC);

-- Derived relevance result — AI relevance score for filtering non-AI content
CREATE TABLE relevance_results (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id         UUID NOT NULL REFERENCES raw_posts(id),
    audit_id            UUID NOT NULL REFERENCES decision_audit_log(id),
    score               REAL NOT NULL,              -- 0.0–1.0
    matched_keywords    TEXT[],                     -- which taxonomy terms matched
    is_relevant         BOOLEAN NOT NULL,           -- score >= threshold
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_relevance_post       ON relevance_results(raw_post_id);
CREATE INDEX idx_relevance_score      ON relevance_results(score DESC);
CREATE INDEX idx_relevance_relevant   ON relevance_results(is_relevant) WHERE is_relevant = TRUE;

-- Derived discourse quality result — DQI scores per post
CREATE TABLE discourse_results (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id         UUID NOT NULL REFERENCES raw_posts(id),
    audit_id            UUID NOT NULL REFERENCES decision_audit_log(id),
    dqi_total           REAL NOT NULL,              -- 0.0–1.0 overall DQI score
    dimensions          JSONB NOT NULL,             -- per-dimension breakdown
    argument_cluster_id TEXT,                       -- semantic cluster UUID (Phase D)
    novelty_score       REAL,                       -- 0.0–1.0 (Phase D — requires embeddings)
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_discourse_post    ON discourse_results(raw_post_id);
CREATE INDEX idx_discourse_score   ON discourse_results(dqi_total DESC);

-- GDPR data lifecycle tracking: every action on data is recorded
CREATE TABLE data_retention_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id     UUID,                           -- nullable after erasure (FK not enforced — intentional)
    action          TEXT NOT NULL,                  -- 'collected' | 'anonymized' | 'compacted' | 'deleted' | 'erasure_requested'
    reason          TEXT,
    legal_basis     TEXT,                           -- e.g., 'GDPR Article 6(1)(f) - Legitimate Interest'
    performed_at    TIMESTAMPTZ DEFAULT NOW(),
    performed_by    TEXT DEFAULT 'system'
);

CREATE INDEX idx_retention_post   ON data_retention_log(raw_post_id) WHERE raw_post_id IS NOT NULL;
CREATE INDEX idx_retention_action ON data_retention_log(action);
