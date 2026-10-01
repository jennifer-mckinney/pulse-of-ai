// tests/unit/pure/collectorHttp.test.js
// The collector HTTP client and robots policy (src/collectors/http.js,
// robots.js): User-Agent, backoff, refusals, conditional GET, robots with
// the conservative trailing-slash reading, and the no-network-in-tests guard.

'use strict';

const {
    HttpClient, HostLimiter, userAgent, defaultTransport, retryAfterMs,
    MAX_IN_RUN_WAIT_MS, MAX_HOLD_MS, DEFAULT_RATE_LIMIT_HOLD_MS, holdKey,
} = require('../../../src/collectors/http');
const { parseRobots, isAllowed, RobotsPolicy } = require('../../../src/collectors/robots');
const { AccessDeniedError, RobotsDisallowedError, HttpError } = require('../../../src/collectors/errors');
const { fixtureTransport, readFixture, TEST_ENV } = require('../../helpers/fixtureTransport');

const noSleep = () => Promise.resolve();
const client = (routes, extra = {}) => {
    const transport = fixtureTransport(routes);
    return { http: new HttpClient({ transport, env: TEST_ENV, sleep: noSleep, ...extra }), transport };
};

describe('User-Agent', () => {
    test('identifies Pulse of AI with the contact URL from env', () => {
        expect(userAgent(TEST_ENV)).toMatch(/^PulseOfAI\/\d+\.\d+\.\d+ \(\+https:\/\/example\.org\/pulse-contact; non-commercial AI discourse research\)$/);
    });

    test('refuses to build without a contact URL', () => {
        expect(() => userAgent({})).toThrow(/COLLECTOR_CONTACT_URL/);
    });

    test('is sent on every request', async () => {
        const { http, transport } = client([['https://a.example/x', { body: 'ok' }]]);
        await http.request('https://a.example/x');
        expect(transport.calls[0].headers['User-Agent']).toBe(userAgent(TEST_ENV));
    });
});

describe('refusals and retries', () => {
    test.each([401, 403, 451])('HTTP %i → AccessDeniedError, never retried', async (status) => {
        const { http, transport } = client([['https://a.example/x', { status, body: 'no' }]]);
        await expect(http.request('https://a.example/x')).rejects.toBeInstanceOf(AccessDeniedError);
        expect(transport.calls).toHaveLength(1);
    });

    test('a bot-challenge page is a refusal even on another 4xx status', async () => {
        const { http, transport } = client([['https://a.example/x', { status: 429, body: '<script src="/_Incapsula_Resource">' }]]);
        await expect(http.request('https://a.example/x')).rejects.toBeInstanceOf(AccessDeniedError);
        expect(transport.calls).toHaveLength(1);
    });

    test('429 and 5xx are retried with backoff, then succeed', async () => {
        let n = 0;
        const sleeps = [];
        const { http } = client([['https://a.example/x', () => (++n < 3
            ? { status: n === 1 ? 429 : 503, headers: { 'retry-after': '2' } } : { body: 'done' })]],
        { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
        const res = await http.request('https://a.example/x');
        expect(res.body).toBe('done');
        expect(sleeps.filter(ms => ms === 2000)).toHaveLength(2);
    });

    test('gives up after the retry budget with an HttpError', async () => {
        const { http, transport } = client([['https://a.example/x', { status: 500 }]]);
        await expect(http.request('https://a.example/x')).rejects.toBeInstanceOf(HttpError);
        expect(transport.calls).toHaveLength(3);
    });

    // The in-run wait is capped at MAX_IN_RUN_WAIT_MS; a longer Retry-After
    // is never slept through and retried early — it becomes a hold
    // (see 'Retry-After holds' below).
    test('the in-run wait honours a short Retry-After, capped; absent → exponential', () => {
        expect(retryAfterMs({ 'retry-after': '5' }, 0)).toBe(5000);
        expect(retryAfterMs({ 'retry-after': '99999' }, 0)).toBe(MAX_IN_RUN_WAIT_MS);
        expect(retryAfterMs({}, 2)).toBe(4000);
    });

    test('network errors are retried, then reported', async () => {
        let n = 0;
        const { http } = client([['https://a.example/x', () => { n++; throw new Error('ECONNRESET'); }]]);
        await expect(http.request('https://a.example/x')).rejects.toThrow(/ECONNRESET/);
        expect(n).toBe(3);
    });

    // Diagnosis 2026-09-30 (option D): Pew's getaddrinfo ENOTFOUND was
    // retried twice within 4 s. A DNS failure is not transient within the
    // same run; the next cadence tick is the retry.
    test.each(['ENOTFOUND', 'EAI_AGAIN'])('a DNS failure (%s) is NOT retried, and is reported as network', async (code) => {
        let n = 0;
        const sleeps = [];
        const { http } = client([['https://a.example/x', () => {
            n++;
            throw Object.assign(new Error(`getaddrinfo ${code} a.example`), { code });
        }]], { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
        const err = await http.request('https://a.example/x').catch(e => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.code).toBe(code);
        expect(require('../../../src/collectors/errors').classifyError(err).error_kind).toBe('network');
        expect(n).toBe(1);
        expect(http.requests).toBe(1);
        expect(sleeps).toEqual([]);
    });
});

// Diagnosis 2026-10-01 (TLDR deadline): tldr.tech answered HTTP 429 with a
// Retry-After of a minute or more. The client capped it at 60 s, slept the
// 60 s INSIDE the run and asked again; two of those overran the run's 120 s
// deadline, so about half the runs were recorded as 'deadline' (hiding the
// 429), and every run re-asked the source sooner than it had told us to.
// Now a Retry-After longer than MAX_IN_RUN_WAIT_MS ends the request at once
// (HTTP 429, http_4xx) and holds the URL until the source's time — in this
// process (all hosts) AND in the route's persisted HTTP cache (so another
// worker replica or a restart honours it too).
describe('Retry-After holds (diagnosis 2026-10-01, TLDR deadline)', () => {
    const URL_ = 'https://feed.example/rss';
    const T0 = Date.parse('2026-10-01T02:00:00Z');
    const { classifyError } = require('../../../src/collectors/errors');

    function holdClient(routes, { now = () => T0, holds = new Map(), sleeps = [], signal } = {}) {
        const transport = fixtureTransport(routes);
        const http = new HttpClient({
            transport, env: TEST_ENV, now, rateLimitHolds: holds, signal,
            sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
        });
        return { http, transport, holds, sleeps };
    }

    test('a 429 whose Retry-After is longer than the in-run wait is neither slept on nor retried in the run', async () => {
        const { http, transport, sleeps } = holdClient([[URL_, { status: 429, headers: { 'retry-after': '120' } }]]);
        const err = await http.request(URL_).catch(e => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(err.status).toBe(429);
        expect(classifyError(err)).toEqual({ error_kind: 'http_4xx', http_status: 429 });
        expect(err.message).toMatch(/Retry-After/);
        expect(err.message).toContain('2026-10-01T02:02:00.000Z');
        expect(transport.calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
    });

    test('the TLDR case: a long Retry-After under a 120 s run deadline is reported as HTTP 429, not as the deadline', async () => {
        // A simulated clock: every sleep advances it, and the run's deadline
        // fires once 120 s have been slept (the worker's cycle deadline).
        const deadline = new AbortController();
        let slept = 0;
        const transport = fixtureTransport([[URL_, { status: 429, headers: { 'retry-after': '60' } }]]);
        const http = new HttpClient({
            transport, env: TEST_ENV, now: () => T0 + slept, rateLimitHolds: new Map(), signal: deadline.signal,
            sleep: (ms) => { slept += ms; if (slept >= 120000) deadline.abort(); return Promise.resolve(); },
        });
        const err = await http.request(URL_).catch(e => e);
        expect(classifyError(err)).toEqual({ error_kind: 'http_4xx', http_status: 429 });
        expect(slept).toBe(0);
        expect(deadline.signal.aborted).toBe(false);
        expect(transport.calls).toHaveLength(1);
    });

    test('the hold is honoured by the next run in the same process: no request is sent before the Retry-After time', async () => {
        const holds = new Map();
        let t = T0;
        const first = holdClient([[URL_, { status: 429, headers: { 'retry-after': '300' } }]], { now: () => t, holds });
        await first.http.request(URL_).catch(() => {});
        t = T0 + 150000;   // the next cadence tick, 2.5 min later
        const next = holdClient([[URL_, { body: '<rss/>' }]], { now: () => t, holds });
        const err = await next.http.request(URL_).catch(e => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(classifyError(err)).toEqual({ error_kind: 'http_4xx', http_status: 429 });
        expect(err.message).toMatch(/not requested/);
        expect(next.transport.calls).toHaveLength(0);
        expect(next.http.requests).toBe(0);
    });

    // The persisted hold is per HOST (holdKey), like the in-process one: a
    // restart must not ask another URL of the same host during the hold.
    test('the hold is persisted per host in the HTTP cache, so another process (or a restart) honours it for every URL', async () => {
        const cache = {};
        let t = T0;
        const first = holdClient([[URL_, { status: 429, headers: { 'retry-after': '300' } }]], { now: () => t });
        await first.http.request(URL_, { cache }).catch(() => {});
        expect(holdKey('feed.example')).toBe('retry-after:feed.example');
        expect(cache).toEqual({ ['retry-after:feed.example']: { until: '2026-10-01T02:05:00.000Z', status: 429 } });
        t = T0 + 150000;
        const other = holdClient([[/./, { body: '<rss/>' }]], { now: () => t });   // empty in-process holds
        await expect(other.http.request(URL_, { cache })).rejects.toThrow(/not requested/);
        await expect(other.http.request('https://feed.example/other.xml', { cache })).rejects.toThrow(/not requested/);
        expect(other.transport.calls).toHaveLength(0);
    });

    test('after the hold the request is sent again, and a success clears the hold but keeps the validators', async () => {
        const holds = new Map();
        const cache = { [URL_]: { etag: '"v1"', last_modified: null }, ['retry-after:feed.example']: { until: '2026-10-01T02:05:00.000Z', status: 429 } };
        holds.set('feed.example', { until: T0 + 300000, status: 429 });
        const later = holdClient([[URL_, { body: '<rss/>', headers: { etag: '"v2"' } }]], { now: () => T0 + 300001, holds });
        const res = await later.http.request(URL_, { cache });
        expect(res.body).toBe('<rss/>');
        expect(later.transport.calls).toHaveLength(1);
        expect(cache).toEqual({ [URL_]: { etag: '"v2"', last_modified: null } });
        expect(holds.has('feed.example')).toBe(false);
    });

    test('a success drops the expired persisted hold of its host', async () => {
        const cache = { ['retry-after:feed.example']: { until: '2026-10-01T01:00:00.000Z', status: 429 } };
        const { http } = holdClient([[URL_, { body: '<rss/>' }]]);
        await http.request(URL_, { cache });
        expect(cache).toEqual({});
    });

    test('the hold is the source\'s full Retry-After (not the old 60 s cap), as seconds or an HTTP date, at most MAX_HOLD_MS', async () => {
        const cases = [
            [{ 'retry-after': '3600' }, T0 + 3600000],
            [{ 'retry-after': 'Wed, 01 Oct 2026 03:30:00 GMT' }, Date.parse('2026-10-01T03:30:00Z')],
            [{ 'retry-after': String(10 * 24 * 3600) }, T0 + MAX_HOLD_MS],
        ];
        for (const [headers, until] of cases) {
            const holds = new Map();
            const { http } = holdClient([[URL_, { status: 429, headers }]], { holds });
            await http.request(URL_).catch(() => {});
            expect(holds.get('feed.example')).toEqual({ until, status: 429 });
        }
    });

    test('a 429 without Retry-After is retried with backoff, then holds for DEFAULT_RATE_LIMIT_HOLD_MS', async () => {
        const holds = new Map();
        const { http, transport, sleeps } = holdClient([[URL_, { status: 429 }]], { holds });
        const err = await http.request(URL_).catch(e => e);
        expect(classifyError(err)).toEqual({ error_kind: 'http_4xx', http_status: 429 });
        expect(transport.calls).toHaveLength(3);
        expect(sleeps).toEqual([1000, 2000]);
        expect(holds.get('feed.example')).toEqual({ until: T0 + DEFAULT_RATE_LIMIT_HOLD_MS, status: 429 });
    });

    test('a 503 with a long Retry-After holds the same way; a 5xx without one does not hold', async () => {
        const holds = new Map();
        const a = holdClient([[URL_, { status: 503, headers: { 'retry-after': '600' } }]], { holds });
        const err = await a.http.request(URL_).catch(e => e);
        expect(classifyError(err)).toEqual({ error_kind: 'http_5xx', http_status: 503 });
        expect(a.transport.calls).toHaveLength(1);
        expect(holds.get('feed.example')).toEqual({ until: T0 + 600000, status: 503 });

        const other = new Map();
        const b = holdClient([[URL_, { status: 500 }]], { holds: other });
        await b.http.request(URL_).catch(() => {});
        expect(other.size).toBe(0);
    });

    // Copilot review #44: only the statuses that can hold (429, 503) skip the
    // in-run retry; any other 5xx keeps the capped retry behaviour.
    test.each([500, 502, 504])('a %i with a long Retry-After keeps the capped in-run retries and never holds', async (status) => {
        const holds = new Map();
        const { http, transport, sleeps } = holdClient([[URL_, { status, headers: { 'retry-after': '600' } }]], { holds });
        const err = await http.request(URL_).catch(e => e);
        expect(classifyError(err)).toEqual({ error_kind: 'http_5xx', http_status: status });
        expect(transport.calls).toHaveLength(3);
        expect(sleeps).toEqual([MAX_IN_RUN_WAIT_MS, MAX_IN_RUN_WAIT_MS]);
        expect(holds.size).toBe(0);
    });

    // Copilot review #44: a hold set on a redirect target is also persisted
    // under the URL the route asks for, so a fresh process sends NOTHING
    // (not robots.txt, not the first hop) during the hold.
    test('a hold behind a redirect is persisted for the requested URL\'s host too, so a fresh client sends nothing', async () => {
        const FINAL = 'https://cdn.feed.example/rss';
        const cache = {};
        const first = holdClient([
            [URL_, { status: 301, headers: { location: FINAL } }],
            [FINAL, { status: 429, headers: { 'retry-after': '300' } }],
        ]);
        await first.http.request(URL_, { cache, robots: true }).catch(() => {});
        const held = { until: '2026-10-01T02:05:00.000Z', status: 429 };
        expect(cache).toEqual({ ['retry-after:feed.example']: held, ['retry-after:cdn.feed.example']: held });

        const fresh = holdClient([[/./, { body: 'never' }]], { now: () => T0 + 150000 });
        await expect(fresh.http.request(URL_, { cache, robots: true })).rejects.toThrow(/not requested/);
        expect(fresh.transport.calls).toEqual([]);
    });

    test('a success through the redirect clears the expired hold of both hosts (validators stay on the final URL)', async () => {
        const FINAL = 'https://cdn.feed.example/rss';
        const expired = { until: '2026-10-01T01:00:00.000Z', status: 429 };
        const cache = { ['retry-after:feed.example']: { ...expired }, ['retry-after:cdn.feed.example']: { ...expired } };
        const { http } = holdClient([
            [URL_, { status: 301, headers: { location: FINAL } }],
            [FINAL, { body: '<rss/>', headers: { etag: '"v3"' } }],
        ]);
        await http.request(URL_, { cache });
        expect(cache).toEqual({ [FINAL]: { etag: '"v3"', last_modified: null } });
    });

    // Copilot re-review #44: a route that does not pass a validator cache
    // (most API collectors) must still persist its hold. The runner hands
    // the client the source's persisted HTTP cache as its hold store.
    test('without a route cache the hold is persisted in the client\'s hold store, honoured by a fresh client', async () => {
        const store = {};
        const first = holdClient([[URL_, { status: 429, headers: { 'retry-after': '300' } }]]);
        first.http.holdStore = store;
        await first.http.request(URL_).catch(() => {});
        expect(store).toEqual({ ['retry-after:feed.example']: { until: '2026-10-01T02:05:00.000Z', status: 429 } });

        const fresh = holdClient([[/./, { body: 'never' }]], { now: () => T0 + 150000 });
        fresh.http.holdStore = store;
        await expect(fresh.http.request(URL_)).rejects.toThrow(/not requested/);
        expect(fresh.transport.calls).toEqual([]);
        // No validators are ever sent or written for an uncached route.
        const later = holdClient([[URL_, { body: 'ok', headers: { etag: '"x"' } }]], { now: () => T0 + 300001 });
        later.http.holdStore = store;
        await later.http.request(URL_);
        expect(later.transport.calls[0].headers['If-None-Match']).toBeUndefined();
        expect(store).toEqual({});
    });

    // Copilot re-review #44: the runner rolls a route's cursor and validators
    // back after a store failure; holds learned meanwhile must survive it.
    test('withHolds(restored, current) keeps the holds learned since the snapshot', () => {
        const { withHolds } = require('../../../src/collectors/http');
        const hold = { until: '2026-10-01T03:00:00.000Z', status: 429 };
        const expired = { until: '2026-10-01T01:00:00.000Z', status: 429 };
        const restored = {
            'https://a.example/1': { etag: '"old"', last_modified: null },
            'retry-after:b.example': { ...hold },
            'retry-after:c.example': { ...expired },                          // cleared during the route
        };
        const current = {
            'https://a.example/1': { etag: '"new"', last_modified: null },   // validator: rolled back
            'https://a.example/3': { etag: '"e"', last_modified: null },     // new validator: dropped
            'retry-after:a.example': { ...hold },                             // hold learned: kept
            'retry-after:b.example': { ...hold },                             // hold still active: kept
        };
        // Holds come from `current` only: the expired c.example hold that
        // clearHold dropped is not brought back by the rollback.
        expect(withHolds(restored, current)).toEqual({
            'https://a.example/1': { etag: '"old"', last_modified: null },
            'retry-after:a.example': { ...hold },
            'retry-after:b.example': { ...hold },
        });
    });

    test('a short Retry-After is still waited out inside the run and retried', async () => {
        let n = 0;
        const holds = new Map();
        const { http, sleeps } = holdClient([[URL_, () => (++n === 1
            ? { status: 429, headers: { 'retry-after': String(MAX_IN_RUN_WAIT_MS / 1000) } } : { body: 'ok' })]], { holds });
        expect((await http.request(URL_)).body).toBe('ok');
        expect(sleeps).toEqual([MAX_IN_RUN_WAIT_MS]);
        expect(holds.size).toBe(0);
    });

    test('a success never clears a hold another source set on the same host while it was in flight', async () => {
        const holds = new Map();
        const { http } = holdClient([[URL_, () => {
            holds.set('feed.example', { until: T0 + 300000, status: 429 });   // set by a concurrent run
            return { body: 'ok' };
        }]], { holds });
        expect((await http.request(URL_)).body).toBe('ok');
        expect(holds.get('feed.example')).toEqual({ until: T0 + 300000, status: 429 });
    });

    test('a hold on one host never blocks another host', async () => {
        const holds = new Map([['feed.example', { until: T0 + 300000, status: 429 }]]);
        const { http, transport } = holdClient([['https://other.example/rss', { body: 'ok' }]], { holds });
        expect((await http.request('https://other.example/rss')).body).toBe('ok');
        expect(transport.calls).toHaveLength(1);
    });

    test('clients on the default (network) transport share one process-wide hold map', () => {
        const a = new HttpClient({ env: TEST_ENV });
        const b = new HttpClient({ env: TEST_ENV });
        expect(a.holds).toBe(b.holds);
        const c = new HttpClient({ env: TEST_ENV, transport: fixtureTransport([]) });
        expect(c.holds).not.toBe(a.holds);
    });
});

describe('refusal response headers (diagnosis 2026-09-30, option D)', () => {
    const { refusalHeaders, REFUSAL_HEADER_ALLOWLIST } = require('../../../src/collectors/http');
    const SECRET = 'sk-live-refusal-9f8e7d6c5b4a';
    const env = { ...TEST_ENV, SOME_API_KEY: SECRET };
    const refusal = {
        server: 'nginx',
        date: 'Wed, 30 Sep 2026 16:26:35 GMT',
        'content-type': 'text/html; charset=UTF-8',
        'x-rq': 'sea1 123 456 443',
        'x-powered-by': 'WordPress VIP',
        'cf-ray': '8c1f0e2d3a4b5c6d-SEA',
        'x-served-by': `cache-sea-1\r\nX-Injected: forged ${SECRET}`,
        'set-cookie': 'session=abc123; HttpOnly',
        'www-authenticate': 'Bearer realm="api"',
        authorization: 'Bearer xyz',
        'x-custom-debug': 'internal',
        'x-request-id': 'req-7f3a-session-bound',
    };

    test('a 403 AccessDeniedError carries ONLY the allow-listed headers, scrubbed and one-line', async () => {
        const { http, transport } = client([['https://www.pewresearch.org/wp-json/wp/v2/posts', {
            status: 403, headers: refusal, body: '<html>Forbidden</html>',
        }]], { env });
        const err = await http.request('https://www.pewresearch.org/wp-json/wp/v2/posts').catch(e => e);
        expect(err).toBeInstanceOf(AccessDeniedError);
        expect(transport.calls).toHaveLength(1);
        expect(Object.keys(err.headers).sort()).toEqual(['cf-ray', 'content-type', 'date', 'server', 'x-rq', 'x-served-by']);
        // Dropped: cookies, auth, fingerprints / session-correlated ids
        // (security L3: x-powered-by, x-request-id), anything not allow-listed.
        for (const k of ['set-cookie', 'www-authenticate', 'authorization', 'x-custom-debug', 'x-powered-by', 'x-request-id']) {
            expect(err.headers).not.toHaveProperty(k);
        }
        // Scrubbed and control-character free (security L4).
        expect(err.headers['x-served-by']).not.toContain(SECRET);
        expect(err.headers['x-served-by']).toContain('[redacted]');
        expect(err.headers['x-served-by']).not.toMatch(/[\r\n]/);
        expect(err.headers['x-served-by']).toContain('\\r\\n');
        // No body is ever kept.
        expect(JSON.stringify(err)).not.toContain('Forbidden');
    });

    test('the allow-list never contains a cookie or credential header', () => {
        for (const bad of ['set-cookie', 'cookie', 'authorization', 'proxy-authorization', 'www-authenticate', 'proxy-authenticate',
            'x-powered-by', 'x-request-id']) {
            expect(REFUSAL_HEADER_ALLOWLIST).not.toContain(bad);
        }
    });

    test('values are capped, array values joined, empty values and missing headers omitted', () => {
        const out = refusalHeaders({ server: 'x'.repeat(500), via: ['1.1 a', '1.1 b'], 'retry-after': '' }, env);
        expect(out.server.length).toBe(200);
        expect(out.via).toBe('1.1 a, 1.1 b');
        expect(out).not.toHaveProperty('retry-after');
        expect(refusalHeaders(undefined, env)).toEqual({});
    });

    test('a bot-challenge refusal carries its headers too', async () => {
        const { http } = client([['https://a.example/x', {
            status: 429, headers: { server: 'cloudflare', 'cf-mitigated': 'challenge' }, body: '<div id="cf-chl-widget">',
        }]]);
        const err = await http.request('https://a.example/x').catch(e => e);
        expect(err).toBeInstanceOf(AccessDeniedError);
        expect(err.headers).toEqual({ server: 'cloudflare', 'cf-mitigated': 'challenge' });
    });
});

describe('conditional GET', () => {
    test('stores validators and sends them; 304 → notModified', async () => {
        const cache = {};
        let second = null;
        const { http } = client([['https://a.example/feed', (url, init) => {
            if (init.headers['If-None-Match']) { second = init.headers; return { status: 304 }; }
            return { body: '<rss/>', headers: { etag: '"v1"', 'last-modified': 'Sun, 28 Sep 2026 08:00:00 GMT' } };
        }]]);
        const first = await http.request('https://a.example/feed', { cache });
        expect(first.notModified).toBe(false);
        expect(cache['https://a.example/feed']).toEqual({ etag: '"v1"', last_modified: 'Sun, 28 Sep 2026 08:00:00 GMT' });
        const again = await http.request('https://a.example/feed', { cache });
        expect(again.notModified).toBe(true);
        expect(second['If-Modified-Since']).toBe('Sun, 28 Sep 2026 08:00:00 GMT');
    });

    test('json() parses bodies and reports 304 without a body', async () => {
        const { http } = client([['https://a.example/j', { body: '{"a":1}' }], ['https://a.example/bad', { body: '<html>' }]]);
        expect((await http.json('https://a.example/j')).data).toEqual({ a: 1 });
        await expect(http.json('https://a.example/bad')).rejects.toThrow(/invalid JSON/);
    });
});

describe('robots.txt', () => {
    const cfr = parseRobots(readFixture('recorded/cfr-robots.txt'));

    test('CFR: "Disallow: /feed/" read conservatively also covers /feed (ADR 0001)', () => {
        expect(isAllowed(cfr, '/feed', { conservative: true })).toBe(false);
        expect(isAllowed(cfr, '/feed/', { conservative: true })).toBe(false);
        expect(isAllowed(cfr, '/feed', { conservative: false })).toBe(true);   // literal RFC 9309
        expect(isAllowed(cfr, '/article/x', { conservative: true })).toBe(true);
    });

    test('our product token group wins over *, longest match, Allow wins ties, wildcards', () => {
        const g = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: PulseOfAI\nDisallow: /private\nAllow: /private/ok$\nDisallow: /*.pdf$\n');
        expect(isAllowed(g, '/news')).toBe(true);
        expect(isAllowed(g, '/private/x')).toBe(false);
        expect(isAllowed(g, '/private/ok')).toBe(true);
        expect(isAllowed(g, '/doc.pdf')).toBe(false);
        expect(isAllowed(parseRobots('User-agent: *\nDisallow:\n'), '/x')).toBe(true);
    });

    test('a disallowed path is never requested; redirects into one are refused', async () => {
        const { http, transport } = client([
            ['https://site.example/robots.txt', { body: 'User-agent: *\nDisallow: /blocked\n' }],
            ['https://site.example/feed', { status: 301, headers: { location: '/blocked/feed' } }],
        ]);
        await expect(http.request('https://site.example/blocked', { robots: true })).rejects.toBeInstanceOf(RobotsDisallowedError);
        await expect(http.request('https://site.example/feed', { robots: true })).rejects.toBeInstanceOf(RobotsDisallowedError);
        expect(transport.calls.map(c => c.url)).not.toContain('https://site.example/blocked/feed');
    });

    test('RFC 9309: 4xx robots.txt → no rules; 5xx / unreachable → complete disallow', async () => {
        const policy = new RobotsPolicy({ fetchRobots: async (url) => {
            if (url.includes('four')) return { status: 403, body: '' };
            if (url.includes('five')) return { status: 503, body: '' };
            throw new Error('ENOTFOUND');
        } });
        expect((await policy.check('https://four.example/feed')).allowed).toBe(true);
        expect((await policy.check('https://five.example/feed')).allowed).toBe(false);
        expect((await policy.check('https://gone.example/feed')).reason).toMatch(/unreachable/);
        expect((await policy.check('https://five.example/robots.txt')).allowed).toBe(true);
    });

    test('robots.txt is cached per origin and follows its own redirects', async () => {
        const { http, transport } = client([
            ['https://apex.example/robots.txt', { status: 301, headers: { location: 'https://www.apex.example/robots.txt' } }],
            ['https://www.apex.example/robots.txt', { body: 'User-agent: *\nDisallow: /x\n' }],
            ['https://apex.example/a', { body: 'a' }],
        ]);
        await http.request('https://apex.example/a', { robots: true });
        await http.request('https://apex.example/a', { robots: true });
        expect(transport.calls.filter(c => c.url.endsWith('robots.txt'))).toHaveLength(2);
        await expect(http.request('https://apex.example/x', { robots: true })).rejects.toBeInstanceOf(RobotsDisallowedError);
    });
});

describe('politeness and the no-network guard', () => {
    test('HostLimiter spaces requests to the same host', async () => {
        let t = 0;
        const slept = [];
        const limiter = new HostLimiter({ now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; } });
        await limiter.wait('a', 1000);
        await limiter.wait('a', 1000);
        await limiter.wait('b', 1000);
        expect(slept).toEqual([1000]);
    });

    test('the default transport refuses the network under NODE_ENV=test', async () => {
        const saved = process.env.NODE_ENV;
        process.env.NODE_ENV = 'test';
        try {
            await expect(defaultTransport('https://example.org/', {})).rejects.toThrow(/network disabled/);
        } finally {
            process.env.NODE_ENV = saved;
        }
    });

    test('too many redirects is an error', async () => {
        const { http } = client([[/loop/, { status: 302, headers: { location: '/loop' } }]]);
        await expect(http.request('https://a.example/loop')).rejects.toThrow(/too many redirects/);
    });
});
