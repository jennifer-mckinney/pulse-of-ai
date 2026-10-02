// tests/integration/api.refresh.csrf.test.js
// PR #8 review: CORS scoping alone does not stop a cross-site "simple" POST
// (an HTML form needs no preflight — the browser sends it and only hides the
// response). POST /api/refresh must reject cross-site requests SERVER-SIDE
// (403, no job created) while the same-origin frontend keeps working, and
// no preflight response may approve it.

'use strict';

const { useServer } = require('../helpers/server');
const app     = require('../../src/server');
const request = useServer(app);   // one listener per file (tests/helpers/server.js)
const { dbGet } = require('../../src/db/connection');
const { _resetRateLimiter, _setEnqueue } = require('../../src/routes/refresh');
const { dbRun } = require('../../src/db/connection');

// Accepted refreshes run a real collection; here it is scoped to no sources
// so no request ever leaves the test (the guard, not collection, is tested).
// A stand-in worker that finishes at once (no network, nothing in flight).
beforeAll(() => _setEnqueue(jobId => dbRun(`UPDATE processing_jobs SET status = 'completed' WHERE id = $1`, [jobId])));
afterAll(() => _setEnqueue(null));

const HOST = 'pulse.test:3000';

beforeEach(() => {
    _resetRateLimiter();
});

async function jobCount() {
    const row = await dbGet('SELECT COUNT(*)::int AS n FROM processing_jobs');
    return row.n;
}

function post() {
    return request().post('/api/refresh').set('Host', HOST);
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

    it('rejects Sec-Fetch-Site: cross-site even when no Origin header is sent', async () => {
        // A missing Origin must never be a free pass: the unforgeable
        // Sec-Fetch-Site header decides whenever the browser sends it.
        const res = await post().set('Sec-Fetch-Site', 'cross-site');
        expect(res.status).toBe(403);
        expect(await jobCount()).toBe(0);
    });

    it('rejects Sec-Fetch-Site: cross-site even when Origin/Referer claim this host', async () => {
        const res = await post()
            .set('Sec-Fetch-Site', 'cross-site')
            .set('Origin', `http://${HOST}`)
            .set('Referer', `http://${HOST}/`);
        expect(res.status).toBe(403);
    });

    it('rejects a same-site (sibling subdomain) POST with 403', async () => {
        const res = await post().set('Sec-Fetch-Site', 'same-site');
        expect(res.status).toBe(403);
    });

    it('a rejected cross-site POST does not consume the global refresh budget', async () => {
        await post().set('Sec-Fetch-Site', 'cross-site');
        const res = await post().set('Sec-Fetch-Site', 'same-origin');
        expect(res.status).toBe(202);
    });

    it('accepts a same-origin POST (Sec-Fetch-Site: same-origin) — the frontend path', async () => {
        const res = await post()
            .set('Sec-Fetch-Site', 'same-origin')
            .set('Origin', `http://${HOST}`);
        expect(res.status).toBe(202);
        expect(res.body.status).toBe('queued');
        expect(await jobCount()).toBe(1);
    });

    it('accepts a user-initiated request (Sec-Fetch-Site: none)', async () => {
        const res = await post().set('Sec-Fetch-Site', 'none');
        expect(res.status).toBe(202);
    });

    describe('without Sec-Fetch-Site (older browsers / non-browser clients)', () => {
        it('accepts when Origin matches the server host', async () => {
            const res = await post().set('Origin', `http://${HOST}`);
            expect(res.status).toBe(202);
        });

        it('accepts when Origin matches behind a TLS-terminating proxy (scheme differs)', async () => {
            const res = await post().set('Origin', `https://${HOST}`);
            expect(res.status).toBe(202);
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
            expect(ok.status).toBe(202);
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
        const res = await request()
            .options('/api/refresh')
            .set('Origin', 'https://evil.example')
            .set('Access-Control-Request-Method', 'POST')
            .set('Access-Control-Request-Headers', 'content-type');
        // Answered by the refresh router itself (explicit 403), never by
        // the read-only surface's cors() handler.
        expect(res.status).toBe(403);
        expect(res.headers.allow).toBe('POST');
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
        expect(res.headers['access-control-allow-methods']).toBeUndefined();
        expect(res.headers['access-control-allow-headers']).toBeUndefined();
        expect(await jobCount()).toBe(0);
    });
});
