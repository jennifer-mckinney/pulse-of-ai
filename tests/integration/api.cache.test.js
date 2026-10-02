// tests/integration/api.cache.test.js
// F3 — in-process response cache on the hot read-only aggregations.
//
// The cache is BYPASSED under NODE_ENV=test by default (every other suite
// mutates the DB between requests and must see fresh reads); this suite is
// the one that targets the cache, so it re-enables it via _setTestBypass and
// restores the bypass afterwards.

'use strict';

const { useServer, withServer } = require('../helpers/server');
const app     = require('../../src/server');
const request = useServer(app);   // one listener per file (tests/helpers/server.js)
const { responseCache, _setTestBypass, _clear } = require('../../src/middleware/response-cache');
const {
    insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline,
} = require('./helpers');

describe('response cache (F3)', () => {
    beforeEach(() => {
        _setTestBypass(false);   // this suite targets the cache
        _clear();
    });

    afterAll(() => {
        _setTestBypass(true);    // restore the default test bypass
        _clear();
    });

    it('serves the second identical GET from cache (miss then hit)', async () => {
        const first = await request().get('/api/posts/aggregated-by-location');
        expect(first.status).toBe(200);
        expect(first.headers['x-response-cache']).toBe('miss');

        const second = await request().get('/api/posts/aggregated-by-location');
        expect(second.status).toBe(200);
        expect(second.headers['x-response-cache']).toBe('hit');
        expect(second.body).toEqual(first.body);
    });

    it('does not reflect a DB write inside the TTL, then does after _clear', async () => {
        const sourceId = await insertSource('cache-src');
        const jobId    = await insertJob();
        const mvIds    = await insertMethodologyVersions();

        const before = await request().get('/api/posts/aggregated-by-location');
        expect(before.headers['x-response-cache']).toBe('miss');

        await insertPostWithFullPipeline(sourceId, jobId, mvIds, { location: 'Berlin' });

        // Inside the TTL: cached body, new post invisible — the accepted
        // trade-off (10s staleness vs a 2-3 minute data cycle).
        const cached = await request().get('/api/posts/aggregated-by-location');
        expect(cached.headers['x-response-cache']).toBe('hit');
        expect(cached.body).toEqual(before.body);

        // After expiry (simulated via _clear): the write is visible.
        _clear();
        const fresh = await request().get('/api/posts/aggregated-by-location');
        expect(fresh.headers['x-response-cache']).toBe('miss');
        expect(fresh.body.some((c) => c.city === 'Berlin')).toBe(true);
    });

    it('caches per query-string, not per path', async () => {
        await request().get('/api/sources/timeseries?hours=2');
        const other = await request().get('/api/sources/timeseries?hours=3');
        expect(other.headers['x-response-cache']).toBe('miss');   // different key
        const same = await request().get('/api/sources/timeseries?hours=3');
        expect(same.headers['x-response-cache']).toBe('hit');
        expect(same.body[0].series).toHaveLength(3);
    });

    it('covers all three hot endpoints, and expiry works without _clear', async () => {
        // 50ms TTL exercised directly on the factory (the mounted routes use
        // 10s — too slow for a test): build a tiny app around the middleware.
        const express = require('express');
        const mini = express();
        let calls = 0;
        mini.get('/x', responseCache(50), (req, res) => res.json({ calls: ++calls }));

        // One listener for the three requests (tests/helpers/server.js).
        await withServer(mini, async (miniRequest) => {
            const a = await miniRequest().get('/x');
            const b = await miniRequest().get('/x');
            expect(a.body.calls).toBe(1);
            expect(b.body.calls).toBe(1);              // cached
            await new Promise((r) => setTimeout(r, 60));
            const c = await miniRequest().get('/x');
            expect(c.body.calls).toBe(2);              // TTL expired → re-computed
        });

        // /api/themes carries the middleware too.
        const t1 = await request().get('/api/themes');
        const t2 = await request().get('/api/themes');
        expect(t1.headers['x-response-cache']).toBe('miss');
        expect(t2.headers['x-response-cache']).toBe('hit');
    });

    it('does not cache non-200 responses', async () => {
        const bad = await request().get('/api/sources/timeseries?hours=nope');
        expect(bad.status).toBe(400);
        const again = await request().get('/api/sources/timeseries?hours=nope');
        expect(again.status).toBe(400);
        expect(again.headers['x-response-cache']).not.toBe('hit');
    });

    // PR #22 security L2: /api/health fans out to Redis and Postgres; a 5 s
    // cache keyed on the path alone bounds unauthenticated load.
    describe('/api/health (security L2)', () => {
        const health = require('../../src/routes/health');
        beforeEach(() => health._setQueueCountsForTests(async () => ({})));
        afterEach(() => { health._setRedisClientForTests(null); health._setQueueCountsForTests(null); });

        it('caches for 5 s: the second call does not touch Redis or the database', async () => {
            expect(health.HEALTH_CACHE_TTL_MS).toBeGreaterThanOrEqual(5000);
            expect(health.HEALTH_CACHE_TTL_MS).toBeLessThanOrEqual(10000);
            const ping = jest.fn(async () => 'PONG');
            health._setRedisClientForTests({ ping, get: async () => null });
            const first = await request().get('/api/health');
            expect(first.headers['x-response-cache']).toBe('miss');
            const job = await insertJob('completed', { postsProcessed: 9 });
            const second = await request().get('/api/health');
            expect(second.headers['x-response-cache']).toBe('hit');
            expect(second.body).toEqual(first.body);
            expect(second.body.last_job).toBeNull();          // the write inside the TTL is not visible
            expect(ping).toHaveBeenCalledTimes(1);
            _clear();
            const third = await request().get('/api/health');
            expect(third.body.last_job.id).toBe(job);
        });

        it('a varying query string cannot bypass the cache', async () => {
            const ping = jest.fn(async () => 'PONG');
            health._setRedisClientForTests({ ping, get: async () => null });
            await request().get('/api/health');
            for (let i = 0; i < 5; i++) {
                const r = await request().get(`/api/health?bust=${i}`);
                expect(r.headers['x-response-cache']).toBe('hit');
            }
            expect(ping).toHaveBeenCalledTimes(1);
        });

        it('expires after the TTL', async () => {
            const realNow = Date.now;
            const ping = jest.fn(async () => 'PONG');
            health._setRedisClientForTests({ ping, get: async () => null });
            try {
                await request().get('/api/health');
                const t = realNow();
                Date.now = () => t + health.HEALTH_CACHE_TTL_MS + 1;
                const r = await request().get('/api/health');
                expect(r.headers['x-response-cache']).toBe('miss');
                expect(ping).toHaveBeenCalledTimes(2);
            } finally {
                Date.now = realNow;
            }
        });
    });
});
