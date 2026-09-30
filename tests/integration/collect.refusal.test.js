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

    it('a successful probe clears the state and resolves the alert', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        await endCooldown('hacker_news');
        const { summary } = await collect([HN]);
        expect(summary.sources[0].outcome).toBe('ok');
        expect(await stateOf('hacker_news')).toMatchObject({ access_denied_at: null, refused_until: null, refusal_count: 0 });
        const [alert] = await alertsOf('hacker_news');
        expect(alert.resolved_at).not.toBeNull();
        expect(alert.details.resolution).toMatch(/probe/);
        expect((await rowOf('hacker_news')).status).toBe('collecting');
    });

    it('an env reset newer than the refusal clears it and the source is asked again; an older one does not', async () => {
        await collect([DENIED]);
        await nextPoll('hacker_news');
        const old = { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: '2000-01-01' };
        expect((await collect([HN], old)).transport.calls).toHaveLength(0);
        const fresh = { ...TEST_ENV, SOURCE_HACKER_NEWS_RESET: new Date(Date.now() + 1000).toISOString() };
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
        const env = { ...unapproved, SOURCE_HACKER_NEWS_RESET: new Date(Date.now() + 1000).toISOString() };
        const { summary, transport } = await collect([HN], env);
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'blocked_by_source',
            reason: expect.stringMatching(/SOURCE_HACKER_NEWS_RESET is set but awaiting named approval/) });
        expect((await stateOf('hacker_news')).refusal_count).toBe(1);
        expect(await db.dbAll(`SELECT 1 FROM source_gate_events WHERE event = 'refusal_reset'`)).toEqual([]);
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

    it('an ordinary failure (HTTP 500) is not a refusal', async () => {
        await collect([[/hn\.algolia\.com/, { status: 500, body: 'oops' }]]);
        expect(await stateOf('hacker_news')).toMatchObject({ access_denied_at: null, refusal_count: 0 });
        expect(await alertsOf('hacker_news')).toHaveLength(0);
    });
});
