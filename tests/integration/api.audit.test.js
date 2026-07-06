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

    it('each decision exposes the methodology config and the input hash', async () => {
        const srcId  = await insertSource('audit-src-5');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        const postId = await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'aud-5' });

        // The helper hashes the generated content with SHA-256 and stores it as
        // decision_audit_log.input_hash for every decision. Recompute it here so
        // the assertion checks the VALUE, not just the field's presence.
        const expectedHash = crypto
            .createHash('sha256')
            .update('Test post aud-5')
            .digest('hex');

        const res = await request(app).get(`/api/audit/${postId}`);
        expect(res.status).toBe(200);

        // Every decision carries its input fingerprint
        for (const decision of res.body.decisions) {
            expect(decision.input_hash).toBe(expectedHash);
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
});
