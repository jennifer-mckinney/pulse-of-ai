// tests/integration/collect.routeKillSwitch.test.js — migration 073: the
// per-ROUTE database kill switch, against the real test DB. It mirrors the
// source-level switch (collect.killswitch.test.js): `npm run source:disable
// -- <slug> --route <id> --reason "<why>"` stops that route before the next
// run (no request to it) while the source's other routes keep collecting;
// every change writes a source_gate_events row in the same transaction, with
// the named approval (GATE_APPROVED_BY) as actor; GET /api/sources reports
// each route's status and reason, and never lists an open route of a
// source (or a route) the database switch has turned off.

'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const db = require('../../src/db/connection');
const app = require('../../src/server');
const { runCollection } = require('../../src/collectors/runner');
const { sourceRows } = require('../../src/collectors/status');
const state = require('../../src/collectors/state');
const { recordGateTransitions } = require('../../src/collectors/governance');
const { evaluateSourceHealth } = require('../../src/collectors/source-health');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { main: adminMain } = require('../../scripts/source-admin');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

// Dated tomorrow (UTC): re-enabling needs an approval dated on or after the
// takedown and at most a day ahead (security review F6), and a run that
// crosses UTC midnight still passes.
// TODAY is the UTC date of the takedowns, as the CLI compares it.
const TODAY = new Date().toISOString().slice(0, 10);
const APPROVER = `Tess Tester ${new Date(Date.now() + 86400000).toISOString().slice(0, 10)}`;
const DB_REASON = why => `kill switch (database): route disabled since ${TODAY} by ${APPROVER} — ${why}`;
const FORUM = /discuss\.huggingface\.co/;
const HF_FIXTURES = [
    ['https://huggingface.co/api/daily_papers?limit=30', 'recorded/hf-daily-papers.json'],
    ['https://huggingface.co/blog/feed.xml', 'recorded/substack-importai.xml'],
    ['https://discuss.huggingface.co/robots.txt', 'recorded/hf-forum-robots.txt'],
    ['https://discuss.huggingface.co/latest.json', 'recorded/hf-forum-latest.json'],
];

async function collect(slug = 'hugging_face') {
    const transport = fixtureTransport(HF_FIXTURES);
    const summary = await runCollection({
        slugs: [slug], triggeredBy: 'test', env: TEST_ENV, transport, now: () => Date.parse(RECORDED_AT),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
        collectorCtx: { sleep: () => Promise.resolve() },
    });
    return { summary, transport, forumCalls: transport.calls.filter(c => FORUM.test(c.url)) };
}
const admin = async (argv, env = { GATE_APPROVED_BY: APPROVER }, extra = {}) => {
    const lines = [];
    const code = await adminMain(argv, { db, out: l => lines.push(l), err: l => lines.push(l), env, ...extra });
    return { code, text: lines.join('\n') };
};
const routeRows = () => db.dbAll(
    `SELECT ds.name AS slug, rs.route_id, rs.collection_disabled_at IS NOT NULL AS disabled,
            rs.collection_disabled_reason AS reason, rs.collection_disabled_by AS by
     FROM source_route_state rs JOIN data_sources ds ON ds.id = rs.source_id ORDER BY ds.name, rs.route_id`);
const gateEvents = (slug = 'hugging_face') => db.dbAll(
    `SELECT event, actor, approved_by, reason, routes FROM source_gate_events
     WHERE slug = $1 AND event <> 'seeded_active' ORDER BY occurred_at, id`, [slug]);
const row = async (slug, env = TEST_ENV) => (await sourceRows({ env })).find(x => x.slug === slug);
// A run claims its source for the poll interval; tests that run twice
// release the claim so the second run really fetches.
const resetPollClaim = () => db.dbRun('UPDATE source_collection_state SET last_attempt_at = NULL');
const sourceId = async (slug) => (await db.dbGet('SELECT id FROM data_sources WHERE name = $1', [slug])).id;

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('per-route database kill switch (migration 073)', () => {
    it('source:disable --route stops ONLY that route (no request to it); the other routes keep collecting', async () => {
        // Baseline: all three routes are asked.
        expect((await collect()).forumCalls.length).toBeGreaterThan(0);
        await resetPollClaim();   // the next run is not held back by the poll interval

        const r = await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms ban automated access']);
        // Security review F9: the operator is told what the takedown
        // publishes BEFORE it is made, then that it was made.
        expect(r).toEqual({ code: 0, text: expect.stringMatching(
            /^Published: the reason and the approver's name will be shown on GET \/api\/sources .*\nhugging_face\/forum-latest: disabled \(database route kill switch\)/) });
        expect(await routeRows()).toEqual([
            { slug: 'hugging_face', route_id: 'forum-latest', disabled: true, reason: 'forum terms ban automated access', by: APPROVER },
        ]);

        const { summary, transport, forumCalls } = await collect();
        expect(forumCalls).toHaveLength(0);
        expect(transport.calls.some(c => /huggingface\.co\/api\/daily_papers/.test(c.url))).toBe(true);
        expect(transport.calls.some(c => /huggingface\.co\/blog\/feed\.xml/.test(c.url))).toBe(true);
        expect(summary.sources[0]).toMatchObject({ slug: 'hugging_face', status: 'collecting', outcome: 'ok', disabledRoutes: ['forum-latest'] });
        // seed must not silently re-enable it.
        await seedSources();
        await resetPollClaim();
        const again = await collect();
        expect(again.summary.sources[0]).toMatchObject({ outcome: 'ok', disabledRoutes: ['forum-latest'] });
        expect(again.forumCalls).toHaveLength(0);
    });

    it('source:enable --route clears it and the route is asked again', async () => {
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'x']);
        const r = await admin(['enable', 'hugging_face', '--route', 'forum-latest', '--note', 'terms re-read']);
        expect(r).toEqual({ code: 0, text: expect.stringMatching(/^hugging_face\/forum-latest: database route kill switch cleared \(env kill switches/) });
        expect((await collect()).forumCalls.length).toBeGreaterThan(0);
        expect(await routeRows()).toEqual([{ slug: 'hugging_face', route_id: 'forum-latest', disabled: false, reason: null, by: null }]);
        // Clearing a route that is not disabled says so (and is still recorded).
        expect((await admin(['enable', 'hugging_face', '--route', 'blog-rss'])).text).toMatch(/cleared \(it was not set\)/);
        // Grumpy #8: the record says nothing changed.
        expect((await gateEvents()).pop()).toMatchObject({
            event: 'route_enabled', routes: ['blog-rss'], reason: 'database route kill switch cleared (it was not set: no change)',
        });
    });

    it('records every change as a route event naming the one route, with the named approval as actor and approver', async () => {
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']);
        await admin(['enable', 'hugging_face', '--route', 'forum-latest']);
        expect(await gateEvents()).toEqual([
            { event: 'route_disabled', actor: APPROVER, approved_by: APPROVER, reason: 'forum terms', routes: ['forum-latest'] },
            { event: 'route_enabled', actor: APPROVER, approved_by: APPROVER, reason: 'database route kill switch cleared', routes: ['forum-latest'] },
        ]);
    });

    it('refuses without a valid named approval or with an unknown route, changing nothing', async () => {
        for (const env of [{}, { GATE_APPROVED_BY: '' }, { GATE_APPROVED_BY: 'tester' }, { GATE_APPROVED_BY: 'Name 2026-09-30' }]) {
            for (const argv of [['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'x'],
                ['enable', 'hugging_face', '--route', 'forum-latest']]) {
                expect(await admin(argv, env)).toEqual({ code: 2, text: expect.stringMatching(/needs a named approval.*Nothing was changed/) });
            }
        }
        for (const route of ['forum', 'topic-projects', 'FORUM-LATEST']) {
            expect((await admin(['disable', 'hugging_face', '--route', route, '--reason', 'x'])).code).toBe(2);
        }
        expect(await routeRows()).toEqual([]);
        expect(await gateEvents()).toEqual([]);
    });

    // Security L6 / grumpy L16: the switch and its event are ONE transaction.
    it('a failed gate-event write rolls the route switch back (and vice versa)', async () => {
        const failing = { recordGateEvent: async () => { throw new Error('event insert failed'); } };
        const r = await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'x'], undefined, failing);
        expect(r).toEqual({ code: 2, text: expect.stringMatching(/database error — event insert failed/) });
        expect(await routeRows()).toEqual([]);
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'x']);
        expect((await admin(['enable', 'hugging_face', '--route', 'forum-latest'], undefined, failing)).code).toBe(2);
        expect((await routeRows())[0].disabled).toBe(true);   // still disabled
        const brokenState = { ...state, setRouteKillSwitch: async () => { throw new Error('switch failed'); } };
        expect((await admin(['enable', 'hugging_face', '--route', 'forum-latest'], undefined, { state: brokenState })).code).toBe(2);
        expect((await gateEvents()).map(e => e.event)).toEqual(['route_disabled']);
    });

    it('the database rejects a route event without its named approver or naming other than one route', async () => {
        const id = await sourceId('hugging_face');
        const insert = (actor, approved, routes) => db.dbRun(
            `INSERT INTO source_gate_events (source_id, slug, event, actor, approved_by, routes)
             VALUES ($1, 'hugging_face', 'route_disabled', $2, $3, $4::text[])`, [id, actor, approved, routes]);
        for (const [actor, approved] of [['tester', null], ['tester', 'tester'], [APPROVER, 'Other Person 2026-09-30']]) {
            await expect(insert(actor, approved, ['forum-latest'])).rejects.toThrow(/source_gate_events_named_approval/);
        }
        for (const routes of [null, [], ['forum-latest', 'blog-rss'], ['Forum Latest']]) {
            await expect(insert(APPROVER, APPROVER, routes)).rejects.toThrow(/source_gate_events_route_event_one_route/);
        }
        await insert(APPROVER, APPROVER, ['forum-latest']);
        // ...and a disabled route row without why and who.
        await expect(db.dbRun(`INSERT INTO source_route_state (source_id, route_id, collection_disabled_at, collection_disabled_reason, collection_disabled_by)
                               VALUES ($1, 'forum-latest', NOW(), ' ', $2)`, [id, APPROVER])).rejects.toThrow(/source_route_state_disabled_named/);
        await expect(db.dbRun(`INSERT INTO source_route_state (source_id, route_id, collection_disabled_at, collection_disabled_reason, collection_disabled_by)
                               VALUES ($1, 'forum-latest', NOW(), 'x', 'tester')`, [id])).rejects.toThrow(/source_route_state_disabled_named/);
        await expect(db.dbRun(`INSERT INTO source_route_state (source_id, route_id) VALUES ($1, '../forum')`, [id]))
            .rejects.toThrow(/source_route_state_route_id/);
    });

    it('a source whose every route is switched off is skipped as disabled, before any request', async () => {
        for (const route of ['daily-papers', 'blog-rss', 'forum-latest']) {
            await admin(['disable', 'hugging_face', '--route', route, '--reason', 'all off']);
        }
        const { summary, transport } = await collect();
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({
            outcome: 'skipped', status: 'disabled', reason: expect.stringMatching(/^every route that would run is switched off by a route kill switch/),
        });
    });
});

describe('per-route switch: review hardening', () => {
    // Security review F6: a standing approval from before a takedown cannot undo it.
    it('re-enabling needs an approval dated on or after the takedown (route and source); nothing changes otherwise', async () => {
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']);
        await admin(['disable', 'gitlab', '--reason', 'publisher asked']);
        const stale = { GATE_APPROVED_BY: 'Tess Tester 2000-01-01' };
        const future = { GATE_APPROVED_BY: 'Tess Tester 2099-12-31' };   // a standing far-future date
        for (const argv of [['enable', 'hugging_face', '--route', 'forum-latest'], ['enable', 'gitlab']]) {
            const r = await admin(argv, stale);
            expect(r.code).toBe(2);
            expect(r.text).toContain(`was disabled on ${TODAY} (UTC) and GATE_APPROVED_BY is dated 2000-01-01`);
            expect(r.text).toMatch(/Nothing was changed\.$/);
            expect(await admin(argv, future)).toEqual({ code: 2,
                text: expect.stringMatching(/needs a named approval dated today: GATE_APPROVED_BY is dated 2099-12-31, in the future.*Nothing was changed\.$/) });
        }
        expect((await routeRows())[0].disabled).toBe(true);
        expect((await db.dbGet(`SELECT collection_disabled_at IS NOT NULL AS off FROM data_sources WHERE name = 'gitlab'`)).off).toBe(true);
        expect((await gateEvents()).map(e => e.event)).toEqual(['route_disabled']);
        expect((await gateEvents('gitlab')).map(e => e.event)).toEqual(['disabled']);
        // A disable needs no newer date, and an approval dated today re-enables.
        expect((await admin(['enable', 'hugging_face', '--route', 'forum-latest'])).code).toBe(0);
        expect((await admin(['enable', 'gitlab'])).code).toBe(0);
    });

    // Security review F3 / grumpy #1: a recorded takedown of a route the
    // registry no longer has holds the whole source, and can be cleared.
    it('a database row naming a route the registry no longer has holds the whole source until source:enable clears it', async () => {
        const id = await sourceId('hugging_face');
        await db.dbRun(`INSERT INTO source_route_state (source_id, route_id, collection_disabled_at, collection_disabled_reason, collection_disabled_by)
                        VALUES ($1, 'old-forum', NOW(), 'renamed route', $2)`, [id, APPROVER]);
        const { summary, transport } = await collect();
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'disabled',
            reason: expect.stringMatching(/^kill switch \(database\) names route old-forum, which is not a route of hugging_face/) });
        expect(await row('hugging_face')).toMatchObject({ status: 'disabled', open_routes: [] });
        // Only an id that is switched off may be cleared this way.
        expect(await admin(['enable', 'hugging_face', '--route', 'other-forum']))
            .toEqual({ code: 2, text: expect.stringMatching(/unknown route 'other-forum' of hugging_face .*no switched-off route has that id/) });
        expect((await admin(['enable', 'hugging_face', '--route', 'old-forum'])).code).toBe(0);
        expect((await gateEvents()).map(e => [e.event, e.routes])).toEqual([['route_enabled', ['old-forum']]]);
        expect((await row('hugging_face')).status).toBe('collecting');
    });

    // Security review F7: a takedown issued mid-run applies before the next route.
    it('a route switched off while the source\'s earlier routes run is not fetched in that run', async () => {
        const id = await sourceId('hugging_face');
        const base = fixtureTransport(HF_FIXTURES);
        let killed = false;
        const transport = async (url, init) => {
            if (!killed && /daily_papers/.test(url)) {
                killed = true;
                await state.setRouteKillSwitch(id, 'forum-latest', true, { reason: 'mid-run takedown', by: APPROVER });
            }
            return base(url, init);
        };
        transport.calls = base.calls;
        const summary = await runCollection({
            slugs: ['hugging_face'], triggeredBy: 'test', env: TEST_ENV, transport, now: () => Date.parse(RECORDED_AT),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
            collectorCtx: { sleep: () => Promise.resolve() },
        });
        expect(killed).toBe(true);
        expect(base.calls.filter(c => FORUM.test(c.url))).toHaveLength(0);
        expect(base.calls.some(c => /blog\/feed\.xml/.test(c.url))).toBe(true);   // still open: fetched
        expect(summary.sources[0].skippedRoutes).toEqual([
            { route: 'forum-latest', reason: 'kill switch (database): the route was disabled during this run' },
        ]);
    });

    // Grumpy #7: env-killed routes are named in the run summary too.
    it('the run summary names routes switched off by env', async () => {
        const transport = fixtureTransport(HF_FIXTURES);
        const summary = await runCollection({
            slugs: ['hugging_face'], triggeredBy: 'test', env: { ...TEST_ENV, COLLECTORS_DISABLED_ROUTES: 'hugging_face/forum-latest' },
            transport, now: () => Date.parse(RECORDED_AT),
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
            collectorCtx: { sleep: () => Promise.resolve() },
        });
        expect(summary.sources[0]).toMatchObject({ outcome: 'ok', disabledRoutes: ['forum-latest'] });
        expect(transport.calls.filter(c => FORUM.test(c.url))).toHaveLength(0);
    });

    it('the database refuses a reason with control characters', async () => {
        const id = await sourceId('hugging_face');
        await expect(db.dbRun(`INSERT INTO source_route_state (source_id, route_id, collection_disabled_at, collection_disabled_reason, collection_disabled_by)
                               VALUES ($1, 'forum-latest', NOW(), E'line one\nline two', $2)`, [id, APPROVER]))
            .rejects.toThrow(/source_route_state_reason_one_line/);
    });
});

describe('GET /api/sources: per-route status and reason (migration 073)', () => {
    // Grumpy #11: a refused source's routes say why they are not collecting.
    it('a source in its refusal cooldown lists no open route, and its routes give the refusal', async () => {
        const id = await sourceId('hugging_face');
        await state.claim(id, 0, 150000);
        await db.dbRun(`UPDATE source_collection_state SET access_denied_at = NOW(), access_denied_status = 403,
                        access_denied_kind = 'access_denied', refused_until = NOW() + INTERVAL '1 hour', refusal_count = 1
                        WHERE source_id = $1`, [id]);
        const hf = await row('hugging_face');
        expect(hf).toMatchObject({ status: 'blocked_by_source', open_routes: [] });
        expect(hf.routes.every(r => r.status === 'closed' && r.reason === hf.status_reason)).toBe(true);
    });

    it('reports the disabled route with its reason; open_routes never lists it', async () => {
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']);
        const hf = await row('hugging_face');
        expect(hf).toMatchObject({
            status: 'collecting', open_routes: ['daily-papers', 'blog-rss'], disabled_routes: ['forum-latest'],
            status_reason: expect.stringContaining(`; route disabled: forum-latest (${DB_REASON('forum terms')})`),
        });
        expect(hf.routes).toEqual([
            { id: 'daily-papers', status: 'open', reason: 'collecting' },
            { id: 'blog-rss', status: 'open', reason: 'collecting' },
            { id: 'forum-latest', status: 'disabled', reason: DB_REASON('forum terms') },
        ]);
        // Through HTTP (the server's own env): the route's state is served.
        const res = await request(app).get('/api/sources');
        expect(res.status).toBe(200);
        const served = res.body.find(x => x.slug === 'hugging_face');
        expect(served.disabled_routes).toEqual(['forum-latest']);
        expect(served.routes.find(r => r.id === 'forum-latest')).toEqual(
            { id: 'forum-latest', status: 'disabled', reason: DB_REASON('forum terms') });
        expect(served.open_routes).not.toContain('forum-latest');
    });

    // The bug this PR fixes: status.js listed open_routes for a source the
    // database kill switch had disabled.
    it('a source disabled by the DATABASE kill switch lists no open route, and its routes say why', async () => {
        expect((await row('hugging_face')).open_routes).toEqual(['daily-papers', 'blog-rss', 'forum-latest']);
        await admin(['disable', 'hugging_face', '--reason', 'stop all HF now']);
        const hf = await row('hugging_face');
        expect(hf).toMatchObject({ status: 'disabled', open_routes: [], online: false });
        expect(hf.routes.map(r => [r.id, r.status, r.reason])).toEqual([
            ['daily-papers', 'closed', 'the source is disabled'],
            ['blog-rss', 'closed', 'the source is disabled'],
            ['forum-latest', 'closed', 'the source is disabled'],
        ]);
        // A route disabled on its own stays reported as disabled, with its reason.
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']);
        expect((await row('hugging_face')).routes.find(r => r.id === 'forum-latest').status).toBe('disabled');
        // Re-enabling the source leaves the route switch in place.
        await admin(['enable', 'hugging_face']);
        expect(await row('hugging_face')).toMatchObject({ status: 'collecting', open_routes: ['daily-papers', 'blog-rss'] });
    });

    it('every route switched off: the source is reported disabled with no open route', async () => {
        await admin(['disable', 'hacker_news', '--route', 'algolia-search', '--reason', 'off']);
        expect(await row('hacker_news')).toMatchObject({
            status: 'disabled', open_routes: [], disabled_routes: ['algolia-search'], online: false,
            status_reason: expect.stringMatching(/^every route that would run is switched off by a route kill switch — algolia-search/),
        });
    });

    it('the env switch (COLLECTORS_DISABLED_ROUTES) is reported the same way', async () => {
        const hf = await row('gitlab', { ...TEST_ENV, COLLECTORS_DISABLED_ROUTES: 'gitlab/forum-latest' });
        expect(hf).toMatchObject({ status: 'collecting', open_routes: ['topic-projects'], disabled_routes: ['forum-latest'] });
        expect(hf.routes.find(r => r.id === 'forum-latest').reason).toBe('kill switch COLLECTORS_DISABLED_ROUTES lists gitlab/forum-latest');
    });
});

describe('the governance log and the health evaluator count the route switch', () => {
    // Security review F5 / grumpy #2 and #10: a change of an open gate's
    // routes is recorded, by database or by env.
    it('the scheduler records a change of an open gate\'s routes (database and env)', async () => {
        await seedSources({ actor: 'test-seed' });
        await recordGateTransitions({ env: TEST_ENV });
        const opened = async slug => (await db.dbAll(`SELECT routes FROM source_gate_events WHERE slug = $1 AND event = 'gate_opened'
                                                      ORDER BY occurred_at, id`, [slug])).map(e => e.routes);
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']);
        expect(await recordGateTransitions({ env: TEST_ENV }))
            .toEqual([{ slug: 'hugging_face', event: 'gate_opened', gate_status: 'collecting', approved_by: null }]);
        expect(await opened('hugging_face')).toEqual([['daily-papers', 'blog-rss', 'forum-latest'], ['daily-papers', 'blog-rss']]);
        expect(await recordGateTransitions({ env: TEST_ENV })).toEqual([]);   // unchanged: nothing new

        const envOff = { ...TEST_ENV, COLLECTORS_DISABLED_ROUTES: 'gitlab/forum-latest' };
        expect((await recordGateTransitions({ env: envOff })).map(e => e.slug)).toEqual(['gitlab']);
        expect((await recordGateTransitions({ env: TEST_ENV })).map(e => e.slug)).toEqual(['gitlab']);   // and back on
        expect(await opened('gitlab')).toEqual([['topic-projects', 'forum-latest'], ['topic-projects'], ['topic-projects', 'forum-latest']]);
    });

    // A gate_opened written before migration 056 has no routes (NULL): the
    // next run records ONE baseline with the routes, then compares normally,
    // so a later route change is still recorded.
    it('a gate_opened with no recorded routes (pre-056) gets one baseline, then route changes are recorded', async () => {
        await seedSources({ actor: 'test-seed' });
        await recordGateTransitions({ env: TEST_ENV });
        await db.dbRun(`INSERT INTO source_gate_events (source_id, slug, event, gate_status, actor)
                        VALUES ($1, 'hugging_face', 'gate_opened', 'collecting', 'worker scheduler (runtime env)')`, [await sourceId('hugging_face')]);
        expect((await recordGateTransitions({ env: TEST_ENV })).map(e => e.slug)).toEqual(['hugging_face']);   // the baseline
        expect(await recordGateTransitions({ env: TEST_ENV })).toEqual([]);
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']);
        expect((await recordGateTransitions({ env: TEST_ENV })).map(e => e.slug)).toEqual(['hugging_face']);
    });

    // Copilot: an enable of a route with no row still serializes with a
    // concurrent disable (a cleared row is created, then locked).
    it('enabling a route that has no row leaves a cleared row behind and records no change', async () => {
        expect((await admin(['enable', 'hugging_face', '--route', 'daily-papers'])).code).toBe(0);
        expect(await routeRows()).toEqual([{ slug: 'hugging_face', route_id: 'daily-papers', disabled: false, reason: null, by: null }]);
        // A far-future approval is refused even when nothing is switched off.
        expect((await admin(['enable', 'hugging_face', '--route', 'daily-papers'], { GATE_APPROVED_BY: 'Tess Tester 2099-12-31' })).code).toBe(2);
        expect((await admin(['enable', 'npr'], { GATE_APPROVED_BY: 'Tess Tester 2099-12-31' })).code).toBe(2);
    });

    it('the scheduler records a gate closing when every route is switched off, and its reopening', async () => {
        await seedSources({ actor: 'test-seed' });
        await recordGateTransitions({ env: TEST_ENV });
        // hacker_news has one route: switching it off closes the gate.
        await admin(['disable', 'hacker_news', '--route', 'algolia-search', '--reason', 'off']);
        const closed = await recordGateTransitions({ env: TEST_ENV });
        expect(closed).toEqual([{ slug: 'hacker_news', event: 'gate_closed', gate_status: 'disabled', approved_by: null }]);
        await admin(['enable', 'hacker_news', '--route', 'algolia-search']);
        expect(await recordGateTransitions({ env: TEST_ENV }))
            .toEqual([{ slug: 'hacker_news', event: 'gate_opened', gate_status: 'collecting', approved_by: null }]);
    });

    it('a source with every route switched off raises no health alert, and its open alert is resolved', async () => {
        const npr = await sourceId('npr');
        await state.claim(npr, 0, 150000);
        await db.dbRun(`UPDATE source_collection_state SET access_denied_at = NOW(), access_denied_status = 403, access_denied_kind = 'access_denied'
                        WHERE source_id = $1`, [npr]);
        const env = { COLLECTOR_CONTACT_URL: 'https://example.org/contact' };
        await evaluateSourceHealth({ env });
        const open = () => db.dbAll('SELECT alert_type FROM alert_events WHERE resolved_at IS NULL AND source_id = $1', [npr]);
        expect(await open()).toEqual([{ alert_type: 'source_refused' }]);
        await admin(['disable', 'npr', '--route', 'technology-rss', '--reason', 'off']);
        await evaluateSourceHealth({ env });
        expect(await open()).toEqual([]);
    });
});

describe('supervised dry run reads the route switch with the source state (one read, writes nothing)', () => {
    const collectCli = require('../../scripts/collect');

    it('readGovernance returns the disabled routes', async () => {
        expect((await collectCli.readGovernance('hugging_face')).route_kills).toEqual([]);
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']);
        const before = await db.dbGet('SELECT COUNT(*)::int AS n FROM source_collection_state');
        const gov = await collectCli.readGovernance('hugging_face');
        expect(gov.route_kills).toEqual([
            { route_id: 'forum-latest', disabled_at: expect.any(String), reason: 'forum terms', by: APPROVER },
        ]);
        expect(await db.dbGet('SELECT COUNT(*)::int AS n FROM source_collection_state')).toEqual(before);
    });

    it('the supervised run asks no disabled route', async () => {
        await admin(['disable', 'hugging_face', '--route', 'forum-latest', '--reason', 'forum terms']);
        const transport = fixtureTransport(HF_FIXTURES);
        const r = await collectCli.supervisedRun({ slug: 'hugging_face', env: TEST_ENV, transport, out: () => {} });
        expect(r.routes.map(x => x.route)).toEqual(['daily-papers', 'blog-rss']);
        expect(transport.calls.filter(c => FORUM.test(c.url))).toHaveLength(0);
    });
});

describe('migrations 073 and 074', () => {
    const sql = n => fs.readFileSync(path.join(__dirname, `../../src/db/migrations/${n}`), 'utf8');
    const SQL_056 = sql('056_named_gate_approval.sql');
    const SQL_073 = sql('073_source_route_kill_switch.sql');
    const SQL_074 = sql('074_route_kill_switch_hardening.sql');
    const run = text => db.dbTransaction(c => c.query(text));
    const def = name => db.dbGet(`SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint WHERE conname = $1`, [name]);
    /** The exact event list of a CHECK (its '{a,b}'::text[] rendering). */
    const list = async (name) => {
        const m = (await def(name)).def.match(/'\{([^}]*)\}'::text\[\]/);
        return m ? m[1].split(',').sort() : null;
    };
    const EVENTS = ['disabled', 'enabled', 'gate_closed', 'gate_opened', 'refusal_reset', 'route_disabled', 'route_enabled', 'seeded_active'];
    const NAMED = ['disabled', 'enabled', 'refusal_reset', 'route_disabled', 'route_enabled'];
    // Leaves the schema exactly as the migration runner left it.
    const restore = async () => { await run(SQL_056); await run(SQL_073); await run(SQL_074); };

    it('re-run cleanly, with exact event lists and NOT VALID kept on the approval CHECK', async () => {
        for (const text of [SQL_073, SQL_074, SQL_073, SQL_074]) await run(text);   // idempotent, in any order
        expect(await list('source_gate_events_event_check')).toEqual(EVENTS);
        expect(await list('source_gate_events_named_approval')).toEqual(NAMED);
        expect((await def('source_gate_events_named_approval')).convalidated).toBe(false);
        // Exactly one event CHECK (the old one is replaced, not duplicated).
        expect(await db.dbGet(`SELECT COUNT(*)::int AS n FROM pg_constraint WHERE conrelid = 'source_gate_events'::regclass
                               AND contype = 'c' AND pg_get_constraintdef(oid) ~ '^CHECK \\(\\(event = ANY'`)).toEqual({ n: 1 });
    });

    it('074 keeps an event another migration added meanwhile (digits included) in both CHECKs', async () => {
        await run(`ALTER TABLE source_gate_events DROP CONSTRAINT source_gate_events_event_check;
                   ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_event_check
                       CHECK (event IN ('enabled', 'disabled', 'seeded_active', 'gate_opened', 'gate_closed', 'refusal_reset',
                                        'route_disabled', 'route_enabled', 'zz_parallel_9'));
                   ALTER TABLE source_gate_events DROP CONSTRAINT source_gate_events_named_approval;
                   ALTER TABLE source_gate_events ADD CONSTRAINT source_gate_events_named_approval
                       CHECK (event NOT IN ('enabled', 'disabled', 'refusal_reset', 'zz_parallel_9') OR actor = approved_by) NOT VALID;`);
        await run(SQL_074);
        expect(await list('source_gate_events_event_check')).toEqual([...EVENTS, 'zz_parallel_9'].sort());
        expect(await list('source_gate_events_named_approval')).toEqual([...NAMED, 'zz_parallel_9'].sort());
        await restore();
        expect(await list('source_gate_events_event_check')).toEqual(EVENTS);
    });

    it('074 stops (and changes nothing) when an event list cannot be read', async () => {
        await expect(run(`ALTER TABLE source_gate_events ADD CONSTRAINT zz_unreadable
                              CHECK (event = ANY (string_to_array('a,b', ','))) NOT VALID;
                          ${SQL_074}`)).rejects.toThrow(/migration 074: cannot read the event list of constraint zz_unreadable/);
        expect(await def('zz_unreadable')).toBeUndefined();
        expect(await list('source_gate_events_event_check')).toEqual(EVENTS);
    });

    it('re-applying 073 and 074 restores the route events after migration 056 is re-run over them', async () => {
        await run(SQL_056);
        expect(await list('source_gate_events_event_check')).toBeNull();   // 056 renders ARRAY[...]: no route events
        expect((await def('source_gate_events_event_check')).def).not.toContain('route_disabled');
        await run(SQL_073);
        await run(SQL_074);
        expect(await list('source_gate_events_event_check')).toEqual(EVENTS);
        expect(await list('source_gate_events_named_approval')).toEqual(NAMED);
    });
});
