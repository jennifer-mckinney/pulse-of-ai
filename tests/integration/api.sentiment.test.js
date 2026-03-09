// tests/integration/api.sentiment.test.js
// Tests for GET /api/sentiment/latest
// Verifies: response shape, summary totals, recent posts, ?limit param.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

describe('GET /api/sentiment/latest', () => {
    it('returns 200 with correct top-level shape', async () => {
        const res = await request(app).get('/api/sentiment/latest');

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            summary:      expect.any(Object),
            recent_posts: expect.any(Array),
            refreshed_at: expect.any(String),
        });
    });

    it('returns zeroed summary when no posts exist', async () => {
        const res = await request(app).get('/api/sentiment/latest');

        expect(res.body.summary).toMatchObject({
            total:    0,
            positive: 0,
            neutral:  0,
            negative: 0,
        });
        expect(res.body.recent_posts).toHaveLength(0);
    });

    it('summary counts match the inserted posts', async () => {
        const srcId = await insertSource('sent-latest-src-1');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        // 2 positive, 1 neutral, 1 negative = 4 total
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { indicator: 'positive', externalId: 'sl-p1' });
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { indicator: 'positive', externalId: 'sl-p2' });
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { indicator: 'neutral',  externalId: 'sl-n1' });
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { indicator: 'negative', externalId: 'sl-ng1' });

        const res = await request(app).get('/api/sentiment/latest');

        expect(res.body.summary.total).toBe(4);
        expect(res.body.summary.positive).toBe(2);
        expect(res.body.summary.neutral).toBe(1);
        expect(res.body.summary.negative).toBe(1);
    });

    it('recent_posts contains correctly shaped post objects', async () => {
        const srcId = await insertSource('sent-latest-src-2');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, {
            location: 'Seoul', indicator: 'positive', externalId: 'sl2-1',
        });

        const res = await request(app).get('/api/sentiment/latest');

        expect(res.body.recent_posts).toHaveLength(1);
        expect(res.body.recent_posts[0]).toMatchObject({
            id:                  expect.any(String),
            content_snippet:     expect.any(String),
            sentiment_indicator: 'positive',
            score:               expect.any(Number),
            comparative:         expect.any(Number),
            location:            'Seoul',
            collected_at:        expect.any(String),
        });
    });

    it('respects the ?limit query param', async () => {
        const srcId = await insertSource('sent-latest-src-3');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        // Insert 5 posts
        for (let i = 0; i < 5; i++) {
            await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: `sl3-${i}` });
        }

        const res = await request(app).get('/api/sentiment/latest?limit=3');
        expect(res.body.recent_posts).toHaveLength(3);
    });

    it('default limit is 20 and does not exceed 100', async () => {
        const srcId = await insertSource('sent-latest-src-4');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        // Insert 25 posts — default limit of 20 should cap the result
        for (let i = 0; i < 25; i++) {
            await insertPostWithFullPipeline(srcId, jobId, mvIds, { externalId: `sl4-${i}` });
        }

        const defaultRes = await request(app).get('/api/sentiment/latest');
        expect(defaultRes.body.recent_posts.length).toBeLessThanOrEqual(20);

        // ?limit=200 should be capped at 100
        const capRes = await request(app).get('/api/sentiment/latest?limit=200');
        expect(capRes.body.recent_posts.length).toBeLessThanOrEqual(100);
    });

    it('avg_comparative is a finite number', async () => {
        const srcId = await insertSource('sent-latest-src-5');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, {
            comparative: 0.4, externalId: 'sl5-1',
        });

        const res = await request(app).get('/api/sentiment/latest');
        expect(typeof res.body.summary.avg_comparative).toBe('number');
        expect(isFinite(res.body.summary.avg_comparative)).toBe(true);
    });
});
