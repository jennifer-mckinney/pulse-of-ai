// tests/unit/pure/collectorHttp.test.js
// The collector HTTP client and robots policy (src/collectors/http.js,
// robots.js): User-Agent, backoff, refusals, conditional GET, robots with
// the conservative trailing-slash reading, and the no-network-in-tests guard.

'use strict';

const { HttpClient, HostLimiter, userAgent, defaultTransport, retryAfterMs } = require('../../../src/collectors/http');
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

    test('Retry-After is honoured but capped; absent → exponential', () => {
        expect(retryAfterMs({ 'retry-after': '5' }, 0)).toBe(5000);
        expect(retryAfterMs({ 'retry-after': '99999' }, 0)).toBe(60000);
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
    };

    test('a 403 AccessDeniedError carries ONLY the allow-listed headers, scrubbed and one-line', async () => {
        const { http, transport } = client([['https://www.pewresearch.org/wp-json/wp/v2/posts', {
            status: 403, headers: refusal, body: '<html>Forbidden</html>',
        }]], { env });
        const err = await http.request('https://www.pewresearch.org/wp-json/wp/v2/posts').catch(e => e);
        expect(err).toBeInstanceOf(AccessDeniedError);
        expect(transport.calls).toHaveLength(1);
        expect(Object.keys(err.headers).sort()).toEqual(['cf-ray', 'content-type', 'date', 'server', 'x-powered-by', 'x-rq', 'x-served-by']);
        // Dropped: cookies, auth, anything not allow-listed.
        for (const k of ['set-cookie', 'www-authenticate', 'authorization', 'x-custom-debug']) expect(err.headers).not.toHaveProperty(k);
        // Scrubbed and control-character free (security L4).
        expect(err.headers['x-served-by']).not.toContain(SECRET);
        expect(err.headers['x-served-by']).toContain('[redacted]');
        expect(err.headers['x-served-by']).not.toMatch(/[\r\n]/);
        expect(err.headers['x-served-by']).toContain('\\r\\n');
        // No body is ever kept.
        expect(JSON.stringify(err)).not.toContain('Forbidden');
    });

    test('the allow-list never contains a cookie or credential header', () => {
        for (const bad of ['set-cookie', 'cookie', 'authorization', 'proxy-authorization', 'www-authenticate', 'proxy-authenticate']) {
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
