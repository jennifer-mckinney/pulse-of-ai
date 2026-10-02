// tests/unit/pure/collectorRateLimit.test.js
// Diagnosis 2026-10-01 (GitHub 403 escalated as a refusal): the pure rules
// of src/collectors/rate-limit.js — what counts as POSITIVE evidence of a
// rate limit (security review F2 / F6: strict, fail closed), when the
// backoff ends (60 s floor growing per repeat, 24 h cap — F1 / F4), when
// weak evidence escalates to a refusal (F1), which routes of a source a
// host hold stops (grumpy #2), and what /api/sources may publish (F3).

'use strict';

const rl = require('../../../src/collectors/rate-limit');
const { getSource } = require('../../../src/config/source-registry');
const { TEST_ENV } = require('../../helpers/fixtureTransport');

const NOW = Date.parse('2026-10-01T02:47:54Z');
const EPOCH_RESET = Math.floor(NOW / 1000) + 600;   // GitHub: epoch seconds
const HOUR = 3600000;
const DAY = 24 * HOUR;
const json = msg => JSON.stringify({ message: msg, documentation_url: 'https://docs.github.com/rest' });
const iso = ms => new Date(ms).toISOString();

describe('rateLimitSignal: positive evidence only', () => {
    test('HTTP 429 is a rate limit (strong), with or without headers', () => {
        expect(rl.rateLimitSignal({ status: 429, headers: {}, body: '' }, NOW)).toEqual({ signal: 'http_429', retryAt: null, weak: false });
        expect(rl.rateLimitSignal({ status: 429, headers: { 'retry-after': '120' }, body: '' }, NOW))
            .toEqual({ signal: 'http_429', retryAt: NOW + 120000, weak: false });
    });

    test('403 with x-ratelimit-remaining: 0 → strong; retryAt is x-ratelimit-reset (epoch seconds)', () => {
        const res = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(EPOCH_RESET) }, body: '' };
        expect(rl.rateLimitSignal(res, NOW)).toEqual({ signal: 'ratelimit_remaining_zero', retryAt: EPOCH_RESET * 1000, weak: false });
    });

    test('x-ratelimit-reset as seconds-until-reset (Reddit) is read relative to now', () => {
        const res = { status: 403, headers: { 'x-ratelimit-remaining': '0.0', 'x-ratelimit-reset': '42' }, body: '' };
        expect(rl.rateLimitSignal(res, NOW)).toMatchObject({ signal: 'ratelimit_remaining_zero', retryAt: NOW + 42000 });
    });

    const GH = 'api.github.com';
    const SECONDARY = json('You have exceeded a secondary rate limit. Please wait a few minutes before you try again.');

    test.each([
        'API rate limit exceeded for 203.0.113.7. (But here\'s the good news: Authenticated requests get a higher rate limit.)',
        'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
        'You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.',
    ])('a 403 from api.github.com whose JSON message is GitHub\'s rate-limit wording (%#) → body_rate_limit (weak)', (msg) => {
        expect(rl.rateLimitSignal({ status: 403, headers: { 'content-type': 'application/json' }, body: json(msg) }, NOW, GH))
            .toEqual({ signal: 'body_rate_limit', retryAt: null, weak: true });
    });

    test('security F2 (re-review): GitHub\'s wording is evidence only from api.github.com — any other host (or none) stays a refusal', () => {
        for (const host of ['gh.example.com', 'github.blog', 'api.github.com.evil.example', undefined]) {
            expect([host, rl.rateLimitSignal({ status: 403, headers: { 'retry-after': '60' }, body: SECONDARY }, NOW, host)]).toEqual([host, null]);
        }
    });

    test('N1: GitHub\'s wording + a strict Retry-After from api.github.com is STRONG (body_rate_limit_retry_after)', () => {
        expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': '90' }, body: SECONDARY }, NOW, GH))
            .toEqual({ signal: 'body_rate_limit_retry_after', retryAt: NOW + 90000, weak: false });
        expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': new Date(NOW + 120000).toUTCString() }, body: SECONDARY }, NOW, 'API.GitHub.com'))
            .toEqual({ signal: 'body_rate_limit_retry_after', retryAt: NOW + 120000, weak: false });
        // The overflow form counts as present and is the cap.
        expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': '1e306' }, body: SECONDARY }, NOW, GH))
            .toEqual({ signal: 'body_rate_limit_retry_after', retryAt: Infinity, weak: false });
        expect(rl.SIGNALS).toContain('body_rate_limit_retry_after');
        expect(rl.WEAK_SIGNALS).toEqual(['body_rate_limit']);
    });

    test.each(['0', 'Thu, 01 Jan 1970 00:00:00 GMT', '1 2', '-5', '0x10'])(
        'N1: GitHub\'s wording + an INVALID Retry-After %p stays weak (the strict parse fails)', (ra) => {
            expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': ra }, body: SECONDARY }, NOW, GH))
                .toEqual({ signal: 'body_rate_limit', retryAt: null, weak: true });
        });

    test('security F2: Retry-After never classifies a 403 on its own (no body evidence)', () => {
        expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': '60' }, body: 'x' }, NOW, GH)).toBeNull();
        expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': new Date(NOW + 90000).toUTCString() }, body: '' }, NOW, GH)).toBeNull();
    });

    test.each(['0', '-5', '0x10', 'Thu, 01 Jan 1970 00:00:00 GMT', '1 2', 'soon', '1.5', ' 60 '])(
        'security F2: a 403 with only Retry-After %p stays a refusal (null)', (ra) => {
            expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': ra }, body: '' }, NOW, GH)).toBeNull();
        });

    test.each([
        'This IP is permanently banned for rate limit abuse',
        'Forbidden: rate limit policy violation, account suspended',
        'Your access is blocked. API rate limit exceeded is not the reason.',
    ])('security F2: a 403 message that merely MENTIONS a rate limit stays a refusal, even with Retry-After (%#)', (msg) => {
        expect(rl.rateLimitSignal({ status: 403, headers: {}, body: json(msg) }, NOW, GH)).toBeNull();
        expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': '60' }, body: json(msg) }, NOW, GH)).toBeNull();
    });

    test('N1: a challenge still wins over GitHub\'s wording + Retry-After', () => {
        expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': '60', 'cf-mitigated': 'challenge' }, body: SECONDARY }, NOW, GH)).toBeNull();
    });

    test('with Retry-After and a spent primary limit, the LATER time wins', () => {
        const res = { status: 403, headers: { 'retry-after': '30', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(EPOCH_RESET) }, body: '' };
        expect(rl.rateLimitSignal(res, NOW).retryAt).toBe(EPOCH_RESET * 1000);
    });

    test('x-ratelimit-reset is ignored while the primary limit is not spent', () => {
        const res = { status: 403, headers: { 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': String(EPOCH_RESET) },
            body: json('You have exceeded a secondary rate limit.') };
        expect(rl.rateLimitSignal(res, NOW, GH)).toEqual({ signal: 'body_rate_limit', retryAt: null, weak: true });
    });

    test('a plain 403 with no signal stays a refusal (null) — fail closed', () => {
        expect(rl.rateLimitSignal({ status: 403, headers: { server: 'Varnish', 'content-type': 'application/json' }, body: json('Forbidden') }, NOW)).toBeNull();
        expect(rl.rateLimitSignal({ status: 403, headers: { 'x-ratelimit-remaining': '12' }, body: '' }, NOW)).toBeNull();
        expect(rl.rateLimitSignal({ status: 403, headers: {}, body: '<html>API rate limit exceeded</html>' }, NOW)).toBeNull();
        expect(rl.rateLimitSignal({ status: 403, headers: {}, body: JSON.stringify({ error: 'API rate limit exceeded' }) }, NOW)).toBeNull();
    });

    test.each([401, 451, 404, 500, 503])('HTTP %i is never a rate limit, whatever its headers or body', (status) => {
        const res = { status, headers: { 'x-ratelimit-remaining': '0', 'retry-after': '60' }, body: json('API rate limit exceeded') };
        expect(rl.rateLimitSignal(res, NOW)).toBeNull();
    });

    test('a bot-wall challenge page wins: never a rate limit, even with remaining 0 or on a 429', () => {
        const wall = '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate">';
        expect(rl.rateLimitSignal({ status: 403, headers: { 'x-ratelimit-remaining': '0' }, body: wall }, NOW)).toBeNull();
        expect(rl.rateLimitSignal({ status: 429, headers: { 'retry-after': '5' }, body: wall }, NOW)).toBeNull();
    });

    test('security F6: Cloudflare\'s cf-mitigated: challenge header wins too (the body is not needed)', () => {
        for (const v of ['challenge', 'Challenge', ['challenge']]) {
            expect(rl.rateLimitSignal({ status: 403, headers: { 'cf-mitigated': v, 'retry-after': '30', 'x-ratelimit-remaining': '0' }, body: '' }, NOW)).toBeNull();
            expect(rl.rateLimitSignal({ status: 429, headers: { 'cf-mitigated': v }, body: '' }, NOW)).toBeNull();
        }
    });
});

describe('parse helpers (security F2 / F4, grumpy #4)', () => {
    test('parseRetryAfter: strict delay-seconds (> 0) or IMF-fixdate in the future; anything else → null', () => {
        expect(rl.parseRetryAfter({ 'retry-after': '5' }, NOW)).toBe(5000);
        expect(rl.parseRetryAfter({ 'retry-after': ['7', '9'] }, NOW)).toBe(7000);
        expect(rl.parseRetryAfter({ 'retry-after': new Date(NOW + 90000).toUTCString() }, NOW)).toBe(90000);
        for (const v of ['0', '-5', '0x10', '1.5', '1 2', 'later', '', new Date(NOW - 1000).toUTCString(), 'Thursday, 01-Oct-26 02:49:24 GMT']) {
            expect([v, rl.parseRetryAfter({ 'retry-after': v }, NOW)]).toEqual([v, null]);
        }
        expect(rl.parseRetryAfter({}, NOW)).toBeNull();
    });

    test('Copilot: an IMF-fixdate must be a REAL date that round-trips (no 31 Feb, no wrong weekday)', () => {
        const future = new Date(NOW + 90000).toUTCString();   // Thu, 01 Oct 2026 02:49:24 GMT
        expect(rl.parseRetryAfter({ 'retry-after': future }, NOW)).toBe(90000);
        for (const v of ['Sun, 31 Feb 2027 00:00:00 GMT', future.replace(/^Thu/, 'Fri'), 'Thu, 01 Oct 2026 25:61:00 GMT']) {
            expect([v, rl.parseRetryAfter({ 'retry-after': v }, NOW)]).toEqual([v, null]);
        }
        // So a malformed date never upgrades GitHub's wording to strong evidence.
        const body = json('You have exceeded a secondary rate limit.');
        expect(rl.rateLimitSignal({ status: 403, headers: { 'retry-after': 'Sun, 31 Feb 2027 00:00:00 GMT' }, body }, NOW, 'api.github.com'))
            .toMatchObject({ signal: 'body_rate_limit', weak: true });
    });

    test('security F4: an overflowing or non-finite Retry-After is Infinity (→ the 24 h cap), never "no time"', () => {
        expect(rl.parseRetryAfter({ 'retry-after': '1e306' }, NOW)).toBe(Infinity);
        expect(rl.parseRetryAfter({ 'retry-after': '9'.repeat(400) }, NOW)).toBe(Infinity);
        expect(rl.parseRetryAfter({ 'retry-after': String(2 * 86400) }, NOW)).toBe(2 * DAY);
    });

    test('parseReset: epoch seconds, epoch MILLISECONDS (grumpy #4) or seconds-until-reset by magnitude; junk → null', () => {
        expect(rl.parseReset(String(EPOCH_RESET), NOW)).toBe(EPOCH_RESET * 1000);
        expect(rl.parseReset(String(EPOCH_RESET * 1000), NOW)).toBe(EPOCH_RESET * 1000);
        expect(rl.parseReset('300', NOW)).toBe(NOW + 300000);
        expect(rl.parseReset('abc', NOW)).toBeNull();
        expect(rl.parseReset(undefined, NOW)).toBeNull();
        expect(rl.parseReset('-5', NOW)).toBeNull();
    });

    test('security F4: an overflowing x-ratelimit-reset is Infinity (→ the 24 h cap)', () => {
        expect(rl.parseReset('1e306', NOW)).toBe(Infinity);
        const res = { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1e306' }, body: '' };
        expect(rl.rateLimitSignal(res, NOW).retryAt).toBe(Infinity);
    });
});

describe('backoffUntil: 60 s floor growing per repeat, 24 h cap', () => {
    test('no time from the source → the floor (GitHub: wait at least one minute)', () => {
        expect(rl.backoffUntil(null, NOW)).toBe(NOW + 60000);
    });
    test('a time in the past or under a minute → the floor', () => {
        expect(rl.backoffUntil(NOW - 5000, NOW)).toBe(NOW + 60000);
        expect(rl.backoffUntil(NOW + 5000, NOW)).toBe(NOW + 60000);
    });
    test('the source\'s time when inside the bounds', () => {
        expect(rl.backoffUntil(NOW + 600000, NOW)).toBe(NOW + 600000);
    });
    test('never more than 24 h; Infinity (security F4) is the cap', () => {
        expect(rl.backoffUntil(NOW + 7 * DAY, NOW)).toBe(NOW + DAY);
        expect(rl.backoffUntil(Infinity, NOW)).toBe(NOW + DAY);
        expect(rl.backoffUntil(NaN, NOW)).toBe(NOW + 60000);
    });
    test('security F1: the floor doubles with each consecutive rate limit of the host (1 → 60 s, 2 → 120 s, 3 → 240 s …)', () => {
        expect([1, 2, 3, 4, 5].map(n => rl.backoffUntil(null, NOW, n) - NOW)).toEqual([60000, 120000, 240000, 480000, 960000]);
        expect(rl.backoffUntil(NOW + 600000, NOW, 2)).toBe(NOW + 600000);   // the source's longer time still wins
        expect(rl.backoffUntil(null, NOW, 40)).toBe(NOW + DAY);
    });
});

describe('nextHold: the per-host streak (security F1)', () => {
    const weak = { status: 403, signal: 'body_rate_limit', weak: true, retryAt: null };
    // A 429 that names a (short) time: the doubling floor decides.
    const strong = { status: 429, signal: 'http_429', weak: false, retryAt: NOW + 1000 };

    test('consecutive rate limits grow the hold; strong ones never escalate', () => {
        let prev = null;
        const lengths = [];
        for (let i = 0; i < 8; i++) {
            // Each limit comes once the previous hold has passed.
            const t = prev ? Date.parse(prev.until) : NOW;
            const n = rl.nextHold(prev, { ...strong, retryAt: t + 1000 }, t);
            expect(n.escalate).toBe(false);
            lengths.push(Date.parse(n.entry.until) - t);
            prev = n.entry;
        }
        expect(lengths.slice(0, 4)).toEqual([60000, 120000, 240000, 480000]);
        expect(prev).toMatchObject({ count: 8, weak: 0, http_status: 429, signal: 'http_429' });
    });

    // PR #44 (TLDR) merged: a 429 naming no time holds at least
    // NO_TIME_429_HOLD_MS; a longer doubling floor or source time still wins.
    test('a 429 that names NO time holds at least NO_TIME_429_HOLD_MS (5 min); the floor wins once longer', () => {
        const none = { status: 429, signal: 'http_429', weak: false, retryAt: null };
        expect(rl.NO_TIME_429_HOLD_MS).toBe(300000);
        expect(Date.parse(rl.nextHold(null, none, NOW).entry.until) - NOW).toBe(300000);
        const fourth = rl.nextHold({ until: iso(NOW - 1), count: 3, weak: 0, at: iso(NOW - 600000) }, none, NOW);
        expect(Date.parse(fourth.entry.until) - NOW).toBe(480000);
        expect(Date.parse(rl.nextHold(null, { ...none, retryAt: NOW + 3600000 }, NOW).entry.until) - NOW).toBe(3600000);
        // Only a 429 without a time: a body-only 403 keeps the 60 s floor.
        expect(Date.parse(rl.nextHold(null, weak, NOW).entry.until) - NOW).toBe(60000);
    });

    test(`${rl.ESCALATE_AFTER} consecutive WEAK (body-only) rate limits escalate to a refusal — fail closed`, () => {
        let prev = null;
        for (let i = 1; i < rl.ESCALATE_AFTER; i++) {
            const n = rl.nextHold(prev, weak, NOW);
            expect([i, n.escalate]).toEqual([i, false]);
            expect(n.entry).toMatchObject({ count: i, weak: i });
            prev = n.entry;
        }
        expect(rl.nextHold(prev, weak, NOW).escalate).toBe(true);
    });

    test('a strong signal in between restarts the weak streak (not the count)', () => {
        let prev = null;
        for (let i = 0; i < rl.ESCALATE_AFTER - 1; i++) prev = rl.nextHold(prev, weak, NOW).entry;
        prev = rl.nextHold(prev, strong, NOW).entry;
        expect(prev).toMatchObject({ count: rl.ESCALATE_AFTER, weak: 0 });
        expect(rl.nextHold(prev, weak, NOW).escalate).toBe(false);
    });

    test('an expired previous hold still counts (only a success resets the streak)', () => {
        const prev = { until: iso(NOW - HOUR), http_status: 429, signal: 'http_429', count: 3, weak: 0 };
        expect(rl.nextHold(prev, strong, NOW).entry.count).toBe(4);
    });
});

describe('stored holds', () => {
    test('sanitizeHolds keeps streaks (even expired) but drops stale, malformed and invalid-host entries', () => {
        const stored = {
            'api.github.com': { until: iso(NOW + 60000), http_status: 403, signal: 'body_rate_limit', count: 2, weak: 2, at: iso(NOW - 1000) },
            'old.example': { until: iso(NOW - HOUR), http_status: 429, signal: 'http_429', count: 4 },
            'stale.example': { until: iso(NOW - 8 * DAY), http_status: 429, signal: 'http_429', count: 9 },
            'bad.example': { until: 'not a date' },
            'worse.example': 'x',
            'evil host/<x>': { until: iso(NOW + 60000) },
            'odd.example': { until: iso(NOW + 60000), signal: 'made_up', count: -3, weak: 'x', http_status: 'y', at: 'later' },
            'srv.example': { until: iso(NOW + 60000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0, at: iso(NOW) },
        };
        expect(rl.sanitizeHolds(stored, NOW)).toEqual({
            'api.github.com': { until: iso(NOW + 60000), http_status: 403, signal: 'body_rate_limit', count: 2, weak: 2, at: iso(NOW - 1000) },
            // Legacy entries (no count / at): count 1, at = a minute before until.
            'old.example': { until: iso(NOW - HOUR), http_status: 429, signal: 'http_429', count: 4, weak: 0, at: iso(NOW - HOUR - 60000) },
            'odd.example': { until: iso(NOW + 60000), http_status: null, signal: null, count: 0, weak: 0, at: iso(NOW) },
            'srv.example': { until: iso(NOW + 60000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0, at: iso(NOW) },
        });
        expect(Object.keys(rl.activeHolds(stored, NOW)).sort()).toEqual(['api.github.com', 'odd.example', 'srv.example']);
        expect(rl.sanitizeHolds(null, NOW)).toEqual({});
        expect(rl.sanitizeHolds('[]', NOW)).toEqual({});
    });

    test('Copilot: mergeHolds takes the NEWEST record\'s streaks — a later strong limit\'s reset weak streak is never resurrected', () => {
        const old = { until: iso(NOW + 600000), http_status: 403, signal: 'body_rate_limit', count: 4, weak: 4, at: iso(NOW - 120000) };
        const newer = { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 5, weak: 0, at: iso(NOW - 1000) };
        // Streaks from the newest record; the hold from the latest until (N6).
        const merged = { ...newer, until: old.until };
        const a = { 'api.github.com': { ...old } };
        rl.mergeHolds(a, { 'api.github.com': newer, 'github.blog': { ...newer, until: iso(NOW + 30000) } }, NOW);
        expect(a['api.github.com']).toEqual(merged);
        expect(Object.keys(a).sort()).toEqual(['api.github.com', 'github.blog']);
        // And in the other order: the older record never overwrites the newer streaks.
        const b = { 'api.github.com': { ...newer } };
        rl.mergeHolds(b, { 'api.github.com': old }, NOW);
        expect(b['api.github.com']).toEqual(merged);
        // The next body-only limit is the FIRST weak one, never the 5th.
        expect(rl.nextHold(b['api.github.com'], { status: 403, signal: 'body_rate_limit', weak: true }, NOW).escalate).toBe(false);
    });

    test('security N6: a merge never SHORTENS a hold in force — the newest record\'s streaks, the latest until among the copies', () => {
        const a = { 'api.github.com': { until: iso(NOW + HOUR), http_status: 403, signal: 'ratelimit_remaining_zero', count: 4, weak: 4, at: iso(NOW - 1000) } };
        rl.mergeHolds(a, { 'api.github.com': { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 5, weak: 0, at: iso(NOW) } }, NOW);
        expect(a['api.github.com']).toEqual({ until: iso(NOW + HOUR), http_status: 429, signal: 'http_429', count: 5, weak: 0, at: iso(NOW) });
        const b = { 'api.github.com': { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 5, weak: 0, at: iso(NOW) } };
        rl.mergeHolds(b, { 'api.github.com': { until: iso(NOW + HOUR), http_status: 403, signal: 'ratelimit_remaining_zero', count: 4, weak: 4, at: iso(NOW - 1000) } }, NOW);
        expect(b['api.github.com']).toMatchObject({ until: iso(NOW + HOUR), count: 5, weak: 0, signal: 'http_429' });
    });

    test('grumpy N4 / Copilot: a 5xx\'s Retry-After hold leaves the streaks alone — three never reach the rate-limit warning', () => {
        let prev = null;
        for (let i = 0; i < 3; i++) {
            const n = rl.nextHold(prev, { retryAt: NOW + 3600000, status: 503, signal: 'retry_after_5xx', weak: false }, NOW);
            expect(n.escalate).toBe(false);
            prev = n.entry;
        }
        expect(prev).toMatchObject({ count: 0, weak: 0, signal: 'retry_after_5xx', until: iso(NOW + 3600000) });
        const { conditionsFor } = require('../../../src/collectors/source-health');
        expect(conditionsFor({ rate_limited_hosts: { 'api.github.com': prev } }, getSource('github'), NOW).source_rate_limited).toBeUndefined();
        // A rate limit after them continues the earlier streak (here: the first).
        expect(rl.nextHold(prev, { status: 429, signal: 'http_429' }, NOW).entry.count).toBe(1);
    });

    test('heldUntil: the active hold of a host (hostname, case-insensitive), else null', () => {
        const holds = { 'api.github.com': { until: iso(NOW + 60000), http_status: 403, signal: 'body_rate_limit', count: 1, weak: 1 } };
        expect(rl.heldUntil(holds, 'api.github.com', NOW)).toMatchObject({ until: NOW + 60000, http_status: 403 });
        expect(rl.heldUntil(holds, 'API.GitHub.com', NOW)).not.toBeNull();
        expect(rl.heldUntil(holds, 'api.github.com', NOW + 60000)).toBeNull();
        expect(rl.heldUntil(holds, 'github.blog', NOW)).toBeNull();
        expect(rl.heldUntil(undefined, 'github.blog', NOW)).toBeNull();
    });
});

describe('route / host scoping (GitHub: the api.github.com limit never pauses github.blog)', () => {
    const github = getSource('github');
    const apiHeld = { 'api.github.com': { until: iso(NOW + 600000), http_status: 403, signal: 'ratelimit_remaining_zero', count: 1, weak: 0 } };

    test('no holds → none', () => {
        expect(rl.holdGate(github, TEST_ENV, {}, NOW)).toMatchObject({ state: 'none', until: null, routes: {} });
    });

    test('an api.github.com hold holds the two search routes only: partial, the blog RSS route still runs', () => {
        const g = rl.holdGate(github, TEST_ENV, apiHeld, NOW);
        expect(g.state).toBe('partial');
        expect(g.routes).toEqual({ 'repo-search': iso(NOW + 600000), 'issue-search': iso(NOW + 600000) });
        expect(g.until).toBe(iso(NOW + 600000));
        // Security F3: the reason names routes, never a host.
        expect(g.reason).toMatch(/routes held: repo-search, issue-search .*not a refusal/);
        expect(g.reason).not.toMatch(/github\.com/);
        const blog = github.routes.find(r => r.id === 'ai-ml-blog-rss');
        expect(rl.routeHeld(blog, TEST_ENV, apiHeld, NOW)).toBe(false);
    });

    test('every route\'s hosts held → all; the source is asked again when the FIRST route frees', () => {
        const both = { ...apiHeld, 'github.blog': { until: iso(NOW + 120000), http_status: 429, signal: 'http_429', count: 1, weak: 0 } };
        const g = rl.holdGate(github, TEST_ENV, both, NOW);
        expect(g.state).toBe('all');
        expect(Object.keys(g.routes)).toEqual(['repo-search', 'issue-search', 'ai-ml-blog-rss']);
        expect(g.until).toBe(iso(NOW + 600000));
        expect(g.next).toBe(iso(NOW + 120000));
    });

    test('an expired hold holds nothing', () => {
        expect(rl.holdGate(github, TEST_ENV, apiHeld, NOW + 600000).state).toBe('none');
    });

    test('grumpy #2 / Copilot: Reddit\'s token host and API host are BOTH prerequisites — a hold on either holds the route', () => {
        const route = getSource('reddit').routes[0];
        expect(rl.routeRequestHosts(route, TEST_ENV)).toEqual({ hosts: ['oauth.reddit.com', 'www.reddit.com'], mode: 'any' });
        const hold = until => ({ until: iso(until), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) });
        expect(rl.routeHeldUntil(route, TEST_ENV, { 'oauth.reddit.com': hold(NOW + 60000) }, NOW)).toBe(iso(NOW + 60000));
        expect(rl.routeHeldUntil(route, TEST_ENV, { 'www.reddit.com': hold(NOW + 90000) }, NOW)).toBe(iso(NOW + 90000));
        // Both held: the route frees when the LAST frees.
        expect(rl.routeHeldUntil(route, TEST_ENV, { 'oauth.reddit.com': hold(NOW + 60000), 'www.reddit.com': hold(NOW + 90000) }, NOW))
            .toBe(iso(NOW + 90000));
        expect(rl.holdGate(getSource('reddit'), TEST_ENV, { 'www.reddit.com': hold(NOW + 90000) }, NOW).routes).toEqual({});   // not open under TEST_ENV
    });

    test('Copilot: Reuters Connect\'s auth host is a prerequisite too', () => {
        const route = getSource('reuters').routes.find(r => r.adapter === 'reuters-connect');
        const env = { ...TEST_ENV, REUTERS_CONNECT_API_URL: 'https://api.reutersconnect.com/content/graphql' };
        expect(rl.routeRequestHosts(route, env).mode).toBe('any');
        const held = { 'auth.thomsonreuters.com': { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) } };
        expect(rl.routeHeld(route, env, held, NOW)).toBe(true);
    });

    test('a multi-feed RSS route (alternatives) is held only when EVERY feed host is', () => {
        const route = { id: 'two', adapter: 'rss', params: { urls: ['https://a.example/f', 'https://b.example/f'] } };
        const hold = { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) };
        expect(rl.routeHeld(route, TEST_ENV, { 'a.example': hold }, NOW)).toBe(false);
        expect(rl.routeHeldUntil(route, TEST_ENV, { 'a.example': hold, 'b.example': { ...hold, until: iso(NOW + 30000) } }, NOW)).toBe(iso(NOW + 30000));
    });

    test('sourceHosts: every host any route of the source may contact', () => {
        expect(rl.sourceHosts(github, TEST_ENV)).toEqual(['api.github.com', 'github.blog']);
    });
});

describe('security F3: what /api/sources may publish about a hold', () => {
    test('registry hosts are served; an env-derived (contract feed) host is masked as "configured host"', () => {
        const cnn = getSource('cnn');
        const env = { ...TEST_ENV, CNN_FEED_URL: 'https://acme-123.feeds.example/x' };
        const holds = { 'acme-123.feeds.example': { until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 2, weak: 0 } };
        const pub = rl.publicHosts(cnn, holds, NOW);
        expect(pub).toEqual([{ host: 'configured host', until: iso(NOW + 60000), http_status: 429, signal: 'http_429', count: 2 }]);
        expect(JSON.stringify(rl.holdGate(cnn, env, holds, NOW))).not.toMatch(/acme-123/);
        const gh = rl.publicHosts(getSource('github'),
            { 'api.github.com': { until: iso(NOW + 60000), http_status: 403, signal: 'body_rate_limit', count: 1, weak: 1 } }, NOW);
        expect(gh[0].host).toBe('api.github.com');
    });
});

describe('classification and status: a rate limit is never a refusal', () => {
    const { classifyError, RateLimitedError, ERROR_KINDS } = require('../../../src/collectors/errors');
    const { refusalOf, REFUSED_KINDS } = require('../../../src/collectors/refusal');
    const { registryFields, summarize, RUNTIME_STATUSES } = require('../../../src/collectors/status');
    const at = s => iso(NOW + s * 1000);

    test('classifyError → rate_limited; refusalOf ignores it; it is not a refused kind', () => {
        expect(ERROR_KINDS).toContain('rate_limited');
        expect(classifyError(new RateLimitedError('m', { status: 403 }))).toEqual({ error_kind: 'rate_limited', http_status: 403 });
        expect(classifyError(new RateLimitedError('m', { held: true }))).toEqual({ error_kind: 'rate_limited', http_status: null });
        expect(REFUSED_KINDS).not.toContain('rate_limited');
        expect(refusalOf([{ error_kind: 'rate_limited', http_status: 403 }])).toBeNull();
        expect(refusalOf([{ error_kind: 'rate_limited', http_status: 429 }, { error_kind: 'access_denied', http_status: 401 }]))
            .toEqual({ kind: 'access_denied', status: 401 });
    });

    const hnHold = { 'hn.algolia.com': { until: at(300), http_status: 429, signal: 'http_429', count: 1, weak: 0 } };

    test('/api/sources: every route held (as the worker stored it) → status rate_limited, never online, never blocked_by_source', () => {
        expect(RUNTIME_STATUSES).toContain('rate_limited');
        const base = { name: 'hacker_news', source_type: 'api', last_success_at: at(-60) };
        const row = registryFields({ ...base, rate_limited_hosts: hnHold, rate_limited_routes: { 'algolia-search': at(300) } }, TEST_ENV, NOW);
        expect(row).toMatchObject({
            status: 'rate_limited', online: false, rate_limited_until: at(300), rate_limited_routes: ['algolia-search'],
            rate_limited_hosts: [{ host: 'hn.algolia.com', until: at(300), http_status: 429, signal: 'http_429', count: 1 }],
            refusal_count: 0, access_denied_at: null,
        });
        expect(row.status_reason).toMatch(/routes held: algolia-search .*not a refusal/);
        // Expired: collecting again.
        expect(registryFields({ ...base, rate_limited_hosts: hnHold, rate_limited_routes: { 'algolia-search': at(300) } }, TEST_ENV, NOW + 300000))
            .toMatchObject({ status: 'collecting', rate_limited_until: null, rate_limited_hosts: [], rate_limited_routes: [] });
        const sum = summarize([{ registry: true, ...row }]);
        expect(sum.by_status).toMatchObject({ rate_limited: 1, blocked_by_source: 0 });
        expect(sum.rate_limited).toBe(1);
    });

    test('/api/sources: some routes held → still collecting (and online), the held hosts and routes served', () => {
        const row = registryFields({ name: 'github', source_type: 'api', last_success_at: at(-60),
            rate_limited_hosts: { 'api.github.com': { until: at(600), http_status: 403, signal: 'ratelimit_remaining_zero', count: 1, weak: 0 } },
            rate_limited_routes: { 'repo-search': at(600), 'issue-search': at(600) } }, TEST_ENV, NOW);
        expect(row).toMatchObject({ status: 'collecting', online: true, rate_limited_until: at(600),
            rate_limited_routes: ['repo-search', 'issue-search'] });
        const sum = summarize([{ registry: true, ...row }]);
        expect(sum.by_status.rate_limited).toBe(0);
        expect(sum.rate_limited).toBe(1);
    });

    test('grumpy #2: the held routes come from the worker (stored), not from the web process\'s env', () => {
        // The web process sees "set" for credential env vars: hosts cannot be
        // recomputed there. The stored route map is authoritative.
        const row = registryFields({ name: 'hacker_news', source_type: 'api', last_success_at: at(-60),
            rate_limited_hosts: {}, rate_limited_routes: { 'algolia-search': at(120) } }, TEST_ENV, NOW);
        expect(row).toMatchObject({ status: 'rate_limited', rate_limited_routes: ['algolia-search'] });
    });

    test('a refusal wins over a rate-limit backoff', () => {
        const row = registryFields({ name: 'hacker_news', source_type: 'api', access_denied_at: at(-10), refused_until: at(3600),
            access_denied_status: 403, refusal_count: 1, rate_limited_hosts: hnHold, rate_limited_routes: { 'algolia-search': at(300) } }, TEST_ENV, NOW);
        expect(row.status).toBe('blocked_by_source');
    });

    test('grumpy re-review: a throttled TERMS page is held but is not the source being rate-limited (status, until, warning)', () => {
        const { conditionsFor } = require('../../../src/collectors/source-health');
        const terms = { 'docs.github.com': { until: at(900), http_status: 429, signal: 'http_429', count: 5, weak: 0, at: at(-1) } };
        const row = registryFields({ name: 'github', source_type: 'api', last_success_at: at(-60), rate_limited_hosts: terms, rate_limited_routes: {} }, TEST_ENV, NOW);
        expect(row).toMatchObject({ status: 'collecting', rate_limited_until: null, rate_limited_hosts: [], rate_limited_routes: [] });
        expect(conditionsFor({ rate_limited_hosts: terms }, getSource('github'), NOW).source_rate_limited).toBeUndefined();
        expect(rl.collectionHolds(getSource('github'), terms)).toEqual({});
    });

    test('security F3: a contract-feed host never reaches /api/sources (hosts or reason)', () => {
        const env = { ...TEST_ENV, CNN_FEED_URL: 'https://acme-123.feeds.example/x' };
        const row = registryFields({ name: 'cnn', source_type: 'news',
            rate_limited_hosts: { 'acme-123.feeds.example': { until: at(300), http_status: 429, signal: 'http_429', count: 1, weak: 0 } },
            rate_limited_routes: { 'wire-store': at(300) } }, env, NOW);
        expect(JSON.stringify(row)).not.toMatch(/acme-123/);
        expect(row.rate_limited_hosts).toEqual([expect.objectContaining({ host: 'configured host' })]);
    });
});

describe('grumpy #6: a multi-feed RSS route whose feeds all fail', () => {
    const { RssAtomCollector } = require('../../../src/collectors/base');
    const { HttpClient } = require('../../../src/collectors/http');
    const { classifyError } = require('../../../src/collectors/errors');
    const { fixtureTransport } = require('../../helpers/fixtureTransport');
    const route = { id: 'two-feeds', adapter: 'rss', params: { urls: ['https://held.example/feed', 'https://broken.example/feed'] } };

    test('a held feed never hides the real failure of another (the lead is the 5xx, not the hold)', async () => {
        const transport = fixtureTransport([[/broken\.example\/feed/, { status: 500, body: '' }]]);
        const http = new HttpClient({ transport, env: TEST_ENV, sleep: () => Promise.resolve(),
            holds: { 'held.example': { until: iso(Date.now() + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0 } } });
        const c = new RssAtomCollector({ source: getSource('github'), route, env: TEST_ENV, http });
        const err = await c.fetchItems().catch(e => e);
        expect(classifyError(err).error_kind).toBe('http_5xx');
        expect(err.held).toBeUndefined();
        expect(transport.calls.filter(k => k.url.includes('held.example'))).toHaveLength(0);
    });

    test('a rate-limited lead keeps its host, time, signal and headers; all held → a skip (held: true)', async () => {
        const transport = fixtureTransport([[/broken\.example\/feed/, { status: 429, headers: { 'retry-after': '600', server: 'edge' }, body: '' }]]);
        const http = new HttpClient({ transport, env: TEST_ENV, sleep: () => Promise.resolve(),
            holds: { 'held.example': { until: iso(Date.now() + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0 } } });
        const c = new RssAtomCollector({ source: getSource('github'), route, env: TEST_ENV, http });
        const err = await c.fetchItems().catch(e => e);
        expect(classifyError(err).error_kind).toBe('rate_limited');
        expect(err).toMatchObject({ host: 'broken.example', signal: 'http_429', headers: { 'retry-after': '600', server: 'edge' } });
        expect(err.held).toBeUndefined();
        expect(Number.isFinite(err.retryAt)).toBe(true);

        http.holds['broken.example'] = { until: iso(Date.now() + 60000), http_status: 429, signal: 'http_429', count: 1, weak: 0 };
        const all = await c.fetchItems().catch(e => e);
        expect(all.held).toBe(true);
    });
});

describe('source health: persistent throttling is a WARNING (grumpy #5)', () => {
    const { conditionsFor, RATE_LIMITED_WARN_AFTER } = require('../../../src/collectors/source-health');
    const github = getSource('github');

    test(`a host rate-limited ${rl.WARN_AFTER} times in a row opens source_rate_limited (warning), even while another route succeeds`, () => {
        expect(RATE_LIMITED_WARN_AFTER).toBe(rl.WARN_AFTER);
        const row = { consecutive_failures: 0, rate_limited_hosts: {
            'api.github.com': { until: iso(NOW + 60000), http_status: 403, signal: 'body_rate_limit', count: rl.WARN_AFTER, weak: rl.WARN_AFTER } } };
        expect(conditionsFor(row, github, NOW).source_rate_limited).toMatchObject({ severity: 'warning', hosts: ['api.github.com'], max_count: rl.WARN_AFTER });
        const below = { rate_limited_hosts: { 'api.github.com': { ...row.rate_limited_hosts['api.github.com'], count: rl.WARN_AFTER - 1 } } };
        expect(conditionsFor(below, github, NOW).source_rate_limited).toBeUndefined();
    });

    test('a masked host is named "configured host" in the alert details too (security F3)', () => {
        const row = { rate_limited_hosts: { 'acme-123.feeds.example': { until: iso(NOW), http_status: 429, signal: 'http_429', count: 9, weak: 0 } } };
        expect(JSON.stringify(conditionsFor(row, getSource('cnn'), NOW))).not.toMatch(/acme-123/);
    });
});

// PR #44 + #45 merge: ONE hold store. PR #44 kept its Retry-After holds as
// `retry-after:<host>` keys in a source's HTTP cache; legacyHolds folds any
// such key into this store's records and strips it from the cache (the
// runner, at claim; migration 077 moved the stored ones).
describe('legacyHolds: PR #44 HTTP-cache hold keys → the one hold store', () => {
    test('active keys become sanitised holds (429 → http_429 count 1; 503 → retry_after_5xx count 0); the cache keeps validators only', () => {
        const cache = {
            'https://tldr.tech/api/rss/ai': { etag: '"v1"', last_modified: null },
            'retry-after:tldr.tech': { until: iso(NOW + 600000), status: 429 },
            'retry-after:srv.example:8443': { until: iso(NOW + 120000), status: 503 },
            'retry-after:old.example': { until: iso(NOW - 1000), status: 429 },
            'retry-after:bad.example': { until: 'not a date', status: 429 },
            'retry-after:': { until: iso(NOW + 60000), status: 429 },
        };
        const { holds, cache: rest } = rl.legacyHolds(cache, NOW);
        expect(rest).toEqual({ 'https://tldr.tech/api/rss/ai': { etag: '"v1"', last_modified: null } });
        expect(holds).toEqual({
            'tldr.tech': { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) },
            'srv.example': { until: iso(NOW + 120000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0, at: iso(NOW) },
        });
        expect(cache['retry-after:tldr.tech']).toBeDefined();   // pure: the input is not mutated
    });

    test('an until beyond 24 h is capped; two keys of one hostname (with and without a port) keep the later until', () => {
        const { holds } = rl.legacyHolds({
            'retry-after:a.example': { until: iso(NOW + 30 * HOUR), status: 429 },
            'retry-after:b.example': { until: iso(NOW + 60000), status: 429 },
            'retry-after:b.example:443': { until: iso(NOW + 600000), status: 429 },
        }, NOW);
        expect(holds['a.example'].until).toBe(iso(NOW + rl.MAX_BACKOFF_MS));
        expect(holds['b.example'].until).toBe(iso(NOW + 600000));
    });

    test('nothing to fold: no holds, the same validators', () => {
        expect(rl.legacyHolds(undefined, NOW)).toEqual({ holds: {}, cache: {} });
        expect(rl.legacyHolds({ 'https://x.example/': { etag: 'e' } }, NOW)).toEqual({ holds: {}, cache: { 'https://x.example/': { etag: 'e' } } });
    });
});

describe('security review L3-L6', () => {
    test('L4: a 5xx Retry-After holds a host at most MAX_5XX_HOLD_MS (a rate limit still up to 24 h); an existing longer hold is never shortened', () => {
        const five = rl.nextHold(null, { retryAt: NOW + 20 * HOUR, status: 503, signal: 'retry_after_5xx', weak: false }, NOW);
        expect(Date.parse(five.entry.until)).toBe(NOW + rl.MAX_5XX_HOLD_MS);
        expect(five.entry.count).toBe(0);
        const limit = rl.nextHold(null, { retryAt: NOW + 20 * HOUR, status: 429, signal: 'http_429', weak: false }, NOW);
        expect(Date.parse(limit.entry.until)).toBe(NOW + 20 * HOUR);
        const prev = { ...limit.entry };
        expect(rl.nextHold(prev, { retryAt: NOW + 20 * HOUR, status: 503, signal: 'retry_after_5xx', weak: false }, NOW).entry.until).toBe(prev.until);
        // A legacy PR #44 503 key is capped the same way.
        const legacy = rl.legacyHolds({ 'retry-after:a.example': { until: iso(NOW + 20 * HOUR), status: 503 } }, NOW);
        expect(Date.parse(legacy.holds['a.example'].until)).toBe(NOW + rl.MAX_5XX_HOLD_MS);
    });

    test('L5: a stored until is never read beyond the 24 h cap', () => {
        const stored = { 'far.example': { until: iso(NOW + 3650 * DAY), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) } };
        expect(Date.parse(rl.sanitizeHolds(stored, NOW)['far.example'].until)).toBe(NOW + rl.MAX_BACKOFF_MS);
        expect(Date.parse(rl.activeHolds(stored, NOW)['far.example'].until)).toBe(NOW + rl.MAX_BACKOFF_MS);
    });

    test('L3: strong403 counts consecutive 403s with remaining 0 only (a 429, a body signal and a 5xx hold do not extend it)', () => {
        const s403 = { retryAt: null, status: 403, signal: 'ratelimit_remaining_zero', weak: false };
        let e = rl.nextHold(null, s403, NOW).entry;
        e = rl.nextHold(e, s403, NOW).entry;
        expect(e.strong403).toBe(2);
        // A 5xx hold leaves it; a 429 or a GitHub body signal ends it.
        expect(rl.nextHold(e, { retryAt: null, status: 503, signal: 'retry_after_5xx', weak: false }, NOW).entry.strong403).toBe(2);
        expect(rl.nextHold(e, { retryAt: null, status: 429, signal: 'http_429', weak: false }, NOW).entry.strong403).toBeUndefined();
        expect(rl.nextHold(e, { retryAt: null, status: 403, signal: 'body_rate_limit_retry_after', weak: false }, NOW).entry.strong403).toBeUndefined();
        // The 10th escalates; the 9th does not.
        let n = null;
        const outcomes = [];
        for (let i = 0; i < rl.ESCALATE_STRONG_403_AFTER; i++) {
            const r = rl.nextHold(n, s403, NOW);
            outcomes.push(r.escalate);
            n = r.entry;
        }
        expect(outcomes.slice(0, -1).every(x => x === false)).toBe(true);
        expect(outcomes[outcomes.length - 1]).toBe(true);
        // Survives a store round trip.
        expect(rl.sanitizeHolds({ 'x.example': n }, NOW)['x.example'].strong403).toBe(rl.ESCALATE_STRONG_403_AFTER);
    });

    test('Copilot: holdGate leaves a database-disabled route out (never held, never stored as rate-limited)', () => {
        const src = getSource('github');
        const hold = { 'api.github.com': { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: iso(NOW) } };
        expect(Object.keys(rl.holdGate(src, TEST_ENV, hold, NOW).routes).sort()).toEqual(['issue-search', 'repo-search']);
        const kill = { route_id: 'issue-search', disabled_at: new Date(NOW).toISOString(), reason: 'x', by: 'op' };
        expect(Object.keys(rl.holdGate(src, TEST_ENV, hold, NOW, { routeKills: [kill] }).routes)).toEqual(['repo-search']);
    });

    test('Copilot: a 5xx Retry-After hold is enforced but never reads as a rate limit (kind server, no limitedRoutes, not in publicHosts)', () => {
        const src = getSource('hacker_news');
        const five = { 'hn.algolia.com': { until: iso(NOW + 600000), http_status: 503, signal: 'retry_after_5xx', count: 0, weak: 0, at: iso(NOW) } };
        const g = rl.holdGate(src, TEST_ENV, five, NOW);
        expect(g).toMatchObject({ state: 'all', kind: 'server', limitedRoutes: {} });
        expect(Object.keys(g.routes)).toEqual(['algolia-search']);
        expect(g.reason).toMatch(/server error/);
        expect(g.reason).not.toMatch(/backing off after a rate limit/);
        // Served: the host with its distinct signal, and its own time — never as a rate limit.
        expect(rl.publicHosts(src, five, NOW)).toEqual([expect.objectContaining({ host: 'hn.algolia.com', signal: 'retry_after_5xx', count: 0 })]);
        expect(rl.serverBackoffUntil(src, five, NOW)).toBe(iso(NOW + 600000));
        expect(rl.serverBackoffUntil(src, {}, NOW)).toBeNull();
        const limit = { 'hn.algolia.com': { ...five['hn.algolia.com'], http_status: 429, signal: 'http_429', count: 1 } };
        const l = rl.holdGate(src, TEST_ENV, limit, NOW);
        expect(l).toMatchObject({ state: 'all', kind: 'rate_limit' });
        expect(Object.keys(l.limitedRoutes)).toEqual(['algolia-search']);
        expect(l.reason).toMatch(/a rate limit/);
    });

    test('Copilot: source health counts only throttled hosts of the routes open NOW (a killed route\'s host cannot resolve the warning)', () => {
        const { conditionsFor, RATE_LIMITED_WARN_AFTER } = require('../../../src/collectors/source-health');
        const src = getSource('github');
        const hold = { until: iso(NOW + 600000), http_status: 429, signal: 'http_429', count: RATE_LIMITED_WARN_AFTER, weak: 0, at: iso(NOW) };
        const row = { rate_limited_hosts: { 'api.github.com': hold } };
        expect(conditionsFor(row, src, NOW).source_rate_limited).toBeDefined();
        expect(conditionsFor(row, src, NOW, { env: TEST_ENV, routeKills: [] }).source_rate_limited).toBeDefined();
        const kills = ['repo-search', 'issue-search'].map(route_id => ({ route_id, disabled_at: iso(NOW), reason: 'x', by: 'op' }));
        expect(conditionsFor(row, src, NOW, { env: TEST_ENV, routeKills: kills }).source_rate_limited).toBeUndefined();
    });

    test('L6: publicHostName names registry hosts only', () => {
        expect(rl.publicHostName('api.github.com')).toBe('api.github.com');
        expect(rl.publicHostName('API.GITHUB.COM')).toBe('API.GITHUB.COM');
        expect(rl.publicHostName('acme-123.feeds.example')).toBe(rl.CONFIGURED_HOST);
    });
});
