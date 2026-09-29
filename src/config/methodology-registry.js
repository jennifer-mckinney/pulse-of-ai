// src/config/methodology-registry.js
// THE single source of truth for the registered methodology_versions rows.
//
// Consumers:
//   - scripts/seed.js inserts every row (ON CONFLICT (component, version)
//     DO NOTHING) — fresh or re-seeded databases;
//   - src/db/migrations/009_methodology_registration.sql inserts the
//     bias / ingest / audit_narration rows the same way, so a database that
//     is only MIGRATED (never re-seeded) still serves them;
//   - src/db/migrations/011_audit_narration_demo.sql inserts
//     audit_narration@1.2.0 (009 is released, so later versions ship as
//     new migrations);
//   - src/db/migrations/012_embedding_methodology.sql inserts embedding@1.0.0
//     (the pinned embedding model revision, P9-5);
//   - tests/integration/helpers.js registers the real bias/ingest rows.
// A component may list several versions (history is kept); the renderer's
// current version is the LAST entry for its component.
// tests/unit/pure/methodologyRegistry.test.js asserts 009 / 011 and this module
// agree field for field (component, version, model_name, config,
// justification). Any change here therefore needs a matching migration.
//
// Versioning convention: a released row is never edited in place — a config
// or wording change ships as a NEW version row (latest effective_from wins).
// Plain-English justification required for every row.

'use strict';

const METHODOLOGY_VERSIONS = [
    {
        component: 'sentiment',
        version: '1.0.0',
        model_name: 'afinn-sentiment-npm-v5.0.2',
        config: {
            positive_threshold: 0.05,
            negative_threshold: -0.05,
            accuracy_target: 0.99,
            accuracy_note: 'Phase 1 baseline — validates audit pattern. RoBERTa v2.0.0 targets 99% on benchmark.',
        },
        justification: 'AFINN-165 English word list (Nielsen 2011). Comparative score = raw_score / token_count (normalizes for post length). Thresholds ±0.05 separate meaningful sentiment from noise, derived from distribution analysis of AI discourse corpus (pulse-of-ai-evidence-based-thresholds.pdf §3). Phase 1 establishes the audit trail pattern; Phase 2 upgrades to RoBERTa for the 99% accuracy target.',
    },
    {
        component: 'relevance',
        version: '1.0.0',
        model_name: 'keyword-relevance-v1.0',
        config: {
            keywords: ['artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'chatgpt', 'gpt', 'llm', 'ai', 'automation', 'algorithm', 'robot', 'autonomous', 'computer vision', 'natural language processing', 'generative ai', 'openai', 'anthropic', 'foundation model'],
            score_per_match: 0.1,
            max_score: 1.0,
            ai_relevance_threshold: 0.99,
        },
        justification: 'Domain keyword taxonomy from AI academic literature and conference proceedings. Each matched keyword contributes 0.1 to relevance score, capped at 1.0. Threshold 0.99 ensures near-perfect AI-relevance filtering. Phase 2 upgrades to embedding-based hybrid scoring for improved recall on implicit AI discourse.',
    },
    {
        component: 'discourse',
        version: '1.0.0-DQI',
        model_name: 'deliberative-quality-index-v1.0',
        config: {
            dimensions: {
                participation:          { weight: 0.15 },
                justification_level:    { weight: 0.30 },
                justification_content:  { weight: 0.15 },
                counterargument_respect: { weight: 0.20 },
                constructiveness:       { weight: 0.10 },
                respect_for_groups:     { weight: 0.10 },
            },
            source_category_weights: {
                academic: 1.5, policy: 1.3, news: 1.2, developer: 1.1, nonprofit: 1.0, blog: 0.9, social: 0.8,
            },
            accuracy_target: 0.99,
            novelty_cosine_threshold: 0.4,
            echo_chamber_cosine_threshold: 0.15,
        },
        justification: 'Deliberative Quality Index (DQI) — Steenbergen et al. (2003), operationalizing Habermas deliberative democracy theory. Applied to AI discourse with four improvements: (1) semantic argument deduplication via embeddings (cosine > 0.4 = novel), (2) echo chamber detection via cross-platform spread, (3) source authority weighting by category credibility, (4) NLP claim-evidence linkage detection. See TECHNICAL_SPEC.md §18.',
    },
    {
        component: 'bias',
        // 1.1.0: presentation config change (prototype layer naming +
        // layer_order) — versioned methodology convention: config changes
        // ship as a NEW version row, never an in-place mutation, so already-
        // seeded databases pick up the change on re-seed (latest
        // effective_from wins) and old receipts stay reproducible.
        version: '1.1.0',
        model_name: 'pulse-bias-monitor-v1',
        config: {
            // Thresholds read by src/pipeline/bias.js (DB-driven, no code deploy to change)
            location_concentration_max: 0.35,
            platform_parity_max_diff:   0.30,
            negative_dominance_max:     0.60,
            // Frontend display names for stored assessment_type values.
            // platform_sentiment_parity IS the demographic-parity check
            // (outcome-rate gap across source categories — Barocas & Selbst
            // 2016), so it carries the prototype's exact layer name and
            // serves REAL value + τ under it.
            layer_names: {
                location_concentration:    'Location concentration',
                platform_sentiment_parity: 'Demographic parity',
                negative_dominance:        'Negative dominance',
            },
            // Methodology notes (P0-3) carried into each computed layer's
            // `note` and rendered in the audit drawer, so the receipt never
            // overstates what a check measures: the 'Demographic parity'
            // layer compares SOURCE CATEGORIES, not people.
            layer_notes: {
                platform_sentiment_parity: 'parity measured across source categories (platform), not user demographics',
            },
            // Literature/spec citations rendered next to each layer (audit
            // receipt fairness layers + bias alert history)
            citations: {
                location_concentration:    'Suresh & Guttag (2021)',
                platform_sentiment_parity: 'Barocas & Selbst (2016)',
                negative_dominance:        'Suresh & Guttag (2021)',
            },
            // Declared-but-not-yet-computed layers: surfaced as N/A on the
            // audit receipt so coverage claims stay honest (never fabricated
            // values — the prototype's own layer-3 pattern)
            planned_layers: [
                { id: 'equalized_odds',          name: 'Equalized odds',          citation: 'Hardt et al. (2016)',  note: 'Phase 3 — not yet enforced' },
                { id: 'counterfactual_fairness', name: 'Counterfactual fairness', citation: 'Kusner et al. (2017)', note: 'Phase 3 — not yet enforced' },
            ],
            // Presentation order (audit drawer): the prototype's three named
            // layers first — Demographic parity, Equalized odds,
            // Counterfactual fairness — then every additional real check
            // (location concentration, negative dominance) as extra rows.
            layer_order: [
                'platform_sentiment_parity',
                'equalized_odds',
                'counterfactual_fairness',
            ],
            legal_basis: 'EU AI Act Article 13 - Transparency and provision of information',
        },
        justification: 'Three fairness checks run automatically after every processing job: platform sentiment parity (the demographic-parity outcome gap across source categories — Barocas & Selbst 2016), location concentration (representation bias — Suresh & Guttag 2021), and negative dominance (selection bias toward controversy). Thresholds live in this config so they are auditable, versioned, and adjustable without a code change (AI Act §13). Equalized odds and counterfactual fairness are declared planned layers and reported as not-yet-enforced rather than omitted; the receipt presents the three literature-named fairness layers first, then the additional checks. The Demographic parity layer is annotated as parity measured across source categories (platform), not user demographics. Vocabulary: migration 008 folded legacy bias_assessments rows stored under the synonym demographic_parity onto the pipeline vocabulary platform_sentiment_parity (values, thresholds and violation flags untouched); any future vocabulary drift is resolved by read-time synonym mapping (src/config/bias-vocabulary.js), never by rewriting stored audit rows.',
    },
    {
        component: 'ingest',
        version: '1.0.0',
        model_name: 'pulse-ingest-v1',
        config: {
            // Must match src/pipeline/ingest.js PII_FIELDS
            pii_fields_removed:   ['author', 'author_fullname', 'username', 'user', 'email'],
            location_granularity: 'city',
            dedup_strategy:       'sha256-content-hash',
            legal_basis:          'GDPR Article 6(1)(f) - Legitimate Interest',
        },
        justification: 'Public-source collection with PII minimisation at ingest: author identifiers are stripped from the raw payload before any database write, location is retained at city granularity only (GDPR data-minimisation), and content is SHA-256 hashed to give every downstream inference an immutable, non-reversible join key. Processing rests on legitimate interest (GDPR Art. 6(1)(f)) — aggregate discourse measurement over public posts with no profiling of identifiable individuals.',
    },
    {
        component: 'audit_narration',
        // 1.1.0: reproduce_command names the real replay script
        // (scripts/replay.js) — 1.0.0 advertised a CLI that never existed.
        version: '1.1.0',
        model_name: 'pulse-narration-templates-v1',
        config: {
            audiences: ['public', 'plain', 'config', 'researcher'],
            renderer:  'src/config/audit-narration.js',
            rendering: 'read-time deterministic templates over stored decision_audit_log output + methodology config; no per-post prose is generated or persisted',
            reproduce_command: 'npm run replay -- --post {post_id}',
        },
        justification: 'The audit endpoint serves four audience representations (public, journalist, regulator, researcher) of every decision step. The wording is part of the auditable surface, so the template set is registered here and version-bumped on any change — the API reports which narration version rendered a receipt. Templates only restate stored facts (cue words, scores, thresholds, versions); they never invent per-post content. 1.1.0 makes the researcher reproduce command real: npm run replay -- --post {post_id} re-runs the deterministic pipeline scorers over the stored content, diffs against the stored outputs, and reports PASS, DIVERGENCE or NOT RE-RUNNABLE per stage.',
    },
    {
        component: 'audit_narration',
        // 1.2.0: demo branch for the ingestion step (fictional demo-feed
        // posts are never described as collected from a public source).
        // Registered by migration 011 — 009 is released and never edited.
        version: '1.2.0',
        model_name: 'pulse-narration-templates-v1',
        config: {
            audiences: ['public', 'plain', 'config', 'researcher'],
            renderer:  'src/config/audit-narration.js',
            rendering: 'read-time deterministic templates over stored decision_audit_log output + methodology config; no per-post prose is generated or persisted',
            reproduce_command: 'npm run replay -- --post {post_id}',
            ingest_branches: ['live_source', 'demo_feed'],
            demo_source_type: 'demo',
        },
        justification: 'The audit endpoint serves four audience representations (public, journalist, regulator, researcher) of every decision step. The wording is part of the auditable surface, so the template set is registered here and version-bumped on any change — the API reports which narration version rendered a receipt. Templates only restate stored facts (cue words, scores, thresholds, versions); they never invent per-post content. 1.2.0 adds a demo branch to the ingestion step: a post whose source is a demo feed (data_sources.source_type = demo, written by the standup demo population) is described as fictional demo content generated for this installation instead of as collected from a public source, so demo data is never presented as real discourse. The wording for real sources and every inference step is unchanged from 1.1.0, including the real reproduce command npm run replay -- --post {post_id}.',
    },
    {
        component: 'embedding',
        // P9-5: the model is pinned to a Hugging Face COMMIT, not a moving
        // branch, so every stored vector is reproducible from exact weights.
        // Registered by migration 012; post_embeddings.methodology_version
        // records this version on each vector (src/pipeline/embeddings.js).
        // A new model or revision ships as a NEW version row.
        version: '1.0.0',
        model_name: 'sentence-transformers/all-MiniLM-L6-v2',
        config: {
            revision: '1110a243fdf4706b3f48f1d95db1a4f5529b4d41',
            dimensions: 384,
            normalize_embeddings: true,
            library: 'sentence-transformers==2.7.0',
            service: 'python/embeddings_service.py',
            revision_env: 'EMBED_MODEL_REVISION',
        },
        justification: 'Sentence embeddings for semantic search and discourse novelty come from all-MiniLM-L6-v2 (Reimers & Gurevych 2019; 384 dimensions, L2-normalised so cosine similarity is a dot product), served by python/embeddings_service.py. The model is loaded at a fixed Hugging Face commit (revision), not the moving main branch, so a vector can always be traced to, and regenerated from, the exact weights that produced it; each stored vector records this methodology version. Changing the model or its revision changes the vectors, so it ships as a new version row.',
    },
];

module.exports = { METHODOLOGY_VERSIONS };
