// tests/integration/api.posts.test.js
// Tests for GET /api/posts/aggregated-by-location
// Verifies: 200 response, correct aggregation by city, ?platform filter.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

describe('GET /api/posts/aggregated-by-location', () => {
    it('returns 200 with an array', async () => {
        const res = await request(app).get('/api/posts/aggregated-by-location');
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
    });

    it('returns empty array when no posts exist', async () => {
        const res = await request(app).get('/api/posts/aggregated-by-location');
        expect(res.body).toEqual([]);
    });

    it('returns a correctly-shaped city object', async () => {
        const srcId = await insertSource('loc-posts-src-1');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, {
            location: 'London', indicator: 'positive', externalId: 'lp-1',
        });

        const res = await request(app).get('/api/posts/aggregated-by-location');

        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({
            city:         'London',
            positive:     expect.any(Number),
            neutral:      expect.any(Number),
            negative:     expect.any(Number),
            total:        expect.any(Number),
            dominant:     expect.any(String),
            last_updated: expect.any(String),
        });
    });

    it('aggregates sentiment counts correctly per city', async () => {
        const srcId = await insertSource('loc-posts-src-2');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        // 3 positive + 1 negative in London
        for (let i = 0; i < 3; i++) {
            await insertPostWithFullPipeline(srcId, jobId, mvIds, {
                location: 'London', indicator: 'positive', externalId: `lp2-pos-${i}`,
            });
        }
        await insertPostWithFullPipeline(srcId, jobId, mvIds, {
            location: 'London', indicator: 'negative', externalId: 'lp2-neg-1',
        });

        const res = await request(app).get('/api/posts/aggregated-by-location');
        const london = res.body.find(c => c.city === 'London');

        expect(london).toBeDefined();
        expect(london.total).toBe(4);
        expect(london.positive).toBe(3);
        expect(london.negative).toBe(1);
        expect(london.dominant).toBe('positive');
    });

    it('returns separate entries for different cities', async () => {
        const srcId = await insertSource('loc-posts-src-3');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        await insertPostWithFullPipeline(srcId, jobId, mvIds, { location: 'Paris',  externalId: 'lp3-1' });
        await insertPostWithFullPipeline(srcId, jobId, mvIds, { location: 'Berlin', externalId: 'lp3-2' });

        const res = await request(app).get('/api/posts/aggregated-by-location');
        const cities = res.body.map(c => c.city);

        expect(cities).toContain('Paris');
        expect(cities).toContain('Berlin');
    });

    it('filters by platform (source category) via ?platform= query param', async () => {
        const socialSrc  = await insertSource('loc-filter-social', 'social');
        const newsSrc    = await insertSource('loc-filter-news',   'news');
        const jobId      = await insertJob();
        const mvIds      = await insertMethodologyVersions();

        await insertPostWithFullPipeline(socialSrc, jobId, mvIds, { location: 'Tokyo',  externalId: 'lf-s1' });
        await insertPostWithFullPipeline(newsSrc,   jobId, mvIds, { location: 'Sydney', externalId: 'lf-n1' });

        const res = await request(app).get('/api/posts/aggregated-by-location?platform=social');
        const cities = res.body.map(c => c.city);

        expect(cities).toContain('Tokyo');
        expect(cities).not.toContain('Sydney');
    });

    it('excludes posts with empty or null location', async () => {
        const srcId = await insertSource('loc-posts-src-4');
        const jobId = await insertJob();
        const mvIds = await insertMethodologyVersions();

        // Post with no location — should not appear in aggregation
        await insertPostWithFullPipeline(srcId, jobId, mvIds, {
            location: '', externalId: 'lp4-empty',
        });

        const res = await request(app).get('/api/posts/aggregated-by-location');
        expect(res.body).toHaveLength(0);
    });
});
