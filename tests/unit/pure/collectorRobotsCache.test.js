// tests/unit/pure/collectorRobotsCache.test.js — F10-9: one robots.txt cache
// per process (not per run), and an unreachable robots.txt is re-checked
// soon and never taken for a refusal (F10-5).

'use strict';

const { HttpClient } = require('../../../src/collectors/http');
const { RobotsPolicy, SHARED_CACHE, UNREACHABLE_TTL_MS } = require('../../../src/collectors/robots');
const { classifyError } = require('../../../src/collectors/errors');
const { refusalOf } = require('../../../src/collectors/refusal');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

const FEED = 'https://feeds.example.org/rss.xml';
const noSleep = () => Promise.resolve();

test('the network transport uses the process-level cache; fixture transports get their own', () => {
    expect(new HttpClient({ env: TEST_ENV }).robots.cache).toBe(SHARED_CACHE);
    expect(new HttpClient({ env: TEST_ENV, transport: fixtureTransport([]) }).robots.cache).not.toBe(SHARED_CACHE);
});

test('two runs (two clients) sharing the cache fetch robots.txt once', async () => {
    const cache = new Map();
    const transport = fixtureTransport([
        ['https://feeds.example.org/robots.txt', { status: 200, body: 'User-agent: *\nAllow: /\n' }],
        [FEED, { status: 200, body: '<rss/>' }],
    ]);
    for (let run = 0; run < 3; run++) {
        const http = new HttpClient({ env: TEST_ENV, transport, sleep: noSleep, robotsCache: cache });
        await http.request(FEED, { robots: true });
    }
    expect(transport.calls.filter(c => /robots\.txt/.test(c.url))).toHaveLength(1);
    expect(transport.calls.filter(c => c.url === FEED)).toHaveLength(3);
});

test('an unreachable robots.txt is cached only briefly and classified robots_unreachable, not a refusal', async () => {
    let t = 0;
    let calls = 0;
    const policy = new RobotsPolicy({ now: () => t, cache: new Map(), fetchRobots: async () => { calls++; return { status: 503, body: '' }; } });
    expect((await policy.check(FEED)).unreachable).toBe(true);
    t = UNREACHABLE_TTL_MS - 1;
    await policy.check(FEED);
    expect(calls).toBe(1);
    t = UNREACHABLE_TTL_MS + 1;
    await policy.check(FEED);
    expect(calls).toBe(2);

    const transport = fixtureTransport([['https://feeds.example.org/robots.txt', { status: 503, body: '' }]]);
    const http = new HttpClient({ env: TEST_ENV, transport, sleep: noSleep });
    const err = await http.request(FEED, { robots: true }).catch(e => e);
    expect(classifyError(err).error_kind).toBe('robots_unreachable');
    expect(refusalOf([classifyError(err)])).toBeNull();

    const disallowT = fixtureTransport([['https://feeds.example.org/robots.txt', { status: 200, body: 'User-agent: *\nDisallow: /\n' }]]);
    const denied = await new HttpClient({ env: TEST_ENV, transport: disallowT, sleep: noSleep }).request(FEED, { robots: true }).catch(e => e);
    expect(classifyError(denied).error_kind).toBe('robots');
    expect(refusalOf([classifyError(denied)])).toEqual({ kind: 'robots', status: null });
});

// Owner decision 2026-10-02 + security review: a 403 on robots.txt is "no rules", but a
// transient WAF block must not pin "allow everything" for 24 h; a 404 is a real "no file".
test('a 403 robots.txt ("no rules") is re-checked after the short TTL; a 404 is cached for the full TTL', async () => {
    const run = async (status) => {
        let t = 0;
        let calls = 0;
        const policy = new RobotsPolicy({ now: () => t, cache: new Map(), fetchRobots: async () => { calls++; return { status, body: '' }; } });
        expect((await policy.check(FEED)).allowed).toBe(true);
        t = UNREACHABLE_TTL_MS + 1;
        await policy.check(FEED);
        return calls;
    };
    expect(await run(403)).toBe(2);
    expect(await run(404)).toBe(1);
});
