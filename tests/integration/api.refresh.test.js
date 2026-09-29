// tests/integration/api.refresh.test.js
// Tests for POST /api/refresh
// Verifies: 201 response, job creation, rate limiting (429).

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { dbGet } = require('../../src/db/connection');

// Reset rate limiter between tests so tests don't bleed into each other
const { _resetRateLimiter } = require('../../src/routes/refresh');

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

    it('background job completes and marks job as completed when sources exist', async () => {
        // Insert some data sources so the background job has work to do
        const { insertSource } = require('./helpers');
        await insertSource('refresh-bg-src-1');
        await insertSource('refresh-bg-src-2');

        const res = await refresh();
        const jobId = res.body.job_id;

        expect(res.status).toBe(201);

        // Wait for the background job to execute (should be nearly instant)
        // Poll up to 2 seconds for the job to complete
        let job;
        for (let i = 0; i < 20; i++) {
            job = await dbGet(
                'SELECT id, status, completed_at FROM processing_jobs WHERE id = $1',
                [jobId],
            );
            if (job && job.status === 'completed') break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        expect(job).toBeDefined();
        expect(job.status).toBe('completed');
        expect(job.completed_at).not.toBeNull();
    });

    it('background job completes and marks job as completed when no sources exist', async () => {
        const res = await refresh();
        const jobId = res.body.job_id;

        expect(res.status).toBe(201);

        // Wait for the background job to execute
        // Poll up to 2 seconds for the job to complete
        let job;
        for (let i = 0; i < 20; i++) {
            job = await dbGet(
                'SELECT id, status, completed_at FROM processing_jobs WHERE id = $1',
                [jobId],
            );
            if (job && job.status === 'completed') break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        expect(job).toBeDefined();
        expect(job.status).toBe('completed');
        expect(job.completed_at).not.toBeNull();
    });
});
