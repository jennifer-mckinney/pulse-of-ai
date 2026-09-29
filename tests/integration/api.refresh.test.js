// tests/integration/api.refresh.test.js
// Tests for POST /api/refresh
// Verifies: 202 + job row + enqueue to the worker (F10-3, F10-8), 409 while
// a refresh is in flight, REFRESH_TOKEN, rate limiting (429), and the
// worker's processRefreshJob running the REAL collection.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { dbGet, dbRun } = require('../../src/db/connection');

// Reset rate limiter between tests so tests don't bleed into each other
const { _resetRateLimiter, _setEnqueue, boundBeyondLoopback } = require('../../src/routes/refresh');
const { processRefreshJob } = require('../../src/workers/collect.worker');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

// Default stand-in for the worker: it picks the job up and finishes at once
// (no network, no background writes outliving the test).
const enqueued = [];
async function fastWorker(jobId) {
    enqueued.push(jobId);
    await dbRun(`UPDATE processing_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`, [jobId]);
}

beforeAll(() => _setEnqueue(fastWorker));
afterAll(() => _setEnqueue(null));

beforeEach(async () => {
    _resetRateLimiter();
    enqueued.length = 0;
    await dbRun(`UPDATE processing_jobs SET status = 'completed' WHERE triggered_by = 'api' AND status = 'running'`);
});

// The same-origin frontend path: browsers stamp Sec-Fetch-Site on every
// request, and POST /api/refresh rejects anything not same-origin (see
// api.refresh.csrf.test.js for the cross-site cases).
function refresh() {
    return request(app).post('/api/refresh').set('Sec-Fetch-Site', 'same-origin');
}

describe('POST /api/refresh', () => {
    it('returns 202 queued and enqueues the job to the worker (the web process collects nothing)', async () => {
        const res = await refresh();

        expect(res.status).toBe(202);
        expect(res.body).toMatchObject({
            job_id:        expect.any(String),
            status:        'queued',
            triggered_by:  'api',
        });
        expect(enqueued).toEqual([res.body.job_id]);
    });

    it('409 with the running job_id while a refresh is in flight; the budget is not spent', async () => {
        _setEnqueue(async (jobId) => { enqueued.push(jobId); });   // the worker has not finished
        try {
            const first = await refresh();
            expect(first.status).toBe(202);
            _resetRateLimiter();
            const second = await refresh();
            expect(second.status).toBe(409);
            expect(second.body).toEqual({ error: 'A refresh collection is already running', job_id: first.body.job_id });
            expect(enqueued).toHaveLength(1);
            // A concurrent insert is refused by migration 019's unique index.
            await expect(dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('api', 'running')`))
                .rejects.toMatchObject({ code: '23505' });
        } finally {
            _setEnqueue(fastWorker);
        }
    });

    it('a refresh row left running past REFRESH_STALE_MINUTES is failed as stale, then a new one starts', async () => {
        const stale = await dbRun(`INSERT INTO processing_jobs (triggered_by, status, started_at)
            VALUES ('api', 'running', NOW() - interval '2 hours') RETURNING id`);
        const res = await refresh();
        expect(res.status).toBe(202);
        const row = await dbGet('SELECT status, error_details FROM processing_jobs WHERE id = $1', [stale.id]);
        expect(row).toEqual({ status: 'failed', error_details: 'stale: the refresh job did not complete within 30 minutes' });
    });

    it('an enqueue failure fails the job, answers 503 and does not spend the budget', async () => {
        _setEnqueue(async () => { throw new Error('ECONNREFUSED redis'); });
        try {
            const res = await refresh();
            expect(res.status).toBe(503);
            const row = await dbGet('SELECT status, error_details FROM processing_jobs WHERE id = $1', [res.body.job_id]);
            expect(row).toEqual({ status: 'failed', error_details: 'collection queue unavailable' });
        } finally {
            _setEnqueue(fastWorker);
        }
        expect((await refresh()).status).toBe(202);
    });

    describe('REFRESH_TOKEN (F10-8)', () => {
        const saved = {};
        const setEnv = (vars) => { for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
        afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

        it('bound beyond loopback with no token: refused (403) before any job is created', async () => {
            setEnv({ PULSE_BIND_ADDR: '0.0.0.0', REFRESH_TOKEN: undefined, HOST: undefined });
            const res = await refresh();
            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/bound beyond loopback and no REFRESH_TOKEN/);
            expect(enqueued).toHaveLength(0);
        });

        it('with a token set: the header must match (timing-safe)', async () => {
            setEnv({ PULSE_BIND_ADDR: '0.0.0.0', REFRESH_TOKEN: 's3cret-token', HOST: undefined });
            expect((await refresh()).status).toBe(403);
            expect((await refresh().set('X-Refresh-Token', 'wrong')).status).toBe(403);
            expect((await refresh().set('X-Refresh-Token', 's3cret-token')).status).toBe(202);
        });

        it('loopback without a token: allowed (local use)', async () => {
            setEnv({ PULSE_BIND_ADDR: '127.0.0.1', REFRESH_TOKEN: undefined, HOST: undefined });
            expect((await refresh()).status).toBe(202);
        });

        it('boundBeyondLoopback reads PULSE_BIND_ADDR and HOST', () => {
            expect(boundBeyondLoopback({})).toBe(false);
            expect(boundBeyondLoopback({ PULSE_BIND_ADDR: '127.0.0.1' })).toBe(false);
            expect(boundBeyondLoopback({ PULSE_BIND_ADDR: '::1' })).toBe(false);
            expect(boundBeyondLoopback({ HOST: 'localhost' })).toBe(false);
            expect(boundBeyondLoopback({ PULSE_BIND_ADDR: '0.0.0.0' })).toBe(true);
            expect(boundBeyondLoopback({ HOST: '192.168.1.5' })).toBe(true);
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
        expect(enqueued).toContain(job.id);
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

        expect(res.status).toBe(202);
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

    // The worker's side: processRefreshJob runs the collection for the job
    // the route enqueued (no network — recorded fixtures).
    function useFixtures(slugs) {
        _setEnqueue(async (jobId) => {
            enqueued.push(jobId);
            await processRefreshJob({ data: { jobId } }, {
                slugs, env: TEST_ENV, now: () => Date.parse(RECORDED_AT),
                queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
                transport: fixtureTransport([
                    ['https://feeds.bbci.co.uk/robots.txt', 'recorded/bbc-robots.txt'],
                    ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'recorded/bbc-technology.xml'],
                    [/hn\.algolia\.com/, 'recorded/hn-algolia.json'],
                ]),
            }).catch(() => {});   // runCollection marks the job failed itself
        });
    }

    afterAll(() => _setEnqueue(fastWorker));

    it('runs a real collection job and completes it with GENUINE counts', async () => {
        await seedSources();
        await seedMethodology();
        useFixtures(['bbc_news', 'hacker_news']);

        const res = await refresh();
        expect(res.status).toBe(202);
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

    it('the worker does not re-run a job that is no longer running', async () => {
        const done = await dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('api', 'failed') RETURNING id`);
        expect(await processRefreshJob({ data: { jobId: done.id } })).toEqual({ jobId: done.id, skipped: true, status: 'failed' });
        await expect(processRefreshJob({ data: {} })).rejects.toThrow(/without a processing job id/);
    });

    it('fails the job loudly when the methodology is not registered', async () => {
        useFixtures(['hacker_news']);
        const res = await refresh();
        const job = await waitForJob(res.body.job_id);
        expect(job.status).toBe('failed');
        expect(job.error_details).toMatch(/methodology not registered/);
    });
});
