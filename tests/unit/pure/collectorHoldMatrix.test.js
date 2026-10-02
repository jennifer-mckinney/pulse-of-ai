// tests/unit/pure/collectorHoldMatrix.test.js
// PR #45 — the systematic matrix (docs/research/rate-limit-hold-matrix.md).
// Every HTTP path that can meet a response (request(), request() behind a
// redirect, robots.txt, robots.txt behind a redirect, the held second call)
// crossed with every response class (429, 403 with x-ratelimit-remaining 0, a
// bot wall at any status, 503 + Retry-After, a plain 403, a success), ONE test
// per cell, so a classification, cause or expiry slip in one path cannot hide
// behind a test of another. The rows below share one table: a path says where
// the scenario's response is served; a scenario says what the client must do.

'use strict';

const { HttpClient } = require('../../../src/collectors/http');
const { RateLimitedError, AccessDeniedError, HttpError, RobotsDisallowedError, classifyError } = require('../../../src/collectors/errors');
const rl = require('../../../src/collectors/rate-limit');
const { fixtureTransport, TEST_ENV } = require('../../helpers/fixtureTransport');

const NOW = Date.parse('2026-10-01T02:47:54Z');
const iso = ms => new Date(ms).toISOString();
const noSleep = () => Promise.resolve();
const CHALLENGE_BODY = '<html><div id="cf-chl-widget"></div></html>';

// The response each scenario serves, and what every path must make of it.
//   kind 'limit'    RateLimitedError, the final host held (the first host too behind a redirect), never AccessDenied
//   kind 'wall'     AccessDeniedError (a refusal), NO hold
//   kind 'server'   a 5xx Retry-After hold: HttpError (never RateLimitedError), signal retry_after_5xx
//   kind 'refusal'  a plain 403: AccessDeniedError (a page AND robots.txt — ADR 0001 ruling 5); NO hold
//   kind 'content'  a 2xx that is content (page) / a refusal (robots.txt)
const SCENARIOS = {
    '429 + Retry-After': { res: { status: 429, headers: { 'retry-after': '600' }, body: '' }, kind: 'limit', signal: 'http_429' },
    '403 + x-ratelimit-remaining 0': {
        res: { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(NOW / 1000) + 600) }, body: '' },
        kind: 'limit', signal: 'ratelimit_remaining_zero',
    },
    'bot wall: cf-mitigated header on a 200': { res: { status: 200, headers: { 'cf-mitigated': 'challenge' }, body: 'ok' }, kind: 'wall' },
    'bot wall: cf-mitigated header on a 302': { res: { status: 302, headers: { 'cf-mitigated': 'challenge', location: 'https://z.example/next' }, body: '' }, kind: 'wall' },
    'bot wall: cf-mitigated header on a 403 with remaining 0': {
        res: { status: 403, headers: { 'cf-mitigated': 'challenge', 'x-ratelimit-remaining': '0', 'retry-after': '600' }, body: '' }, kind: 'wall',
    },
    'bot wall: challenge page on a 301': { res: { status: 301, headers: { location: 'https://z.example/next' }, body: CHALLENGE_BODY }, kind: 'wall' },
    'bot wall: challenge page on a 429': { res: { status: 429, headers: { 'retry-after': '600' }, body: CHALLENGE_BODY }, kind: 'wall' },
    'bot wall: challenge page on a 403': { res: { status: 403, headers: {}, body: CHALLENGE_BODY }, kind: 'wall' },
    'bot wall: challenge page on a 503 with Retry-After': { res: { status: 503, headers: { 'retry-after': '3600' }, body: CHALLENGE_BODY }, kind: 'wall' },
    'bot wall: challenge page on a 200 text/html': { res: { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: CHALLENGE_BODY }, kind: 'wall' },
    '503 + Retry-After 3600': { res: { status: 503, headers: { 'retry-after': '3600' }, body: '' }, kind: 'server', signal: 'retry_after_5xx' },
    'plain 403': { res: { status: 403, headers: { server: 'Varnish' }, body: '' }, kind: 'refusal' },
};

// Where the scenario's response is served.
//   page      the page itself (first hop)
//   redirect  the page redirects to another host; the response is that host's
//   robots    the response is robots.txt of the page's host
//   robotsRedirect  robots.txt redirects to another host; the response is that host's
const PATHS = ['page', 'redirect', 'robots', 'robotsRedirect'];

function build(path, res) {
    const robots = path === 'robots' || path === 'robotsRedirect';
    const redirected = path === 'redirect' || path === 'robotsRedirect';
    const routes = [];
    const final = redirected ? 'b.example' : 'a.example';
    if (path === 'page') routes.push([/a\.example\/page/, res]);
    if (path === 'redirect') {
        routes.push([/a\.example\/page/, { status: 302, headers: { location: 'https://b.example/page' }, body: '' }]);
        routes.push([/b\.example\/page/, res]);
    }
    if (path === 'robots') {
        routes.push(['https://a.example/robots.txt', res]);
        routes.push([/a\.example\/page/, { body: 'ok' }]);
    }
    if (path === 'robotsRedirect') {
        routes.push(['https://a.example/robots.txt', { status: 301, headers: { location: 'https://b.example/robots.txt' }, body: '' }]);
        routes.push(['https://b.example/robots.txt', res]);
        routes.push([/a\.example\/page/, { body: 'ok' }]);
    }
    // A scenario that redirects (wall on a 3xx) points at z.example: it must never be requested.
    routes.push([/z\.example/, { body: 'never' }]);
    const transport = fixtureTransport(routes);
    const http = new HttpClient({ transport, env: TEST_ENV, now: () => NOW, sleep: noSleep, robotsCache: new Map() });
    return { http, transport, robots, redirected, final, first: 'a.example', run: () => http.request('https://a.example/page', { robots }) };
}

const cells = [];
for (const [name, sc] of Object.entries(SCENARIOS)) for (const path of PATHS) cells.push([path, name, sc]);

describe('matrix: HTTP path x response class (one test per cell)', () => {
    test.each(cells)('%s x %s', async (path, name, sc) => {
        const t = build(path, sc.res);
        const robots = t.robots;
        // A 3xx wall on the first hop of a redirect path is the redirect itself: serve it as the page's response.
        const err = await t.run().then(() => null, e => e);
        const holds = Object.keys(t.http.holds).sort();
        // Nothing behind a refusal wall is ever requested (z.example is the redirect target of the wall scenarios).
        expect(t.transport.calls.filter(c => c.url.includes('z.example'))).toHaveLength(0);
        if (sc.kind === 'limit') {
            expect(err).toBeInstanceOf(RateLimitedError);
            expect(err).not.toBeInstanceOf(AccessDeniedError);
            expect(classifyError(err).error_kind).toBe('rate_limited');
            expect(t.http.holds[t.final]).toMatchObject({ signal: sc.signal });
            // A hold learned behind a redirect also holds the host that was asked first.
            expect(holds).toEqual(t.redirected ? [t.first, t.final].sort() : [t.final]);
            if (t.redirected) expect(t.http.holds[t.first]).toMatchObject({ signal: sc.signal, until: t.http.holds[t.final].until });
            // The page itself is never fetched when robots.txt is what was limited.
            if (robots) expect(t.transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
        } else if (sc.kind === 'wall') {
            // A bot wall is a refusal at every status and never a hold or a rate limit.
            expect(err).toBeInstanceOf(AccessDeniedError);
            expect(classifyError(err).error_kind).toBe('access_denied');
            expect(holds).toEqual([]);
            if (robots) expect(t.transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
        } else if (sc.kind === 'server') {
            expect(holds).toEqual(t.redirected ? [t.first, t.final].sort() : [t.final]);
            expect(t.http.holds[t.final]).toMatchObject({ signal: 'retry_after_5xx', http_status: 503, count: 0, until: iso(NOW + 3600000) });
            if (robots) {
                // robots.txt unreachable: a robots failure, never a rate limit or a refusal.
                expect(err).toBeInstanceOf(RobotsDisallowedError);
                expect(err.kind).toBe('robots_unreachable');
            } else {
                expect(err).toBeInstanceOf(HttpError);
                expect(err).not.toBeInstanceOf(RateLimitedError);
                expect(classifyError(err)).toEqual({ error_kind: 'http_5xx', http_status: 503 });
            }
        } else if (sc.kind === 'refusal') {
            // ADR 0001 ruling 5: a plain 403 is the source saying no, on robots.txt too (never "no rules").
            expect(err).toBeInstanceOf(AccessDeniedError);
            expect(holds).toEqual([]);
            if (robots) expect(t.transport.calls.filter(c => c.url.includes('/page'))).toHaveLength(0);
        }
    });
});

describe('matrix: a 2xx page that is content is not a refusal', () => {
    test('a bot-wall marker inside a JSON or feed body (an article about the vendor) is content, not a refusal', async () => {
        for (const type of ['application/json', 'application/rss+xml', 'application/atom+xml', 'text/plain']) {
            const t = build('page', { status: 200, headers: { 'content-type': type }, body: '{"title":"How DataDome and captcha-delivery work"}' });
            expect((await t.run()).status).toBe(200);
            expect(t.http.holds).toEqual({});
        }
    });
});

describe('matrix: the held second call (heldError)', () => {
    test.each(cells)('%s x %s: the next call', async (path, name, sc) => {
        const t = build(path, sc.res);
        await t.run().catch(() => {});
        const before = t.transport.calls.length;
        const again = await t.run().then(() => null, e => e);
        const sent = t.transport.calls.length - before;
        if (sc.kind === 'limit') {
            // Held: refused unsent (no request, not even robots.txt), the cause named.
            expect(again).toBeInstanceOf(RateLimitedError);
            expect(again).toMatchObject({ held: true });
            expect(sent).toBe(0);
        } else if (sc.kind === 'server') {
            // A server backoff is honoured too, but it is an http_5xx failure — never rate_limited.
            expect(again).toBeInstanceOf(HttpError);
            expect(again).not.toBeInstanceOf(RateLimitedError);
            expect(again).toMatchObject({ held: true, status: 503 });
            expect(classifyError(again).error_kind).toBe('http_5xx');
            expect(sent).toBe(0);
        } else {
            // A refusal never creates a hold: the next call is sent (and refused again).
            expect(sent).toBeGreaterThan(0);
            expect(again).toBeInstanceOf(AccessDeniedError);
        }
    });
});

describe('matrix: success resets the streak on every host the path touched', () => {
    const LIMIT = { until: iso(NOW - 1000), http_status: 429, signal: 'http_429', count: 4, weak: 0, at: iso(NOW - 600000) };
    const SERVER = { until: iso(NOW - 1000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0, at: iso(NOW - 600000) };
    const OK = { status: 200, headers: {}, body: 'User-agent: *\nDisallow:\n' };
    test.each([['page'], ['redirect'], ['robots'], ['robotsRedirect']].flatMap(([p]) => [[p, 'rate-limit', LIMIT], [p, '5xx', SERVER]]))(
        '%s x expired %s hold', async (path, _kind, hold) => {
            const t = build(path, OK);
            t.http.holds['a.example'] = { ...hold };
            t.http.holds['b.example'] = { ...hold };
            t.http.holds['c.example'] = { ...hold };   // a host this path never touches keeps its streak
            if (path === 'page' || path === 'robots') delete t.http.holds['b.example'];
            await t.run();
            expect(t.http.holds['a.example']).toBeUndefined();
            if (path === 'redirect' || path === 'robotsRedirect') expect(t.http.holds['b.example']).toBeUndefined();
            expect(t.http.holds['c.example']).toBeDefined();
            expect(t.http.drainHoldChanges().get('a.example')).toBeNull();
        });
});

describe('matrix: combineHold is order-independent (concurrent merge, both orders)', () => {
    const rec = (over) => ({ until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW), ...over });
    const kinds = {
        '429': rec({ count: 3 }),
        'weak body': rec({ http_status: 403, signal: 'body_rate_limit', count: 2, weak: 2 }),
        'strong 403': rec({ http_status: 403, signal: 'ratelimit_remaining_zero', count: 4, strong403: 4, until: iso(NOW + 900000) }),
        '5xx': rec({ http_status: 503, signal: 'retry_after_5xx', count: 0, until: iso(NOW + 3600000) }),
    };
    const pairs = [];
    for (const a of Object.keys(kinds)) for (const b of Object.keys(kinds)) pairs.push([a, b]);
    test.each(pairs)('%s then %s equals %s... reversed — records written in the same millisecond', (a, b) => {
        const x = kinds[a];
        const y = kinds[b];
        // The same `at`: the tie must be broken by the records themselves, never by the argument order.
        expect(rl.combineHold(x, y)).toEqual(rl.combineHold(y, x));
        // Different `at`: the newest gives the streaks, whichever side it is on.
        const older = { ...x, at: iso(NOW - 5000) };
        expect(rl.combineHold(older, y)).toEqual(rl.combineHold(y, older));
    });

    test('mergeHolds of the same stored rows is independent of the row order', () => {
        const rows = Object.values(kinds).map(h => ({ 'h.example': h }));
        const fwd = {};
        const rev = {};
        for (const r of rows) rl.mergeHolds(fwd, r, NOW);
        for (const r of [...rows].reverse()) rl.mergeHolds(rev, r, NOW);
        expect(fwd).toEqual(rev);
    });
});

describe('matrix: held-host aliases and mid-flight holds', () => {
    test('a redirect into an already-held host holds the host first asked too (grumpy 8)', async () => {
        const t = build('redirect', { status: 200, body: 'ok' });
        t.http.holds['b.example'] = { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) };
        const err = await t.run().catch(e => e);
        expect(err).toMatchObject({ held: true });
        expect(t.http.holds['a.example']).toMatchObject({ signal: 'http_429', until: iso(NOW + 600000) });
        expect([...t.http.drainHoldChanges().keys()]).toContain('a.example');
    });

    test('a trailing-dot or www. twin of a held host is held too (security F4)', async () => {
        const { http, transport } = (() => {
            const tr = fixtureTransport([[/./, { body: 'ok' }]]);
            return { http: new HttpClient({ transport: tr, env: TEST_ENV, now: () => NOW, sleep: noSleep, robotsCache: new Map() }), transport: tr };
        })();
        http.holds['h.example'] = { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) };
        for (const u of ['https://h.example./x', 'https://H.EXAMPLE/x', 'https://www.h.example/x']) {
            expect(await http.request(u).catch(e => e)).toMatchObject({ held: true });
        }
        expect(transport.calls).toHaveLength(0);
    });

    test('a hold set between attempts is the answer, not a swallowed retry (grumpy 1)', async () => {
        const sleeps = [];
        let http;
        const tr = fixtureTransport([[/h\.example/, () => {
            http.holds['h.example'] = { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) };
            return { status: 500, body: '' };
        }]]);
        http = new HttpClient({ transport: tr, env: TEST_ENV, now: () => NOW, sleep: ms => { sleeps.push(ms); return Promise.resolve(); }, robotsCache: new Map() });
        const err = await http.request('https://h.example/x').catch(e => e);
        expect(err).toBeInstanceOf(RateLimitedError);
        expect(err.held).toBe(true);
    });

    test('an undecodable 503 with a long Retry-After holds the host (grumpy 14)', async () => {
        const t = build('page', () => { throw Object.assign(new Error('incorrect header check'), { decode: true, status: 503, headers: { 'retry-after': '3600' } }); });
        const err = await t.run().catch(e => e);
        expect(err).toBeInstanceOf(HttpError);
        expect(t.http.holds['a.example']).toMatchObject({ signal: 'retry_after_5xx' });
    });

    test('a 403 on /robots.txt with a bare remaining: 0 is a refusal, never a rate limit (security F1 / P1)', async () => {
        const t = build('robots', { status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: '' });
        expect(await t.run().catch(e => e)).toBeInstanceOf(AccessDeniedError);
        expect(t.http.holds).toEqual({});
    });
});

describe('security F6: hold maps have no prototype', () => {
    test('__proto__, constructor, hasOwnProperty and toString are never hosts; maps are prototype-less; heldUntil ignores inherited keys', () => {
        const until = iso(NOW + 600000);
        const stored = JSON.parse(`{"__proto__":{"until":"${until}"},"constructor":{"until":"${until}"},"hasOwnProperty":{"until":"${until}"},"toString":{"until":"${until}"},"ok.example":{"until":"${until}"}}`);
        const out = rl.sanitizeHolds(stored, NOW);
        expect(Object.getPrototypeOf(out)).toBeNull();
        expect(Object.keys(out)).toEqual(['ok.example']);
        expect(Object.getPrototypeOf(rl.activeHolds(stored, NOW))).toBeNull();
        for (const k of ['__proto__', 'constructor', 'hasOwnProperty', 'toString']) expect(rl.heldUntil(out, k, NOW)).toBeNull();
        expect(Object.getPrototypeOf(new HttpClient({ transport: async () => ({}), env: TEST_ENV }).holds)).toBeNull();
    });
});

describe('review round: false-positive walls, forged resets, escalation behind a redirect, undecodable robots 5xx', () => {
    const jsd = '<html><body>Not found<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>';

    test('Cloudflare\'s jsd beacon on an ordinary 404 / 503 / small 200 page is NOT a bot wall; robots 404 through Cloudflare is "no rules"', async () => {
        for (const status of [404, 503, 200]) {
            const t = build('page', { status, headers: { 'content-type': 'text/html' }, body: jsd });
            const err = await t.run().catch(e => e);
            expect(err && err.refusal).toBeUndefined();
            if (status !== 200) expect(err).toBeInstanceOf(HttpError);
        }
        const r = build('robots', { status: 404, headers: { 'content-type': 'text/html' }, body: jsd });
        expect(await r.run().catch(e => e)).toMatchObject({ status: 200 });
    });

    test('a 200 text/plain robots.txt that names a vendor is rules, not a wall; an HTML wall without a content-type still is one', async () => {
        const rules = build('robots', { status: 200, headers: { 'content-type': 'text/plain' }, body: 'User-agent: DataDome\nDisallow: /cdn-cgi/challenge-platform/\n' });
        expect(await rules.run().catch(e => e)).toMatchObject({ status: 200 });
        const wall = build('page', { status: 200, headers: {}, body: '<!doctype html><html><div id="cf-chl-widget"></div></html>' });
        expect(await wall.run().catch(e => e)).toBeInstanceOf(AccessDeniedError);
        const px = build('page', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html><div id="px-captcha"></div></html>' });
        expect(await px.run().catch(e => e)).toBeInstanceOf(AccessDeniedError);
    });

    test('a forged relative reset (x-ratelimit-reset: 1 / 60) on a 403 is a refusal; a 429 may carry one', async () => {
        for (const reset of ['1', '60']) {
            const t = build('page', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset }, body: '' });
            expect(await t.run().catch(e => e)).toBeInstanceOf(AccessDeniedError);
            expect(t.http.holds).toEqual({});
        }
        const t = build('page', { status: 429, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '90' }, body: '' });
        expect(await t.run().catch(e => e)).toBeInstanceOf(RateLimitedError);
    });

    test('an escalated refusal behind a redirect holds the host first asked too', async () => {
        let t0 = NOW;
        const reset = () => String(Math.floor(t0 / 1000) + 600);
        const tr = fixtureTransport([
            [/a\.example\/page/, { status: 302, headers: { location: 'https://b.example/page' }, body: '' }],
            [/b\.example\/page/, () => ({ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset() }, body: '' })],
        ]);
        const http = new HttpClient({ transport: tr, env: TEST_ENV, now: () => t0, sleep: noSleep, robotsCache: new Map() });
        let err;
        for (let i = 0; i < 5; i++) {
            err = await http.request('https://a.example/page').catch(e => e);
            t0 = Date.parse(http.holds['b.example'].until);
            if (i < 4) delete http.holds['a.example'];
        }
        expect(err).toMatchObject({ refusal: 'escalated' });
        expect(http.holds['a.example']).toMatchObject({ count: 5 });
    });

    test.each([['robots'], ['robotsRedirect']])('an undecodable 503 robots.txt with a long Retry-After holds the host (%s)', async (path) => {
        const t = build(path, () => { throw Object.assign(new Error('incorrect header check'), { decode: true, status: 503, headers: { 'retry-after': '3600' } }); });
        await t.run().catch(() => {});
        expect(t.http.holds[t.final]).toMatchObject({ signal: 'retry_after_5xx' });
    });
});
