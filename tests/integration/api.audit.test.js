// tests/integration/api.audit.test.js
// Tests for GET /api/audit/:post_id
// Verifies: full decision trail, 404 for unknown post, 400 for invalid UUID.

'use strict';

const crypto  = require('crypto');
const request = require('supertest');
const app     = require('../../src/server');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

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
