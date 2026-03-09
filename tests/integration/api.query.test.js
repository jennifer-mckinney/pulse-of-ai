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
});
