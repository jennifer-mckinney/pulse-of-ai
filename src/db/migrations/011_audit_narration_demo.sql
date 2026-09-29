-- Migration 011: register audit_narration@1.2.0 (demo ingestion wording).
--
-- src/config/audit-narration.js 1.2.0 gives the receipt's ingestion step a
-- DEMO branch: posts from demo feeds (data_sources.source_type = 'demo',
-- written by the standup's demo population, scripts/populate.js) are
-- described as fictional demo content generated for this installation, not
-- as "came from a public source". The wording is part of the auditable
-- surface, so the new template version is registered here.
--
-- Why a new migration and not an edit of 009: 009 is released and already
-- applied to existing databases; editing it in place would never reach them
-- and would change what "009" means. Existing methodology rows are never
-- edited (audit_narration@1.1.0 keeps its row and its effective_from).
--
-- Mirrors the audit_narration@1.2.0 entry of src/config/methodology-registry.js
-- FIELD FOR FIELD (tests/unit/pure/methodologyRegistry.test.js parses this
-- file). effective_from = clock_timestamp(), not NOW(): scripts/migrate.js
-- applies every pending migration in ONE transaction, where NOW() would tie
-- with 009's row on a fresh database and make "latest version" ambiguous.
-- Idempotent: ON CONFLICT (component, version) DO NOTHING.

-- audit_narration@1.2.0
INSERT INTO methodology_versions (component, version, model_name, config, justification, effective_from)
VALUES (
    'audit_narration',
    '1.2.0',
    'pulse-narration-templates-v1',
    $cfg${
    "audiences": [
        "public",
        "plain",
        "config",
        "researcher"
    ],
    "renderer": "src/config/audit-narration.js",
    "rendering": "read-time deterministic templates over stored decision_audit_log output + methodology config; no per-post prose is generated or persisted",
    "reproduce_command": "npm run replay -- --post {post_id}",
    "ingest_branches": [
        "live_source",
        "demo_feed"
    ],
    "demo_source_type": "demo"
}$cfg$::jsonb,
    $just$The audit endpoint serves four audience representations (public, journalist, regulator, researcher) of every decision step. The wording is part of the auditable surface, so the template set is registered here and version-bumped on any change — the API reports which narration version rendered a receipt. Templates only restate stored facts (cue words, scores, thresholds, versions); they never invent per-post content. 1.2.0 adds a demo branch to the ingestion step: a post whose source is a demo feed (data_sources.source_type = demo, written by the standup demo population) is described as fictional demo content generated for this installation instead of as collected from a public source, so demo data is never presented as real discourse. The wording for real sources and every inference step is unchanged from 1.1.0, including the real reproduce command npm run replay -- --post {post_id}.$just$,
    clock_timestamp()
)
ON CONFLICT (component, version) DO NOTHING;
