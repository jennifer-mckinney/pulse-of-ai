// tests/integration/api.sources.timeseries.test.js
// Tests for GET /api/sources/timeseries
// Verifies: canonical category enumeration (one row per canon category,
// always — forums honest zero), hourly buckets, zero-fill, hours clamp,
// validation.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');
const { CATEGORY_SLUGS } = require('../../src/config/categories');

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
    it('enumerates every canonical category (all-zero series) even when no posts exist', async () => {
        // Enumeration comes from the canon config, never SELECT DISTINCT
        // over the data — an empty DB still serves the full taxonomy as
        // honest zeros.
        const res = await request(app).get('/api/sources/timeseries');
        expect(res.status).toBe(200);
        expect(res.body.map(e => e.category)).toEqual(CATEGORY_SLUGS);
        for (const entry of res.body) {
            expect(entry.top_site).toBeNull();
            expect(entry.words).toEqual([]);
            expect(entry.series).toHaveLength(12);
            expect(entry.series.every(b => b.total === 0)).toBe(true);
        }
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

        // One row per canonical category, in canon (registry) order
        expect(res.body.map(e => e.category)).toEqual(CATEGORY_SLUGS);

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

    it('serves categories with zero posts in the window as honest all-zero series', async () => {
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
        expect(res.body.map(e => e.category)).toEqual(CATEGORY_SLUGS);
        const academicEntry = res.body.find(e => e.category === 'academic');
        expect(academicEntry.series.every(b => b.total === 0)).toBe(true);
        expect(academicEntry.top_site).toBeNull();
        const socialEntry = res.body.find(e => e.category === 'social');
        expect(socialEntry.series.some(b => b.total > 0)).toBe(true);
    });

    it('forums is first-class canon with honest zeros — never invented volume', async () => {
        // Forums has ZERO seeded sources by design (the prototype renders
        // the category; the top-50 registry carries no forum source). It
        // must still enumerate — all-zero series, no top_site, no words.
        const social = await insertSource('ts-forums-peer', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { externalId: 'ts-fz1', collectedAt: minutesAgo(5) });

        const res = await request(app).get('/api/sources/timeseries');
        expect(res.status).toBe(200);
        const forums = res.body.find(e => e.category === 'forums');
        expect(forums).toBeDefined();
        expect(forums.top_site).toBeNull();
        expect(forums.words).toEqual([]);
        expect(forums.series).toHaveLength(12);
        expect(forums.series.every(
            b => b.positive === 0 && b.neutral === 0 && b.negative === 0
                && b.total === 0)).toBe(true);
    });

    it('never serves a non-canonical category (and future rows cannot leak counts)', async () => {
        const future = await insertSource('ts-future',  'futurecat');
        const social = await insertSource('ts-present', 'social');
        const jobId  = await insertJob();
        const mvIds  = await insertMethodologyVersions();

        // Future-timestamped row (bad upstream clock / ingestion bug), 2h
        // ahead, in a NON-canonical category: the canon enumeration never
        // serves 'futurecat', and the counts upper bound keeps the future
        // row out of every returned bucket.
        await insertPostWithFullPipeline(future, jobId, mvIds,
            { externalId: 'ts-f1', collectedAt: new Date(Date.now() + 2 * 60 * 60 * 1000) });
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { externalId: 'ts-f2', collectedAt: minutesAgo(5) });

        const res = await request(app).get('/api/sources/timeseries');
        expect(res.status).toBe(200);
        expect(res.body.map(e => e.category)).toEqual(CATEGORY_SLUGS);
        expect(res.body.some(e => e.category === 'futurecat')).toBe(false);
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
        // Hour-aligned INSIDE the current hour — a 1-bucket window only spans
        // the current clock hour, so minutesAgo(5) landed in the PREVIOUS
        // hour whenever the test ran in an hour's first five minutes (flaky
        // near rollovers). The bucket start is inside the window by
        // construction, whatever the wall clock says.
        await insertPostWithFullPipeline(social, jobId, mvIds,
            { externalId: 'ts-c2', collectedAt: hourFloor(new Date()) });

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

    // ─── Ribbon metadata: busiest source + cue words per category ─────────────

    describe('ribbon metadata (top_site + words)', () => {
        it('top_site is the display name of the category\'s busiest source in the window', async () => {
            const busy  = await insertSource('ts-site-busy',  'social');
            const quiet = await insertSource('ts-site-quiet', 'social');
            const jobId = await insertJob();
            const mvIds = await insertMethodologyVersions();

            // busy: 2 posts, quiet: 1 post — busy wins
            await insertPostWithFullPipeline(busy, jobId, mvIds,
                { externalId: 'tsb-1', collectedAt: minutesAgo(5) });
            await insertPostWithFullPipeline(busy, jobId, mvIds,
                { externalId: 'tsb-2', collectedAt: minutesAgo(10) });
            await insertPostWithFullPipeline(quiet, jobId, mvIds,
                { externalId: 'tsq-1', collectedAt: minutesAgo(5) });

            const res = await request(app).get('/api/sources/timeseries');
            const social = res.body.find(e => e.category === 'social');
            // insertSource sets display_name = name
            expect(social.top_site).toBe('ts-site-busy');
        });

        it('words are the category\'s two most-matched relevance keywords in the window', async () => {
            const src   = await insertSource('ts-words-src', 'news');
            const jobId = await insertJob();
            const mvIds = await insertMethodologyVersions();

            // "regulation" 3×, "safety" 2×, "misc" 1× → top-2 = regulation, safety
            for (let i = 0; i < 3; i++) {
                await insertPostWithFullPipeline(src, jobId, mvIds, {
                    externalId: `tsw-r${i}`, collectedAt: minutesAgo(5),
                    keywords: ['regulation'],
                });
            }
            for (let i = 0; i < 2; i++) {
                await insertPostWithFullPipeline(src, jobId, mvIds, {
                    externalId: `tsw-s${i}`, collectedAt: minutesAgo(10),
                    keywords: ['safety'],
                });
            }
            await insertPostWithFullPipeline(src, jobId, mvIds, {
                externalId: 'tsw-m0', collectedAt: minutesAgo(15),
                keywords: ['misc'],
            });

            const res = await request(app).get('/api/sources/timeseries');
            const news = res.body.find(e => e.category === 'news');
            expect(news.words).toEqual(['regulation', 'safety']);
        });

        it('words is [] and top_site still set for categories whose posts matched no keywords', async () => {
            const { dbRun } = require('../../src/db/connection');
            const crypto2   = require('crypto');
            const src   = await insertSource('ts-nokw-src', 'policy');
            const jobId = await insertJob();
            const mvIds = await insertMethodologyVersions();

            // Sentiment-scored post with NO relevance row at all
            const content = 'No-keyword post';
            const hash    = crypto2.createHash('sha256').update(content).digest('hex');
            const post = await dbRun(
                `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, collected_at)
                 VALUES ($1, 'tsnk-1', $2, $3, 'London', $4) RETURNING id`,
                [src, content, hash, minutesAgo(5).toISOString()],
            );
            const audit = await dbRun(
                `INSERT INTO decision_audit_log
                    (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output)
                 VALUES ($1, $2, $3, 'sentiment', 'afinn-sentiment-v5', $4, '{}'::jsonb)
                 RETURNING id`,
                [post.id, jobId, mvIds.sentimentMvId, hash],
            );
            await dbRun(
                `INSERT INTO sentiment_results
                    (raw_post_id, audit_id, score, comparative, indicator, positive_words, negative_words, token_count)
                 VALUES ($1, $2, 1, 0.1, 'positive', '{}', '{}', 5)`,
                [post.id, audit.id],
            );

            const res = await request(app).get('/api/sources/timeseries');
            const policy = res.body.find(e => e.category === 'policy');
            expect(policy.top_site).toBe('ts-nokw-src');
            expect(policy.words).toEqual([]);
        });
    });
});
