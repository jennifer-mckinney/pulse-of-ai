-- Migration 006: Cross-Platform User Correlation Tables
-- Implements privacy-preserving pseudonymous user profiles.
-- No usernames, handles, or platform IDs are ever stored.
-- Verb-noun IDs (e.g., 'running-tiger') are generated from behavioral signals
-- combined with a deployment-specific salt — not reversible.
-- Correlation confidence must be >= 0.85 (CORRELATION_MIN_CONFIDENCE) before assignment.

-- Pseudonymous user profiles: behavioral fingerprints, no PII
CREATE TABLE pseudonymous_users (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pseudo_id               TEXT NOT NULL UNIQUE,   -- verb-noun ID: 'running-tiger'
    style_cluster_id        TEXT,                   -- writing style embedding cluster (Phase D)
    topic_affinity          TEXT[],                 -- top 5 topic categories by engagement
    platform_count          INTEGER DEFAULT 1,      -- number of distinct platforms sighted on
    correlation_confidence  REAL NOT NULL,          -- overall confidence score (>= 0.85 to exist)
    first_sighted_at        TIMESTAMPTZ DEFAULT NOW(),
    last_sighted_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_pseudo_id      ON pseudonymous_users(pseudo_id);
CREATE INDEX idx_pseudo_cluster ON pseudonymous_users(style_cluster_id) WHERE style_cluster_id IS NOT NULL;
CREATE INDEX idx_pseudo_count   ON pseudonymous_users(platform_count DESC);

-- Sighting log: each time a correlated pseudonymous user appears on a new source
-- signal_hash: SHA-256(style_embedding_cluster + temporal_pattern + topic_affinity + salt)
-- Not reversible — verifiable (can check if a post matches) but not reconstructable
CREATE TABLE user_platform_sightings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pseudo_user_id  UUID NOT NULL REFERENCES pseudonymous_users(id),
    source_id       UUID NOT NULL REFERENCES data_sources(id),
    signal_hash     TEXT NOT NULL,                  -- SHA-256 of correlation signals (not reversible)
    confidence      REAL NOT NULL,
    sighted_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sightings_user   ON user_platform_sightings(pseudo_user_id);
CREATE INDEX idx_sightings_source ON user_platform_sightings(source_id);
CREATE INDEX idx_sightings_at     ON user_platform_sightings(sighted_at DESC);

-- Add cross-platform FK to raw_posts (nullable — unlinked posts have NULL)
ALTER TABLE raw_posts
    ADD CONSTRAINT fk_raw_posts_pseudo_user
    FOREIGN KEY (pseudo_user_id) REFERENCES pseudonymous_users(id);

CREATE INDEX idx_raw_posts_pseudo ON raw_posts(pseudo_user_id)
    WHERE pseudo_user_id IS NOT NULL;
