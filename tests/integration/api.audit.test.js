// tests/integration/api.audit.test.js
// Tests for GET /api/audit/:post_id
// Verifies: full decision trail, 404 for unknown post, 400 for invalid UUID.

'use strict';

const crypto  = require('crypto');
const request = require('supertest');
const app     = require('../../src/server');
const {
    insertSource, insertJob, insertMethodologyVersions,
    insertBiasMethodology, insertIngestMethodology, insertBiasAssessment,
    insertPostWithFullPipeline,
} = require('./helpers');

describe('GET /api/audit/:post_id', () => {
    it('returns 400 for an invalid (non-UUID) post_id', async () => {
        const res = await request(app).get('/api/audit/not-a-uuid');
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 404 when the post does not exist', async () => {
        const res = await request(app).get('/api/audit/00000000-0000-0000-0000-000000000000');
        expect(res.status).toBe(404);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 200 with the correct top-level shape', async () => {
        const srcId = await insertSource('audit-src-1');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-1' });

        const res = await request(app).get(`/api/audit/${postId}`);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            post:      expect.any(Object),
            decisions: expect.any(Array),
        });
    });

    it('post object contains id, content_snippet, and collected_at', async () => {
        const srcId  = await insertSource('audit-src-2');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-2' });

        const res = await request(app).get(`/api/audit/${postId}`);

        expect(res.body.post).toMatchObject({
            id:              postId,
            content_snippet: expect.any(String),
            collected_at:    expect.any(String),
        });
        // Snippet must be truncated to 120 chars or less
        expect(res.body.post.content_snippet.length).toBeLessThanOrEqual(120);
    });

    it('decisions array contains all three decision types', async () => {
        const srcId  = await insertSource('audit-src-3');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-3' });

        const res = await request(app).get(`/api/audit/${postId}`);

        const types = res.body.decisions.map(d => d.decision_type);
        expect(types).toContain('sentiment');
        expect(types).toContain('relevance');
        expect(types).toContain('discourse');
    });

    it('each decision includes model_name, methodology_version, justification, and output', async () => {
        const srcId  = await insertSource('audit-src-4');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-4' });

        const res     = await request(app).get(`/api/audit/${postId}`);
        const sentDec = res.body.decisions.find(d => d.decision_type === 'sentiment');

        expect(sentDec).toMatchObject({
            decision_type:        'sentiment',
            model_name:           expect.any(String),
            methodology_version:  expect.any(String),
            justification:        expect.any(String),
            output:               expect.any(Object),
            created_at:           expect.any(String),
        });
    });

    // ─── Four audience views per step (gap G17) ───────────────────────────────

    describe('four audience representations', () => {
        it('every decision carries audiences { public, plain, config, researcher } + status + score', async () => {
            const srcId  = await insertSource('audit-aud-1');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-v4-1' });

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.status).toBe(200);
            expect(res.body.decisions.length).toBeGreaterThan(0);
            for (const decision of res.body.decisions) {
                expect(decision.status).toBe('pass');
                expect(decision).toHaveProperty('score');
                expect(decision.audiences).toMatchObject({
                    public:     expect.any(String),
                    plain:      expect.any(String),
                    config:     expect.any(Object),
                    researcher: expect.any(String),
                });
                // Researcher view always carries the reproduce command
                expect(decision.audiences.researcher).toContain(`pulse replay --post ${postId}`);
            }
        });

        it('the regulator config view merges versioned thresholds with the observed output', async () => {
            const srcId  = await insertSource('audit-aud-2');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, {
                externalId: 'aud-v4-2', indicator: 'positive', comparative: 0.5,
            });

            const res = await request(app).get(`/api/audit/${postId}`);
            const sentDec = res.body.decisions.find(d => d.decision_type === 'sentiment');
            expect(sentDec.audiences.config).toMatchObject({
                model:                'afinn-sentiment-v5@1.0.0',
                positive_threshold:   0.05,
                negative_threshold:   -0.05,
                observed_comparative: 0.5,
                observed_indicator:   'positive',
            });
            // Headline score = bounded comparative
            expect(sentDec.score).toBe(0.5);
        });

        it('reports the narration template version that rendered the receipt', async () => {
            const srcId  = await insertSource('audit-aud-3');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-v4-3' });

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.body.narration).toEqual({
                component: 'audit_narration',
                version:   expect.stringMatching(/^\d+\.\d+\.\d+$/),
            });
        });
    });

    // ─── Synthetic ingestion step from versioned config ───────────────────────

    describe('ingestion step', () => {
        it('renders the ingestion step when the ingest methodology is registered', async () => {
            const srcId  = await insertSource('audit-ing-1');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            await insertIngestMethodology();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-ing-1' });

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.body.ingest).toMatchObject({
                stage:               'ingestion',
                model_name:          'pulse-ingest-v1',
                methodology_version: '1.0.0',
                status:              'pass',
            });
            // Legal basis comes from the VERSIONED config, not a hardcoded string
            expect(res.body.ingest.audiences.config.legal_basis)
                .toBe('GDPR Article 6(1)(f) - Legitimate Interest');
            expect(res.body.ingest.audiences.public).toEqual(expect.any(String));
        });

        it('serves ingest: null when no ingest methodology is registered', async () => {
            const srcId  = await insertSource('audit-ing-2');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-ing-2' });

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.body.ingest).toBeNull();
        });
    });

    // ─── Bias fairness layers for the post's job (gap G18) ────────────────────

    describe('bias fairness layers', () => {
        it('serves the job-level assessments as layers with value, τ, citation, and status', async () => {
            const srcId  = await insertSource('audit-bias-1');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            await insertBiasMethodology();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-b-1' });

            await insertBiasAssessment(jobId, {
                assessmentType: 'location_concentration',
                metricValue: 0.41, threshold: 0.35,
                isViolation: true, severity: 'warning',
            });
            await insertBiasAssessment(jobId, {
                assessmentType: 'platform_sentiment_parity',
                groupField: 'platform', groupValue: 'social vs news',
                metricName: 'max_comparative_diff',
                metricValue: 0.031, threshold: 0.30,
                isViolation: false,
            });

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.body.bias.job_id).toBe(jobId);
            expect(res.body.bias.assessed_at).toEqual(expect.any(String));
            // Versioned bias-monitor identity for the drawer's model pill
            expect(res.body.bias.model_name).toBe('pulse-bias-monitor-v1');
            expect(res.body.bias.version).toBe('1.1.0');

            const loc = res.body.bias.layers.find(l => l.assessment_type === 'location_concentration');
            expect(loc).toMatchObject({
                name:      'Location concentration',
                value:     0.41,
                threshold: 0.35,
                citation:  'Suresh & Guttag (2021)',
                status:    'fail',
                severity:  'watch',
            });

            const parity = res.body.bias.layers.find(l => l.assessment_type === 'platform_sentiment_parity');
            expect(parity).toMatchObject({
                name:     'Demographic parity',   // prototype's exact layer name
                value:    0.031,                   // REAL computed value + τ
                threshold: 0.30,
                citation: 'Barocas & Selbst (2016)',
                status:   'pass',
            });

            // Prototype presentation order: the three literature-named
            // layers lead (Demographic parity real, Equalized odds /
            // Counterfactual fairness honest n-a), extra real checks after.
            expect(res.body.bias.layers.map(l => l.name)).toEqual([
                'Demographic parity',
                'Equalized odds',
                'Counterfactual fairness',
                'Location concentration',
            ]);
        });

        it('includes planned-but-not-enforced layers as n-a (honest coverage)', async () => {
            const srcId  = await insertSource('audit-bias-2');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            await insertBiasMethodology();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-b-2' });

            const res = await request(app).get(`/api/audit/${postId}`);
            const eo = res.body.bias.layers.find(l => l.assessment_type === 'equalized_odds');
            expect(eo).toMatchObject({
                name:     'Equalized odds',
                value:    null,
                status:   'n-a',
                citation: 'Hardt et al. (2016)',
                note:     expect.stringContaining('not yet enforced'),
            });
        });

        it('degrades to empty layers when no assessments and no bias methodology exist', async () => {
            const srcId  = await insertSource('audit-bias-3');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-b-3' });

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.body.bias).toEqual({
                job_id:      jobId,
                assessed_at: null,
                model_name:  null,   // no 'bias' methodology → no invented pill
                version:     null,
                layers:      [],
            });
        });
    });

    // ─── input_hash keying (security review L1, 2026-07-06) ───────────────────
    // Same explicit set/delete/restore env pattern as api.config.test.js.
    // Every test in this block establishes its own AUDIT_HASH_KEY state —
    // none may depend on the ambient environment (CI has no key; a local
    // .env supplies one). afterEach restores whatever the suite started with.
    describe('input_hash keying', () => {
        const ORIGINAL_KEY = process.env.AUDIT_HASH_KEY;
        const TEST_KEY     = 'test-audit-hash-key-0123456789abcdef';

        afterEach(() => {
            if (ORIGINAL_KEY === undefined) {
                delete process.env.AUDIT_HASH_KEY;
            } else {
                process.env.AUDIT_HASH_KEY = ORIGINAL_KEY;
            }
        });

        it('each decision exposes the methodology config and a keyed input fingerprint', async () => {
            // Self-sufficient in env: the route reads AUDIT_HASH_KEY per
            // request, so setting it here controls both the server response
            // and the expected-HMAC computation below.
            process.env.AUDIT_HASH_KEY = TEST_KEY;

            const srcId  = await insertSource('audit-src-5');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-5' });

            // The helper stores SHA-256(content) as decision_audit_log.input_hash.
            // The API must NOT return that raw value (unsalted content hashes are
            // offline-confirmable for guessable text) — it returns
            // HMAC-SHA256(AUDIT_HASH_KEY, storedHash) instead.
            const storedHash = crypto
                .createHash('sha256')
                .update('Test post aud-5')
                .digest('hex');
            const expectedKeyed = crypto
                .createHmac('sha256', TEST_KEY)
                .update(storedHash)
                .digest('hex');

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.status).toBe(200);

            // Every decision carries the KEYED input fingerprint
            for (const decision of res.body.decisions) {
                expect(decision.input_hash).toMatch(/^[0-9a-f]{64}$/);
                expect(decision.input_hash).not.toBe(storedHash);
                expect(decision.input_hash).toBe(expectedKeyed);
                expect(decision.config).toEqual(expect.any(Object));
            }

            // Config must be the exact methodology_versions.config JSONB the helper seeded
            const sentDec = res.body.decisions.find(d => d.decision_type === 'sentiment');
            expect(sentDec.config).toEqual({
                positive_threshold: 0.05,
                negative_threshold: -0.05,
            });

            const relDec = res.body.decisions.find(d => d.decision_type === 'relevance');
            expect(relDec.config).toEqual({
                keywords: ['ai', 'machine learning'],
            });
        });

        it('never returns the raw stored hash when the key is set (verified against the DB)', async () => {
            process.env.AUDIT_HASH_KEY = TEST_KEY;

            const srcId  = await insertSource('audit-src-6');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-6' });

            // Fetch the RAW stored hashes straight from the test DB — the
            // comparison must be against what is actually persisted.
            const { dbAll } = require('../../src/db/connection');
            const storedRows = await dbAll(
                'SELECT input_hash FROM decision_audit_log WHERE raw_post_id = $1',
                [postId],
            );
            expect(storedRows.length).toBeGreaterThan(0);
            const storedHashes = new Set(storedRows.map(r => r.input_hash));

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.status).toBe(200);
            for (const decision of res.body.decisions) {
                expect(decision.input_hash).toMatch(/^[0-9a-f]{64}$/);
                expect(storedHashes.has(decision.input_hash)).toBe(false);
            }
        });

        it('omits input_hash entirely when AUDIT_HASH_KEY is unset (never falls back to raw)', async () => {
            delete process.env.AUDIT_HASH_KEY;

            const srcId  = await insertSource('audit-src-7');
            const jobId  = await insertJob();
            const mvIds  = await insertMethodologyVersions();
            const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-7' });

            const res = await request(app).get(`/api/audit/${postId}`);
            expect(res.status).toBe(200);
            expect(res.body.decisions.length).toBeGreaterThan(0);
            for (const decision of res.body.decisions) {
                expect(decision).not.toHaveProperty('input_hash');
                // the rest of the trail is unaffected
                expect(decision).toMatchObject({
                    decision_type: expect.any(String),
                    model_name:    expect.any(String),
                    output:        expect.any(Object),
                });
            }
        });
    });
});
