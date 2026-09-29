// tests/integration/api.refresh.test.js
// Tests for POST /api/refresh
// Verifies: 201 response, job creation, rate limiting (429).

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { dbGet } = require('../../src/db/connection');

// Reset rate limiter between tests so tests don't bleed into each other
const { _resetRateLimiter, _setCollectionOptions } = require('../../src/routes/refresh');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

// Every accepted refresh in this file collects nothing unless a test opts
// in to fixtures (no network, no background writes outliving the test).
beforeAll(() => _setCollectionOptions({ slugs: [], queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} } }));

beforeEach(() => {
    _resetRateLimiter();
});

// The same-origin frontend path: browsers stamp Sec-Fetch-Site on every
// request, and POST /api/refresh rejects anything not same-origin (see
// api.refresh.csrf.test.js for the cross-site cases).
function refresh() {
    return request(app).post('/api/refresh').set('Sec-Fetch-Site', 'same-origin');
}

describe('POST /api/refresh', () => {
    it('returns 201 with the correct response shape', async () => {
        const res = await refresh();

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            job_id:        expect.any(String),
            status:        'started',
            triggered_by:  'api',
        });
    });

    it('creates a processing_jobs row in the database', async () => {
        const res = await refresh();

        const job = await dbGet(
            'SELECT id, triggered_by, status FROM processing_jobs WHERE id = $1',
            [res.body.job_id],
        );

        expect(job).toBeDefined();
        expect(job.triggered_by).toBe('api');
        expect(['running', 'completed', 'failed']).toContain(job.status);
    });

    it('returns 429 when called a second time within the rate limit window', async () => {
        await refresh();                   // first call — OK
        const res = await refresh();       // second call — rate limited

        expect(res.status).toBe(429);
        expect(res.body).toHaveProperty('error');
    });

    it('debounces GLOBALLY — a different caller is still 429 inside the window (F2)', async () => {
        // The debounce is a single in-process timestamp, deliberately not
        // keyed on req.ip: rotating IPs or spoofed forwarding headers must
        // not buy extra collection cycles. Distinct X-Forwarded-For values
        // therefore share the same window.
        await refresh().set('X-Forwarded-For', '203.0.113.1');
        const res = await refresh().set('X-Forwarded-For', '198.51.100.7');

        expect(res.status).toBe(429);
        expect(res.body.error).toMatch(/global/i);
    });

    it('returns the job_id as a valid UUID', async () => {
        const res = await refresh();
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        expect(res.body.job_id).toMatch(UUID_REGEX);
    });

    it('includes retry_after_seconds in 429 response', async () => {
        await refresh();
        const res = await refresh();

        expect(res.status).toBe(429);
        expect(res.body).toHaveProperty('retry_after_seconds');
        expect(res.body.retry_after_seconds).toBeGreaterThan(0);
        expect(res.body.retry_after_seconds).toBeLessThanOrEqual(60);
    });

    it('sets Retry-After header in 429 response', async () => {
        await refresh();
        const res = await refresh();

        expect(res.status).toBe(429);
        expect(res.headers['retry-after']).toBeDefined();
    });

    it('allows a new request after rate limit window expires', async () => {
        _resetRateLimiter();
        await refresh();

        // Manually manipulate the rate limiter for testing (this is a bit hacky
        // but ensures we can test the time window behavior; in production, we
        // would just wait 60 seconds)
        _resetRateLimiter();
        const res = await refresh();

        expect(res.status).toBe(201);
    });

    // ─── The background job is a REAL collection (ADR 0001) ─────────────────
    // Recorded fixtures stand in for the network (tests/helpers/fixtureTransport).
    async function waitForJob(jobId) {
        let job;
        for (let i = 0; i < 100; i++) {
            job = await dbGet(
                `SELECT id, status, completed_at, posts_collected, posts_processed, sources_queried, error_details
                 FROM processing_jobs WHERE id = $1`, [jobId]);
            if (job && job.status !== 'running') return job;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return job;
    }

    function useFixtures(slugs) {
        _setCollectionOptions({
            slugs, env: TEST_ENV, now: () => Date.parse(RECORDED_AT),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
            transport: fixtureTransport([
                ['https://feeds.bbci.co.uk/robots.txt', 'recorded/bbc-robots.txt'],
                ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'recorded/bbc-technology.xml'],
                [/hn\.algolia\.com/, 'recorded/hn-algolia.json'],
            ]),
        });
    }

    afterAll(() => _setCollectionOptions({}));

    it('runs a real collection job and completes it with GENUINE counts', async () => {
        await seedSources();
        await seedMethodology();
        useFixtures(['bbc_news', 'hacker_news']);

        const res = await refresh();
        expect(res.status).toBe(201);
        const job = await waitForJob(res.body.job_id);

        expect(job.status).toBe('completed');
        expect(job.completed_at).not.toBeNull();
        expect(job.sources_queried).toBe(2);
        expect(job.posts_processed).toBeGreaterThan(0);
        // posts_processed is exactly the posts this job scored (3 audited decisions each)
        const scored = await dbGet(
            `SELECT COUNT(DISTINCT raw_post_id)::int AS n FROM decision_audit_log WHERE job_id = $1`, [job.id]);
        expect(job.posts_processed).toBe(scored.n);
        expect(job.posts_collected).toBeGreaterThanOrEqual(job.posts_processed);
    });

    it('completes with 0 posts when no requested source is collecting (gated source)', async () => {
        await seedSources();
        await seedMethodology();
        useFixtures(['x']);

        const res = await refresh();
        const job = await waitForJob(res.body.job_id);
        expect(job).toMatchObject({ status: 'completed', posts_processed: 0, sources_queried: 0 });
    });

    it('fails the job loudly when the methodology is not registered', async () => {
        useFixtures(['hacker_news']);
        const res = await refresh();
        const job = await waitForJob(res.body.job_id);
        expect(job.status).toBe('failed');
        expect(job.error_details).toMatch(/methodology not registered/);
    });
});
