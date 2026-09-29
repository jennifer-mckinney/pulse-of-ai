-- Migration 012: real source collection (ADR 0001).
--
-- Additive only — no column dropped, no row deleted:
--   1. data_sources.retired_at / retired_note: the old 50-row seed list is
--      replaced by the 51-source registry of record
--      (src/config/source-registry.js). Old rows are RETIRED, never deleted,
--      so every post, score and audit row keeps its source.
--   2. source_collection_state: one row per source — cursor, HTTP validators
--      (ETag / Last-Modified), last attempt / success / error, last item
--      count. The atomic "claim" on last_attempt_at is the cross-process
--      cadence guard (worker schedule and POST /api/refresh never run the
--      same source inside its poll interval).
--   3. source_runs: one row per collection run of a source — the outcome
--      record behind the health drawer's per-source status.
--
-- Demo feeds (source_type = 'demo', scripts/populate.js) are never touched.
-- Idempotent: IF NOT EXISTS everywhere; the retirement UPDATE only matches
-- rows not yet retired.

ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS retired_at   TIMESTAMPTZ;
ALTER TABLE data_sources ADD COLUMN IF NOT EXISTS retired_note TEXT;

CREATE TABLE IF NOT EXISTS source_collection_state (
    source_id            UUID PRIMARY KEY REFERENCES data_sources(id),
    cursor               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per-route since-ids / timestamps
    http_cache           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- url → { etag, last_modified }
    last_attempt_at      TIMESTAMPTZ,
    last_success_at      TIMESTAMPTZ,
    last_item_count      INTEGER,
    last_new_posts       INTEGER,
    last_error           TEXT,
    last_error_at        TIMESTAMPTZ,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS source_runs (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id     UUID NOT NULL REFERENCES data_sources(id),
    job_id        UUID REFERENCES processing_jobs(id),
    gate_status   TEXT NOT NULL,              -- collecting | awaiting_* | blocked | disabled
    outcome       TEXT NOT NULL,              -- ok | error | skipped
    items_fetched INTEGER NOT NULL DEFAULT 0,
    posts_new     INTEGER NOT NULL DEFAULT 0,
    requests      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_source_runs_source ON source_runs(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_runs_job    ON source_runs(job_id);

-- Retire the pre-registry seed list (scripts/seed.js before ADR 0001). The
-- names are the exact 50 slugs that list inserted; none is a registry slug.
UPDATE data_sources
SET active       = FALSE,
    retired_at   = NOW(),
    retired_note = 'Retired 2026-09-29 by migration 012: replaced by the 51-source registry of record '
                || '(src/config/source-registry.js, ADR 0001). Posts and audit history are kept.'
WHERE retired_at IS NULL
  AND source_type <> 'demo'
  AND name IN (
    'reddit_artificial', 'reddit_machinelearning', 'reddit_aiethics', 'mastodon_social', 'bluesky_ai',
    'hackernews_ai', 'twitter_x_ai', 'linkedin_ai', 'techcrunch_ai', 'wired_ai', 'mit_tech_review',
    'ars_technica_ai', 'the_verge_ai', 'venturebeat_ai', 'ieee_spectrum', 'nature_news_ai',
    'science_magazine', 'reuters_technology', 'arxiv_cs_ai', 'semantic_scholar', 'acm_dl',
    'openreview_neurips', 'pubmed_ai', 'ssrn_ai', 'eff_ai', 'ai_now_institute', 'rand_ai',
    'brookings_ai', 'center_ai_safety', 'eu_ai_office', 'nist_ai', 'georgetown_cset',
    'future_of_life', 'partnership_on_ai', 'mozilla_ai', 'openmind_ai', 'algorithm_watch',
    'access_now', 'ai4people', 'github_discussions_ai', 'stackoverflow_ai', 'huggingface_community',
    'papers_with_code', 'kaggle_forums', 'fastai_forums', 'lesswrong', 'alignment_forum',
    'substack_ai', 'medium_ai', 'stratechery'
  );
