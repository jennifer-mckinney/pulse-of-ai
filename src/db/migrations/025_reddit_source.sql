-- Migration 025: Reddit as source #52 (workbook Rev. 4, ADR 0001 ruling 8).
--
-- Two columns and three tables, all additive and idempotent. No existing
-- row is changed;
-- the data_sources row itself is upserted by scripts/seed.js from the
-- registry (src/config/source-registry.js), like every other source.
--
-- reddit_subreddit_rankings — one row per subreddit-selection snapshot
--   (Jennifer, 2026-09-29: "the top 7 subreddits mentioning AI", ranked by
--   "Most subscribers, among those mentioning AI"). The daily discovery job
--   (src/collectors/reddit/discovery.js) records the rolling 7-day window,
--   the per-subreddit AI-post counts, subscribers, the exclusions with their
--   reasons, and whether the snapshot replaced the selection (applied). The
--   latest applied snapshot IS the selection; before the first one the
--   documented provisional list is used (src/collectors/reddit/selection.js).
--
-- reddit_api_budget — the single shared request budget (id = 1): Reddit's
--   100 queries per minute per client id, averaged over 10 minutes, counted
--   in 10-minute windows across every process (src/collectors/reddit/
--   budget.js), plus the last X-Ratelimit-* state Reddit reported.
--
-- reddit_maintenance — when the discovery (daily) and deletion re-check
--   (every 6 hours) jobs last started and completed, with an atomic claim so
--   one worker runs each (src/collectors/reddit/maintenance.js).
--
-- raw_posts.text_removed_at / text_removed_reason — set when a post's text
--   is blanked under platform terms (ADR 0001 ruling 9, Jennifer:
--   "Blank text, keep audit rows"): Reddit posts at 48 h or on upstream
--   deletion (src/collectors/retention.js). The row, its scores and its
--   audit trail stay; the receipt and replay read these columns.

ALTER TABLE raw_posts ADD COLUMN IF NOT EXISTS text_removed_at     TIMESTAMPTZ;
ALTER TABLE raw_posts ADD COLUMN IF NOT EXISTS text_removed_reason TEXT;

CREATE TABLE IF NOT EXISTS reddit_subreddit_rankings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ranked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_start    TIMESTAMPTZ NOT NULL,
    window_end      TIMESTAMPTZ NOT NULL,
    min_ai_posts    INTEGER NOT NULL CHECK (min_ai_posts >= 1),
    top_n           INTEGER NOT NULL CHECK (top_n >= 1),
    applied         BOOLEAN NOT NULL,
    selected        TEXT[] NOT NULL,
    ranking         JSONB NOT NULL,
    exclusions      JSONB NOT NULL,
    stats           JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reddit_rankings_ranked ON reddit_subreddit_rankings(ranked_at DESC);
CREATE INDEX IF NOT EXISTS idx_reddit_rankings_applied ON reddit_subreddit_rankings(ranked_at DESC) WHERE applied;

CREATE TABLE IF NOT EXISTS reddit_api_budget (
    id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    window_start        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used                INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
    blocked_until       TIMESTAMPTZ,
    upstream_remaining  REAL,
    upstream_reset_at   TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reddit_maintenance (
    job                 TEXT PRIMARY KEY CHECK (job IN ('discovery', 'recheck')),
    last_started_at     TIMESTAMPTZ,
    last_completed_at   TIMESTAMPTZ,
    last_outcome        TEXT,
    last_error_kind     TEXT,
    last_stats          JSONB,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
