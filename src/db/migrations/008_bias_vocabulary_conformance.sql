-- Migration 008: Bias assessment-type vocabulary conformance
-- The pipeline's vocabulary of record for the demographic-parity check is
-- 'platform_sentiment_parity' (src/pipeline/bias.js — the outcome-rate gap
-- across source categories, Barocas & Selbst 2016). Ad-hoc / legacy rows
-- stored under the synonym 'demographic_parity' are folded onto the
-- pipeline vocabulary so the versioned bias config (layer_names /
-- citations / layer_order) resolves them: the audit receipt then serves
-- their REAL stored value + τ under the prototype's 'Demographic parity'
-- layer name instead of dropping to an unconfigured title-case fallback.
-- Additive data update only — values, thresholds and violation flags are
-- untouched; idempotent by construction (re-running matches zero rows).

UPDATE bias_assessments
SET assessment_type = 'platform_sentiment_parity'
WHERE assessment_type = 'demographic_parity';
