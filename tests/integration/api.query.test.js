// tests/integration/api.query.test.js
// Tests for POST /api/query
// Verifies: returns filtered results, date/platform filters, validation errors.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

describe('POST /api/query', () => {
    it('returns 200 with correct top-level shape', async () => {
        const res = await request(app)
            .post('/api/query')
            .send({});

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            results: expect.any(Array),
            total:   expect.any(Number),
            query:   expect.any(Object),
        });
    });

    it('returns all posts when no filters are provided', async () => {
        const srcId = await insertSource('query-src-1');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'q1-a' });
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'q1-b' });

        const res = await request(app).post('/api/query').send({});
        expect(res.body.total).toBe(2);
    });

    it('filters by platform (source category)', async () => {
        const social = await insertSource('query-social', 'social');
        const news   = await insertSource('query-news',   'news');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        await insertPostWithFullPipeline(social, jobId, mvIds, { externalId: 'qp-s1' });
        await insertPostWithFullPipeline(news,   jobId, mvIds, { externalId: 'qp-n1' });

        const res = await request(app).post('/api/query').send({ platform: 'social' });

        expect(res.body.total).toBe(1);
        expect(res.body.results[0]).toMatchObject({
            platform: 'social',
        });
    });

    it('respects the limit field', async () => {
        const srcId = await insertSource('query-src-2');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        for (let i = 0; i < 5; i++) {
            await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: `ql-${i}` });
        }

        const res = await request(app).post('/api/query').send({ limit: 2 });
        expect(res.body.results).toHaveLength(2);
    });

    it('returns 400 when limit exceeds 100', async () => {
        const res = await request(app).post('/api/query').send({ limit: 500 });
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 for invalid from date', async () => {
        const res = await request(app).post('/api/query').send({ from: 'not-a-date' });
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('returns 400 for invalid to date', async () => {
        const res = await request(app).post('/api/query').send({ to: 'not-a-date' });
        expect(res.status).toBe(400);
        expect(res.body).toHaveProperty('error');
    });

    it('each result has the correct shape', async () => {
        const srcId = await insertSource('query-src-3');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, {
            location: 'Mumbai', indicator: 'positive', externalId: 'qshape-1',
        });

        const res = await request(app).post('/api/query').send({});

        expect(res.body.results[0]).toMatchObject({
            id:           expect.any(String),
            content_snippet: expect.any(String),
            indicator:    expect.any(String),
            comparative:  expect.any(Number),
            location:     'Mumbai',
            platform:     expect.any(String),
            collected_at: expect.any(String),
        });
    });

    it('query object in response echoes back the applied filters', async () => {
        const res = await request(app).post('/api/query').send({ platform: 'social', limit: 10 });

        expect(res.body.query).toMatchObject({
            platform: 'social',
            limit:    10,
        });
    });

    // ─── location filter ──────────────────────────────────────────────────────

    it('filters by location (exact match) and echoes it in query', async () => {
        const srcId = await insertSource('query-loc-1');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, { location: 'Mumbai', externalId: 'qloc-m1' });
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { location: 'Mumbai', externalId: 'qloc-m2' });
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { location: 'London', externalId: 'qloc-l1' });

        const res = await request(app).post('/api/query').send({ location: 'Mumbai' });

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(2);
        for (const row of res.body.results) {
            expect(row.location).toBe('Mumbai');
        }
        expect(res.body.query.location).toBe('Mumbai');
    });

    it('location filter combines with platform and limit', async () => {
        const social = await insertSource('query-loc-social', 'social');
        const news   = await insertSource('query-loc-news',   'news');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        // Three Mumbai/social posts, one Mumbai/news post, one London/social post
        await insertPostWithFullPipeline(social, jobId, mvIds, { location: 'Mumbai', externalId: 'qlc-s1' });
        await insertPostWithFullPipeline(social, jobId, mvIds, { location: 'Mumbai', externalId: 'qlc-s2' });
        await insertPostWithFullPipeline(social, jobId, mvIds, { location: 'Mumbai', externalId: 'qlc-s3' });
        await insertPostWithFullPipeline(news,   jobId, mvIds, { location: 'Mumbai', externalId: 'qlc-n1' });
        await insertPostWithFullPipeline(social, jobId, mvIds, { location: 'London', externalId: 'qlc-s4' });

        const res = await request(app)
            .post('/api/query')
            .send({ location: 'Mumbai', platform: 'social', limit: 2 });

        expect(res.status).toBe(200);
        expect(res.body.results).toHaveLength(2);
        for (const row of res.body.results) {
            expect(row.location).toBe('Mumbai');
            expect(row.platform).toBe('social');
        }
        expect(res.body.query).toMatchObject({ location: 'Mumbai', platform: 'social', limit: 2 });
    });

    it('behaves unchanged when location is absent (echoed as null)', async () => {
        const srcId = await insertSource('query-loc-2');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, { location: 'Mumbai', externalId: 'qla-1' });
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { location: 'London', externalId: 'qla-2' });

        const res = await request(app).post('/api/query').send({});

        expect(res.status).toBe(200);
        expect(res.body.total).toBe(2);
        expect(res.body.query.location).toBeNull();
    });

    it('returns 400 when location is not a string', async () => {
        const res = await request(app).post('/api/query').send({ location: 123 });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'location must be a string' });
    });

    it('returns 400 when location is an empty string', async () => {
        // '' is falsy, so without an explicit guard it silently skipped the
        // filter and returned ALL posts — a caller error must fail loudly.
        const res = await request(app).post('/api/query').send({ location: '' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'location must be a non-empty string' });
    });

    it('returns 400 when location is whitespace-only', async () => {
        const res = await request(app).post('/api/query').send({ location: '   ' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'location must be a non-empty string' });
    });

    it('returns 400 when limit is 0', async () => {
        const res = await request(app).post('/api/query').send({ limit: 0 });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'limit must be a positive integer' });
    });

    it('returns 400 when limit is negative', async () => {
        const res = await request(app).post('/api/query').send({ limit: -5 });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'limit must be a positive integer' });
    });

    it('returns 400 when limit is not numeric', async () => {
        const res = await request(app).post('/api/query').send({ limit: 'not-a-number' });
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ error: 'limit must be a positive integer' });
    });

    it('filters by from date only', async () => {
        const srcId = await insertSource('query-from');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        // Create posts at different times
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'qfrom-1' });
        
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 86400000); // 1 day ago
        const from = oneDayAgo.toISOString();

        const res = await request(app).post('/api/query').send({ from });
        
        expect(res.status).toBe(200);
        expect(res.body.query.from).toBe(from);
        expect(res.body.results).toBeDefined();
    });

    it('filters by to date only', async () => {
        const srcId = await insertSource('query-to');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'qto-1' });
        
        const now = new Date();
        const to = now.toISOString();

        const res = await request(app).post('/api/query').send({ to });
        
        expect(res.status).toBe(200);
        expect(res.body.query.to).toBe(to);
        expect(res.body.results).toBeDefined();
    });

    it('filters by both from and to dates', async () => {
        const srcId = await insertSource('query-from-to');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: 'qft-1' });
        
        const now = new Date();
        const oneDayAgo = new Date(now.getTime() - 86400000);
        const from = oneDayAgo.toISOString();
        const to = now.toISOString();

        const res = await request(app).post('/api/query').send({ from, to });
        
        expect(res.status).toBe(200);
        expect(res.body.query.from).toBe(from);
        expect(res.body.query.to).toBe(to);
        expect(res.body.results).toBeDefined();
    });
});
