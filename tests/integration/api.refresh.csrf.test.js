// tests/integration/api.refresh.csrf.test.js
// PR #8 review: CORS scoping alone does not stop a cross-site "simple" POST
// (an HTML form needs no preflight — the browser sends it and only hides the
// response). POST /api/refresh must reject cross-site requests SERVER-SIDE
// (403, no job created) while the same-origin frontend keeps working, and
// no preflight response may approve it.

'use strict';

const request = require('supertest');
const app     = require('../../src/server');
const { dbGet } = require('../../src/db/connection');
const { _resetRateLimiter } = require('../../src/routes/refresh');

const HOST = 'pulse.test:3000';

beforeEach(() => {
    _resetRateLimiter();
});

async function jobCount() {
    const row = await dbGet('SELECT COUNT(*)::int AS n FROM processing_jobs');
    return row.n;
}

function post() {
    return request(app).post('/api/refresh').set('Host', HOST);
}

describe('POST /api/refresh — cross-site request guard', () => {
    it('rejects a cross-site POST (Sec-Fetch-Site: cross-site) with 403 and creates no job', async () => {
        const res = await post()
            .set('Sec-Fetch-Site', 'cross-site')
            .set('Origin', 'https://evil.example');
        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/cross-site/i);
        expect(await jobCount()).toBe(0);
    });

    it('rejects a same-site (sibling subdomain) POST with 403', async () => {
        const res = await post().set('Sec-Fetch-Site', 'same-site');
        expect(res.status).toBe(403);
    });

    it('a rejected cross-site POST does not consume the global refresh budget', async () => {
        await post().set('Sec-Fetch-Site', 'cross-site');
        const res = await post().set('Sec-Fetch-Site', 'same-origin');
        expect(res.status).toBe(201);
    });

    it('accepts a same-origin POST (Sec-Fetch-Site: same-origin) — the frontend path', async () => {
        const res = await post()
            .set('Sec-Fetch-Site', 'same-origin')
            .set('Origin', `http://${HOST}`);
        expect(res.status).toBe(201);
        expect(res.body.status).toBe('started');
        expect(await jobCount()).toBe(1);
    });

    it('accepts a user-initiated request (Sec-Fetch-Site: none)', async () => {
        const res = await post().set('Sec-Fetch-Site', 'none');
        expect(res.status).toBe(201);
    });

    describe('without Sec-Fetch-Site (older browsers / non-browser clients)', () => {
        it('accepts when Origin matches the server host', async () => {
            const res = await post().set('Origin', `http://${HOST}`);
            expect(res.status).toBe(201);
        });

        it('accepts when Origin matches behind a TLS-terminating proxy (scheme differs)', async () => {
            const res = await post().set('Origin', `https://${HOST}`);
            expect(res.status).toBe(201);
        });

        it('rejects when Origin is a different host', async () => {
            const res = await post().set('Origin', 'https://evil.example');
            expect(res.status).toBe(403);
        });

        it('rejects Origin: null (sandboxed iframe / file://)', async () => {
            const res = await post().set('Origin', 'null');
            expect(res.status).toBe(403);
        });

        it('rejects a foreign Origin even when the Referer matches', async () => {
            const res = await post()
                .set('Origin', 'https://evil.example')
                .set('Referer', `http://${HOST}/`);
            expect(res.status).toBe(403);
        });

        it('falls back to Referer when Origin is absent', async () => {
            const ok = await post().set('Referer', `http://${HOST}/explore`);
            expect(ok.status).toBe(201);
            _resetRateLimiter();
            const bad = await post().set('Referer', 'https://evil.example/page');
            expect(bad.status).toBe(403);
        });

        it('rejects a request that carries no provenance headers at all', async () => {
            const res = await post();
            expect(res.status).toBe(403);
            expect(await jobCount()).toBe(0);
        });
    });
});

describe('OPTIONS /api/refresh — preflight is never approved', () => {
    it('serves no Access-Control-Allow-* headers for a cross-origin JSON preflight', async () => {
        const res = await request(app)
            .options('/api/refresh')
            .set('Origin', 'https://evil.example')
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'content-type');
        // Answered by the refresh router itself (Allow: POST), never by the
        // read-only surface's cors() handler.
        expect(res.headers.allow).toBe('POST');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-methods']).toBeUndefined();
        expect(res.headers['access-control-allow-headers']).toBeUndefined();
        expect(await jobCount()).toBe(0);
    });
});
