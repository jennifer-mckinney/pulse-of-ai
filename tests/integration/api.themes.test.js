// tests/integration/api.themes.test.js
// Tests for GET /api/themes
// Verifies: keyword aggregation with sentiment splits, modal category with
// alphabetical tie-break, volume ordering, volume-<3 noise exclusion, empty → [].

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

describe('GET /api/themes', () => {
    it('returns 200 with an empty array when no relevance results exist', async () => {
        const res = await request(app).get('/api/themes');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('aggregates keywords with sentiment splits, modal category, and volume ordering', async () => {
        const news   = await insertSource('themes-news',   'news');
        const social = await insertSource('themes-social', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        // "regulation": 4 posts — 2 news / 2 social (tie → alphabetical → 'news'),
        // sentiment split 2 positive / 1 neutral / 1 negative
        await insertPostWithFullPipeline(news, jobId, mvIds,
            { indicator: 'positive', externalId: 'th-r1', keywords: ['regulation'] });
        await insertPostWithFullPipeline(news, jobId, mvIds,
            { indicator: 'positive', externalId: 'th-r2', keywords: ['regulation'] });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'neutral', externalId: 'th-r3', keywords: ['regulation', 'ethics'] });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'negative', externalId: 'th-r4', keywords: ['regulation'] });

        // "jobs": 3 posts, all social, all negative
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'negative', externalId: 'th-j1', keywords: ['jobs'] });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'negative', externalId: 'th-j2', keywords: ['jobs'] });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'negative', externalId: 'th-j3', keywords: ['jobs', 'ethics'] });

        const res = await request(app).get('/api/themes');
        expect(res.status).toBe(200);

        // "ethics" appears on only 2 posts → excluded by the volume >= 3 noise guard.
        // Remaining themes ordered by volume desc: regulation (4) then jobs (3).
        expect(res.body).toEqual([
            {
                keyword:      'regulation',
                volume:       4,
                positive:     2,
                neutral:      1,
                negative:     1,
                top_category: 'news',
            },
            {
                keyword:      'jobs',
                volume:       3,
                positive:     0,
                neutral:      0,
                negative:     3,
                top_category: 'social',
            },
        ]);
    });

    it('picks the strictly modal category when there is no tie', async () => {
        const news   = await insertSource('themes-news-2',   'news');
        const social = await insertSource('themes-social-2', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        // "safety": 2 social + 1 news → modal category is social (beats alphabetical)
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'neutral', externalId: 'th-s1', keywords: ['safety'] });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'neutral', externalId: 'th-s2', keywords: ['safety'] });
        await insertPostWithFullPipeline(news, jobId, mvIds,
            { indicator: 'neutral', externalId: 'th-s3', keywords: ['safety'] });

        const res = await request(app).get('/api/themes');
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({
            keyword:      'safety',
            volume:       3,
            top_category: 'social',
        });
    });

    it('excludes keywords with volume below 3', async () => {
        const social = await insertSource('themes-social-3', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        await insertPostWithFullPipeline(social, jobId, mvIds,
            { externalId: 'th-n1', keywords: ['niche'] });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { externalId: 'th-n2', keywords: ['niche'] });

        const res = await request(app).get('/api/themes');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });
});
