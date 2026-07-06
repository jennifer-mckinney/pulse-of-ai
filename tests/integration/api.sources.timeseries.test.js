// tests/integration/api.sources.timeseries.test.js
// Tests for GET /api/sources/timeseries
// Verifies: hourly buckets per source category, zero-fill, hours clamp, validation.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

// Floor a Date to the start of its hour — mirrors PostgreSQL date_trunc('hour', ...)
function hourFloor(date) {
    const d = new Date(date);
    d.setMinutes(0, 0, 0);
    return d;
}

// Minutes-ago helper for controlled collected_at timestamps
function minutesAgo(mins) {
    return new Date(Date.now() - mins * 60 * 1000);
}

describe('GET /api/sources/timeseries', () => {
    it('returns 200 with an empty array when no posts exist', async () => {
        const res = await request(app).get('/api/sources/timeseries');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('groups sentiment counts into hourly buckets per category', async () => {
        const social = await insertSource('ts-social', 'social');
        const news   = await insertSource('ts-news',   'news');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        const recent = minutesAgo(5);       // current-ish bucket
        const older  = minutesAgo(125);     // 2+ hours back

        // social: two positive posts in the recent bucket, one negative 2h back
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'positive', externalId: 'ts-s1', collectedAt: recent });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'positive', externalId: 'ts-s2', collectedAt: recent });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'negative', externalId: 'ts-s3', collectedAt: older });

        // news: one neutral post in the recent bucket
        await insertPostWithFullPipeline(news, jobId, mvIds,
            { indicator: 'neutral', externalId: 'ts-n1', collectedAt: recent });

        const res = await request(app).get('/api/sources/timeseries');
        expect(res.status).toBe(200);

        // Categories ordered alphabetically: news before social
        expect(res.body.map(e => e.category)).toEqual(['news', 'social']);

        const socialEntry = res.body.find(e => e.category === 'social');
        const newsEntry   = res.body.find(e => e.category === 'news');

        const recentIso = hourFloor(recent).toISOString();
        const olderIso  = hourFloor(older).toISOString();

        const socialRecent = socialEntry.series.find(b => b.hour === recentIso);
        expect(socialRecent).toMatchObject({ positive: 2, neutral: 0, negative: 0, total: 2 });

        const socialOlder = socialEntry.series.find(b => b.hour === olderIso);
        expect(socialOlder).toMatchObject({ positive: 0, neutral: 0, negative: 1, total: 1 });

        const newsRecent = newsEntry.series.find(b => b.hour === recentIso);
        expect(newsRecent).toMatchObject({ positive: 0, neutral: 1, negative: 0, total: 1 });
    });

    it('returns exactly `hours` zero-filled hourly buckets, oldest to newest', async () => {
        const social = await insertSource('ts-zf', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        // Single post — every other bucket in the window must still be present, zeroed
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'positive', externalId: 'ts-zf1', collectedAt: minutesAgo(5) });

        const res = await request(app).get('/api/sources/timeseries');   // default 12h
        expect(res.status).toBe(200);

        const { series } = res.body.find(e => e.category === 'social');
        expect(series).toHaveLength(12);

        // Buckets are consecutive hours in ascending order
        for (let i = 1; i < series.length; i++) {
            const prev = new Date(series[i - 1].hour).getTime();
            const curr = new Date(series[i].hour).getTime();
            expect(curr - prev).toBe(60 * 60 * 1000);
        }

        // Exactly one bucket has data; all others are zero-filled
        const nonEmpty = series.filter(b => b.total > 0);
        expect(nonEmpty).toHaveLength(1);
        for (const bucket of series.filter(b => b.total === 0)) {
            expect(bucket).toMatchObject({ positive: 0, neutral: 0, negative: 0, total: 0 });
        }
    });

    it('respects the hours param and excludes posts outside the window', async () => {
        const social = await insertSource('ts-window', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'positive', externalId: 'ts-w1', collectedAt: minutesAgo(5) });
        // 125 minutes back — always outside a 2-bucket window
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { indicator: 'negative', externalId: 'ts-w2', collectedAt: minutesAgo(125) });

        const res = await request(app).get('/api/sources/timeseries?hours=2');
        expect(res.status).toBe(200);

        const { series } = res.body.find(e => e.category === 'social');
        expect(series).toHaveLength(2);

        const totals = series.reduce((sum, b) => sum + b.total, 0);
        expect(totals).toBe(1);   // only the recent post is inside the window
    });

    it('omits categories with zero posts in the window', async () => {
        const academic = await insertSource('ts-academic', 'academic');
        const social   = await insertSource('ts-social-2', 'social');
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        // academic post far outside any allowed window (max clamp is 48h)
        await insertPostWithFullPipeline(academic, jobId, mvIds,
            { externalId: 'ts-o1', collectedAt: minutesAgo(60 * 60) });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { externalId: 'ts-o2', collectedAt: minutesAgo(5) });

        const res = await request(app).get('/api/sources/timeseries');
        expect(res.status).toBe(200);
        expect(res.body.map(e => e.category)).toEqual(['social']);
    });

    it('clamps hours above 48 down to 48', async () => {
        const social = await insertSource('ts-clamp-hi', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { externalId: 'ts-c1', collectedAt: minutesAgo(5) });

        const res = await request(app).get('/api/sources/timeseries?hours=500');
        expect(res.status).toBe(200);
        expect(res.body.find(e => e.category === 'social').series).toHaveLength(48);
    });

    it('clamps hours below 1 up to 1', async () => {
        const social = await insertSource('ts-clamp-lo', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { externalId: 'ts-c2', collectedAt: minutesAgo(5) });

        const res = await request(app).get('/api/sources/timeseries?hours=0');
        expect(res.status).toBe(200);
        expect(res.body.find(e => e.category === 'social').series).toHaveLength(1);
    });

    it('returns 400 for non-integer hours', async () => {
        const bad1 = await request(app).get('/api/sources/timeseries?hours=abc');
        expect(bad1.status).toBe(400);
        expect(bad1.body).toHaveProperty('error');

        const bad2 = await request(app).get('/api/sources/timeseries?hours=1.5');
        expect(bad2.status).toBe(400);
        expect(bad2.body).toHaveProperty('error');
    });
});
