-- Migration 001: Core Schema
-- Establishes the foundational tables: source registry, immutable raw posts,
-- processing job tracking, and methodology versioning.
-- All inference decisions are linked back to a methodology_versions row.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Source registry: one row per data source (Reddit, arXiv, RSS feeds, etc.)
-- Non-secret config only (URLs, subreddit names) — API keys live in .env
CREATE TABLE data_sources (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL UNIQUE,           -- slug: 'reddit_machinelearning'
    display_name    TEXT NOT NULL,                  -- human-readable: 'Reddit r/MachineLearning'
    source_type     TEXT NOT NULL,                  -- 'reddit' | 'rss' | 'api' | 'scrape'
    category        TEXT NOT NULL,                  -- 'social' | 'news' | 'academic' | 'policy' | 'nonprofit' | 'developer' | 'blog'
    config          JSONB,                          -- non-secret: poll_interval_sec, url, subreddit, etc.
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sources_category ON data_sources(category);
CREATE INDEX idx_sources_active   ON data_sources(active) WHERE active = TRUE;

-- Immutable raw posts: INSERT only — never UPDATE or DELETE the data row.
-- PII is stripped at ingest time (no usernames, handles, author IDs).
-- content_hash enables deduplication without storing content twice.
CREATE TABLE raw_posts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id       UUID NOT NULL REFERENCES data_sources(id),
    external_id     TEXT NOT NULL,                  -- platform's own post/comment ID
    content         TEXT NOT NULL,                  -- sanitized text, PII stripped
    raw_payload     JSONB,                          -- full API response with author fields removed
    content_hash    TEXT NOT NULL,                  -- SHA-256(normalized content) — dedup key
    location        TEXT DEFAULT '',                -- city-level only (GDPR: max granularity)
    language        TEXT DEFAULT 'en',              -- ISO 639-1 language code
    collected_at    TIMESTAMPTZ DEFAULT NOW(),
    pseudo_user_id  UUID,                           -- FK added in migration 006; nullable
    UNIQUE(source_id, external_id)                  -- prevents duplicate ingestion per source
);

CREATE INDEX idx_raw_posts_source      ON raw_posts(source_id);
CREATE INDEX idx_raw_posts_collected   ON raw_posts(collected_at DESC);
CREATE INDEX idx_raw_posts_hash        ON raw_posts(content_hash);
CREATE INDEX idx_raw_posts_location    ON raw_posts(location) WHERE location != '';
CREATE INDEX idx_raw_posts_language    ON raw_posts(language);

-- Processing jobs: one row per collection run (cron, api trigger, or manual)
CREATE TABLE processing_jobs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    triggered_by    TEXT NOT NULL,                  -- 'cron' | 'api' | 'startup' | 'manual'
    status          TEXT NOT NULL DEFAULT 'running',-- 'running' | 'completed' | 'failed'
    posts_collected INTEGER DEFAULT 0,
    posts_processed INTEGER DEFAULT 0,
    sources_queried INTEGER DEFAULT 0,
    error_details   TEXT,                           -- only populated on failure
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_jobs_status  ON processing_jobs(status);
CREATE INDEX idx_jobs_started ON processing_jobs(started_at DESC);

-- Methodology versions: every algorithm configuration is registered here
-- BEFORE it processes any data. Plain-English justification required.
-- methodology_versions.id is the foreign key into decision_audit_log.
CREATE TABLE methodology_versions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    component       TEXT NOT NULL,                  -- 'sentiment' | 'relevance' | 'discourse' | 'demographic'
    version         TEXT NOT NULL,
    model_name      TEXT NOT NULL,                  -- exact model identifier (for reproducibility)
    config          JSONB NOT NULL,                 -- thresholds, parameters, accuracy_target
    justification   TEXT NOT NULL,                  -- plain English, defensible to regulators
    effective_from  TIMESTAMPTZ DEFAULT NOW(),
    deprecated_at   TIMESTAMPTZ,                    -- set when replaced by a newer version
    UNIQUE(component, version)
);
