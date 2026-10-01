// tests/unit/pure/collectorHttp.test.js
// The collector HTTP client and robots policy (src/collectors/http.js,
// robots.js): User-Agent, backoff, refusals, conditional GET, robots with
// the conservative trailing-slash reading, and the no-network-in-tests guard.

'use strict';

const {
    HttpClient, HostLimiter, userAgent, defaultTransport, retryAfterMs, MAX_IN_RUN_WAIT_MS,
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

    // Diagnosis 2026-10-01: Retry-After is the source's MINIMUM wait. The old
    // code capped it at 60 s and retried early; it is now returned whole and
    // withRetries decides (a longer wait than the in-run maximum is not slept).
    test('Retry-After is honoured whole (never shortened); absent → exponential', () => {
        expect(retryAfterMs({ 'retry-after': '5' }, 0)).toBe(5000);
        expect(retryAfterMs({ 'retry-after': '99999' }, 0)).toBe(99999000);
        expect(retryAfterMs({}, 2)).toBe(4000);
    });

    test('a 5xx whose Retry-After exceeds the in-run maximum is NOT retried early (one request, http_5xx)', async () => {
        const sleeps = [];
        const { http, transport } = client([['https://a.example/x', { status: 503, headers: { 'retry-after': '120' } }]],
            { sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
        const err = await http.request('https://a.example/x').catch(e => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(require('../../../src/collectors/errors').classifyError(err)).toEqual({ error_kind: 'http_5xx', http_status: 503 });
        expect(transport.calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
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

// Diagnosis 2026-10-01 (TLDR deadline, PR #44 — unified with PR #45's
// classifier in the merge): tldr.tech answered HTTP 429 with a Retry-After
// of a minute or more. The client capped the wait at 60 s, slept it INSIDE
// the run and asked again; two of those overran the run's 120 s deadline,
// so about half the runs were recorded as 'deadline' (hiding the 429). Now
// a wait longer than MAX_IN_RUN_WAIT_MS (10 s) is never slept: the 429 is
// classified like any rate limit (RateLimitedError, 'rate_limited') and the
// HOST is held in the client's ONE holds map — the map the runner persists
// to source_collection_state.rate_limited_hosts (never the HTTP cache).
describe('Retry-After holds through the one rate-limit path (PR #44 TLDR, unified)', () => {
    const { RateLimitedError, classifyError } = require('../../../src/collectors/errors');
    const { NO_TIME_429_HOLD_MS } = require('../../../src/collectors/rate-limit');
    const URL_ = 'https://feed.example/rss';
    const FINAL = 'https://cdn.feed.example/rss';
    const T0 = Date.parse('2026-10-01T02:00:00Z');
    const iso = ms => new Date(ms).toISOString();

    function holdClient(routes, { now = () => T0, holds = {}, sleeps = [], signal } = {}) {
        const transport = fixtureTransport(routes);
        const http = new HttpClient({
            transport, env: TEST_ENV, now, holds, signal,
            sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); },
        });
        return { http, transport, sleeps };
    }

    test('the TLDR case: Retry-After 60 s under a 120 s run deadline is a RATE LIMIT at once — never slept, never the deadline', async () => {
        // A simulated clock: every sleep advances it, and the run's deadline
        // fires once 120 s have been slept (the worker's cycle deadline).
        const deadline = new AbortController();
        let slept = 0;
        const transport = fixtureTransport([[URL_, { status: 429, headers: { 'retry-after': '60' } }]]);
        const http = new HttpClient({
            transport, env: TEST_ENV, now: () => T0 + slept, signal: deadline.signal,
            sleep: (ms) => { slept += ms; if (slept >= 120000) deadline.abort(); return Promise.resolve(); },
        });
        const err = await http.request(URL_).catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(classifyError(err)).toEqual({ error_kind: 'rate_limited', http_status: 429 });
        expect(err).toMatchObject({ signal: 'http_429', host: 'feed.example', retryAt: T0 + 60000 });
        expect(slept).toBe(0);
        expect(deadline.signal.aborted).toBe(false);
        expect(transport.calls).toHaveLength(1);
        // The hold is in the client's one map, and reported as a change for
        // the runner to persist (state.saveHolds → rate_limited_hosts).
        expect(http.holds['feed.example']).toMatchObject({ until: iso(T0 + 60000), http_status: 429, signal: 'http_429', count: 1 });
        expect([...http.drainHoldChanges().keys()]).toEqual(['feed.example']);
    });

    test('MAX_IN_RUN_WAIT_MS is 10 s: a Retry-After of exactly 10 s is waited out and retried; 11 s is a hold, never a sleep', async () => {
        expect(MAX_IN_RUN_WAIT_MS).toBe(10000);
        let n = 0;
        const a = holdClient([[URL_, () => (++n === 1 ? { status: 429, headers: { 'retry-after': '10' } } : { body: 'ok' })]]);
        expect((await a.http.request(URL_)).body).toBe('ok');
        expect(a.sleeps).toEqual([10000]);
        expect(a.http.holds).toEqual({});

        const b = holdClient([[URL_, { status: 429, headers: { 'retry-after': '11' } }]]);
        await expect(b.http.request(URL_)).rejects.toBeInstanceOf(RateLimitedError);
        expect(b.sleeps).toEqual([]);
        expect(b.transport.calls).toHaveLength(1);
    });

    test('a 429 that names no time is retried with backoff (1 s, 2 s), then held NO_TIME_429_HOLD_MS (5 min — PR #44\'s default)', async () => {
        const { http, transport, sleeps } = holdClient([[URL_, { status: 429 }]]);
        const err = await http.request(URL_).catch(e => e);
        expect(classifyError(err)).toEqual({ error_kind: 'rate_limited', http_status: 429 });
        expect(transport.calls).toHaveLength(3);
        expect(sleeps).toEqual([1000, 2000]);
        expect(NO_TIME_429_HOLD_MS).toBe(300000);
        expect(http.holds['feed.example'].until).toBe(iso(T0 + NO_TIME_429_HOLD_MS));
    });

    test('a fresh client loaded with the stored holds (a restart, another replica) sends nothing to the host — no URL of it', async () => {
        const first = holdClient([[URL_, { status: 429, headers: { 'retry-after': '300' } }]]);
        await first.http.request(URL_).catch(() => {});
        const stored = JSON.parse(JSON.stringify(first.http.holds));   // as saved to and read from the database
        const fresh = holdClient([[/./, { body: '<rss/>' }]], { now: () => T0 + 150000 });
        fresh.http.loadHolds(stored);
        await expect(fresh.http.request(URL_, { robots: true })).rejects.toMatchObject({ held: true, host: 'feed.example' });
        await expect(fresh.http.request('https://feed.example/other.xml')).rejects.toMatchObject({ held: true });
        expect(fresh.transport.calls).toEqual([]);
    });

    // PR #44 (Copilot review): a hold learned behind a redirect also holds
    // the host the route asks for, so a fresh client sends NOTHING (not
    // robots.txt, not the first hop) during the hold.
    test.each([
        ['a 429', { status: 429, headers: { 'retry-after': '300' } }, 'http_429'],
        ['a 503 with a long Retry-After', { status: 503, headers: { 'retry-after': '300' } }, 'retry_after_5xx'],
    ])('%s behind a redirect holds the requested URL\'s host too; a fresh client sends nothing', async (_, final, signal) => {
        const first = holdClient([[URL_, { status: 301, headers: { location: FINAL } }], [FINAL, final]]);
        await first.http.request(URL_, { robots: true }).catch(() => {});
        expect(first.http.holds['cdn.feed.example']).toMatchObject({ until: iso(T0 + 300000), signal });
        expect(first.http.holds['feed.example']).toEqual(first.http.holds['cdn.feed.example']);
        expect([...first.http.drainHoldChanges().keys()].sort()).toEqual(['cdn.feed.example', 'feed.example']);

        const fresh = holdClient([[/./, { body: 'never' }]], { now: () => T0 + 150000 });
        fresh.http.loadHolds(JSON.parse(JSON.stringify(first.http.holds)));
        await expect(fresh.http.request(URL_, { robots: true })).rejects.toMatchObject({ held: true, host: 'feed.example' });
        expect(fresh.transport.calls).toEqual([]);
    });

    test('a success through the redirect clears the EXPIRED holds of both hosts (validators stay on the final URL)', async () => {
        const expired = { until: iso(T0 - 1000), http_status: 429, signal: 'http_429', count: 2, weak: 0, at: iso(T0 - 600000) };
        const cache = {};
        const { http } = holdClient([
            [URL_, { status: 301, headers: { location: FINAL } }],
            [FINAL, { body: '<rss/>', headers: { etag: '"v3"' } }],
        ], { holds: { 'feed.example': { ...expired }, 'cdn.feed.example': { ...expired } } });
        await http.request(URL_, { cache });
        expect(http.holds).toEqual({});
        expect(cache).toEqual({ [FINAL]: { etag: '"v3"', last_modified: null } });
        const changes = http.drainHoldChanges();
        expect([...changes.keys()].sort()).toEqual(['cdn.feed.example', 'feed.example']);
        expect([...changes.values()]).toEqual([null, null]);
    });

    test('a success never clears a hold a concurrent request set on the same host while it was in flight', async () => {
        const holds = {};
        const concurrent = { until: iso(T0 + 300000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(T0) };
        const { http } = holdClient([[URL_, () => {
            holds['feed.example'] = concurrent;   // set meanwhile by another request of this client
            return { body: 'ok' };
        }]], { holds });
        expect((await http.request(URL_)).body).toBe('ok');
        expect(holds['feed.example']).toBe(concurrent);
        expect(http.drainHoldChanges().size).toBe(0);
    });

    // Merge decision: PR #44 kept in-run retries for a 500 / 502 / 504 with
    // a long Retry-After (capped, i.e. BEFORE the source's time); PR #45
    // (grumpy #7) honours any 5xx's Retry-After whole. The stronger rule is
    // kept: never asked before the source's time.
    test.each([500, 502, 504])('a %i with a long Retry-After is not retried early: one request, a retry_after_5xx hold', async (status) => {
        const { http, transport, sleeps } = holdClient([[URL_, { status, headers: { 'retry-after': '600' } }]]);
        const err = await http.request(URL_).catch(e => e);
        expect(classifyError(err)).toEqual({ error_kind: 'http_5xx', http_status: status });
        expect(transport.calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
        expect(http.holds['feed.example']).toMatchObject({ until: iso(T0 + 600000), signal: 'retry_after_5xx', count: 0 });
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

// Diagnosis 2026-10-01: GitHub answered ONE search request with a 403
// (JSON, server Varnish) and it was escalated as a refusal. A rate limit is
// recognised on positive evidence only and becomes a RateLimitedError (never
// an AccessDeniedError); every other 401 / 403 / 451 stays a refusal.
describe('rate limits are not refusals (diagnosis 2026-10-01)', () => {
    const { RateLimitedError, classifyError } = require('../../../src/collectors/errors');
    const NOW = Date.parse('2026-10-01T02:47:54Z');
    const RESET = Math.floor(NOW / 1000) + 600;
    const URL_ = 'https://api.github.com/search/repositories?q=topic%3Aartificial-intelligence';
    const GH_JSON = msg => JSON.stringify({ message: msg, documentation_url: 'https://docs.github.com/rest/overview/rate-limits-for-the-rest-api' });
    const GH = { server: 'Varnish', 'content-type': 'application/json; charset=utf-8', date: 'Thu, 01 Oct 2026 02:47:54 GMT' };
    const SECONDARY = GH_JSON('You have exceeded a secondary rate limit. Please wait a few minutes before you try again.');
    const at = (routes, extra = {}) => client(routes, { now: () => NOW, ...extra });
    const iso = ms => new Date(ms).toISOString();
    const recordSleeps = () => {
        const sleeps = [];
        return { sleeps, sleep: (ms) => { sleeps.push(ms); return Promise.resolve(); } };
    };

    test('403 + x-ratelimit-remaining: 0 → RateLimitedError, backoff to x-ratelimit-reset, ONE request, host held on the client', async () => {
        const { http, transport } = at([[/api\.github\.com/, {
            status: 403, body: GH_JSON('API rate limit exceeded for 203.0.113.7.'),
            headers: { ...GH, 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET),
                'x-ratelimit-used': '10', 'x-ratelimit-resource': 'search' },
        }]]);
        const err = await http.request(URL_).catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err).toMatchObject({ status: 403, signal: 'ratelimit_remaining_zero', retryAt: RESET * 1000, host: 'api.github.com' });
        expect(classifyError(err)).toEqual({ error_kind: 'rate_limited', http_status: 403 });
        expect(transport.calls).toHaveLength(1);
        expect(http.holds).toEqual({ 'api.github.com': { until: iso(RESET * 1000), http_status: 403, signal: 'ratelimit_remaining_zero', count: 1, weak: 0, at: iso(NOW) } });
        expect([...http.drainHoldChanges().keys()]).toEqual(['api.github.com']);
        // The rate-limit headers are kept (allow-listed, scrubbed); the body never.
        expect(err.headers).toMatchObject({ 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET),
            'x-ratelimit-used': '10', 'x-ratelimit-resource': 'search', server: 'Varnish' });
        expect(JSON.stringify(err)).not.toContain('203.0.113.7');
        expect(err.message).not.toMatch(/API rate limit exceeded/);
        expect(err.message).toMatch(/api\.github\.com rate-limited us \(HTTP 403, ratelimit_remaining_zero\) — not a refusal.*backing off until 2026-10-01T02:57:54\.000Z/);
    });

    test('403 + a "secondary rate limit" body alone → weak RateLimitedError at the 60 s floor; the body never kept', async () => {
        const { http, transport } = at([[/api\.github\.com/, { status: 403, headers: GH, body: SECONDARY }]]);
        const err = await http.request(URL_).catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err).toMatchObject({ signal: 'body_rate_limit', retryAt: NOW + 60000 });
        expect(transport.calls).toHaveLength(1);
        expect(JSON.stringify(err)).not.toContain('secondary rate limit');
        expect(http.holds['api.github.com']).toMatchObject({ count: 1, weak: 1 });
    });

    test('N1: GitHub\'s secondary-limit body + Retry-After is STRONG — ten in a row never become a refusal; the holds double to the 24 h cap', async () => {
        let t = NOW;
        const { http } = client([[/api\.github\.com/, { status: 403, headers: { ...GH, 'retry-after': '60' }, body: SECONDARY }]], { now: () => t });
        const lengths = [];
        for (let i = 1; i <= 12; i++) {
            const err = await http.request(URL_).catch(e => e);
            expect([i, err.constructor.name, err.signal]).toEqual([i, 'RateLimitedError', 'body_rate_limit_retry_after']);
            lengths.push(Date.parse(http.holds['api.github.com'].until) - t);
            t = Date.parse(http.holds['api.github.com'].until);
        }
        expect(lengths.slice(0, 4)).toEqual([60000, 120000, 240000, 480000]);
        expect(lengths[11]).toBe(86400000);
        expect(http.holds['api.github.com']).toMatchObject({ count: 12, weak: 0 });
    });

    test('N1: the same response from another host is a REFUSAL (GitHub\'s wording is evidence from api.github.com only)', async () => {
        const { http } = at([[/gh\.example\.com/, { status: 403, headers: { ...GH, 'retry-after': '60' }, body: SECONDARY }]]);
        await expect(http.request('https://gh.example.com/search')).rejects.toBeInstanceOf(AccessDeniedError);
        expect(http.holds).toEqual({});
    });

    test('N1: the FINAL hostname decides (a redirect to api.github.com answering with the body + Retry-After)', async () => {
        const { http } = at([
            [/a\.example\/x/, { status: 302, headers: { location: 'https://api.github.com/search/repositories?q=x' } }],
            [/api\.github\.com/, { status: 403, headers: { ...GH, 'retry-after': '60' }, body: SECONDARY }],
        ]);
        const err = await http.request('https://a.example/x').catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err).toMatchObject({ host: 'api.github.com', signal: 'body_rate_limit_retry_after' });
    });

    test.each(['0', '-5', '0x10', 'Thu, 01 Jan 1970 00:00:00 GMT', '1 2', '60'])(
        'security F2: a 403 whose only evidence is Retry-After %p stays a REFUSAL', async (ra) => {
            const { http } = at([[/api\.github\.com/, { status: 403, headers: { ...GH, 'retry-after': ra }, body: GH_JSON('Forbidden') }]]);
            await expect(http.request(URL_)).rejects.toBeInstanceOf(AccessDeniedError);
            expect(http.holds).toEqual({});
        });

    test('security F2: a 403 message that merely mentions a rate limit stays a REFUSAL', async () => {
        const { http } = at([[/api\.github\.com/, { status: 403, headers: GH, body: GH_JSON('This IP is permanently banned for rate limit abuse') }]]);
        await expect(http.request(URL_)).rejects.toBeInstanceOf(AccessDeniedError);
    });

    test('regression: a plain 403 with no rate-limit signal (the incident\'s headers alone) stays a REFUSAL', async () => {
        const { http, transport } = at([[/api\.github\.com/, { status: 403, headers: GH, body: GH_JSON('Forbidden') }]]);
        const err = await http.request(URL_).catch(e => e);
        expect(err).toBeInstanceOf(AccessDeniedError);
        expect(classifyError(err).error_kind).toBe('access_denied');
        expect(transport.calls).toHaveLength(1);
    });

    test.each([401, 451])('HTTP %i stays a refusal even with rate-limit headers and body', async (status) => {
        const { http } = at([[/api\.github\.com/, {
            status, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60' }, body: GH_JSON('API rate limit exceeded'),
        }]]);
        const err = await http.request(URL_).catch(e => e);
        expect(err).toBeInstanceOf(AccessDeniedError);
        expect(http.holds).toEqual({});
    });

    test('a bot-wall challenge wins over x-ratelimit-remaining: 0 (a refusal, never a rate limit)', async () => {
        const { http } = at([[/a\.example/, {
            status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: '<div id="cf-chl-widget">',
        }]]);
        await expect(http.request('https://a.example/x')).rejects.toBeInstanceOf(AccessDeniedError);
    });

    test('security F6: cf-mitigated: challenge wins — a 403 with Retry-After / remaining 0, or a 429, is a REFUSAL, never retried', async () => {
        const a = at([[/a\.example/, { status: 403, headers: { 'cf-mitigated': 'challenge', 'retry-after': '30', 'x-ratelimit-remaining': '0' }, body: '' }]]);
        await expect(a.http.request('https://a.example/x')).rejects.toBeInstanceOf(AccessDeniedError);
        const b = at([[/a\.example/, { status: 429, headers: { 'cf-mitigated': 'Challenge', 'retry-after': '1' }, body: '' }]]);
        await expect(b.http.request('https://a.example/x')).rejects.toBeInstanceOf(AccessDeniedError);
        expect(b.transport.calls).toHaveLength(1);
        expect(b.http.holds).toEqual({});
    });

    test('security F6: an undecodable 403 stays a refusal unless remaining is 0 — and never with cf-mitigated: challenge', async () => {
        const undecodable = (status, headers) => () => { throw Object.assign(new Error('incorrect header check'), { decode: true, status, headers }); };
        const a = at([[/a\.example/, undecodable(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(RESET) })]]);
        const e1 = await a.http.request('https://a.example/x').catch(e => e);
        expect(e1).toBeInstanceOf(RateLimitedError);
        expect(e1.retryAt).toBe(RESET * 1000);
        expect(a.transport.calls).toHaveLength(1);
        const b = at([[/a\.example/, undecodable(429, {})]]);
        await expect(b.http.request('https://a.example/x')).rejects.toBeInstanceOf(RateLimitedError);
        expect(b.transport.calls).toHaveLength(1);
        for (const headers of [{ server: 'x' }, { 'retry-after': '30' }, { 'cf-mitigated': 'challenge', 'x-ratelimit-remaining': '0' }]) {
            const c = at([[/a\.example/, undecodable(403, headers)]]);
            await expect(c.http.request('https://a.example/x')).rejects.toBeInstanceOf(AccessDeniedError);
        }
        const d = at([[/a\.example/, undecodable(429, { 'cf-mitigated': 'challenge' })]]);
        await expect(d.http.request('https://a.example/x')).rejects.toBeInstanceOf(AccessDeniedError);
    });

    test('429 with a short Retry-After (5 s): waited out EXACTLY, then retried once; the success clears the host\'s streak', async () => {
        const { sleeps, sleep } = recordSleeps();
        let n = 0;
        const { http, transport } = at([[/a\.example/, () => (++n === 1
            ? { status: 429, headers: { 'retry-after': '5' } } : { body: 'ok' })]], { sleep });
        http.holds['a.example'] = { until: iso(NOW - 1000), http_status: 429, signal: 'http_429', count: 3, weak: 0 };
        expect((await http.request('https://a.example/x')).body).toBe('ok');
        expect(transport.calls).toHaveLength(2);
        expect(sleeps).toEqual([5000]);
        expect(http.holds).toEqual({});
        expect(http.drainHoldChanges().get('a.example')).toBeNull();
    });

    test('regression: 429 with Retry-After 600 s is NEVER retried early — one request, no sleep, backoff = 600 s', async () => {
        const { sleeps, sleep } = recordSleeps();
        const { http, transport } = at([[/a\.example/, { status: 429, headers: { 'retry-after': '600' } }]], { sleep });
        const err = await http.request('https://a.example/x').catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err).toMatchObject({ status: 429, signal: 'http_429', retryAt: NOW + 600000 });
        expect(transport.calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
        expect(http.holds['a.example'].until).toBe(iso(NOW + 600000));
    });

    test('security F4: a 429 with Retry-After 1e306 — exactly one request, no sleep, held for the 24 h cap', async () => {
        const { sleeps, sleep } = recordSleeps();
        const { http, transport } = at([[/a\.example/, { status: 429, headers: { 'retry-after': '1e306' } }]], { sleep });
        const err = await http.request('https://a.example/x').catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(transport.calls).toHaveLength(1);
        expect(sleeps).toEqual([]);
        expect(http.holds['a.example'].until).toBe(iso(NOW + 86400000));
    });

    test('security F4: remaining 0 with x-ratelimit-reset 1e306 → held for the 24 h cap, not the 60 s floor', async () => {
        const { http } = at([[/api\.github\.com/, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1e306' }, body: '' }]]);
        await expect(http.request(URL_)).rejects.toBeInstanceOf(RateLimitedError);
        expect(http.holds['api.github.com'].until).toBe(iso(NOW + 86400000));
    });

    test('429 with x-ratelimit-remaining 0 and a reset 8 s away: waits until the reset, never the shorter exponential backoff', async () => {
        const { sleeps, sleep } = recordSleeps();
        let n = 0;
        const { http } = at([[/a\.example/, () => (++n === 1
            ? { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 8) } }
            : { body: 'ok' })]], { sleep });
        expect((await http.request('https://a.example/x')).body).toBe('ok');
        expect(sleeps).toEqual([8000]);
    });

    // PR #44 merge: the in-run wait is at most 10 s (TLDR deadline), so a
    // reset 30 s away is a hold — never slept, never retried before it.
    test('429 with x-ratelimit-remaining 0 and a reset 30 s away: no sleep, one request, held (60 s floor)', async () => {
        const { sleeps, sleep } = recordSleeps();
        const { http, transport } = at([[/a\.example/, {
            status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 30) },
        }]], { sleep });
        await expect(http.request('https://a.example/x')).rejects.toBeInstanceOf(RateLimitedError);
        expect(sleeps).toEqual([]);
        expect(transport.calls).toHaveLength(1);
        expect(http.holds['a.example'].until).toBe(iso(NOW + 60000));
    });

    test('a 429 still answered after the retries → RateLimitedError (rate_limited), never HttpError / http_4xx', async () => {
        const { sleeps, sleep } = recordSleeps();
        const { http, transport } = at([[/a\.example/, { status: 429, headers: { 'retry-after': '2' } }]], { sleep });
        const err = await http.request('https://a.example/x').catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(classifyError(err)).toEqual({ error_kind: 'rate_limited', http_status: 429 });
        expect(transport.calls).toHaveLength(3);
        expect(sleeps).toEqual([2000, 2000]);
        expect(err.retryAt).toBe(NOW + 60000);   // the 60 s floor
    });

    test('security F1: consecutive rate limits of a host grow its hold (60 → 120 → 240 s); the 5th weak one is a REFUSAL', async () => {
        let t = NOW;
        const { http } = client([[/api\.github\.com/, { status: 403, headers: GH, body: SECONDARY }]], { now: () => t });
        const lengths = [];
        for (let i = 1; i < 5; i++) {
            const err = await http.request(URL_).catch(e => e);
            expect([i, err.constructor.name]).toEqual([i, 'RateLimitedError']);
            lengths.push(Date.parse(http.holds['api.github.com'].until) - t);
            t = Date.parse(http.holds['api.github.com'].until);   // the hold passes
        }
        expect(lengths).toEqual([60000, 120000, 240000, 480000]);
        const fifth = await http.request(URL_).catch(e => e);
        expect(fifth).toBeInstanceOf(AccessDeniedError);
        expect(fifth.message).toMatch(/5 rate limits in a row on body text alone — treated as a refusal \(fail closed\)/);
        expect(http.holds).toEqual({});
    });

    test('grumpy #7: a 5xx whose Retry-After is too long to wait in-run holds the host (signal retry_after_5xx), still http_5xx', async () => {
        const { http, transport } = at([[/a\.example/, { status: 503, headers: { 'retry-after': '3600' } }]]);
        const err = await http.request('https://a.example/x').catch(e => e);
        expect(classifyError(err)).toEqual({ error_kind: 'http_5xx', http_status: 503 });
        expect(transport.calls).toHaveLength(1);
        expect(http.holds['a.example']).toMatchObject({ until: iso(NOW + 3600000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0 });
        await expect(http.request('https://a.example/x')).rejects.toMatchObject({ held: true });
        expect(transport.calls).toHaveLength(1);
    });

    test('a held host is never requested: RateLimitedError { held: true }, zero transport calls; other hosts proceed', async () => {
        const { http, transport } = at([[/api\.github\.com/, { body: '{}' }], [/github\.blog/, { body: '<rss/>' }]]);
        http.holds['api.github.com'] = { until: iso(NOW + 300000), http_status: 403, signal: 'body_rate_limit', count: 1, weak: 1 };
        const err = await http.request(URL_).catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err).toMatchObject({ held: true, host: 'api.github.com', retryAt: NOW + 300000 });
        expect(classifyError(err).error_kind).toBe('rate_limited');
        expect(err.message).toMatch(/not requested: api\.github\.com is rate-limiting us .*backing off until 2026-10-01T02:52:54\.000Z/);
        expect(transport.calls).toHaveLength(0);
        expect((await http.request('https://github.blog/ai-and-ml/feed/')).body).toBe('<rss/>');
        // Once the hold has passed the host is asked again.
        const later = client([[/api\.github\.com/, { body: '{}' }]], { now: () => NOW + 300000, holds: http.holds });
        expect((await later.http.request(URL_)).body).toBe('{}');
    });

    test('security F5 / grumpy #2: holds are keyed by hostname — a port or letter case never escapes one', async () => {
        const { http, transport } = at([[/a\.example/, { body: 'x' }]]);
        http.holds['a.example'] = { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0 };
        await expect(http.request('https://A.Example:8443/x')).rejects.toMatchObject({ held: true });
        expect(transport.calls).toHaveLength(0);
    });

    test('security F5: a redirect hop to a held host is never requested', async () => {
        const { http, transport } = at([
            [/a\.example/, { status: 302, headers: { location: 'https://b.example/y' } }],
            [/b\.example/, { body: 'x' }],
        ]);
        http.holds['b.example'] = { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0 };
        await expect(http.request('https://a.example/x')).rejects.toMatchObject({ held: true, host: 'b.example' });
        expect(transport.calls.filter(c => c.url.includes('b.example'))).toHaveLength(0);
    });

    test('security F5: a robots.txt redirect to a held host is never fetched (and nothing is cached)', async () => {
        const { http, transport } = at([
            ['https://a.example/robots.txt', { status: 301, headers: { location: 'https://b.example/robots.txt' } }],
            [/b\.example/, { body: 'User-agent: *\nAllow: /' }],
            [/a\.example\/page/, { body: 'ok' }],
        ]);
        http.holds['b.example'] = { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0 };
        await expect(http.request('https://a.example/page', { robots: true })).rejects.toMatchObject({ held: true, host: 'b.example' });
        expect(transport.calls.filter(c => c.url.includes('b.example'))).toHaveLength(0);
        expect(transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
    });

    test('Copilot: a rate limit on robots.txt itself (429 + Retry-After) holds the host — nothing cached, the page never fetched', async () => {
        const robotsCache = new Map();
        const { http, transport } = at([
            ['https://a.example/robots.txt', { status: 429, headers: { 'retry-after': '600' }, body: '' }],
            [/a\.example\/page/, { body: 'ok' }],
        ], { robotsCache });
        const err = await http.request('https://a.example/page', { robots: true }).catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err).toMatchObject({ host: 'a.example', status: 429 });
        expect(http.holds['a.example']).toMatchObject({ until: iso(NOW + 600000), signal: 'http_429' });
        expect(robotsCache.size).toBe(0);
        expect(transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
        // A robots.txt 403 with remaining 0 is a rate limit too (not "allow all").
        const b = at([['https://b.example/robots.txt', { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: '' }],
            [/b\.example\/page/, { body: 'ok' }]], { robotsCache: new Map() });
        await expect(b.http.request('https://b.example/page', { robots: true })).rejects.toBeInstanceOf(RateLimitedError);
        expect(b.transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
    });

    test('Copilot (3rd): robots.txt goes through the same classification — a bot wall is a REFUSAL, never "allow all"', async () => {
        const robotsCache = new Map();
        const { http, transport } = at([
            ['https://a.example/robots.txt', { status: 403, headers: {}, body: '<div id="cf-chl-widget">' }],
            [/a\.example\/page/, { body: 'ok' }],
        ], { robotsCache });
        await expect(http.request('https://a.example/page', { robots: true })).rejects.toBeInstanceOf(AccessDeniedError);
        expect(transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
        expect(robotsCache.size).toBe(0);
    });

    test('Copilot (3rd): an undecodable robots.txt is classified too (rate-limit headers → hold; a challenge header → refusal)', async () => {
        const undecodable = (status, headers) => () => { throw Object.assign(new Error('incorrect header check'), { decode: true, status, headers }); };
        const a = at([['https://a.example/robots.txt', undecodable(429, { 'retry-after': '600' })], [/a\.example\/page/, { body: 'ok' }]], { robotsCache: new Map() });
        await expect(a.http.request('https://a.example/page', { robots: true })).rejects.toBeInstanceOf(RateLimitedError);
        expect(a.http.holds['a.example']).toMatchObject({ until: iso(NOW + 600000) });
        expect(a.transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
        const b = at([['https://b.example/robots.txt', undecodable(403, { 'cf-mitigated': 'challenge' })], [/b\.example\/page/, { body: 'ok' }]], { robotsCache: new Map() });
        await expect(b.http.request('https://b.example/page', { robots: true })).rejects.toBeInstanceOf(AccessDeniedError);
        expect(b.transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
    });

    test('Copilot (3rd): a successful robots.txt ends the host\'s expired streak (a success is a success)', async () => {
        const { http } = at([['https://a.example/robots.txt', { body: 'User-agent: *\nDisallow: /private' }], [/a\.example\/page/, { body: 'ok' }]],
            { robotsCache: new Map() });
        http.holds['a.example'] = { until: iso(NOW - 1000), http_status: 403, signal: 'body_rate_limit', count: 4, weak: 4, at: iso(NOW - 600000) };
        http.holds['b.example'] = { until: iso(NOW - 1000), http_status: 429, signal: 'http_429', count: 2, weak: 0, at: iso(NOW - 600000) };
        await expect(http.request('https://a.example/private/x', { robots: true })).rejects.toBeInstanceOf(RobotsDisallowedError);
        expect(http.holds).not.toHaveProperty(['a.example']);
        expect(http.holds).toHaveProperty(['b.example']);
    });

    test('security F5: the governance terms fetch never requests a held host', async () => {
        const { snapshotTerms } = require('../../../src/collectors/governance');
        const { http, transport } = at([[/./, { body: 'terms' }]]);
        http.holds['docs.github.com'] = { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0 };
        const [row] = await snapshotTerms({ http, slugs: ['github'], loadHolds: async () => ({}) });
        expect(row).toMatchObject({ status: 'unreachable' });
        expect(row.reason).toMatch(/rate-limiting us/);
        expect(transport.calls).toHaveLength(0);
    });

    test('the header allow-list keeps x-ratelimit-limit/-remaining/-reset/-used/-resource, scrubbed, one-line and capped', () => {
        const { refusalHeaders, REFUSAL_HEADER_ALLOWLIST } = require('../../../src/collectors/http');
        for (const h of ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-used', 'x-ratelimit-resource']) {
            expect(REFUSAL_HEADER_ALLOWLIST).toContain(h);
        }
        const SECRET = 'ghp_ratelimitsecret123456';
        const out = refusalHeaders({
            'x-ratelimit-remaining': '0', 'x-ratelimit-resource': `search\r\nX-Evil: ${SECRET}`, 'x-ratelimit-used': '9'.repeat(400),
            'x-github-request-id': 'ABCD:1234', 'set-cookie': 'a=b',
        }, { ...TEST_ENV, GITHUB_TOKEN: SECRET });
        expect(out['x-ratelimit-remaining']).toBe('0');
        expect(out['x-ratelimit-resource']).not.toContain(SECRET);
        expect(out['x-ratelimit-resource']).not.toMatch(/[\r\n]/);
        expect(out['x-ratelimit-used'].length).toBe(200);
        // Still dropped: the request id (security L3 class) and cookies.
        expect(out).not.toHaveProperty('x-github-request-id');
        expect(out).not.toHaveProperty('set-cookie');
    });
});
