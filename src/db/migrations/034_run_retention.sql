-- Migration 034: retention for the operational run tables (PR #10 review
-- P10-9, G10-12).
--
-- source_run_daily — one row per (day, source): the counts of the
-- source_runs rows that the maintenance job (src/collectors/run-retention.js)
-- rolls up once they are older than SOURCE_RUNS_RAW_DAYS (30). The raw rows
-- are then removed; the daily rollup is kept. Additive.
--
-- Monthly partitioning of source_runs was considered: converting an
-- existing table to a partitioned one is not additive (it needs a table
-- rewrite and a swap), so it is not done here; the 30-day raw window with
-- daily rollups bounds the table instead (ADR 0001, P10-9).

CREATE TABLE IF NOT EXISTS source_run_daily (
    day            DATE NOT NULL,
    source_id      UUID NOT NULL REFERENCES data_sources(id),
    runs           INTEGER NOT NULL DEFAULT 0,
    ok_runs        INTEGER NOT NULL DEFAULT 0,
    error_runs     INTEGER NOT NULL DEFAULT 0,
    skipped_runs   INTEGER NOT NULL DEFAULT 0,
    items_fetched  BIGINT  NOT NULL DEFAULT 0,
    posts_new      BIGINT  NOT NULL DEFAULT 0,
    requests       BIGINT  NOT NULL DEFAULT 0,
    error_kinds    JSONB   NOT NULL DEFAULT '{}'::jsonb,
    rolled_up_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, source_id)
);
CREATE INDEX IF NOT EXISTS idx_source_runs_started ON source_runs (started_at);
CREATE INDEX IF NOT EXISTS idx_processing_jobs_status_started ON processing_jobs (status, started_at);
