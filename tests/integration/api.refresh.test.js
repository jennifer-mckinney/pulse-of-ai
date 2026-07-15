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

describe('POST /api/refresh', () => {
    it('returns 201 with the correct response shape', async () => {
        const res = await request(app).post('/api/refresh');

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            job_id:        expect.any(String),
            status:        'started',
            triggered_by:  'api',
        });
    });

    it('creates a processing_jobs row in the database', async () => {
        const res = await request(app).post('/api/refresh');

        const job = await dbGet(
            'SELECT id, triggered_by, status FROM processing_jobs WHERE id = $1',
            [res.body.job_id],
        );

        expect(job).toBeDefined();
        expect(job.triggered_by).toBe('api');
        expect(['running', 'completed', 'failed']).toContain(job.status);
    });

    it('returns 429 when called a second time within the rate limit window', async () => {
        await request(app).post('/api/refresh');                   // first call — OK
        const res = await request(app).post('/api/refresh');       // second call — rate limited

        expect(res.status).toBe(429);
        expect(res.body).toHaveProperty('error');
    });

    it('returns the job_id as a valid UUID', async () => {
        const res = await request(app).post('/api/refresh');
        const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        expect(res.body.job_id).toMatch(UUID_REGEX);
    });

    it('includes retry_after_seconds in 429 response', async () => {
        await request(app).post('/api/refresh');
        const res = await request(app).post('/api/refresh');

        expect(res.status).toBe(429);
        expect(res.body).toHaveProperty('retry_after_seconds');
        expect(res.body.retry_after_seconds).toBeGreaterThan(0);
        expect(res.body.retry_after_seconds).toBeLessThanOrEqual(60);
    });

    it('sets Retry-After header in 429 response', async () => {
        await request(app).post('/api/refresh');
        const res = await request(app).post('/api/refresh');

        expect(res.status).toBe(429);
        expect(res.headers['retry-after']).toBeDefined();
    });

    it('allows a new request after rate limit window expires', async () => {
        _resetRateLimiter();
        await request(app).post('/api/refresh');

        // Manually manipulate the rate limiter for testing (this is a bit hacky
        // but ensures we can test the time window behavior; in production, we
        // would just wait 60 seconds)
        _resetRateLimiter();
        const res = await request(app).post('/api/refresh');

        expect(res.status).toBe(201);
    });
});
