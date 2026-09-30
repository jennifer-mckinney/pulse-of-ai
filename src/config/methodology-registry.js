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

const { RELEVANCE_TERMS_1_2_0, describeRule } = require('./ai-lexicon');

// bias@1.1.0's config, shared by reference with later bias versions that
// extend it (bias@1.2.0 spreads it); never mutated.
const BIAS_1_1_0_CONFIG = Object.freeze({
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
    });

// bias@1.2.0's config (decision D3): 1.1.0 plus the publisher exclusion.
const BIAS_1_2_0_CONFIG = Object.freeze({
    ...BIAS_1_1_0_CONFIG,
    // Read by src/pipeline/bias.js checkLocationConcentration
    location_basis_excluded: ['publisher'],
    location_concentration_scope: 'posts located by their content (location_basis content, or no basis recorded); '
        + 'posts placed at the publisher\'s home city (location_basis publisher) are excluded and counted in the evidence',
    layer_notes: {
        ...BIAS_1_1_0_CONFIG.layer_notes,
        location_concentration: 'content-located posts only: posts placed at the publisher\'s home city are shown as a '
            + 'separate publisher-location layer and excluded from this check (ADR 0001 D3)',
    },
});

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
        config: BIAS_1_1_0_CONFIG,
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

    // ── 2026-09-29 alignment (ADR 0001; migration 014) ────────────────────
    // `npm run replay` reported config drift: the registered relevance row
    // listed 18 keywords and a 0.1-per-match rule, the code scores 20
    // keywords at 1/20 each; the registered DQI dimensions were not the
    // five the code computes. Released rows are never edited — these NEW
    // rows state exactly what src/pipeline does, and the pipeline records
    // them (CURRENT_VERSIONS below: the code declares the version it
    // implements instead of trusting "latest effective_from").
    {
        component: 'relevance',
        version: '1.1.0',
        model_name: 'keyword-relevance-v1',
        config: {
            // Must equal src/pipeline/relevance.js KEYWORD_LIST (order included)
            keywords: ['artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'large language model', 'llm', 'natural language processing', 'nlp', 'transformer', 'reinforcement learning', 'generative ai', 'computer vision', 'foundation model', 'fine-tuning', 'embeddings', 'gpt', 'bert', 'diffusion model', 'autonomous agent', 'ai safety'],
            matching: 'case-insensitive substring match; each keyword counted once',
            score_rule: 'unique matched keywords / number of keywords, capped at 1.0',
            score_per_match: 0.05,
            max_score: 1.0,
            is_relevant_rule: 'score > 0 (at least one keyword matched)',
            // Must equal src/pipeline/relevance.js EMBED_GATE_MIN_SCORE
            embed_gate_min_score: 0.05,
            embed_gate_rule: 'a post is embedded when its relevance score is at least 1/20 (one lexicon match); replaces the unreachable 0.40 gate, which needed 8 of the 20 keywords',
        },
        justification: 'Registers the relevance scorer exactly as the code runs it, after the replay tool found the 1.0.0 row out of step with the code (18 registered keywords and a 0.1-per-match rule, against a 20-keyword lexicon scored as the matched fraction). Score = unique lexicon keywords found in the post (case-insensitive substring) divided by 20, capped at 1.0; a post is AI-relevant when at least one keyword matches. The embedding gate moves from 0.40, which required 8 of 20 keywords and was never reached, to one keyword match (score >= 0.05), so relevant posts are embedded for semantic search. Collection is already scoped to each source\'s AI or technology feed; this score measures how explicitly a post uses AI vocabulary.',
    },
    {
        component: 'discourse',
        version: '1.1.0-DQI',
        model_name: 'dqi-heuristic-v1',
        config: {
            // Keys must equal src/pipeline/discourse.js DQI_DIMENSIONS
            dimensions: {
                participation:    { weight: 0.2, rule: '1.0 at 50+ words, 0.5 at 15-49 words, else 0' },
                justification:    { weight: 0.2, rule: '1.0 for 2+ reasoning connectors, 0.5 for 1, else 0' },
                respectfulness:   { weight: 0.2, rule: '1.0 minus 0.25 per hostile marker, floor 0' },
                constructiveness: { weight: 0.2, rule: '1.0 for 3+ solution markers, 0.5 for 1-2, else 0' },
                evidence:         { weight: 0.2, rule: '1.0 for 2+ evidence markers, 0.5 for 1, else 0' },
            },
            total_rule: 'unweighted mean of the five dimension scores, in [0, 1]',
            source_category_weighting: 'none in this version',
        },
        justification: 'Registers the Deliberative Quality Index scorer exactly as the code runs it (Steenbergen et al. 2003, adapted as keyword heuristics), after the replay tool found the 1.0.0-DQI row describing six weighted dimensions and source-category weights the code does not apply. The code scores five dimensions (participation, justification, respectfulness, constructiveness, evidence), each 0, 0.5 or 1 from marker counts (respectfulness deducts 0.25 per hostile marker), and the total is their unweighted mean. No source-category weighting, semantic deduplication or echo-chamber signal is applied in this version.',
    },
    {
        component: 'ingest',
        version: '1.1.0',
        model_name: 'pulse-ingest-v1',
        config: {
            // Must match src/pipeline/ingest.js PII_FIELDS
            pii_fields_removed:   ['author', 'author_fullname', 'author_id', 'authors', 'username', 'user', 'user_id', 'screen_name', 'creator', 'uploader', 'owner', 'email'],
            collector_payload:    'collectors build the stored payload from an allowlist of content fields; identity fields are never requested',
            location_granularity: 'city',
            location_basis:       ['content', 'publisher'],
            dedup_strategy:       'unique (source, external id); sha256-content-hash join key',
            legal_basis:          'GDPR Article 6(1)(f) - Legitimate Interest',
        },
        justification: 'Real collection (ADR 0001): each collector builds the stored payload from an allowlist of content fields (title, text, link, timestamp, licence) and never requests author, username or profile-location fields; the ingest step still removes any identity field that arrives. Location is kept at city level only and comes from a content-level field (for example a geotag rounded to the nearest registry city) or, for editorial sources publishing their own articles, the publisher\'s home city, with the basis recorded on the post; a person\'s location is never inferred. Content is SHA-256 hashed as the immutable join key; duplicates are dropped per source and external id. Processing rests on legitimate interest (GDPR Art. 6(1)(f)) - aggregate discourse measurement over public posts with no profiling of identifiable individuals.',
    },
    {
        component: 'ingest',
        // 1.2.0: in-text identity redaction (migration 015).
        version: '1.2.0',
        model_name: 'pulse-ingest-v1',
        config: {
            // Must match src/pipeline/ingest.js PII_FIELDS
            pii_fields_removed:   ['author', 'author_fullname', 'author_id', 'authors', 'username', 'user', 'user_id', 'screen_name', 'creator', 'uploader', 'owner', 'email'],
            collector_payload:    'collectors build the stored payload from an allowlist of content fields; identity fields are never requested',
            // Must match src/collectors/normalize.js redactIdentities
            text_redaction:       { email_addresses: '[email]', at_handles: '@[user]' },
            identity_links:       'links whose path names a person (/user/, /u/, /@name) are not stored',
            location_granularity: 'city',
            location_basis:       ['content', 'publisher'],
            dedup_strategy:       'unique (source, external id); sha256-content-hash join key',
            legal_basis:          'GDPR Article 6(1)(f) - Legitimate Interest',
        },
        justification: 'Adds in-text identity redaction to real collection (ADR 0001): besides building the stored payload from an allowlist of content fields and removing any identity field that arrives, e-mail addresses in the text become [email] and @handles (mentions, pings) become @[user] before the post is stored, and links whose path names a person are not kept. Location stays at city level from a content-level field or, for editorial sources, the publisher\'s home city, with the basis recorded; a person\'s location is never inferred. Content is SHA-256 hashed as the immutable join key; duplicates are dropped per source and external id. Processing rests on legitimate interest (GDPR Art. 6(1)(f)) - aggregate discourse measurement over public posts with no profiling of identifiable individuals.',
    },
    {
        component: 'ingest',
        // 1.3.0: decision D2 (2026-09-29) — wider in-text redaction, the
        // precise privacy claim, and the provenance fingerprint (migration 017).
        version: '1.3.0',
        model_name: 'pulse-ingest-v1',
        config: {
            // Must match src/pipeline/ingest.js PII_FIELDS
            pii_fields_removed:   ['author', 'author_fullname', 'author_id', 'authors', 'username', 'user', 'user_id', 'screen_name', 'creator', 'uploader', 'owner', 'email'],
            collector_payload:    'collectors build the stored payload from an allowlist of content fields; identity fields are never requested',
            // Must match src/collectors/identity.js redactText
            text_redaction:       {
                email_addresses:       '[email]',
                at_handles:            '@[user]',
                phone_numbers:         '[phone] (E.164 and NANP)',
                identity_links:        '[profile link]',
                cc_names:              'cc [name]',
                trailing_signoffs:     'removed',
                wikipedia_unsigned:    'removed',
            },
            identity_links:       'links that point at a person (/user/, /u/, /profile/, /@name, github.com/<user>, gitlab.com/<user>, x.com and twitter.com handles, linkedin.com/in/, medium.com/<name>, a <name>.substack.com root, facebook, instagram, t.me, YouTube channels, Wikipedia User pages) are not stored and are replaced in text',
            privacy_claim:        'identity fields are never stored; e-mail addresses, handles, phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content',
            external_ids:         'the upstream id is stored only when it is not identity-bearing (numeric, arXiv, PMID, DOI, HN item ids, clean slugs); otherwise its keyed fingerprint is stored; the Telegram chat id is fingerprinted',
            provenance:           'HMAC-SHA256(PROVENANCE_KEY or AUDIT_HASH_KEY, source_slug + ":" + raw upstream id + ":" + canonical source URL), stored per post; reproduced by npm run verify-provenance -- --post <id> --url <original>',
            location_granularity: 'city',
            location_basis:       ['content', 'publisher'],
            dedup_strategy:       'unique (source, external id); sha256-content-hash join key',
            legal_basis:          'GDPR Article 6(1)(f) - Legitimate Interest',
        },
        justification: 'Decision D2 (2026-09-29): "both yet we need an identifier to be able to prove the audit traceability back to the source." Precise claim: identity fields are never stored; e-mail addresses, handles, phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content. Collectors build the stored payload from an allowlist of content fields and the ingest step removes any identity field that arrives. Before a post is stored, e-mail addresses become [email], @handles become @[user], phone numbers (E.164 and North American formats) become [phone], links to a person\'s profile become [profile link], "cc <Name>" becomes "cc [name]", and a trailing sign-off or a Wikipedia unsigned-comment note is removed. Each post carries a provenance fingerprint, a keyed HMAC of the source, the upstream id and the source URL, so anyone holding the original link can prove which item a post came from without the post storing anything that identifies a person; an upstream id that could identify someone is stored only as its fingerprint. Location stays at city level from a content-level field or, for editorial sources, the publisher\'s home city, with the basis recorded. Content is SHA-256 hashed as the immutable join key; duplicates are dropped per source and external id. Processing rests on legitimate interest (GDPR Art. 6(1)(f)) - aggregate discourse measurement over public posts with no profiling of identifiable individuals.',
    },
    {
        component: 'audit_narration',
        // 1.3.0: decision D2 — the live ingestion step restates the ingest
        // version's precise privacy claim and shows the post's provenance
        // (migration 017).
        version: '1.3.0',
        model_name: 'pulse-narration-templates-v1',
        config: {
            audiences: ['public', 'plain', 'config', 'researcher'],
            renderer:  'src/config/audit-narration.js',
            rendering: 'read-time deterministic templates over stored decision_audit_log output + methodology config; no per-post prose is generated or persisted',
            reproduce_command: 'npm run replay -- --post {post_id}',
            verify_provenance_command: 'npm run verify-provenance -- --post {post_id} --url <original URL> [--id <original id>]',
            ingest_branches: ['live_source', 'demo_feed'],
            demo_source_type: 'demo',
            provenance_fields: ['source', 'published_at', 'permalink', 'external_id', 'fingerprint', 'verifiable'],
        },
        justification: 'The audit endpoint serves four audience representations (public, journalist, regulator, researcher) of every decision step. The wording is part of the auditable surface, so the template set is registered here and version-bumped on any change — the API reports which narration version rendered a receipt. Templates only restate stored facts; they never invent per-post content. 1.3.0 implements decision D2 in the ingestion step for real sources: instead of saying that anything that could identify the writer was removed, it restates the privacy claim registered by the ingest version (identity fields are never stored; e-mail addresses, handles, phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content), and it shows the post\'s provenance - the source, its published time, the permalink when it does not identify a person, the stored external id and the provenance fingerprint - with the words "verifiable: provide the original URL or id to reproduce the fingerprint" and the command npm run verify-provenance that does so. Demo-feed wording and every inference step are unchanged from 1.2.0.',
    },
    {
        component: 'ingest',
        // 1.4.0: single-character @handles are redacted too (Copilot
        // 4129565702; migration 024). Otherwise identical to 1.3.0.
        version: '1.4.0',
        model_name: 'pulse-ingest-v1',
        config: {
            // Must match src/pipeline/ingest.js PII_FIELDS
            pii_fields_removed:   ['author', 'author_fullname', 'author_id', 'authors', 'username', 'user', 'user_id', 'screen_name', 'creator', 'uploader', 'owner', 'email'],
            collector_payload:    'collectors build the stored payload from an allowlist of content fields; identity fields are never requested',
            // Must match src/collectors/identity.js redactText
            text_redaction:       {
                email_addresses:       '[email]',
                at_handles:            '@[user]',
                at_handle_min_length:  1,
                phone_numbers:         '[phone] (E.164 and NANP)',
                identity_links:        '[profile link]',
                cc_names:              'cc [name]',
                trailing_signoffs:     'removed',
                wikipedia_unsigned:    'removed',
            },
            identity_links:       'links that point at a person (/user/, /u/, /profile/, /@name, github.com/<user>, gitlab.com/<user>, x.com and twitter.com handles, linkedin.com/in/, medium.com/<name>, a <name>.substack.com root, facebook, instagram, t.me, YouTube channels, Wikipedia User pages) are not stored and are replaced in text',
            privacy_claim:        'identity fields are never stored; e-mail addresses, handles, phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content',
            external_ids:         'the upstream id is stored only when it is not identity-bearing (numeric, arXiv, PMID, DOI, HN item ids, clean slugs); otherwise its keyed fingerprint is stored; the Telegram chat id is fingerprinted',
            provenance:           'HMAC-SHA256(PROVENANCE_KEY or AUDIT_HASH_KEY, source_slug + ":" + raw upstream id + ":" + canonical source URL), stored per post; reproduced by npm run verify-provenance -- --post <id> --url <original>',
            location_granularity: 'city',
            location_basis:       ['content', 'publisher'],
            dedup_strategy:       'unique (source, external id); sha256-content-hash join key',
            legal_basis:          'GDPR Article 6(1)(f) - Legitimate Interest',
        },
        justification: 'ingest@1.4.0 redacts single-character @handles too (1.3.0 required at least two characters after the @, so "@a" was stored). Decision D2 (2026-09-29): "both yet we need an identifier to be able to prove the audit traceability back to the source." Precise claim: identity fields are never stored; e-mail addresses, handles, phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content. Collectors build the stored payload from an allowlist of content fields and the ingest step removes any identity field that arrives. Before a post is stored, e-mail addresses become [email], @handles of one or more characters become @[user], phone numbers (E.164 and North American formats) become [phone], links to a person\'s profile become [profile link], "cc <Name>" becomes "cc [name]", and a trailing sign-off or a Wikipedia unsigned-comment note is removed. Each post carries a provenance fingerprint, a keyed HMAC of the source, the upstream id and the source URL, so anyone holding the original link can prove which item a post came from without the post storing anything that identifies a person; an upstream id that could identify someone is stored only as its fingerprint. Location stays at city level from a content-level field or, for editorial sources, the publisher\'s home city, with the basis recorded. Content is SHA-256 hashed as the immutable join key; duplicates are dropped per source and external id. Processing rests on legitimate interest (GDPR Art. 6(1)(f)) - aggregate discourse measurement over public posts with no profiling of identifiable individuals.',
    },
    {
        component: 'ingest',
        // 1.5.0: Reddit (#52, migration 026) — u/<name>, /u/<name> and
        // scheme-less reddit.com/u|user/<name> are redacted. Otherwise
        // identical to 1.4.0.
        version: '1.5.0',
        model_name: 'pulse-ingest-v1',
        config: {
            // Must match src/pipeline/ingest.js PII_FIELDS
            pii_fields_removed:   ['author', 'author_fullname', 'author_id', 'authors', 'username', 'user', 'user_id', 'screen_name', 'creator', 'uploader', 'owner', 'email'],
            collector_payload:    'collectors build the stored payload from an allowlist of content fields; identity fields are never requested',
            // Must match src/collectors/identity.js redactText
            text_redaction:       {
                email_addresses:       '[email]',
                at_handles:            '@[user]',
                at_handle_min_length:  1,
                reddit_user_handles:   'u/[user] (u/<name> and /u/<name>); a scheme-less reddit.com/u/ or /user/ link becomes [profile link]',
                phone_numbers:         '[phone] (E.164 and NANP)',
                identity_links:        '[profile link]',
                cc_names:              'cc [name]',
                trailing_signoffs:     'removed',
                wikipedia_unsigned:    'removed',
            },
            identity_links:       'links that point at a person (/user/, /u/, /profile/, /@name, github.com/<user>, gitlab.com/<user>, x.com and twitter.com handles, linkedin.com/in/, medium.com/<name>, a <name>.substack.com root, facebook, instagram, t.me, YouTube channels, Wikipedia User pages) are not stored and are replaced in text',
            privacy_claim:        'identity fields are never stored; e-mail addresses, handles (including Reddit u/ names), phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content',
            external_ids:         'the upstream id is stored only when it is not identity-bearing (numeric, arXiv, PMID, DOI, HN item ids, Reddit t3_ fullnames, clean slugs); otherwise its keyed fingerprint is stored; the Telegram chat id is fingerprinted',
            provenance:           'HMAC-SHA256(PROVENANCE_KEY or AUDIT_HASH_KEY, source_slug + ":" + raw upstream id + ":" + canonical source URL), stored per post; reproduced by npm run verify-provenance -- --post <id> --url <original>',
            location_granularity: 'city',
            location_basis:       ['content', 'publisher'],
            dedup_strategy:       'unique (source, external id); sha256-content-hash join key',
            legal_basis:          'GDPR Article 6(1)(f) - Legitimate Interest',
        },
        justification: 'ingest@1.5.0 adds Reddit (source #52): u/<name> and /u/<name> become u/[user], and a scheme-less reddit.com/u/ or /user/ link becomes [profile link]; Reddit collectors store only allowlisted submission fields (never author, author_fullname or any user field). Single-character @handles are redacted since 1.4.0. Decision D2 (2026-09-29): "both yet we need an identifier to be able to prove the audit traceability back to the source." Precise claim: identity fields are never stored; e-mail addresses, handles (including Reddit u/ names), phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content. Collectors build the stored payload from an allowlist of content fields and the ingest step removes any identity field that arrives. Before a post is stored, e-mail addresses become [email], @handles of one or more characters become @[user], phone numbers (E.164 and North American formats) become [phone], links to a person\'s profile become [profile link], "cc <Name>" becomes "cc [name]", and a trailing sign-off or a Wikipedia unsigned-comment note is removed. Each post carries a provenance fingerprint, a keyed HMAC of the source, the upstream id and the source URL, so anyone holding the original link can prove which item a post came from without the post storing anything that identifies a person; an upstream id that could identify someone is stored only as its fingerprint. Location stays at city level from a content-level field or, for editorial sources, the publisher\'s home city, with the basis recorded. Content is SHA-256 hashed as the immutable join key; duplicates are dropped per source and external id. Processing rests on legitimate interest (GDPR Art. 6(1)(f)) - aggregate discourse measurement over public posts with no profiling of identifiable individuals.',
    },
    // bias@1.2.0 — decision D3 (ADR 0001, Jennifer 2026-09-29: "Separate
    // layer, excluded from bias."): posts placed at their publisher's home
    // city are excluded from the location-concentration check. Everything
    // else is bias@1.1.0 unchanged (1.1.0 is never edited; migration 027).
    {
        component: 'bias',
        version: '1.2.0',
        model_name: 'pulse-bias-monitor-v1',
        config: BIAS_1_2_0_CONFIG,
        justification: 'bias@1.2.0 applies decision D3 (ADR 0001, Jennifer 2026-09-29, verbatim: "Separate layer, excluded from bias."). '
            + 'A post from an editorial source with no content-level location is placed at the publisher\'s home city (BBC in London, NPR in '
            + 'Washington, D.C.) and recorded with location_basis publisher. That city says where the outlet is, not where the '
            + 'discussion happened, so it is not evidence of geographic concentration: the location-concentration check now counts '
            + 'only posts located by their content (or with no basis recorded) and states how many publisher-located posts it '
            + 'excluded. The globe shows publisher-located posts as a separate, labelled publisher-location layer. Platform '
            + 'sentiment parity and negative dominance are unchanged, and every threshold, name, citation and planned layer is as '
            + 'in bias@1.1.0: three fairness checks run after every processing job (platform sentiment parity across source '
            + 'categories, Barocas & Selbst 2016; location concentration, Suresh & Guttag 2021; negative dominance), with '
            + 'thresholds in this config so they are auditable and versioned (AI Act Article 13). Equalized odds and '
            + 'counterfactual fairness remain declared planned layers reported as not yet enforced.',
    },
    // bias@1.3.0 — P10-5: a minimum located sample for location
    // concentration (30 content-located posts, else "insufficient sample"
    // and no alert). Otherwise bias@1.2.0 (migration 028).
    {
        component: 'bias',
        version: '1.3.0',
        model_name: 'pulse-bias-monitor-v1',
        config: {
            ...BIAS_1_2_0_CONFIG,
            // Read by src/pipeline/bias.js checkLocationConcentration
            location_min_sample: 30,
            location_min_sample_rule: 'fewer than 30 content-located posts in the job: the assessment is recorded as '
                + '"insufficient sample" with its share stated, no violation and no alert',
            layer_notes: {
                ...BIAS_1_2_0_CONFIG.layer_notes,
                location_concentration: 'content-located posts only (publisher-located posts are a separate layer, ADR 0001 D3); '
                    + 'needs at least 30 of them, else "insufficient sample" and no alert',
            },
        },
        justification: 'bias@1.3.0 adds a minimum sample to the location-concentration check (PR #10 review P10-5). A share computed '
            + 'over a handful of located posts measures the shape of one collection run, not the discourse: a scheduled run of one '
            + 'editorial source had all its located posts in one city and read 1.000, raising critical alerts that said nothing '
            + 'about the posts. The check now needs at least 30 content-located posts in the job; below that it records an '
            + '"insufficient sample" assessment with the share still stated, and raises no violation and no alert. As in bias@1.2.0 '
            + '(decision D3, "Separate layer, excluded from bias."), posts placed at the publisher\'s home city are excluded from '
            + 'this check and counted in its evidence. Platform sentiment parity (Barocas & Selbst 2016) and negative dominance are '
            + 'unchanged, every threshold, layer name, citation and planned layer is as in bias@1.1.0 (AI Act Article 13), and '
            + 'equalized odds and counterfactual fairness remain declared planned layers reported as not yet enforced. Open '
            + 'location-concentration alerts that this version would not raise are resolved by migration 028 with an audited '
            + 'alert_resolutions record, never deleted.',
    },
    // relevance@1.2.0 — P10-13: word-boundary matching, case-sensitive "AI"
    // (the collection filter's own rule, shared through
    // src/config/ai-lexicon.js). relevance@1.1.0 is never edited and its
    // scorer is kept for replay (migration 029).
    {
        component: 'relevance',
        version: '1.2.0',
        model_name: 'keyword-relevance-v2',
        config: {
            // Must equal src/config/ai-lexicon.js RELEVANCE_TERMS_1_2_0 (order included)
            keywords: RELEVANCE_TERMS_1_2_0.map(t => t.term),
            matching: Object.fromEntries(RELEVANCE_TERMS_1_2_0.map(t => [t.term, describeRule(t)])),
            shared_with: 'src/collectors/ai-filter.js uses the same case-sensitive "AI" expression (src/config/ai-lexicon.js AI_ACRONYM_RE); '
                + 'the filter\'s wider product and topic patterns scope collection only and are not relevance terms',
            score_rule: 'unique matched terms / number of terms (21), capped at 1.0',
            score_per_match: 1 / RELEVANCE_TERMS_1_2_0.length,
            max_score: 1.0,
            is_relevant_rule: 'score > 0 (at least one term matched)',
            // Must equal src/pipeline/relevance.js EMBED_GATE_MIN_SCORE
            embed_gate_min_score: 1 / RELEVANCE_TERMS_1_2_0.length,
            embed_gate_rule: 'a post is embedded when its relevance score is at least 1/21 (one term matched)',
        },
        justification: 'relevance@1.2.0 fixes false matches found in review (PR #10, P10-13). Version 1.1.0 matched every lexicon '
            + 'keyword as a case-insensitive substring, so "Robert" matched "bert", and a post that the collection filter admitted '
            + 'only because it said "AI" scored 0, since the lexicon had no "AI" term. Version 1.2.0 keeps the 20 terms of 1.1.0 '
            + 'and adds "AI" (21 terms). Every term now matches as whole words: "AI" (or "A.I.") only in upper case, the same rule '
            + 'the collection filter uses (one shared expression, src/config/ai-lexicon.js); "BERT" only in upper case, since Bert '
            + 'is a name; LLM and NLP as whole words in any case; "gpt" as a whole word with ChatGPT and a version suffix such as '
            + 'GPT-4o allowed; every other term in any case with word boundaries, a space or hyphen between words and a plural '
            + 's allowed. Score = unique matched terms divided by 21, capped at 1.0; a post is AI-relevant when at least one term '
            + 'matches, and it is embedded at the same point (score >= 1/21). Collection is already scoped to each source\'s AI or '
            + 'technology feed; this score measures how explicitly a post uses AI vocabulary. Decisions scored under 1.1.0 keep '
            + 'their version and are replayed with the 1.1.0 rule.',
    },
];

// ingest@1.6.0 — P10-2: the post text is stored once (raw_posts.content),
// never duplicated in raw_payload, so retention genuinely removes it; every
// collected post gets a 'collected' retention row; each source's text window
// is registered. Otherwise ingest@1.5.0 unchanged (migration 031).
(() => {
    const prev = METHODOLOGY_VERSIONS.find(m => m.component === 'ingest' && m.version === '1.5.0');
    METHODOLOGY_VERSIONS.push({
        component: 'ingest',
        version: '1.6.0',
        model_name: prev.model_name,
        config: {
            ...prev.config,
            // Must match src/pipeline/ingest.js PAYLOAD_TEXT_KEYS
            payload_text_keys_not_stored: ['text', 'title', 'body', 'content', 'selftext'],
            text_storage: 'the post text is stored once, in raw_posts.content; raw_payload keeps metadata only (url, published_at, '
                + 'location_basis, route, licence, attribution)',
            collected_log: 'every stored post writes a data_retention_log row, action collected, legal basis GDPR Article 6(1)(f), '
                + 'in the same statement as the insert',
            text_retention: {
                rule: 'after its source\'s window the text is replaced by a removal notice (raw_posts.text_removed_at); scores and '
                    + 'audit rows are kept (ADR 0001 ruling 9, "Blank text, keep audit rows")',
                platform_terms_hours: { reddit: 48, guardian: 24, youtube: 720, tiktok: 720 },
                default: 'RETENTION_DETAIL_DAYS (90) days, TECHNICAL_SPEC §19',
                applied_by_analogy: ['guardian', 'youtube', 'tiktok'],
            },
        },
        justification: 'ingest@1.6.0 makes retention genuine (PR #10 review P10-2). Until 1.5.0 the text and title were copied into '
            + 'raw_payload next to raw_posts.content, so removing the content left the text in the payload. From 1.6.0 the text is '
            + 'stored once, in raw_posts.content, and the payload keeps metadata only; every stored post also writes a collected '
            + 'row to data_retention_log (legal basis GDPR Article 6(1)(f)) in the same statement as the insert (TECHNICAL_SPEC §8). '
            + 'Each source has a text window: Reddit 48 hours (ADR 0001 ruling 9), the Guardian 24 hours (its terms), YouTube and '
            + 'TikTok 30 days (their API terms), every other source the §19 detail window of 90 days. When the window ends the '
            + 'text, and any legacy copy in the payload, is replaced by a removal notice and the url is dropped (Reddit keeps its '
            + 'slug-less permalink); the scores, audit rows, content hash and provenance fingerprint are kept, applying Jennifer\'s '
            + 'ruling 9 ("Blank text, keep audit rows") to the Guardian, YouTube and TikTok by analogy. Everything else is as in '
            + 'ingest@1.5.0: identity fields are never stored; e-mail addresses, handles (including Reddit u/ names), phone '
            + 'numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content; '
            + 'each post carries a keyed provenance fingerprint; location stays at city level with its basis recorded; processing '
            + 'rests on legitimate interest (GDPR Art. 6(1)(f)).',
    });
})();

// bias@1.4.0 — Jennifer's live site (2026-09-29): parity and negative
// dominance alerts from tiny per-category samples in 2–3 minute cycles. A
// minimum sample for EVERY check (migration 032). Otherwise bias@1.3.0.
(() => {
    const prev = METHODOLOGY_VERSIONS.find(m => m.component === 'bias' && m.version === '1.3.0');
    METHODOLOGY_VERSIONS.push({
        component: 'bias',
        version: '1.4.0',
        model_name: prev.model_name,
        config: {
            ...prev.config,
            // Read by src/pipeline/bias.js
            parity_min_per_category: 10,
            negative_min_sample: 30,
            sample_rules: {
                location_concentration: 'at least 30 content-located posts in the job (location_min_sample), publisher-located posts excluded',
                platform_sentiment_parity: 'only categories with at least 10 posts are compared (parity_min_per_category); fewer than two such categories: insufficient sample',
                negative_dominance: 'at least 30 posts in the job (negative_min_sample)',
                below_minimum: '"insufficient sample": the value is stated, no violation, no alert',
                basis: 'n >= 30 is the conventional minimum for treating a sample proportion as approximately normal (central limit '
                    + 'theorem rule of thumb); n >= 10 per group is the conventional floor for comparing group means. Both are '
                    + 'deliberately conservative floors, not significance tests.',
            },
            layer_notes: {
                ...prev.config.layer_notes,
                platform_sentiment_parity: 'parity measured across source categories (platform), not user demographics; only categories '
                    + 'with at least 10 posts in the job are compared',
                negative_dominance: 'needs at least 30 posts in the job, else "insufficient sample" and no alert',
            },
        },
        justification: 'bias@1.4.0 gives every fairness check a minimum sample, after the live dashboard showed 39 active alerts from '
            + 'collection cycles of a few posts: location concentration of 1.000 for single publisher cities and demographic-parity '
            + 'watches between two categories of three or four posts each. Location concentration keeps bias@1.3.0\'s rule (at least '
            + '30 content-located posts; publisher-located posts excluded, decision D3 "Separate layer, excluded from bias."). '
            + 'Platform sentiment parity (the demographic-parity outcome gap across source categories, Barocas & Selbst 2016) now '
            + 'compares only categories with at least 10 posts in the job; with fewer than two such categories it records '
            + '"insufficient sample". Negative dominance needs at least 30 posts. Below a minimum the assessment is recorded with its '
            + 'value, as "insufficient sample", with no violation and no alert. The floors are conventional (n >= 30 for a '
            + 'proportion to be treated as approximately normal; n >= 10 per group for comparing means) and are floors, not '
            + 'significance tests. Thresholds, names, citations (Suresh & Guttag 2021 for location and negative dominance) and '
            + 'planned layers are as in bias@1.1.0 (AI Act Article 13). Open alerts that this version would not raise are '
            + 'resolved by migration 032 with an audited alert_resolutions record linked to this version, never deleted.',
    });
})();

// admission_filter@1.0.0 — PR #22 G6 (Jennifer, 2026-09-29): the collection
// admission filter (src/collectors/ai-filter.js) decides which items are
// stored, so it is a versioned methodology component. The config IS the
// code's patterns (tests/unit/pure/admissionFilter.test.js); any change is a
// new version. Every collected post records its version
// (raw_posts.admission_mv_id, migration 042).
(() => {
    const { patternDescriptions, SEARCH_TERMS, ADMISSION_FILTER_VERSION } = require('../collectors/ai-filter');
    METHODOLOGY_VERSIONS.push({
        component: 'admission_filter',
        version: ADMISSION_FILTER_VERSION,
        model_name: 'ai-scope-filter-v1',
        config: {
            // Must equal src/collectors/ai-filter.js PATTERNS (order included)
            patterns: patternDescriptions(),
            match_rule: 'an item is admitted when ANY pattern matches its title + summary text',
            scope_rule: {
                filter: 'site-wide and technology feeds (registry route scope "filter"): only items the patterns match are stored',
                ai: 'AI-specific feeds and searches (route scope "ai"): every item is stored; the patterns are not applied',
            },
            // Must equal src/collectors/ai-filter.js SEARCH_TERMS
            search_terms: [...SEARCH_TERMS],
            search_terms_rule: 'server-side search terms (Reddit subreddit discovery); every result is still filtered with the patterns',
            shared_with: 'the "AI" pattern is src/config/ai-lexicon.js AI_ACRONYM_RE, the same expression relevance@1.2.0 scores',
            not_relevance: 'admission scopes collection only; the relevance score (relevance@1.2.0) is a separate component',
        },
        justification: 'admission_filter@1.0.0 registers the collection admission filter as methodology (PR #22 review, decision G6, '
            + 'Jennifer McKinney 2026-09-29). The filter decides which items of a site-wide or technology feed are stored at all, '
            + 'which is a selection decision: it shapes every downstream measure. It was code-only until now; this version records '
            + 'exactly the patterns that ran since relevance@1.2.0 (PR #10 P10-13): upper-case "AI" or "A.I." as a whole word, AGI, '
            + 'LLM, NLP, GPT with a version suffix, and topic and product phrases (artificial intelligence, machine learning, deep '
            + 'learning, neural networks, language models, generative AI, natural language processing, computer vision, named AI '
            + 'products and labs, deepfakes, facial recognition, algorithmic, autonomous vehicles, agents or weapons, robots and '
            + 'robotics). An item is stored when any pattern matches its title and summary. AI-specific feeds are stored whole. '
            + 'Each collected post records the admission version it was stored under; a change to the patterns, the search terms '
            + 'or the scope rule is a new version, never an edit of this row.',
    });
})();

// ─── Errata (P10-16) ─────────────────────────────────────────────────────────
// A released methodology row is never edited, even when it turns out not to
// describe the code that ran. An erratum is a NEW row in
// methodology_errata (migration 030; scripts/seed.js inserts the same rows)
// attached to the row it corrects; GET /api/methodology serves it with that
// version.
const METHODOLOGY_ERRATA = [
    {
        component: 'relevance',
        version: '1.0.0',
        erratum_key: 'relevance-1.0.0-config-mismatch',
        corrected_by: 'relevance@1.1.0',
        erratum: 'The registered relevance@1.0.0 config does not describe the code that produced its decisions. It lists 18 '
            + 'keywords, 0.1 per match and an AI-relevance threshold of 0.99; the code that ran scored every post against the '
            + '20-keyword lexicon later registered as relevance@1.1.0 (case-insensitive substring match, score = unique matched '
            + 'keywords / 20, AI-relevant when at least one keyword matched). Read decisions recorded under 1.0.0 against '
            + 'relevance@1.1.0\'s config; `npm run replay` re-runs them with that rule. The 1.0.0 row is kept unedited as it '
            + 'was registered. Found by the replay tool (ADR 0001, methodology alignment); recorded 2026-09-29 (PR #10 review P10-16).',
    },
];

/**
 * The version of each component that the CODE implements: the last registry
 * entry per component. The pipeline records these rows on every decision
 * (src/pipeline/methodology.js), so a replay always compares the code with
 * the configuration it was registered under.
 * @type {Readonly<Record<string, string>>}
 */
const CURRENT_VERSIONS = Object.freeze(METHODOLOGY_VERSIONS.reduce((acc, m) => {
    acc[m.component] = m.version;
    return acc;
}, {}));

module.exports = { METHODOLOGY_VERSIONS, CURRENT_VERSIONS, METHODOLOGY_ERRATA };
