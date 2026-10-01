// tests/unit/pure/auditNarration.test.js
// Pure unit tests for src/config/audit-narration.js — the versioned read-time
// audience templates behind GET /api/audit/:post_id (gap G17).
// No DB: the renderer is a deterministic function of the stored decision row.

'use strict';

const {
    NARRATION_COMPONENT,
    NARRATION_VERSION,
    renderAudiences,
    deriveScore,
    deriveStatus,
    renderIngestStep,
    INGEST_HASH_NOTE,
} = require('../../../src/config/audit-narration');

const POST_ID = '9b2f1f1e-2b1a-4c3d-8e4f-000000000001';

function sentimentDecision(overrides = {}) {
    return {
        decision_type:       'sentiment',
        model_name:          'afinn-sentiment-v5',
        methodology_version: '1.0.0',
        config:              { positive_threshold: 0.05, negative_threshold: -0.05 },
        output: {
            score: 4, comparative: 0.32, indicator: 'positive',
            positiveWords: ['shipped', 'wild'], negativeWords: ['regret'],
        },
        confidence: null,
        ...overrides,
    };
}

describe('audit-narration renderAudiences', () => {
    it('sentiment: returns all four audience representations', () => {
        const views = renderAudiences(sentimentDecision(), POST_ID);
        expect(views).toEqual({
            public:     expect.any(String),
            plain:      expect.any(String),
            config:     expect.any(Object),
            researcher: expect.any(String),
        });
    });

    it('sentiment public view is jargon-free and cites a cue word', () => {
        const views = renderAudiences(sentimentDecision(), POST_ID);
        expect(views.public).toContain('positive');
        expect(views.public).toContain('shipped');       // cue word surfaced
        expect(views.public).toContain('no human');      // automated-decision disclosure
        // No jargon in the public view
        expect(views.public).not.toMatch(/comparative|AFINN|lexicon threshold/i);
    });

    it('sentiment plain (journalist) view carries cue phrases, scores, and thresholds', () => {
        const views = renderAudiences(sentimentDecision(), POST_ID);
        expect(views.plain).toContain('0.32');           // comparative
        expect(views.plain).toContain('shipped');
        expect(views.plain).toContain('regret');
        expect(views.plain).toContain('0.05');           // threshold from versioned config
    });

    it('sentiment regulator config view is key/value with thresholds, versions, observed values', () => {
        const views = renderAudiences(sentimentDecision(), POST_ID);
        expect(views.config).toMatchObject({
            model:                'afinn-sentiment-v5@1.0.0',
            methodology_version:  '1.0.0',
            positive_threshold:   0.05,
            negative_threshold:   -0.05,
            observed_comparative: 0.32,
            observed_indicator:   'positive',
            cue_words_positive:   ['shipped', 'wild'],
            cue_words_negative:   ['regret'],
        });
    });

    it('sentiment researcher view has signed cue weights and a reproduce command', () => {
        const views = renderAudiences(sentimentDecision(), POST_ID);
        expect(views.researcher).toContain('+“shipped”');
        expect(views.researcher).toContain('−“regret”');
        expect(views.researcher).toContain(
            `npm run replay -- --post ${POST_ID}`,
        );
    });

    it('relevance: renders matched terms and percentage', () => {
        const views = renderAudiences({
            decision_type:       'relevance',
            model_name:          'keyword-relevance-v1',
            methodology_version: '1.0.0',
            config:              { keywords: ['ai', 'machine learning'] },
            output:              { score: 0.6, matchedKeywords: ['ai', 'llm'] },
        }, POST_ID);
        expect(views.plain).toContain('60%');
        expect(views.plain).toContain('ai');
        expect(views.config).toMatchObject({ observed_score: 0.6, matched_terms: ['ai', 'llm'] });
        expect(views.researcher).toContain(`Reproduce: npm run replay -- --post ${POST_ID}`);
    });

    it('discourse: renders DQI total and dimensions', () => {
        const views = renderAudiences({
            decision_type:       'discourse',
            model_name:          'dqi-heuristic-v1',
            methodology_version: '1.0.0-DQI',
            config:              {},
            output:              { total: 0.5, dimensions: { participation: 0.5 } },
        }, POST_ID);
        expect(views.plain).toContain('0.50');
        expect(views.config).toMatchObject({ observed_dqi_total: 0.5 });
        expect(views.researcher).toContain('participation=0.50');
    });

    it('unknown decision types fall back to a generic four-view rendering', () => {
        const views = renderAudiences({
            decision_type:       'demographic',
            model_name:          'x',
            methodology_version: '0.1.0',
            config:              { a: 1 },
            output:              { anything: true },
            justification:       'Registered justification.',
        }, POST_ID);
        expect(views.public).toEqual(expect.any(String));
        expect(views.plain).toBe('Registered justification.');
        expect(views.config).toMatchObject({ a: 1 });
        expect(views.researcher).toContain(`Reproduce: npm run replay -- --post ${POST_ID}`);
    });

    it('never crashes on empty output/config (sparse stored rows)', () => {
        for (const type of ['sentiment', 'relevance', 'discourse']) {
            const views = renderAudiences({
                decision_type: type, model_name: 'm', methodology_version: 'v',
                config: null, output: null,
            }, POST_ID);
            expect(views.public.length).toBeGreaterThan(0);
            expect(views.researcher).toContain('npm run replay -- --post');
        }
    });
});

describe('audit-narration deriveScore / deriveStatus', () => {
    it('sentiment score is the comparative, clamped to [-1, 1]', () => {
        expect(deriveScore(sentimentDecision())).toBe(0.32);
        expect(deriveScore(sentimentDecision({ output: { comparative: 3.2 } }))).toBe(1);
        expect(deriveScore(sentimentDecision({ output: { comparative: -3.2 } }))).toBe(-1);
        expect(deriveScore(sentimentDecision({ output: {} }))).toBeNull();
    });

    it('relevance and discourse scores come from their stored outputs', () => {
        expect(deriveScore({ decision_type: 'relevance', output: { score: 0.6 } })).toBe(0.6);
        expect(deriveScore({ decision_type: 'discourse', output: { total: 0.5 } })).toBe(0.5);
        expect(deriveScore({ decision_type: 'discourse', output: { dqi_total: 0.4 } })).toBe(0.4);
        expect(deriveScore({ decision_type: 'other', output: {} })).toBeNull();
    });

    it('every logged decision is a pass (failures never reach the log)', () => {
        expect(deriveStatus()).toBe('pass');
    });
});

describe('audit-narration renderIngestStep', () => {
    const INGEST_MV = {
        model_name: 'pulse-ingest-v1',
        version:    '1.0.0',
        config: {
            pii_fields_removed:   ['author', 'username', 'email'],
            location_granularity: 'city',
            dedup_strategy:       'sha256-content-hash',
            legal_basis:          'GDPR Article 6(1)(f) - Legitimate Interest',
        },
    };

    it('returns null when no ingest methodology is registered', () => {
        expect(renderIngestStep(null)).toBeNull();
    });

    it('renders the ingestion step with legal basis from versioned config', () => {
        const step = renderIngestStep(INGEST_MV);
        expect(step).toMatchObject({
            stage:               'ingestion',
            model_name:          'pulse-ingest-v1',
            methodology_version: '1.0.0',
            status:              'pass',
        });
        expect(step.audiences.config.legal_basis)
            .toBe('GDPR Article 6(1)(f) - Legitimate Interest');
        expect(step.audiences.plain).toContain('3 identifying field(s)');
        expect(step.audiences.public).toContain('city');
        expect(step.audiences.researcher).toContain('SHA-256');
    });

    it('describes demo-feed posts as fictional demo content, never as a public source (1.2.0)', () => {
        const step = renderIngestStep(INGEST_MV, { demo: true });
        expect(step).toMatchObject({ stage: 'ingestion', status: 'pass', methodology_version: '1.0.0' });
        expect(step.audiences.public).toMatch(/fictional demo post generated for this installation/);
        expect(step.audiences.public).not.toMatch(/came from a public source/);
        expect(step.audiences.plain).toMatch(/^Demo content: /);
        expect(step.audiences.plain).not.toMatch(/Collected via the source/);
        expect(step.audiences.config).toMatchObject({ content_origin: 'demo_feed', fictional: true,
            legal_basis: 'GDPR Article 6(1)(f) - Legitimate Interest' });
        expect(step.audiences.researcher).toContain('SHA-256');
        expect(step.audiences.researcher).toContain("source_type = 'demo'");
    });

    it('keeps the live-source wording unchanged when the post is not a demo', () => {
        const live = renderIngestStep(INGEST_MV, { demo: false });
        expect(live).toEqual(renderIngestStep(INGEST_MV));
        expect(live.audiences.public).toMatch(/^This post came from a public source\./);
        expect(live.audiences.config.content_origin).toBeUndefined();
    });

    // 1.4.0 (migration 066): the content hash is an integrity check recorded
    // as input_hash, not a join key — in the live and the demo branch alike,
    // whatever ingest version the post was stored under.
    it('states what the content hash is, never that it is a join key (1.4.0)', () => {
        const prov = { source: 'hn', permalink: null, fingerprint: 'a'.repeat(64) };
        const views = [
            renderIngestStep(INGEST_MV),
            renderIngestStep(INGEST_MV, { demo: true }),
            renderIngestStep({ ...INGEST_MV, version: '1.7.0', config: { ...INGEST_MV.config, privacy_claim: 'c' } },
                { provenance: prov, postId: POST_ID }),
        ];
        for (const step of views) {
            expect(step.audiences.researcher.startsWith(INGEST_HASH_NOTE)).toBe(true);
            expect(step.audiences.researcher).not.toMatch(/join key across/);
            expect(step.audiences.researcher).not.toMatch(/immutable join key/);
        }
        expect(INGEST_HASH_NOTE).toMatch(/SHA-256/);
        expect(INGEST_HASH_NOTE).toMatch(/input_hash/);
        expect(INGEST_HASH_NOTE).toMatch(/npm run replay/);
        expect(INGEST_HASH_NOTE).toMatch(/HMAC-SHA256 with AUDIT_HASH_KEY/);
        expect(INGEST_HASH_NOTE).toMatch(/It is an integrity check, not a join key\.$/);
        // Live provenance wording follows the note unchanged (1.3.0).
        expect(views[2].audiences.researcher).toContain(`${INGEST_HASH_NOTE} Provenance: HMAC-SHA256(key, source_slug:upstream id:source URL) = ${'a'.repeat(64)}`);
    });

    it('narration version constants are exported for the API to report', () => {
        expect(NARRATION_COMPONENT).toBe('audit_narration');
        expect(NARRATION_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
        expect(NARRATION_VERSION).toBe('1.4.0');
    });
});
