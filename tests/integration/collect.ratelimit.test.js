// tests/integration/collect.ratelimit.test.js
// Diagnosis 2026-10-01 (GitHub): a RATE LIMIT is a backoff, never a refusal.
// A response with positive rate-limit evidence (429; a 403 with
// x-ratelimit-remaining 0, or — from api.github.com only — a JSON message
// naming a rate limit, which with a strictly parsed Retry-After is strong)
// holds the HOST it came from until the source's own time (60 s floor
// doubling per consecutive limit, 24 h cap — migration 075). Retry-After
// alone never classifies a 403; it only lengthens a hold. A rate limit never
// touches the refused state (refusal count, cooldown, probation) and never
// opens the critical source_refused alert; persistent throttling opens the
// source_rate_limited WARNING (3 in a row on a host), and the 5th weak
// (body-only) limit in a row, or the 10th strong 403, is a refusal. A plain
// 403 with none of those signals stays a refusal.

'use strict';

const request = require('supertest');
const db = require('../../src/db/connection');
const { dbGet, dbAll, dbRun } = db;
const { runCollection } = require('../../src/collectors/runner');
const { sourceRows, summarize } = require('../../src/collectors/status');
const { evaluateSourceHealth, FAILING_AFTER } = require('../../src/collectors/source-health');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const NOW = () => Date.parse(RECORDED_AT);
const SEARCH = /api\.github\.com\/search\//;
const REPO_SEARCH = /api\.github\.com\/search\/repositories/;
const ISSUE_SEARCH = /api\.github\.com\/search\/issues/;
const BLOG = /github\.blog\/ai-and-ml\/feed/;
const SEARCH_OK = [SEARCH, 'recorded/github-repos.json'];
const BLOG_OK = [BLOG, 'recorded/bbc-technology.xml'];
const HN = [/hn\.algolia\.com/, 'recorded/hn-algolia.json'];
// The incident's response headers exactly (server Varnish, JSON) — no
// rate-limit evidence at all.
const INCIDENT_HEADERS = { date: 'Thu, 01 Oct 2026 02:47:54 GMT', server: 'Varnish', 'content-type': 'application/json; charset=utf-8' };
const resetIn = sec => String(Math.floor(Date.now() / 1000) + sec);
// GitHub's primary-limit 403: remaining 0, reset in epoch seconds.
const spent403 = (sec = 600) => ({
    status: 403,
    headers: { ...INCIDENT_HEADERS, 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '0', 'x-ratelimit-used': '10',
        'x-ratelimit-reset': resetIn(sec), 'x-ratelimit-resource': 'search', 'set-cookie': 'sid=secret' },
    body: '{"message":"API rate limit exceeded for 203.0.113.7.","documentation_url":"https://docs.github.com/rest"}',
});

async function collect(routes, slugs = ['github'], env = TEST_ENV) {
    const transport = fixtureTransport(routes);
    const sleeps = [];
    const summary = await runCollection({
        slugs, triggeredBy: 'test', env, transport, now: NOW,
        queues: { enqueueEmbeds: jest.fn().mockResolvedValue(), enqueueIngestRetry: jest.fn().mockResolvedValue() },
        collectorCtx: { sleep: ms => { sleeps.push(ms); return Promise.resolve(); } },
    });
    return { summary, transport, sleeps };
}

const stateOf = slug => dbGet(
    `SELECT s.* FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = $1`, [slug]);
const alertsOf = (slug, type) => dbAll(
    `SELECT a.alert_type, a.severity, a.resolved_at FROM alert_events a JOIN data_sources ds ON ds.id = a.source_id
     WHERE ds.name = $1 ${type ? 'AND a.alert_type = $2' : ''} ORDER BY a.created_at`, type ? [slug, type] : [slug]);
const runsOf = slug => dbAll(
    `SELECT r.outcome, r.error_kind, r.http_status, r.response_headers FROM source_runs r
     JOIN data_sources ds ON ds.id = r.source_id WHERE ds.name = $1 ORDER BY r.started_at`, [slug]);
const nextPoll = slug => dbRun(
    `UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'
     WHERE source_id = (SELECT id FROM data_sources WHERE name = $1)`, [slug]);
// Let every stored hold pass (as if the source's reset time went by).
const endHolds = slug => dbRun(
    `UPDATE source_collection_state
     SET rate_limited_hosts = (SELECT COALESCE(jsonb_object_agg(k, v || jsonb_build_object('until', (NOW() - interval '1 second')::text)), '{}'::jsonb)
                               FROM jsonb_each(rate_limited_hosts) AS e(k, v)),
         rate_limited_until = NOW() - interval '1 second'
     WHERE source_id = (SELECT id FROM data_sources WHERE name = $1)`, [slug]);
const urls = t => t.calls.map(c => c.url).filter(u => !u.endsWith('/robots.txt'));
const rowOf = async slug => (await sourceRows({ env: TEST_ENV })).find(r => r.slug === slug);

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('a GitHub rate limit is a host backoff, not a refusal', () => {
    it('403 + x-ratelimit-remaining 0: no refusal, no critical alert; api.github.com held until x-ratelimit-reset; github.blog still collected', async () => {
        const reset = resetIn(900);
        const res = spent403();
        res.headers['x-ratelimit-reset'] = reset;
        const { summary, transport } = await collect([[REPO_SEARCH, res], [ISSUE_SEARCH, 'recorded/github-repos.json'], BLOG_OK]);

        // repo-search was asked ONCE; issue-search (same host) was not asked
        // at all; the github.blog RSS route was.
        expect(urls(transport).filter(u => REPO_SEARCH.test(u))).toHaveLength(1);
        expect(urls(transport).filter(u => ISSUE_SEARCH.test(u))).toHaveLength(0);
        expect(urls(transport).filter(u => BLOG.test(u))).toHaveLength(1);
        expect(summary.sources[0].status).not.toBe('blocked_by_source');
        expect(summary.sources[0].rateLimitedUntil).toBe(new Date(Number(reset) * 1000).toISOString());

        const st = await stateOf('github');
        expect(st).toMatchObject({ refusal_count: 0, refused_until: null, access_denied_at: null, probation_until: null });
        expect(new Date(st.rate_limited_until).getTime()).toBe(Number(reset) * 1000);
        expect(st.rate_limited_hosts).toEqual({
            'api.github.com': { until: new Date(Number(reset) * 1000).toISOString(), http_status: 403, signal: 'ratelimit_remaining_zero', count: 1, weak: 0, strong403: 1,
                limit_at: expect.any(String), at: expect.any(String) },
        });
        // Grumpy #2: the held routes are stored by the worker.
        expect(Object.keys(st.rate_limited_routes)).toEqual(['repo-search', 'issue-search']);
        expect(st.rate_limited_at).not.toBeNull();
        // The allow-listed headers are kept (x-ratelimit-* included); the
        // cookie and the body never are.
        expect(st.rate_limit_headers).toMatchObject({ server: 'Varnish', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset,
            'x-ratelimit-resource': 'search' });
        expect(JSON.stringify(st.rate_limit_headers)).not.toMatch(/set-cookie|sid=secret|API rate limit exceeded|203\.0\.113/);

        const [run] = await runsOf('github');
        expect(run).toMatchObject({ error_kind: 'rate_limited', http_status: 403 });
        expect(run.response_headers).toMatchObject({ 'x-ratelimit-remaining': '0' });
        expect(await alertsOf('github', 'source_refused')).toEqual([]);

        // /api/sources view: still collecting (the blog route is open), the
        // held host and routes served; never blocked_by_source.
        const row = await rowOf('github');
        expect(row).toMatchObject({ status: 'collecting', refusal_count: 0, rate_limited_routes: ['repo-search', 'issue-search'],
            rate_limited_until: new Date(Number(reset) * 1000).toISOString() });
        expect(summarize(await sourceRows({ env: TEST_ENV })).by_status.blocked_by_source).toBe(0);
    });

    it('while held, a later poll never asks api.github.com (the blog still collects); after the reset it is asked again and the hold clears', async () => {
        await collect([[SEARCH, spent403()], BLOG_OK]);
        await nextPoll('github');
        const held = await collect([SEARCH_OK, BLOG_OK]);
        expect(urls(held.transport).filter(u => SEARCH.test(u))).toHaveLength(0);
        expect(urls(held.transport).filter(u => BLOG.test(u))).toHaveLength(1);
        expect(held.summary.sources[0].outcome).toBe('ok');

        await nextPoll('github');
        await endHolds('github');
        const after = await collect([SEARCH_OK, BLOG_OK]);
        expect(urls(after.transport).filter(u => SEARCH.test(u))).toHaveLength(2);
        expect(after.summary.sources[0].outcome).toBe('ok');
        const st = await stateOf('github');
        expect(st).toMatchObject({ rate_limited_hosts: {}, rate_limited_until: null, refusal_count: 0 });
        expect((await rowOf('github')).rate_limited_until).toBeNull();
    });

    it('regression (the 2026-10-01 incident): a plain 403 with no rate-limit signal still REFUSES the source', async () => {
        const { summary } = await collect([[REPO_SEARCH, { status: 403, headers: INCIDENT_HEADERS, body: '{"message":"Forbidden"}' }],
            [ISSUE_SEARCH, 'recorded/github-repos.json'], BLOG_OK]);
        expect(summary.sources[0]).toMatchObject({ status: 'blocked_by_source', outcome: 'error' });
        const st = await stateOf('github');
        expect(st).toMatchObject({ refusal_count: 1, access_denied_status: 403, rate_limited_until: null, rate_limited_hosts: {} });
        expect(await alertsOf('github', 'source_refused')).toEqual([expect.objectContaining({ severity: 'critical' })]);
    });

    it('a 403 whose JSON message names a secondary rate limit (no headers): held at the 60 s floor, body never stored', async () => {
        const before = Date.now();
        await collect([[REPO_SEARCH, { status: 403, headers: INCIDENT_HEADERS,
            body: '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}' }],
        [ISSUE_SEARCH, 'recorded/github-repos.json'], BLOG_OK]);
        const st = await stateOf('github');
        expect(st.refusal_count).toBe(0);
        expect(st.rate_limited_hosts['api.github.com']).toMatchObject({ http_status: 403, signal: 'body_rate_limit' });
        const heldMs = new Date(st.rate_limited_until).getTime() - before;
        expect(heldMs).toBeGreaterThanOrEqual(60000);
        expect(heldMs).toBeLessThan(65000);
        expect(JSON.stringify(st)).not.toMatch(/secondary rate limit/i);
        expect(await alertsOf('github', 'source_refused')).toEqual([]);
    });

    it('a 429 with Retry-After 600 s is never retried early: one request, no sleep, held for 600 s', async () => {
        const before = Date.now();
        const { transport, sleeps } = await collect([[REPO_SEARCH, { status: 429, headers: { 'retry-after': '600' }, body: '' }],
            [ISSUE_SEARCH, 'recorded/github-repos.json'], BLOG_OK]);
        expect(urls(transport).filter(u => REPO_SEARCH.test(u))).toHaveLength(1);
        expect(sleeps.filter(ms => ms >= 60000)).toEqual([]);
        const st = await stateOf('github');
        const heldMs = new Date(st.rate_limited_until).getTime() - before;
        expect(heldMs).toBeGreaterThanOrEqual(600000);
        expect(heldMs).toBeLessThan(605000);
        expect(st.rate_limited_hosts['api.github.com']).toMatchObject({ http_status: 429, signal: 'http_429' });
        expect((await runsOf('github'))[0]).toMatchObject({ error_kind: 'rate_limited', http_status: 429 });
    });

    it('security F5: a host held for ANOTHER source is held for this one too (one map per host) — zero requests', async () => {
        // A hold on hn.algolia.com stored on github's row (as if github
        // contacted it): hacker_news must not ask it either.
        await collect([SEARCH_OK, BLOG_OK]);
        await dbRun(`UPDATE source_collection_state
                     SET rate_limited_hosts = jsonb_build_object('hn.algolia.com', jsonb_build_object(
                         'until', to_char((NOW() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                         'http_status', 429, 'signal', 'http_429', 'count', 1, 'weak', 0))
                     WHERE source_id = (SELECT id FROM data_sources WHERE name = 'github')`);
        const { summary, transport } = await collect([HN], ['hacker_news']);
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'rate_limited' });
        // The shared hold is now on hacker_news's own row as well (its status shows it).
        expect((await stateOf('hacker_news')).rate_limited_hosts).toHaveProperty(['hn.algolia.com']);
        expect((await rowOf('hacker_news')).status).toBe('rate_limited');
    });

    it('security F5: the governance terms fetch never requests a host held in the database', async () => {
        const { snapshotTerms } = require('../../src/collectors/governance');
        const { HttpClient } = require('../../src/collectors/http');
        await collect([SEARCH_OK, BLOG_OK]);
        await dbRun(`UPDATE source_collection_state
                     SET rate_limited_hosts = jsonb_build_object('docs.github.com', jsonb_build_object(
                         'until', to_char((NOW() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                         'http_status', 429, 'signal', 'http_429', 'count', 1, 'weak', 0))
                     WHERE source_id = (SELECT id FROM data_sources WHERE name = 'github')`);
        const transport = fixtureTransport([[/./, { body: 'terms' }]]);
        const [row] = await snapshotTerms({ http: new HttpClient({ env: TEST_ENV, transport, sleep: () => Promise.resolve() }), slugs: ['github'] });
        expect(row.status).toBe('unreachable');
        expect(transport.calls).toHaveLength(0);
    });

    it('Copilot: a success clears the host\'s EXPIRED copies on every source\'s row (one streak per host); an active newer one is kept (grumpy N5)', async () => {
        await collect([SEARCH_OK, BLOG_OK]);
        const copy = (minutes, count) => `jsonb_build_object('hn.algolia.com', jsonb_build_object(
            'until', to_char((NOW() + make_interval(mins => ${minutes})) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
            'http_status', 429, 'signal', 'http_429', 'count', ${count}, 'weak', 0,
            'at', to_char((NOW() - interval '2 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`;
        // An expired 4-long streak for hn.algolia.com stored on github's row.
        await dbRun(`UPDATE source_collection_state SET rate_limited_hosts = ${copy(-60, 4)}
                     WHERE source_id = (SELECT id FROM data_sources WHERE name = 'github')`);
        const { transport } = await collect([HN], ['hacker_news']);
        expect(urls(transport)).toHaveLength(1);
        expect((await stateOf('github')).rate_limited_hosts).toEqual({});
        expect((await stateOf('hacker_news')).rate_limited_hosts).toEqual({});

        // A copy still IN FORCE elsewhere is never removed by a success.
        await dbRun(`UPDATE source_collection_state SET rate_limited_hosts = ${copy(30, 2)}
                     WHERE source_id = (SELECT id FROM data_sources WHERE name = 'github')`);
        const clear = require('../../src/collectors/state');
        const hnId = (await dbGet(`SELECT id FROM data_sources WHERE name = 'hacker_news'`)).id;
        await clear.saveHolds(hnId, { hosts: ['hn.algolia.com'], changes: new Map([['hn.algolia.com', null]]) });
        expect((await stateOf('github')).rate_limited_hosts).toHaveProperty(['hn.algolia.com']);
    });

    it('grumpy re-review: saving uses the same combine rule as loading — a newer strong record\'s streak wins, the later until is kept', async () => {
        const st = require('../../src/collectors/state');
        await collect([SEARCH_OK, BLOG_OK]);
        const ghId = (await dbGet(`SELECT id FROM data_sources WHERE name = 'github'`)).id;
        // Stored: an OLDER weak streak (4) whose hold ends LATER (+1 h).
        await dbRun(`UPDATE source_collection_state SET rate_limited_hosts = jsonb_build_object('api.github.com', jsonb_build_object(
                        'until', to_char((NOW() + interval '1 hour') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                        'http_status', 403, 'signal', 'body_rate_limit', 'count', 4, 'weak', 4,
                        'at', to_char((NOW() - interval '5 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))
                     WHERE source_id = $1`, [ghId]);
        const newer = { until: new Date(Date.now() + 60000).toISOString(), http_status: 429, signal: 'http_429', count: 5, weak: 0, at: new Date().toISOString() };
        await st.saveHolds(ghId, { hosts: ['api.github.com'], changes: new Map([['api.github.com', newer]]) });
        const saved = (await stateOf('github')).rate_limited_hosts['api.github.com'];
        // Streaks from the newer rate limit; the cause stays that of the record with the later until.
        expect(saved).toMatchObject({ signal: 'body_rate_limit', count: 5, weak: 0 });
        expect(Date.parse(saved.until) - Date.now()).toBeGreaterThan(55 * 60000);
    });

    it('grumpy N2: a rate limit met by the terms fetch is SAVED (on the source whose terms page it is) and honoured next time', async () => {
        const { snapshotTerms } = require('../../src/collectors/governance');
        const { HttpClient } = require('../../src/collectors/http');
        await collect([SEARCH_OK, BLOG_OK]);
        const t1 = fixtureTransport([[/docs\.github\.com\/robots\.txt/, { status: 404, body: '' }], [/docs\.github\.com/, { status: 429, headers: { 'retry-after': '900' }, body: '' }]]);
        const [row] = await snapshotTerms({ http: new HttpClient({ env: TEST_ENV, transport: t1, sleep: () => Promise.resolve() }), slugs: ['github'] });
        expect(row.status).toBe('unreachable');
        const st = await stateOf('github');
        expect(st.rate_limited_hosts['docs.github.com']).toMatchObject({ http_status: 429, signal: 'http_429', count: 1 });
        // The collector's own hosts are untouched (github keeps collecting),
        // and a throttled terms page is not shown as the source rate-limited.
        expect(st.rate_limited_hosts).not.toHaveProperty(['api.github.com']);
        expect(await rowOf('github')).toMatchObject({ status: 'collecting', rate_limited_until: null, rate_limited_hosts: [] });
        // Grumpy NIT: the stored column agrees (a terms page is not the source).
        expect(st.rate_limited_until).toBeNull();
        const t2 = fixtureTransport([[/./, { body: 'terms' }]]);
        await snapshotTerms({ http: new HttpClient({ env: TEST_ENV, transport: t2, sleep: () => Promise.resolve() }), slugs: ['github'] });
        expect(t2.calls).toHaveLength(0);
    });

    it('a reset days away is capped at 24 h', async () => {
        const before = Date.now();
        await collect([[SEARCH, spent403(5 * 24 * 3600)], BLOG_OK]);
        const heldMs = new Date((await stateOf('github')).rate_limited_until).getTime() - before;
        expect(heldMs).toBeLessThanOrEqual(24 * 3600000 + 5000);
        expect(heldMs).toBeGreaterThan(24 * 3600000 - 5000);
    });
});

describe('security F1: weak evidence never keeps a source polled forever', () => {
    it('consecutive body-only 403s grow the hold (60 → 120 → 240 → 480 s); the 5th refuses the source (fail closed)', async () => {
        const WEAK = [REPO_SEARCH, { status: 403, headers: INCIDENT_HEADERS, body: '{"message":"You have exceeded a secondary rate limit."}' }];
        const lengths = [];
        for (let i = 1; i <= 4; i++) {
            if (i > 1) { await nextPoll('github'); await endHolds('github'); }
            const before = Date.now();
            const { summary } = await collect([WEAK, [ISSUE_SEARCH, 'recorded/github-repos.json'], BLOG_OK]);
            expect(summary.sources[0].status).not.toBe('blocked_by_source');
            const st = await stateOf('github');
            expect(st.rate_limited_hosts['api.github.com']).toMatchObject({ count: i, weak: i });
            lengths.push(Math.round((new Date(st.rate_limited_until).getTime() - before) / 60000 * 2) / 2);
        }
        expect(lengths).toEqual([1, 2, 4, 8]);
        expect(await alertsOf('github', 'source_refused')).toEqual([]);
        await nextPoll('github');
        await endHolds('github');
        const { summary } = await collect([WEAK, [ISSUE_SEARCH, 'recorded/github-repos.json'], BLOG_OK]);
        expect(summary.sources[0]).toMatchObject({ status: 'blocked_by_source', outcome: 'error' });
        const st = await stateOf('github');
        expect(st).toMatchObject({ refusal_count: 1, access_denied_status: 403 });
        // The refusal keeps the host held with its streak (security review F9).
        expect(st.rate_limited_hosts['api.github.com']).toMatchObject({ count: 5, weak: 5 });
        expect(await alertsOf('github', 'source_refused')).toEqual([expect.objectContaining({ severity: 'critical' })]);
    });

    it('a success from the host resets the streak (the next limit starts at 60 s again)', async () => {
        const WEAK = [SEARCH, { status: 403, headers: INCIDENT_HEADERS, body: '{"message":"You have exceeded a secondary rate limit."}' }];
        await collect([WEAK, BLOG_OK]);
        await nextPoll('github'); await endHolds('github');
        await collect([WEAK, BLOG_OK]);
        expect((await stateOf('github')).rate_limited_hosts['api.github.com']).toMatchObject({ count: 2 });
        await nextPoll('github'); await endHolds('github');
        await collect([SEARCH_OK, BLOG_OK]);
        expect((await stateOf('github')).rate_limited_hosts).toEqual({});
        await nextPoll('github');
        const before = Date.now();
        await collect([WEAK, BLOG_OK]);
        const st = await stateOf('github');
        expect(st.rate_limited_hosts['api.github.com']).toMatchObject({ count: 1, weak: 1 });
        expect(new Date(st.rate_limited_until).getTime() - before).toBeLessThan(65000);
    });
});

describe('a source whose every route is held is skipped, not failed', () => {
    it('hacker_news (one host) rate-limited → next poll: zero requests, status rate_limited, no run row, served by GET /api/sources', async () => {
        await collect([[/hn\.algolia\.com/, { status: 429, headers: { 'retry-after': '300' }, body: '' }]], ['hacker_news']);
        const runs = await runsOf('hacker_news');
        expect(runs).toHaveLength(1);
        await nextPoll('hacker_news');
        const { summary, transport } = await collect([HN], ['hacker_news']);
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'rate_limited',
            reason: expect.stringMatching(/routes held: algolia-search .*not a refusal/) });
        expect(await runsOf('hacker_news')).toHaveLength(1);

        const st = await stateOf('hacker_news');
        expect(st).toMatchObject({ refusal_count: 0, access_denied_at: null });

        // The public API: status rate_limited with its until-time, never online.
        const saved = { ...process.env };
        Object.assign(process.env, TEST_ENV);
        try {
            const res = await request(require('../../src/server')).get('/api/sources');
            expect(res.status).toBe(200);
            const hn = res.body.find(s => s.slug === 'hacker_news');
            expect(hn).toMatchObject({ status: 'rate_limited', online: false, rate_limited_routes: ['algolia-search'],
                rate_limited_until: new Date(st.rate_limited_until).toISOString(), last_error_kind: 'rate_limited' });
            expect(hn.rate_limited_hosts).toEqual([expect.objectContaining({ host: 'hn.algolia.com', http_status: 429, signal: 'http_429' })]);
        } finally {
            for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
            Object.assign(process.env, saved);
        }
    });

    it('grumpy #9: a source found all-held only AFTER its claim — no request, the heartbeat beats, not counted as queried', async () => {
        const rateLimit = require('../../src/collectors/rate-limit');
        await collect([[/hn\.algolia\.com/, { status: 429, headers: { 'retry-after': '300' }, body: '' }]], ['hacker_news']);
        await nextPoll('hacker_news');
        // The pre-claim gate misses the hold (as if it were learned between
        // the gate and the route — another process, a later route).
        const spy = jest.spyOn(rateLimit, 'holdGate').mockReturnValueOnce({ state: 'none', until: null, next: null, routes: {}, reason: null });
        try {
            const { summary, transport } = await collect([HN], ['hacker_news']);
            expect(transport.calls).toHaveLength(0);
            expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'rate_limited' });
            expect(summary.sourcesQueried).toBe(0);
            expect(await runsOf('hacker_news')).toHaveLength(1);
        } finally {
            spy.mockRestore();
        }
    });

    it('security review M1: a throw in the route loop after a rate limit was learned still saves the hold (a restart never re-polls the limited host)', async () => {
        const rateLimit = require('../../src/collectors/rate-limit');
        const real = rateLimit.routeHeld;
        let calls = 0;
        // Route 1 (repo-search) is requested and rate-limited; the loop then
        // throws at route 2 — outside every per-route try/catch.
        const spy = jest.spyOn(rateLimit, 'routeHeld').mockImplementation((...a) => {
            if (++calls === 2) throw new Error('boom between routes');
            return real(...a);
        });
        try {
            await collect([[REPO_SEARCH, spent403(600)], [ISSUE_SEARCH, SEARCH_OK], BLOG_OK]).catch(() => null);
        } finally {
            spy.mockRestore();
        }
        expect(calls).toBeGreaterThanOrEqual(2);
        const hosts = (await stateOf('github')).rate_limited_hosts;
        expect(hosts['api.github.com']).toMatchObject({ http_status: 403, signal: 'ratelimit_remaining_zero', count: 1 });
        expect(Date.parse(hosts['api.github.com'].until)).toBeGreaterThan(Date.now());
    });

    it('Copilot: a partly held source lists only the routes that run now in open_routes (held ones are in rate_limited_routes)', async () => {
        // The repo-search route hits api.github.com; the blog route is another host.
        await collect([[REPO_SEARCH, spent403(600)], [ISSUE_SEARCH, spent403(600)], BLOG_OK]);
        const row = await rowOf('github');
        expect(row.rate_limited_routes).toEqual(expect.arrayContaining(['repo-search', 'issue-search']));
        expect(row.open_routes).not.toContain('repo-search');
        expect(row.open_routes).not.toContain('issue-search');
        expect(row.open_routes).toContain('ai-ml-blog-rss');
    });

    it('Copilot: saveHolds recomputes rate_limited_routes from the MERGED stored holds under the lock (a saver that saw no hold keeps a concurrent one\'s routes)', async () => {
        const state = require('../../src/collectors/state');
        const rl = require('../../src/collectors/rate-limit');
        const { getSource } = require('../../src/config/source-registry');
        const src = getSource('github');
        const id = (await dbGet("SELECT id FROM data_sources WHERE name = 'github'")).id;
        const until = new Date(Date.now() + 600000).toISOString();
        const hold = { until, http_status: 429, signal: 'http_429', count: 1, weak: 0, at: new Date().toISOString() };
        // A concurrent saver stored a hold on api.github.com ...
        await state.saveHolds(id, { hosts: ['api.github.com'], changes: new Map([['api.github.com', hold]]), view: { 'api.github.com': hold }, src, env: TEST_ENV });
        // ... then a saver whose snapshot saw NO hold saves with routes {} and no change for the host.
        await state.saveHolds(id, { hosts: rl.sourceHosts(src, TEST_ENV), changes: new Map(), view: {}, routes: {}, src, env: TEST_ENV });
        const st = await stateOf('github');
        expect(st.rate_limited_hosts['api.github.com']).toBeDefined();
        expect(Object.keys(st.rate_limited_routes)).toEqual(expect.arrayContaining(['repo-search', 'issue-search']));
    });

    it('Copilot: saveHolds reads the database route kill switches again — a disabled route is never stored as rate-limited', async () => {
        const state = require('../../src/collectors/state');
        const { getSource } = require('../../src/config/source-registry');
        const src = getSource('github');
        const id = (await dbGet("SELECT id FROM data_sources WHERE name = 'github'")).id;
        await state.setRouteKillSwitch(id, 'issue-search', true, { reason: 'test takedown', by: 'Test Operator 2026-10-01' });
        const hold = { until: new Date(Date.now() + 600000).toISOString(), http_status: 429, signal: 'http_429', count: 1, weak: 0, at: new Date().toISOString() };
        await state.saveHolds(id, { hosts: ['api.github.com'], changes: new Map([['api.github.com', hold]]), view: { 'api.github.com': hold }, src, env: TEST_ENV });
        const st = await stateOf('github');
        expect(Object.keys(st.rate_limited_routes)).toEqual(['repo-search']);
        const row = await rowOf('github');
        expect(row.disabled_routes).toContain('issue-search');
        expect(row.rate_limited_routes).not.toContain('issue-search');
    });

    it('Copilot: a 503 with a long Retry-After is honoured (no request next poll) but is NOT served as a rate limit', async () => {
        await collect([[/hn\.algolia\.com/, { status: 503, headers: { 'retry-after': '3600' }, body: '' }]], ['hacker_news']);
        const st = await stateOf('hacker_news');
        expect(st.rate_limited_hosts['hn.algolia.com']).toMatchObject({ signal: 'retry_after_5xx', count: 0 });
        expect(st.rate_limited_until).toBeNull();
        expect(st.rate_limited_routes).toEqual({ 'server:algolia-search': expect.any(String) });
        const row = await rowOf('hacker_news');
        expect(row.status).toBe('collecting');
        expect(row.rate_limited_until).toBeNull();
        expect(row.rate_limited_hosts).toEqual([]);
        expect(row.server_backoff_hosts).toEqual([expect.objectContaining({ host: 'hn.algolia.com', signal: 'retry_after_5xx' })]);
        expect(Date.parse(row.server_backoff_until)).toBeGreaterThan(Date.now());
        // The held route does not run now: out of open_routes, in server_backoff_routes, never in rate_limited_routes.
        expect(row.open_routes).toEqual([]);
        expect(row.server_backoff_routes).toEqual(['algolia-search']);
        expect(row.rate_limited_routes).toEqual([]);
        await nextPoll('hacker_news');
        const { summary, transport } = await collect([HN], ['hacker_news']);
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'backing_off' });
        expect(summary.sources[0].reason).toMatch(/server error/);
        expect(summary.sources[0].reason).not.toMatch(/backing off after a rate limit/);
    });

    it('Copilot: a route killed AFTER the worker saved its rate-limit map is not published as rate-limited (stale map)', async () => {
        const state = require('../../src/collectors/state');
        await collect([[REPO_SEARCH, spent403(600)], [ISSUE_SEARCH, spent403(600)], BLOG_OK]);
        expect((await rowOf('github')).rate_limited_routes).toEqual(expect.arrayContaining(['repo-search', 'issue-search']));
        const id = (await dbGet("SELECT id FROM data_sources WHERE name = 'github'")).id;
        await state.setRouteKillSwitch(id, 'issue-search', true, { reason: 'late takedown', by: 'Test Operator 2026-10-01' });
        const row = await rowOf('github');
        expect(row.disabled_routes).toContain('issue-search');
        expect(row.rate_limited_routes).toEqual(['repo-search']);
    });

    it('security F3: a contract-feed host never reaches GET /api/sources', async () => {
        await dbRun(`INSERT INTO source_collection_state (source_id, rate_limited_hosts, rate_limited_until, rate_limited_routes)
                     SELECT id, jsonb_build_object('acme-123.feeds.example', jsonb_build_object(
                         'until', to_char((NOW() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                         'http_status', 429, 'signal', 'http_429', 'count', 3, 'weak', 0)),
                         NOW() + interval '10 minutes',
                         jsonb_build_object('wire-store', to_char((NOW() + interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
                     FROM data_sources WHERE name = 'cnn'
                     ON CONFLICT (source_id) DO UPDATE SET rate_limited_hosts = EXCLUDED.rate_limited_hosts,
                         rate_limited_until = EXCLUDED.rate_limited_until, rate_limited_routes = EXCLUDED.rate_limited_routes`);
        const saved = { ...process.env };
        Object.assign(process.env, TEST_ENV, { CNN_FEED_URL: 'https://acme-123.feeds.example/x', CNN_LICENSE_REF: 'L-1' });
        try {
            const res = await request(require('../../src/server')).get('/api/sources');
            expect(res.status).toBe(200);
            expect(JSON.stringify(res.body)).not.toMatch(/acme-123/);
            const cnn = res.body.find(s => s.slug === 'cnn');
            expect(cnn.rate_limited_hosts).toEqual([expect.objectContaining({ host: 'configured host' })]);
            const health = await evaluateSourceHealth({ env: process.env });
            expect(JSON.stringify(health)).not.toMatch(/acme-123/);
            const details = await dbAll(`SELECT details FROM alert_events WHERE alert_type = 'source_rate_limited'`);
            expect(JSON.stringify(details)).not.toMatch(/acme-123/);
        } finally {
            for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
            Object.assign(process.env, saved);
        }
    });
});

describe('rate limits never escalate the refused state', () => {
    it('a source on probation (refusal count 2) that is rate-limited keeps its count and probation; no alert', async () => {
        await collect([[SEARCH, 'recorded/github-repos.json'], BLOG_OK]);
        await dbRun(`UPDATE source_collection_state SET refusal_count = 2, probation_until = NOW() + interval '12 hours',
                     last_refused_at = NOW() - interval '1 hour'
                     WHERE source_id = (SELECT id FROM data_sources WHERE name = 'github')`);
        const { probation_until: probation } = await stateOf('github');
        await nextPoll('github');
        await collect([[SEARCH, spent403()], BLOG_OK]);
        const st = await stateOf('github');
        expect(st).toMatchObject({ refusal_count: 2, access_denied_at: null, refused_until: null });
        expect(st.probation_until).toEqual(probation);
        expect(st.rate_limited_until).not.toBeNull();
        expect(await alertsOf('github', 'source_refused')).toEqual([]);
    });

    it(`${FAILING_AFTER} consecutive rate-limited runs open the source_failing and source_rate_limited WARNINGS, never a critical alert`, async () => {
        const LIMITED = [/hn\.algolia\.com/, { status: 429, headers: { 'retry-after': '120' }, body: '' }];
        for (let i = 0; i < FAILING_AFTER; i++) {
            if (i > 0) { await nextPoll('hacker_news'); await endHolds('hacker_news'); }
            const { transport } = await collect([LIMITED], ['hacker_news']);
            expect(urls(transport)).toHaveLength(1);
        }
        const st = await stateOf('hacker_news');
        expect(st).toMatchObject({ consecutive_failures: FAILING_AFTER, last_error_kind: 'rate_limited', refusal_count: 0 });
        const r = await evaluateSourceHealth({ env: TEST_ENV });
        expect(r.opened.sort((a, b) => a.type.localeCompare(b.type))).toEqual([
            { slug: 'hacker_news', type: 'source_failing' }, { slug: 'hacker_news', type: 'source_rate_limited' }]);
        const alerts = await alertsOf('hacker_news');
        expect(alerts.map(a => [a.alert_type, a.severity]).sort()).toEqual([['source_failing', 'warning'], ['source_rate_limited', 'warning']]);
    });

    it('grumpy #5: GitHub\'s API throttled 3 runs in a row while its blog route succeeds → source_rate_limited WARNING (consecutive_failures stays 0); resolved by a success', async () => {
        for (let i = 0; i < 3; i++) {
            if (i > 0) { await nextPoll('github'); await endHolds('github'); }
            const { summary } = await collect([[SEARCH, spent403(30)], BLOG_OK]);
            expect(summary.sources[0].outcome).toBe('ok');
        }
        expect((await stateOf('github')).consecutive_failures).toBe(0);
        const r = await evaluateSourceHealth({ env: TEST_ENV });
        expect(r.opened).toEqual([{ slug: 'github', type: 'source_rate_limited' }]);
        expect(await alertsOf('github', 'source_rate_limited')).toEqual([expect.objectContaining({ severity: 'warning', resolved_at: null })]);
        await nextPoll('github'); await endHolds('github');
        await collect([SEARCH_OK, BLOG_OK]);
        expect((await evaluateSourceHealth({ env: TEST_ENV })).resolved).toEqual([{ slug: 'github', type: 'source_rate_limited' }]);
    });
});
