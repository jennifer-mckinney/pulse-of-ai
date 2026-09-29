-- Migration 010: record the exact bias methodology used for each assessment.
--
-- ADDITIVE and IDEMPOTENT: one nullable column plus an index, both guarded by
-- IF NOT EXISTS. From this migration on, src/pipeline/bias.js writes the
-- biasMvId it ran with on every row, so receipts (/api/audit) and the alert
-- history (/api/bias/history) render each assessment with the methodology
-- version that PRODUCED it (PR #8 review).
--
-- NO BACKFILL. Rows written before this migration keep NULL. Their version
-- is resolved at READ time from methodology_versions.effective_from and is
-- served as lineage 'inferred' (src/config/bias-lineage.js). Stamping every
-- old row with today's newest version would permanently record a lineage
-- that may be false, and bias_assessments is an audit record whose rows are
-- never rewritten. Methodology rows are not touched either.

ALTER TABLE bias_assessments
    ADD COLUMN IF NOT EXISTS methodology_version_id UUID
    REFERENCES methodology_versions(id);

CREATE INDEX IF NOT EXISTS idx_bias_methodology
    ON bias_assessments(methodology_version_id);
