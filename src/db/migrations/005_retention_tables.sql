-- Migration 005: Retention & Compaction Tables
-- Implements the 3-tier layered retention architecture:
--   Tier 1 (0–3 months):   Post-level detail (raw_posts, sentiment_results, etc.)
--   Tier 2 (3mo+):         Monthly aggregates (monthly_*_rollups)
--   Tier 3 (permanent):    Methodology, audit skeletons, compaction log
-- The compaction job (scripts/compact.js) moves Tier 1 → Tier 2 monthly.

-- Monthly topic-level rollups: the primary historical research interface
-- After compaction, raw_posts.content is nulled but these aggregates remain
CREATE TABLE monthly_topic_rollups (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rollup_month    DATE NOT NULL,                  -- first day of month (e.g., '2026-01-01')
    topic_label     TEXT NOT NULL,                  -- keyword cluster or BERTopic label (Phase D)
    source_category TEXT,                           -- null = all categories combined
    location        TEXT,                           -- null = global aggregate
    language        TEXT,                           -- null = all languages
    post_count      INTEGER NOT NULL,
    positive_count  INTEGER NOT NULL DEFAULT 0,
    neutral_count   INTEGER NOT NULL DEFAULT 0,
    negative_count  INTEGER NOT NULL DEFAULT 0,
    avg_comparative REAL,
    avg_dqi_score   REAL,                           -- null until Phase B discourse pipeline
    top_keywords    TEXT[],                         -- top 10 keywords from this cluster this month
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Expression-based unique index (COALESCE handles NULLs — not allowed in inline UNIQUE constraints)
CREATE UNIQUE INDEX idx_monthly_topic_rollups_uniq
    ON monthly_topic_rollups(
        rollup_month,
        topic_label,
        COALESCE(source_category, ''),
        COALESCE(location, ''),
        COALESCE(language, '')
    );

CREATE INDEX idx_rollup_month    ON monthly_topic_rollups(rollup_month DESC);
CREATE INDEX idx_rollup_topic    ON monthly_topic_rollups(topic_label);
CREATE INDEX idx_rollup_category ON monthly_topic_rollups(source_category) WHERE source_category IS NOT NULL;
CREATE INDEX idx_rollup_location ON monthly_topic_rollups(location) WHERE location IS NOT NULL;

-- Monthly source-level rollups: per-source aggregate for bias trend analysis
CREATE TABLE monthly_source_rollups (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rollup_month    DATE NOT NULL,
    source_id       UUID REFERENCES data_sources(id),
    source_category TEXT NOT NULL,
    post_count      INTEGER NOT NULL,
    positive_count  INTEGER NOT NULL DEFAULT 0,
    neutral_count   INTEGER NOT NULL DEFAULT 0,
    negative_count  INTEGER NOT NULL DEFAULT 0,
    avg_comparative REAL,
    avg_dqi_score   REAL,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(rollup_month, source_id)
);

CREATE INDEX idx_src_rollup_month  ON monthly_source_rollups(rollup_month DESC);
CREATE INDEX idx_src_rollup_source ON monthly_source_rollups(source_id);

-- Compaction audit log: records every Tier 1 → Tier 2 transition
-- Required for GDPR accountability and internal audit
CREATE TABLE compaction_log (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    compacted_month     DATE NOT NULL UNIQUE,       -- which month was compacted
    posts_compacted     INTEGER NOT NULL,
    rollups_created     INTEGER NOT NULL,
    embeddings_deleted  INTEGER NOT NULL DEFAULT 0,
    content_nulled      INTEGER NOT NULL DEFAULT 0,
    completed_at        TIMESTAMPTZ DEFAULT NOW()
);
