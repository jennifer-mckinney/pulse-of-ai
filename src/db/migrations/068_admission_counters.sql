-- Migration 068: admission rejection counters (relevance-accuracy Stage 0,
-- P1 / R1). Decision, Jennifer McKinney 2026-09-30, verbatim "Counters only
-- (Recommended)": the collector keeps COUNTS of why fetched items were
-- admitted or rejected — never their text, never their ids. Rejected items
-- are still not retained. src/collectors/admission-counters.js documents the
-- rules; src/collectors/base.js counts them; src/collectors/runner.js writes
-- them.
--
-- 1. source_runs.dropped_* — the collector's in-memory dropped counters
--    (invalid, old, out of scope, in-batch duplicate), summed over the
--    source's routes, per run. Like items_fetched they describe THAT run, so a
--    route retried after a store failure appears in both runs (the per-rule
--    admission_rule_hits counts, below, count it once). NULL on rows written before this migration
--    (not recorded), never a fake 0.
-- 2. source_run_daily.dropped_* — the same counts, rolled up with the run
--    after SOURCE_RUNS_RAW_DAYS (src/collectors/run-retention.js); spec §19
--    Tier 3 (kept permanently). NULL when no rolled-up run recorded them; a
--    day mixing recorded and unrecorded runs is a partial total (SUM skips NULL).
-- 3. admission_rule_hits — per UTC day, source, route, admission_filter
--    version and rule: admitted_count and rejected_count, upserted by the
--    collector. rule_id and route are CHECKed against closed vocabularies
--    (the same expressions as src/collectors/admission-counters.js RULE_ID_RE
--    and ROUTE_ID_RE), so no free text can be stored. The route CHECK is a
--    shape backstop only (the registry is code, not data): recordRuleHits
--    writes a route only if it is an exact registered route of the source. Retention:
--    ADMISSION_RULE_HITS_DAYS, default 400 days (expireRuleHits, the worker's
--    daily maintenance).
--
-- Additive and idempotent: columns and one table, IF NOT EXISTS everywhere;
-- no existing row is updated or deleted.

ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS dropped_invalid INTEGER CHECK (dropped_invalid >= 0);
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS dropped_old INTEGER CHECK (dropped_old >= 0);
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS dropped_out_of_scope INTEGER CHECK (dropped_out_of_scope >= 0);
ALTER TABLE source_runs ADD COLUMN IF NOT EXISTS dropped_duplicate INTEGER CHECK (dropped_duplicate >= 0);

ALTER TABLE source_run_daily ADD COLUMN IF NOT EXISTS dropped_invalid BIGINT CHECK (dropped_invalid >= 0);
ALTER TABLE source_run_daily ADD COLUMN IF NOT EXISTS dropped_old BIGINT CHECK (dropped_old >= 0);
ALTER TABLE source_run_daily ADD COLUMN IF NOT EXISTS dropped_out_of_scope BIGINT CHECK (dropped_out_of_scope >= 0);
ALTER TABLE source_run_daily ADD COLUMN IF NOT EXISTS dropped_duplicate BIGINT CHECK (dropped_duplicate >= 0);

CREATE TABLE IF NOT EXISTS admission_rule_hits (
    day             DATE NOT NULL,
    source_id       UUID NOT NULL REFERENCES data_sources(id),
    route           TEXT NOT NULL CHECK (route ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    admission_mv_id UUID NOT NULL REFERENCES methodology_versions(id),
    rule_id         TEXT NOT NULL CHECK (rule_id ~ '^(invalid|old|duplicate|no_pattern|any_pattern|pattern:[0-9]{2})$'),
    admitted_count  BIGINT NOT NULL DEFAULT 0 CHECK (admitted_count >= 0),
    rejected_count  BIGINT NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (day, source_id, route, admission_mv_id, rule_id)
);
-- The API reads the last 7 days (/api/sources, /api/health): the primary key
-- starts with day, so that is a range seek. This index serves per-source history.
CREATE INDEX IF NOT EXISTS idx_admission_rule_hits_source_day ON admission_rule_hits (source_id, day);

COMMENT ON TABLE admission_rule_hits IS
    'Counts only (no text, no ids): per UTC day, source, route, admission_filter version and rule, how many fetched items were admitted or rejected. Counted per evaluation (a re-served item counts again). Kept ADMISSION_RULE_HITS_DAYS (default 400) days. Migration 068; src/collectors/admission-counters.js.';
