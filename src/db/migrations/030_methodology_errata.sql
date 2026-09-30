-- Migration 030: an erratum for relevance@1.0.0 (PR #10 review P10-16).
--
-- The registered relevance@1.0.0 row does not describe the code that ran
-- (ADR 0001, methodology alignment). Released rows are never edited, so the
-- correction is a NEW row in a new table, methodology_errata, attached to
-- the row it corrects. relevance@1.0.0 itself is untouched. The INSERT
-- mirrors src/config/methodology-registry.js METHODOLOGY_ERRATA field for
-- field (tests/unit/pure/methodologyRegistry.test.js) and is a no-op when
-- the corrected row is not registered.

CREATE TABLE IF NOT EXISTS methodology_errata (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    methodology_version_id  UUID NOT NULL REFERENCES methodology_versions(id),
    erratum_key             TEXT NOT NULL UNIQUE,
    corrected_by            TEXT,
    erratum                 TEXT NOT NULL,
    recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO methodology_errata (methodology_version_id, erratum_key, corrected_by, erratum)
SELECT mv.id, 'relevance-1.0.0-config-mismatch', 'relevance@1.1.0', $err$The registered relevance@1.0.0 config does not describe the code that produced its decisions. It lists 18 keywords, 0.1 per match and an AI-relevance threshold of 0.99; the code that ran scored every post against the 20-keyword lexicon later registered as relevance@1.1.0 (case-insensitive substring match, score = unique matched keywords / 20, AI-relevant when at least one keyword matched). Read decisions recorded under 1.0.0 against relevance@1.1.0's config; `npm run replay` re-runs them with that rule. The 1.0.0 row is kept unedited as it was registered. Found by the replay tool (ADR 0001, methodology alignment); recorded 2026-09-29 (PR #10 review P10-16).$err$
FROM methodology_versions mv
WHERE mv.component = 'relevance' AND mv.version = '1.0.0'
ON CONFLICT (erratum_key) DO NOTHING;
