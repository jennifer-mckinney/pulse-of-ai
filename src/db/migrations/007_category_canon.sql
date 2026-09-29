-- Migration 007: Canonical category taxonomy conformance
-- The canonical source-category taxonomy is the frontend prototype's 8-set
-- (see public/js/config/design.config.js CATEGORIES / src/config/categories.js):
--   social, news, academic, policy, nonprofit, developer, forums, blog
-- The pre-canon 'tech' slug is retired: any residual tech-categorized data
-- maps to 'developer' (the semantically closest canonical category — the
-- frontend applies the same residual mapping in globe.js).
-- Additive data update only — no schema change, idempotent by construction
-- (re-running the UPDATEs matches zero rows). The seeded top-50 registry
-- never used 'tech'; this covers ad-hoc / imported rows only.

-- data_sources.category is the taxonomy column of record (raw_posts join it)
UPDATE data_sources SET category = 'developer' WHERE category = 'tech';

-- bias_assessments group_value carries category values for the platform
-- (source-category) parity layer — keep stored assessments on canon slugs
UPDATE bias_assessments
SET group_value = 'developer'
WHERE group_field = 'platform' AND group_value = 'tech';
