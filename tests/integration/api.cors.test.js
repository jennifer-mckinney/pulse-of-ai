// tests/integration/api.cors.test.js
// F2 — CORS scoping: the read-only API surface is world-readable
// (Access-Control-Allow-Origin present), while the mutating POST /api/refresh
// endpoint is mounted WITHOUT cors() so cross-origin pages cannot read its
// responses and its preflight is never approved. CORS alone does not stop a
// cross-site simple POST from being SENT — the server-side guard that does is
// covered in api.refresh.csrf.test.js.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { _resetRateLimiter } = require('../../src/routes/refresh');

beforeEach(() => {
    _resetRateLimiter();
});

const ORIGIN = 'https://evil.example';

describe('CORS scoping (F2)', () => {
    it('serves Access-Control-Allow-Origin on read-only GET endpoints', async () => {
        const res = await request(app).get('/api/health').set('Origin', ORIGIN);
        expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('serves Access-Control-Allow-Origin on the read-only POST /api/query', async () => {
        const res = await request(app)
            .post('/api/query')
            .set('Origin', ORIGIN)
            .send({ keywords: ['ai'] });
        expect(res.headers['access-control-allow-origin']).toBe('*');
    });

    it('does NOT serve CORS headers on POST /api/refresh', async () => {
        const res = await request(app).post('/api/refresh').set('Origin', ORIGIN);
        // Rejected server-side by the cross-site guard (see
        // api.refresh.csrf.test.js) — and still no CORS headers.
        expect(res.status).toBe(403);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('does NOT approve a cross-origin preflight for POST /api/refresh', async () => {
        const res = await request(app)
            .options('/api/refresh')
            .set('Origin', ORIGIN)
            .set('Access-Control-Request-Method', 'POST');
        // Without cors() on the mount, no Access-Control-Allow-* headers exist,
        // so the browser rejects the preflight.
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-methods']).toBeUndefined();
    });
});
