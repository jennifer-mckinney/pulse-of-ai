-- Migration 009: Methodology registration (P0-2)
-- Registers the methodology rows the audit receipt READS at request time —
-- bias@1.1.0 (fairness-layer names, citations, layer_notes, planned layers,
-- layer_order), ingest@1.0.0 (synthetic Ingestion step) and
-- audit_narration@1.1.0 (the receipt template version) — so a database
-- that is only MIGRATED, never re-seeded (CI test DB, a deploy that runs
-- `npm run migrate` alone), serves the same receipt as a seeded one.
--
-- Mirrors src/config/methodology-registry.js (the shared source scripts/
-- seed.js inserts from) FIELD FOR FIELD; tests/unit/pure/
-- methodologyRegistry.test.js parses this file and fails on any drift.
-- config and justification are dollar-quoted ($cfg$ / $just$) so the JSON
-- and prose are byte-identical to the registry values.
--
-- Idempotent: ON CONFLICT (component, version) DO NOTHING — the same rule
-- seed.js uses, so re-running this (or seeding before/after it) never
-- duplicates or mutates a registered row. Released rows are never edited in
-- place; a change ships as a new version row and a new migration.

-- bias@1.1.0
INSERT INTO methodology_versions (component, version, model_name, config, justification)
VALUES (
    'bias',
    '1.1.0',
    'pulse-bias-monitor-v1',
    $cfg${
    "location_concentration_max": 0.35,
    "platform_parity_max_diff": 0.3,
    "negative_dominance_max": 0.6,
    "layer_names": {
        "location_concentration": "Location concentration",
        "platform_sentiment_parity": "Demographic parity",
        "negative_dominance": "Negative dominance"
    },
    "layer_notes": {
        "platform_sentiment_parity": "parity measured across source categories (platform), not user demographics"
    },
    "citations": {
        "location_concentration": "Suresh & Guttag (2021)",
        "platform_sentiment_parity": "Barocas & Selbst (2016)",
        "negative_dominance": "Suresh & Guttag (2021)"
    },
    "planned_layers": [
        {
            "id": "equalized_odds",
            "name": "Equalized odds",
            "citation": "Hardt et al. (2016)",
            "note": "Phase 3 — not yet enforced"
        },
        {
            "id": "counterfactual_fairness",
            "name": "Counterfactual fairness",
            "citation": "Kusner et al. (2017)",
            "note": "Phase 3 — not yet enforced"
        }
    ],
    "layer_order": [
        "platform_sentiment_parity",
        "equalized_odds",
        "counterfactual_fairness"
    ],
    "legal_basis": "EU AI Act Article 13 - Transparency and provision of information"
}$cfg$::jsonb,
    $just$Three fairness checks run automatically after every processing job: platform sentiment parity (the demographic-parity outcome gap across source categories — Barocas & Selbst 2016), location concentration (representation bias — Suresh & Guttag 2021), and negative dominance (selection bias toward controversy). Thresholds live in this config so they are auditable, versioned, and adjustable without a code change (AI Act §13). Equalized odds and counterfactual fairness are declared planned layers and reported as not-yet-enforced rather than omitted; the receipt presents the three literature-named fairness layers first, then the additional checks. The Demographic parity layer is annotated as parity measured across source categories (platform), not user demographics. Vocabulary: migration 008 folded legacy bias_assessments rows stored under the synonym demographic_parity onto the pipeline vocabulary platform_sentiment_parity (values, thresholds and violation flags untouched); any future vocabulary drift is resolved by read-time synonym mapping (src/config/bias-vocabulary.js), never by rewriting stored audit rows.$just$
)
ON CONFLICT (component, version) DO NOTHING;

-- ingest@1.0.0
INSERT INTO methodology_versions (component, version, model_name, config, justification)
VALUES (
    'ingest',
    '1.0.0',
    'pulse-ingest-v1',
    $cfg${
    "pii_fields_removed": [
        "author",
        "author_fullname",
        "username",
        "user",
        "email"
    ],
    "location_granularity": "city",
    "dedup_strategy": "sha256-content-hash",
    "legal_basis": "GDPR Article 6(1)(f) - Legitimate Interest"
}$cfg$::jsonb,
    $just$Public-source collection with PII minimisation at ingest: author identifiers are stripped from the raw payload before any database write, location is retained at city granularity only (GDPR data-minimisation), and content is SHA-256 hashed to give every downstream inference an immutable, non-reversible join key. Processing rests on legitimate interest (GDPR Art. 6(1)(f)) — aggregate discourse measurement over public posts with no profiling of identifiable individuals.$just$
)
ON CONFLICT (component, version) DO NOTHING;

-- audit_narration@1.1.0
INSERT INTO methodology_versions (component, version, model_name, config, justification)
VALUES (
    'audit_narration',
    '1.1.0',
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
    "reproduce_command": "npm run replay -- --post {post_id}"
}$cfg$::jsonb,
    $just$The audit endpoint serves four audience representations (public, journalist, regulator, researcher) of every decision step. The wording is part of the auditable surface, so the template set is registered here and version-bumped on any change — the API reports which narration version rendered a receipt. Templates only restate stored facts (cue words, scores, thresholds, versions); they never invent per-post content. 1.1.0 makes the researcher reproduce command real: npm run replay -- --post {post_id} re-runs the deterministic pipeline scorers over the stored content, diffs against the stored outputs, and reports PASS, DIVERGENCE or NOT RE-RUNNABLE per stage.$just$
)
ON CONFLICT (component, version) DO NOTHING;
