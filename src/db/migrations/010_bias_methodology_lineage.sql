-- Migration 010: retain the exact bias methodology used for each assessment.
-- Existing rows may predate lineage tracking and remain readable via the
-- vocabulary fallbacks; all pipeline-created rows record this ID.

ALTER TABLE bias_assessments
    ADD COLUMN IF NOT EXISTS methodology_version_id UUID
    REFERENCES methodology_versions(id);

UPDATE bias_assessments
SET methodology_version_id = (
    SELECT id
    FROM methodology_versions
    WHERE component = 'bias' AND deprecated_at IS NULL
    ORDER BY effective_from DESC
    LIMIT 1
)
WHERE methodology_version_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_bias_methodology
    ON bias_assessments(methodology_version_id);
