// tests/integration/collect.refusal.test.js
// F10-5: a source that refuses access (401/403/451, a bot wall, robots.txt)
// enters the refused state — cooldown 1 h → 24 h, a critical alert, status
// 'blocked_by_source', never online — and leaves it only on a successful
// probe after the cooldown or a manual reset (env or npm run source:reset).

'use strict';

const db = require('../../src/db/connection');
const { dbGet, dbAll, dbRun } = db;
const { runCollection } = require('../../src/collectors/runner');
const { sourceRows, summarize } = require('../../src/collectors/status');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { main: adminMain } = require('../../scripts/source-admin');
const state = require('../../src/collectors/state');
const { probationOver } = require('../../src/collectors/refusal');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const NOW = () => Date.parse(RECORDED_AT);
const HN = [/hn\.algolia\.com/, 'recorded/hn-algolia.json'];
const DENIED = [/hn\.algolia\.com/, { status: 403, body: 'denied' }];

async function collect(routes, env = TEST_ENV, slugs = ['hacker_news']) {
    const transport = fixtureTransport(routes);
    const summary = await runCollection({
        slugs, triggeredBy: 'test', env, transport, now: NOW,
        queues: { enqueueEmbeds: jest.fn().mockResolvedValue(), enqueueIngestRetry: jest.fn().mockResolvedValue() },
        collectorCtx: { sleep: () => Promise.resolve() },
    });
    return { summary, transport };
}

const stateOf = slug => dbGet(
    `SELECT s.* FROM source_collection_state s JOIN data_sources ds ON ds.id = s.source_id WHERE ds.name = $1`, [slug]);
const alertsOf = slug => dbAll(
    `SELECT a.severity, a.resolved_at, a.details FROM alert_events a
     JOIN data_sources ds ON ds.id = a.source_id
     WHERE a.alert_type = 'source_refused' AND ds.name = $1 ORDER BY a.created_at`, [slug]);
// Let the next run past the poll-interval claim (a later poll).
const nextPoll = slug => dbRun(
    `UPDATE source_collection_state SET last_attempt_at = NOW() - interval '1 day'
     WHERE source_id = (SELECT id FROM data_sources WHERE name = $1)`, [slug]);
const endCooldown = slug => dbRun(
    `UPDATE source_collection_state SET refused_until = NOW() - interval '1 second'
     WHERE source_id = (SELECT id FROM data_sources WHERE name = $1)`, [slug]);
// Let the 24 h probation pass (as if a day went by without a refusal).
const endProbation = slug => dbRun(
    `UPDATE source_collection_state SET probation_until = NOW() - interval '1 second'
     WHERE source_id = (SELECT id FROM data_sources WHERE name = $1)`, [slug]);
// Grumpy final #1: a reset date must be at or after the refusal AND not in
// the future. The date used here is the stored refusal time itself (the
// inclusive lower bound); the wait covers a database clock a few ms ahead of
// the host's, so the date is never "in the future" for the runner.
async function resetDateAtRefusal(slug, column = 'access_denied_at') {
    const at = new Date((await stateOf(slug))[column]).getTime();
    while (Date.now() <= at) await new Promise(r => setTimeout(r, 5));
    return new Date(at).toISOString();
}
const cooldownHours = st => Math.round((new Date(st.refused_until) - new Date(st.access_denied_at)) / 3600000);
const rowOf = async slug => (await sourceRows({ env: TEST_ENV })).find(r => r.slug === slug);

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('the refused state (F10-5)', () => {
    it('a 403 refuses the source: cooldown 1 h, one critical alert, blocked_by_source, not online', async () => {
        const { summary } = await collect([DENIED]);
        expect(summary.sources[0]).toMatchObject({ outcome: 'error', status: 'blocked_by_source' });
        const st = await stateOf('hacker_news');
        expect(st).toMatchObject({ access_denied_status: 403, access_denied_kind: 'access_denied', refusal_count: 1 });
        const cooldown = new Date(st.refused_until) - new Date(st.access_denied_at);
        expect(Math.round(cooldown / 60000)).toBe(60);
        const alerts = await alertsOf('hacker_news');
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ severity: 'critical', resolved_at: null,
            details: expect.objectContaining({ slug: 'hacker_news', http_status: 403, error_kind: 'access_denied' }) });

        const row = await rowOf('hacker_news');
        expect(row).toMatchObject({ status: 'blocked_by_source', online: false, refusal_count: 1, reset_env: 'SOURCE_HACKER_NEWS_RESET' });
        expect(row.status_reason).toMatch(/refused access \(HTTP 403\).*cooldown until/);
        const sum = summarize(await sourceRows({ env: TEST_ENV }));
        expect(sum.by_status.blocked_by_source).toBe(1);
    });

    it('during the cooldown no request is made, even on a later poll', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        const { summary, transport } = await collect([HN]);
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'blocked_by_source', reason: expect.stringMatching(/cooldown until/) });
    });

    it('after the cooldown one probe runs; a second refusal doubles the cooldown (capped at 24 h), still one alert', async () => {
        await collect([DENIED]);
        for (let n = 2; n <= 7; n++) {
            await nextPoll('hacker_news');
            await endCooldown('hacker_news');
            const { transport } = await collect([DENIED]);
            expect(transport.calls).toHaveLength(1);
            const st = await stateOf('hacker_news');
            expect(st.refusal_count).toBe(n);
            const hours = (new Date(st.refused_until) - new Date(st.access_denied_at)) / 3600000;
            expect(Math.round(hours)).toBe(Math.min(24, 2 ** (n - 1)));
        }
        expect(await alertsOf('hacker_news')).toHaveLength(1);
    });

    it('a successful probe ends the refused state and resolves the alert, but KEEPS the count (24 h probation)', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        const { summary } = await collect([HN]);
        expect(summary.sources[0].outcome).toBe('ok');
        const st = await stateOf('hacker_news');
        expect(st).toMatchObject({ access_denied_at: null, refused_until: null, refusal_count: 1, access_denied_headers: null });
        const probationH = (new Date(st.probation_until) - Date.now()) / 3600000;
        expect(probationH).toBeGreaterThan(23.9);
        expect(probationH).toBeLessThanOrEqual(24);
        const [alert] = await alertsOf('hacker_news');
        expect(alert.resolved_at).not.toBeNull();
        expect(alert.details.resolution).toMatch(/probe run after the cooldown succeeded; on probation until .*refusal count 1 kept/);
        const row = await rowOf('hacker_news');
        expect(row).toMatchObject({ status: 'collecting', refusal_count: 1 });
        expect(row.probation_until).not.toBeNull();
    });

    it('an env reset at or after the refusal clears it and the source is asked again; an older one does not', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        const old = { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: '2000-01-01' };
        expect((await collect([HN], old)).transport.calls).toHaveLength(0);
        const fresh = { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: await resetDateAtRefusal('hacker_news') };
        const { summary, transport } = await collect([HN], fresh);
        expect(transport.calls).toHaveLength(1);
        expect(summary.sources[0].outcome).toBe('ok');
        expect((await alertsOf('hacker_news'))[0].details.resolution).toMatch(/SOURCE_HACKER_NEWS_RESET\) approved by Test Operator 2026-09-29/);
        // Security L6 / G5: the env reset is a recorded gate event, its actor the named approval.
        expect(await db.dbAll(`SELECT event, actor, approved_by, reason FROM source_gate_events
                               WHERE slug = 'hacker_news' AND event = 'refusal_reset'`)).toEqual([{
            event: 'refusal_reset', actor: 'Test Operator 2026-09-29', approved_by: 'Test Operator 2026-09-29',
            reason: `SOURCE_HACKER_NEWS_RESET=${fresh.SOURCE_HACKER_NEWS_RESET}` }]);
    });

    it('an env reset without a named approval (G5) leaves the refusal standing and records nothing', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        const { GATE_APPROVED_BY: _drop, ...unapproved } = TEST_ENV;
        const env = { ...unapproved, SOURCE_HACKER_NEWS_RESET: await resetDateAtRefusal('hacker_news') };
        const { summary, transport } = await collect([HN], env);
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'blocked_by_source',
            reason: expect.stringMatching(/SOURCE_HACKER_NEWS_RESET is set but awaiting named approval/) });
        expect((await stateOf('hacker_news')).refusal_count).toBe(1);
        expect(await db.dbAll(`SELECT 1 FROM source_gate_events WHERE event = 'refusal_reset'`)).toEqual([]);
    });

    // Grumpy final #1: an approved reset date in the FUTURE never clears a
    // refusal. Before the fix it cleared every refusal recorded before the
    // date, so a source that refused again was re-requested on the very
    // next poll (one refusal_reset gate event and one alert per cycle).
    it('an approved env reset dated in the future is ignored: no request, no reset event, the reason says why', async () => {
        await collect([DENIED]);
        const future = new Date(Date.now() + 2 * 3600 * 1000).toISOString();
        const env = { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: future };
        for (let poll = 0; poll < 3; poll++) {
            await nextPoll('hacker_news');
            const { summary, transport } = await collect([HN], env);
            expect(transport.calls).toHaveLength(0);
            expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'blocked_by_source',
                reason: expect.stringContaining(`SOURCE_HACKER_NEWS_RESET (${future}) is in the future and is ignored until then`) });
        }
        expect(await stateOf('hacker_news')).toMatchObject({ refusal_count: 1, access_denied_status: 403 });
        expect(await db.dbAll(`SELECT 1 FROM source_gate_events WHERE event = 'refusal_reset'`)).toEqual([]);
        expect((await alertsOf('hacker_news')).filter(a => !a.resolved_at)).toHaveLength(1);
        // /api/sources says the same.
        expect((await rowOf('hacker_news')).status).toBe('blocked_by_source');
    });

    it('npm run source:reset clears the refused state (the DB flag) and resolves the alert with the note', async () => {
        await collect([DENIED]);
        const lines = [];
        expect(await adminMain(['reset', 'hacker_news', '--note', 'publisher allowlisted us'],
            { db, out: l => lines.push(l), err: l => lines.push(l), env: { GATE_APPROVED_BY: 'Tess Tester 2026-09-29' } })).toBe(0);
        expect(lines.join('\n')).toMatch(/refused state cleared/);
        expect((await stateOf('hacker_news')).access_denied_at).toBeNull();
        expect((await alertsOf('hacker_news'))[0].details.resolution).toBe('manual reset by Tess Tester 2026-09-29: publisher allowlisted us');
        expect(await db.dbAll(`SELECT event, actor, approved_by, reason FROM source_gate_events WHERE event = 'refusal_reset'`))
            .toEqual([{ event: 'refusal_reset', actor: 'Tess Tester 2026-09-29', approved_by: 'Tess Tester 2026-09-29',
                reason: 'publisher allowlisted us' }]);
        await nextPoll('hacker_news');
        expect((await collect([HN])).transport.calls).toHaveLength(1);
        const errs = [];
        expect(await adminMain(['reset'], { db, err: l => errs.push(l), env: {} })).toBe(2);
        expect(await adminMain(['reset', 'nope'], { db, err: l => errs.push(l) })).toBe(2);
        expect(errs.join('\n')).toMatch(/usage[\s\S]*unknown source 'nope'/);
    });

    it('a robots.txt disallow refuses the source too (kind robots)', async () => {
        await collect([['https://feeds.bbci.co.uk/robots.txt', { status: 200, body: 'User-agent: *\nDisallow: /\n' }]], TEST_ENV, ['bbc_news']);
        const st = await stateOf('bbc_news');
        expect(st).toMatchObject({ access_denied_kind: 'robots', refusal_count: 1 });
        expect((await rowOf('bbc_news')).status).toBe('blocked_by_source');
    });

    // Owner decision 2026-10-02 (ADR 0001 ruling 5 note): a 401 / 451 on robots.txt is the
    // source saying no; a plain 403 there is "no robots.txt" again (as before PR #45).
    it.each([401, 451])('a %i on robots.txt refuses the source (the feed is never asked)', async (status) => {
        const { transport } = await collect([['https://feeds.bbci.co.uk/robots.txt', { status, body: 'no' }]], TEST_ENV, ['bbc_news']);
        expect(await stateOf('bbc_news')).toMatchObject({ access_denied_status: status, refusal_count: 1 });
        expect((await rowOf('bbc_news')).status).toBe('blocked_by_source');
        expect(transport.calls.filter(c => !c.url.endsWith('/robots.txt'))).toHaveLength(0);
    });

    it('a plain 403 on robots.txt is "no rules": the source is not refused and the feed is asked', async () => {
        const { transport } = await collect([['https://feeds.bbci.co.uk/robots.txt', { status: 403, body: 'denied' }]], TEST_ENV, ['bbc_news']);
        expect(await stateOf('bbc_news')).toMatchObject({ access_denied_at: null, refusal_count: 0 });
        expect(transport.calls.filter(c => !c.url.endsWith('/robots.txt')).length).toBeGreaterThan(0);
    });

    it('an ordinary failure (HTTP 500) is not a refusal', async () => {
        await collect([[/hn\.algolia\.com/, { status: 500, body: 'oops' }]]);
        expect(await stateOf('hacker_news')).toMatchObject({ access_denied_at: null, refusal_count: 0 });
        expect(await alertsOf('hacker_news')).toHaveLength(0);
    });
});

// Diagnosis 2026-09-30 (Pew Research Center): one clean probe zeroed the
// count, so a publisher that lets a few requests through before refusing
// again held us at a 1 h cooldown forever. Jennifer's ruling "Probation +
// log headers (Recommended)" (ADR 0001 note 2026-09-30).
describe('refusal probation (ADR 0001 note 2026-09-30)', () => {
    const OK_RUNS = 3;
    // refuse → cooldown ends → probe ok → more ok runs → refuse again
    async function probeThenRefuse() {
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        expect((await collect([HN])).summary.sources[0].outcome).toBe('ok');
        for (let i = 1; i < OK_RUNS; i++) {
            await nextPoll('hacker_news');
            expect((await collect([HN])).summary.sources[0].outcome).toBe('ok');
        }
        await nextPoll('hacker_news');
        const { transport } = await collect([DENIED]);
        expect(transport.calls).toHaveLength(1);
        return stateOf('hacker_news');
    }

    it('refuse → cooldown → success → refuse again ESCALATES: refusal 2, a 2 h cooldown (not 1 and 1 h)', async () => {
        await collect([DENIED]);
        const st = await probeThenRefuse();
        expect(st).toMatchObject({ refusal_count: 2, probation_until: null, access_denied_status: 403 });
        expect(cooldownHours(st)).toBe(2);
        expect(summaryReason(await collect([HN]))).toMatch(/cooldown until/);
    });

    it('repeated refusals after clean probes escalate 1 h → 2 h → 4 h → … → 24 h (capped)', async () => {
        await collect([DENIED]);
        expect(cooldownHours(await stateOf('hacker_news'))).toBe(1);
        const seen = [];
        for (let n = 2; n <= 7; n++) {
            const st = await probeThenRefuse();
            expect(st.refusal_count).toBe(n);
            seen.push(cooldownHours(st));
        }
        expect(seen).toEqual([2, 4, 8, 16, 24, 24]);
    });

    it('sustained success decays: after 24 h without a refusal the next ok run resets the count to 0', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([HN]);                     // probe ok → probation
        await nextPoll('hacker_news');
        await collect([HN]);                     // still on probation: count kept
        expect(await stateOf('hacker_news')).toMatchObject({ refusal_count: 1 });
        await endProbation('hacker_news');
        await nextPoll('hacker_news');
        await collect([HN]);                     // probation over → decays
        expect(await stateOf('hacker_news')).toMatchObject({ refusal_count: 0, probation_until: null, access_denied_at: null });
        await nextPoll('hacker_news');
        await collect([DENIED]);                 // a later refusal starts over at 1 h
        const st = await stateOf('hacker_news');
        expect(st.refusal_count).toBe(1);
        expect(cooldownHours(st)).toBe(1);
    });

    it('a refusal after the probation window counts as refusal 1 even with no run in between', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([HN]);
        await endProbation('hacker_news');
        await nextPoll('hacker_news');
        await collect([DENIED]);
        const st = await stateOf('hacker_news');
        expect(st.refusal_count).toBe(1);
        expect(cooldownHours(st)).toBe(1);
    });

    it('the open source_refused alert reflects the current count when a refused probe escalates it', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([DENIED]);                 // the probe itself is refused: 1 → 2, same episode
        let alerts = await alertsOf('hacker_news');
        expect(alerts).toHaveLength(1);
        expect(alerts[0].resolved_at).toBeNull();
        expect(alerts[0].details).toMatchObject({ refusal_count: 2, opened_refusal_count: 1, escalations: 1, http_status: 403 });
        const st = await stateOf('hacker_news');
        expect(new Date(alerts[0].details.refused_until).getTime()).toBe(new Date(st.refused_until).getTime());
        expect(alerts[0].details.escalated_at).toBeTruthy();
        // A clean probe resolves it; a refusal during probation opens a NEW
        // alert that starts at the continued count.
        const after = await probeThenRefuse();
        expect(after.refusal_count).toBe(3);
        alerts = await alertsOf('hacker_news');
        expect(alerts).toHaveLength(2);
        expect(alerts[0].resolved_at).not.toBeNull();
        expect(alerts[1]).toMatchObject({ resolved_at: null,
            details: expect.objectContaining({ refusal_count: 3, opened_refusal_count: 3 }) });
        expect(alerts[1].details).not.toHaveProperty('escalations');
    });

    it('refusals are still honoured throughout: no request during any cooldown of the escalated schedule', async () => {
        await collect([DENIED]);
        await probeThenRefuse();
        await nextPoll('hacker_news');
        const { transport, summary } = await collect([HN]);
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'blocked_by_source',
            reason: expect.stringMatching(/refusal 2; .*cooldown until/) });
    });

    it('a manual reset clears the count and the probation too', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([HN]);
        expect(await adminMain(['reset', 'hacker_news', '--note', 'publisher confirmed'],
            { db, out: () => {}, err: () => {}, env: { GATE_APPROVED_BY: 'Tess Tester 2026-09-29' } })).toBe(0);
        expect(await stateOf('hacker_news')).toMatchObject({ refusal_count: 0, probation_until: null });
    });
});

describe('refusal response headers (diagnosis 2026-09-30, option D)', () => {
    const SECRET = 'sk-refusal-test-5e6f7a8b9c0d';
    const HEADERS = {
        server: 'nginx', date: 'Wed, 30 Sep 2026 16:26:35 GMT', 'content-type': 'text/html',
        'x-rq': 'sea1 83 196 443', 'x-served-by': `cache-sea\nFAKE ${SECRET}`,
        'set-cookie': 'vip-go-seg=abc; HttpOnly', 'www-authenticate': 'Basic realm="x"', 'x-debug-internal': 'nope',
    };
    const DENIED_H = [/hn\.algolia\.com/, { status: 403, headers: HEADERS, body: '<html>Forbidden body</html>' }];

    it('are logged and stored with the refusal: allow-listed only, scrubbed, one line; never cookies, auth or body', async () => {
        const env = { ...TEST_ENV, SOME_SERVICE_TOKEN: SECRET };
        const lines = [];
        await runCollection({
            slugs: ['hacker_news'], triggeredBy: 'test', env, transport: fixtureTransport([DENIED_H]), now: NOW,
            log: l => lines.push(l),
            queues: { enqueueEmbeds: jest.fn().mockResolvedValue(), enqueueIngestRetry: jest.fn().mockResolvedValue() },
            collectorCtx: { sleep: () => Promise.resolve() },
        });
        const expected = ['content-type', 'date', 'server', 'x-rq', 'x-served-by'];
        const st = await stateOf('hacker_news');
        expect(Object.keys(st.access_denied_headers).sort()).toEqual(expected);
        const [run] = await dbAll(
            `SELECT r.response_headers, r.error_kind, r.http_status FROM source_runs r
             JOIN data_sources ds ON ds.id = r.source_id WHERE ds.name = 'hacker_news'`);
        expect(run).toMatchObject({ error_kind: 'access_denied', http_status: 403 });
        expect(run.response_headers).toEqual(st.access_denied_headers);
        const [alert] = await alertsOf('hacker_news');
        expect(alert.details.response_headers).toEqual(st.access_denied_headers);
        const stored = JSON.stringify([st.access_denied_headers, run.response_headers, alert.details]);
        for (const bad of [SECRET, 'vip-go-seg', 'Basic realm', 'x-debug-internal', 'Forbidden body']) expect(stored).not.toContain(bad);
        expect(st.access_denied_headers['x-served-by']).toBe('cache-sea\\nFAKE [redacted]');
        const logged = lines.filter(l => /refusal response headers/.test(l));
        expect(logged).toHaveLength(1);
        expect(logged[0]).not.toContain(SECRET);
        expect(logged[0]).not.toMatch(/\n/);
        expect(logged[0]).toContain('"x-rq":"sea1 83 196 443"');
        // Never on the public surface (F10-1: classification only).
        expect(JSON.stringify(await rowOf('hacker_news'))).not.toContain('sea1 83 196 443');
    });

    it('a run that was not refused stores no headers; a successful probe clears the refusal headers', async () => {
        await collect([HN]);
        const runs = await dbAll(`SELECT response_headers FROM source_runs`);
        expect(runs.every(r => r.response_headers === null)).toBe(true);
        await nextPoll('hacker_news');
        await collect([DENIED_H]);
        expect((await stateOf('hacker_news')).access_denied_headers).not.toBeNull();
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([HN]);
        expect((await stateOf('hacker_news')).access_denied_headers).toBeNull();
    });
});

describe('DNS failures are not retried within a run (diagnosis 2026-09-30, option D)', () => {
    it('ENOTFOUND costs ONE request, is a network error, and is not a refusal', async () => {
        let n = 0;
        const { summary } = await collect([[/hn\.algolia\.com/, () => {
            n++;
            throw Object.assign(new Error('getaddrinfo ENOTFOUND hn.algolia.com'), { code: 'ENOTFOUND' });
        }]]);
        expect(n).toBe(1);
        expect(summary.sources[0]).toMatchObject({ outcome: 'error', errorKind: 'network' });
        const [run] = await dbAll(`SELECT requests, error_kind FROM source_runs`);
        expect(run).toEqual({ requests: 1, error_kind: 'network' });
        expect(await stateOf('hacker_news')).toMatchObject({ access_denied_at: null, refusal_count: 0 });
    });
});

const idOf = async slug => (await dbGet('SELECT id FROM data_sources WHERE name = $1', [slug])).id;
const setState = (slug, sql) => dbRun(`UPDATE source_collection_state SET ${sql}
     WHERE source_id = (SELECT id FROM data_sources WHERE name = $1)`, [slug]);

// Grumpy review #5: the three transitions that had no test.
describe('refusal transitions (grumpy review #5)', () => {
    it.each([
        ['a 5xx', [/hn\.algolia\.com/, { status: 503, body: 'down' }]],
        ['a DNS failure', [/hn\.algolia\.com/, () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }); }]],
    ])('(i) a probe that fails with %s (not a refusal) leaves the source refused: next run is a probe again, count unchanged', async (_l, fail) => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        const before = await stateOf('hacker_news');
        const { transport } = await collect([fail]);
        expect(transport.calls.length).toBeGreaterThanOrEqual(1);
        const st = await stateOf('hacker_news');
        expect(st).toMatchObject({ refusal_count: 1, probation_until: null });
        expect(new Date(st.access_denied_at).getTime()).toBe(new Date(before.access_denied_at).getTime());
        expect((await alertsOf('hacker_news')).filter(a => !a.resolved_at)).toHaveLength(1);
        // Still the probe: one request is allowed and a success starts probation.
        await nextPoll('hacker_news');
        const { transport: t2 } = await collect([HN]);
        expect(t2.calls).toHaveLength(1);
        expect(await stateOf('hacker_news')).toMatchObject({ access_denied_at: null, refusal_count: 1 });
    });

    it('(ii) a robots.txt refusal during probation continues the count, stores no headers, and resets the alert headers', async () => {
        const BBC_FEED = 'https://feeds.bbci.co.uk/news/technology/rss.xml';
        const ROBOTS_OK = ['https://feeds.bbci.co.uk/robots.txt', { status: 200, body: 'User-agent: *\nAllow: /\n' }];
        const ROBOTS_NO = ['https://feeds.bbci.co.uk/robots.txt', { status: 200, body: 'User-agent: *\nDisallow: /\n' }];
        const bbc = routes => collect(routes, TEST_ENV, ['bbc_news']);
        await bbc([ROBOTS_OK, [BBC_FEED, { status: 403, headers: { server: 'Belfrage', via: '1.1 edge' }, body: 'no' }]]);
        expect((await stateOf('bbc_news')).access_denied_headers).toEqual({ server: 'Belfrage', via: '1.1 edge' });
        await nextPoll('bbc_news');
        await endCooldown('bbc_news');
        await bbc([ROBOTS_OK, [BBC_FEED, 'recorded/bbc-technology.xml']]);     // probe ok → probation
        expect(await stateOf('bbc_news')).toMatchObject({ access_denied_at: null, refusal_count: 1 });
        await nextPoll('bbc_news');
        await bbc([ROBOTS_NO]);
        const st = await stateOf('bbc_news');
        expect(st).toMatchObject({ refusal_count: 2, access_denied_kind: 'robots', access_denied_headers: null });
        expect(cooldownHours(st)).toBe(2);
        const open = (await alertsOf('bbc_news')).filter(a => !a.resolved_at);
        expect(open).toHaveLength(1);
        expect(open[0].details).toMatchObject({ refusal_count: 2, error_kind: 'robots', response_headers: null });
    });

    it('(iii) a pre-062 row (count > 0, no probation time, not refused) decays to 0 on the next ok run', async () => {
        await collect([HN]);
        await setState('hacker_news', 'refusal_count = 2, probation_until = NULL, access_denied_at = NULL');
        expect((await rowOf('hacker_news')).refusal_count).toBe(0);     // already not in effect (grumpy #8)
        await nextPoll('hacker_news');
        await collect([HN]);
        expect(await stateOf('hacker_news')).toMatchObject({ refusal_count: 0, probation_until: null, last_refused_at: null });
    });

    // Grumpy final #4: migration 062 added last_refused_at without a
    // backfill, so a source REFUSED before 062 (access_denied_at set,
    // last_refused_at NULL) went on probation with no last refusal time, and
    // an approved env reset then silently did nothing. endCooldown now
    // carries access_denied_at over when last_refused_at is NULL.
    it('(iv) a pre-062 REFUSED row: its probe keeps the refusal time, so an approved env reset clears the probation', async () => {
        await collect([DENIED]);
        // As written before 062: refused, no last_refused_at.
        await setState('hacker_news', 'last_refused_at = NULL');
        const refusedAt = (await stateOf('hacker_news')).access_denied_at;
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([HN]);                             // probe ok → probation
        const st = await stateOf('hacker_news');
        expect(st).toMatchObject({ access_denied_at: null, refusal_count: 1 });
        expect(st.probation_until).not.toBeNull();
        expect(new Date(st.last_refused_at).getTime()).toBe(new Date(refusedAt).getTime());

        await nextPoll('hacker_news');
        const resetAt = await resetDateAtRefusal('hacker_news', 'last_refused_at');
        await collect([HN], { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: resetAt });
        expect(await stateOf('hacker_news')).toMatchObject({ refusal_count: 0, probation_until: null, last_refused_at: null });
        expect(await dbAll(`SELECT event FROM source_gate_events WHERE slug = 'hacker_news' AND event = 'refusal_reset'`))
            .toEqual([{ event: 'refusal_reset' }]);
    });

    it('(iv) endCooldown never overwrites a last_refused_at that is already set', async () => {
        await collect([DENIED]);
        const before = await stateOf('hacker_news');
        expect(before.last_refused_at).not.toBeNull();
        await setState('hacker_news', "last_refused_at = access_denied_at - interval '1 hour'");
        const kept = (await stateOf('hacker_news')).last_refused_at;
        const id = await idOf('hacker_news');
        expect(await state.endCooldown(id, before.access_denied_at)).not.toBeNull();
        expect(new Date((await stateOf('hacker_news')).last_refused_at).getTime()).toBe(new Date(kept).getTime());
    });
});

// Security review: the listed tests.
describe('refusal state races and escalations (security review)', () => {
    it('M1: a stale probe success never clears a NEWER refusal; racing endCooldowns resolve the alert once', async () => {
        await collect([DENIED]);
        await endCooldown('hacker_news');
        const id = await idOf('hacker_news');
        const probed = (await state.getRefusal(id)).access_denied_at;
        // Another run refuses in between (the probe is refused elsewhere).
        await dbRun(`UPDATE source_collection_state SET access_denied_at = access_denied_at + interval '1 second' WHERE source_id = $1`, [id]);
        expect(await state.endCooldown(id, probed)).toBeNull();
        const st = await stateOf('hacker_news');
        expect(st.access_denied_at).not.toBeNull();
        expect(st.probation_until).toBeNull();
        expect((await alertsOf('hacker_news')).filter(a => !a.resolved_at)).toHaveLength(1);
        // Two concurrent successes for the SAME refusal: one ends it.
        const current = (await state.getRefusal(id)).access_denied_at;
        const results = await Promise.all([state.endCooldown(id, current), state.endCooldown(id, current)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const resolutions = await dbAll(
            `SELECT r.resolution FROM alert_resolutions r JOIN alert_events a ON a.id = r.alert_id
             WHERE a.alert_type = 'source_refused' AND a.source_id = $1`, [id]);
        expect(resolutions).toHaveLength(1);
        expect(resolutions[0].resolution).not.toMatch(/null/);
    });

    it('L1: an escalation with headers followed by a header-less refusal leaves no stale headers on the alert', async () => {
        const H403 = [/hn\.algolia\.com/, { status: 403, headers: { server: 'nginx', 'x-rq': 'sea1' }, body: 'no' }];
        await collect([DENIED]);                         // opens: no headers
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([H403]);                           // escalates with headers
        let [alert] = await alertsOf('hacker_news');
        expect(alert.details).toMatchObject({ refusal_count: 2, response_headers: { server: 'nginx', 'x-rq': 'sea1' } });
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([DENIED]);                         // escalates without headers
        [alert] = await alertsOf('hacker_news');
        expect(alert.details).toMatchObject({ refusal_count: 3, response_headers: null, escalations: 2 });
        expect((await stateOf('hacker_news')).access_denied_headers).toBeNull();
    });

    it('L3: sourceRows() never returns the refusal headers', async () => {
        await collect([[/hn\.algolia\.com/, { status: 403, headers: { server: 'nginx', 'x-rq': 'sea1' }, body: 'no' }]]);
        for (const r of await sourceRows({ env: TEST_ENV, includeInactive: true })) {
            expect(r).not.toHaveProperty('access_denied_headers');
            expect(r).not.toHaveProperty('response_headers');
            expect(JSON.stringify(r)).not.toContain('sea1');
        }
    });
});

// Grumpy #4: the JS rule (refusal.js probationOver, used by the runner and
// /api/sources) is pinned to the SQL that actually counts
// (state.js PRIOR_COUNT_SQL): a new refusal is (probationOver ? 0 : n) + 1.
describe('probationOver pins PRIOR_COUNT_SQL (grumpy #4)', () => {
    it.each([
        ['refused', "access_denied_at = NOW() - interval '1 hour', refused_until = NOW() - interval '1 second', refusal_count = 3, probation_until = NULL"],
        ['on probation', "access_denied_at = NULL, refused_until = NULL, refusal_count = 3, probation_until = NOW() + interval '5 hours'"],
        ['probation over', "access_denied_at = NULL, refused_until = NULL, refusal_count = 3, probation_until = NOW() - interval '1 second'"],
        ['pre-062 row', "access_denied_at = NULL, refused_until = NULL, refusal_count = 3, probation_until = NULL"],
        ['clean', "access_denied_at = NULL, refused_until = NULL, refusal_count = 0, probation_until = NULL"],
    ])('%s', async (_label, sql) => {
        await collect([HN]);
        await setState('hacker_news', sql);
        const id = await idOf('hacker_news');
        const before = await state.getRefusal(id);
        const expected = (probationOver(before, Date.now()) ? 0 : before.refusal_count) + 1;
        const r = await state.recordRefusal(id, { kind: 'access_denied', status: 403 }, 'hacker_news');
        expect(r.refusal_count).toBe(expected);
    });
});

// Grumpy #3 (option b): the env reset clears a PROBATION too, with the same
// named approval and 'refusal_reset' gate event as a reset of the refused state.
describe('env reset during probation (grumpy #3)', () => {
    it('an approved SOURCE_<SLUG>_RESET at or after the last refusal clears the count; unapproved, older or future does not', async () => {
        await collect([DENIED]);
        await probeThenRefuseQuick();                    // refusal 2
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        await collect([HN]);                             // probe ok → probation, count 2
        expect(await stateOf('hacker_news')).toMatchObject({ access_denied_at: null, refusal_count: 2 });

        const resetAt = await resetDateAtRefusal('hacker_news', 'last_refused_at');
        const { GATE_APPROVED_BY: _drop, ...unapproved } = TEST_ENV;
        await nextPoll('hacker_news');
        await collect([HN], { ...unapproved, SOURCE_HACKER_NEWS_RESET: resetAt });
        expect((await stateOf('hacker_news')).refusal_count).toBe(2);
        await nextPoll('hacker_news');
        await collect([HN], { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: '2000-01-01' });
        expect((await stateOf('hacker_news')).refusal_count).toBe(2);
        // Grumpy final #1: a future date does not clear a probation either.
        await nextPoll('hacker_news');
        await collect([HN], { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: new Date(Date.now() + 3600 * 1000).toISOString() });
        expect((await stateOf('hacker_news')).refusal_count).toBe(2);
        expect(await dbAll(`SELECT 1 FROM source_gate_events WHERE event = 'refusal_reset'`)).toEqual([]);

        await nextPoll('hacker_news');
        const { transport } = await collect([HN], { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: resetAt });
        expect(transport.calls).toHaveLength(1);
        expect(await stateOf('hacker_news')).toMatchObject({ refusal_count: 0, probation_until: null, last_refused_at: null });
        expect(await dbAll(`SELECT event, actor, approved_by, reason FROM source_gate_events
                            WHERE slug = 'hacker_news' AND event = 'refusal_reset'`)).toEqual([{
            event: 'refusal_reset', actor: 'Test Operator 2026-09-29', approved_by: 'Test Operator 2026-09-29',
            reason: `SOURCE_HACKER_NEWS_RESET=${resetAt}` }]);
        // A later refusal (newer than the reset date) starts at 1 and is not reset by the stale date.
        await nextPoll('hacker_news');
        await collect([DENIED], { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: resetAt });
        const st = await stateOf('hacker_news');
        expect(st.refusal_count).toBe(1);
        expect(cooldownHours(st)).toBe(1);
    });
});

async function probeThenRefuseQuick() {
    await nextPoll('hacker_news');
    await endCooldown('hacker_news');
    await collect([HN]);
    await nextPoll('hacker_news');
    await collect([DENIED]);
}

function summaryReason({ summary }) {
    return summary.sources[0].reason;
}
