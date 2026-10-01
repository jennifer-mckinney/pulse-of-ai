// tests/integration/collect.killswitch.test.js — F10-10: the database kill
// switch stops a source before its next run, in any process, and the API
// reports it; env changes need a recreate, this does not.

'use strict';

const db = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { sourceRows } = require('../../src/collectors/status');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { main: adminMain } = require('../../scripts/source-admin');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

async function collect() {
    const transport = fixtureTransport([[/hn\.algolia\.com/, 'recorded/hn-algolia.json']]);
    const summary = await runCollection({
        slugs: ['hacker_news'], triggeredBy: 'test', env: TEST_ENV, transport, now: () => Date.parse(RECORDED_AT),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
        collectorCtx: { sleep: () => Promise.resolve() },
    });
    return { summary, transport };
}
// PR #22 decision G5 / security L6: the actor is the named approval. It is
// dated today: re-enabling needs an approval dated on or after the takedown
// (security review F6, scripts/source-admin.js).
const APPROVER = `Tess Tester ${new Date().toISOString().slice(0, 10)}`;
const admin = async (argv, env = { GATE_APPROVED_BY: APPROVER }, extra = {}) => {
    const lines = [];
    const code = await adminMain(argv, { db, out: l => lines.push(l), err: l => lines.push(l), env, ...extra });
    return { code, text: lines.join('\n') };
};
const killSwitch = async () => db.dbGet(`SELECT collection_disabled_at, collection_disabled_by FROM data_sources WHERE name = 'hacker_news'`);
const gateEvents = async () => db.dbAll(`SELECT event, actor, approved_by FROM source_gate_events
                                         WHERE slug = 'hacker_news' AND event <> 'seeded_active' ORDER BY occurred_at, id`);

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('database kill switch (F10-10)', () => {
    it('source:disable stops the next run (no request) and the API reports disabled with the reason', async () => {
        const r = await admin(['disable', 'hacker_news', '--reason', 'takedown request 2026-09-29']);
        expect(r).toEqual({ code: 0, text: expect.stringMatching(/disabled \(database kill switch\)/) });
        const { summary, transport } = await collect();
        expect(transport.calls).toHaveLength(0);
        expect(summary.sources[0]).toMatchObject({ outcome: 'skipped', status: 'disabled',
            reason: `kill switch (database): disabled by ${APPROVER} — takedown request 2026-09-29` });
        const row = (await sourceRows({ env: TEST_ENV })).find(x => x.slug === 'hacker_news');
        expect(row).toMatchObject({ status: 'disabled', online: false,
            status_reason: `kill switch (database): disabled by ${APPROVER} — takedown request 2026-09-29` });
        // seed must not silently re-enable it.
        await seedSources();
        expect((await collect()).transport.calls).toHaveLength(0);
    });

    it('source:enable clears it and the source collects again', async () => {
        await admin(['disable', 'hacker_news', '--reason', 'x']);
        expect((await admin(['enable', 'hacker_news'])).code).toBe(0);
        const { summary, transport } = await collect();
        expect(transport.calls.length).toBeGreaterThan(0);
        expect(summary.sources[0].outcome).toBe('ok');
        expect((await sourceRows({ env: TEST_ENV })).find(x => x.slug === 'hacker_news').collection_disabled_at).toBeNull();
    });

    it('disable requires --reason; unknown commands and slugs are usage errors', async () => {
        expect((await admin(['disable', 'hacker_news'])).text).toMatch(/needs --reason/);
        expect((await admin(['disable', 'hacker_news'])).code).toBe(2);
        expect((await admin(['frobnicate', 'hacker_news'])).code).toBe(2);
        expect((await admin(['enable', 'nope'])).code).toBe(2);
    });

    // PR #22 decision G5 / security L6: no self-asserted actor ($USER).
    it('refuses every command without a valid named approval, changing nothing', async () => {
        for (const env of [{}, { GATE_APPROVED_BY: '' }, { GATE_APPROVED_BY: 'tester' }, { GATE_APPROVED_BY: '<your name> 2026-09-29' },
            { GATE_APPROVED_BY: 'Tess 2026-13-01' }, { GATE_APPROVED_BY: 'Name 2026-09-29' }]) {
            for (const argv of [['disable', 'hacker_news', '--reason', 'x'], ['enable', 'hacker_news'], ['reset', 'hacker_news']]) {
                const r = await admin(argv, env);
                expect(r).toEqual({ code: 2, text: expect.stringMatching(/needs a named approval: set GATE_APPROVED_BY="Name YYYY-MM-DD".*Nothing was changed/) });
            }
        }
        expect((await killSwitch()).collection_disabled_at).toBeNull();
        expect(await gateEvents()).toEqual([]);
    });

    it('records the named approval as actor and approver of disable / enable', async () => {
        await admin(['disable', 'hacker_news', '--reason', 'x']);
        expect((await killSwitch()).collection_disabled_by).toBe(APPROVER);
        await admin(['enable', 'hacker_news']);
        expect(await gateEvents()).toEqual([
            { event: 'disabled', actor: APPROVER, approved_by: APPROVER },
            { event: 'enabled', actor: APPROVER, approved_by: APPROVER },
        ]);
    });

    // Security L6 / grumpy L16: the kill switch and its event are ONE transaction.
    it('a failed gate-event write rolls the kill switch back (and vice versa)', async () => {
        const failing = { recordGateEvent: async () => { throw new Error('event insert failed'); } };
        const r = await admin(['disable', 'hacker_news', '--reason', 'x'], undefined, failing);
        expect(r).toEqual({ code: 2, text: expect.stringMatching(/database error — event insert failed/) });
        expect((await killSwitch()).collection_disabled_at).toBeNull();
        await admin(['disable', 'hacker_news', '--reason', 'x']);
        expect((await admin(['enable', 'hacker_news'], undefined, failing)).code).toBe(2);
        expect((await killSwitch()).collection_disabled_at).not.toBeNull();   // still disabled
        const state = { ...require('../../src/collectors/state'), setDbKillSwitch: async () => { throw new Error('switch failed'); } };
        expect((await admin(['enable', 'hacker_news'], undefined, { state })).code).toBe(2);
        expect((await gateEvents()).map(e => e.event)).toEqual(['disabled']);
    });

    it('the database rejects an operator event without a named approver (migration 056)', async () => {
        const { id } = await db.dbGet(`SELECT id FROM data_sources WHERE name = 'hacker_news'`);
        for (const [actor, approved] of [['tester', null], ['tester', 'tester'], [APPROVER, 'Other Person 2026-09-29']]) {
            await expect(db.dbRun(`INSERT INTO source_gate_events (source_id, slug, event, actor, approved_by)
                                   VALUES ($1, 'hacker_news', 'disabled', $2, $3)`, [id, actor, approved]))
                .rejects.toThrow(/source_gate_events_named_approval/);
        }
    });
});

// PR #22 security M2: `npm run collect -- --supervised` reads the SAME
// database state (read-only) and refuses a disabled or cooling-down source
// before any request.
describe('supervised dry run honours the database gates (security M2)', () => {
    const collectCli = require('../../scripts/collect');
    const supervised = async () => {
        const transport = fixtureTransport([[/hn\.algolia\.com/, 'recorded/hn-algolia.json']]);
        const err = await collectCli.supervisedRun({ slug: 'hacker_news', env: TEST_ENV, transport, out: () => {} })
            .then(() => null, e => e);
        return { err, transport };
    };

    it('readGovernance returns the kill switch and refusal columns, and writes nothing', async () => {
        const before = await db.dbGet('SELECT COUNT(*)::int AS n FROM source_collection_state');
        const gov = await collectCli.readGovernance('hacker_news');
        expect(gov).toMatchObject({ disabled_at: null, access_denied_at: null, refused_until: null });
        expect(await collectCli.readGovernance('no_such_source')).toBeNull();
        expect(await db.dbGet('SELECT COUNT(*)::int AS n FROM source_collection_state')).toEqual(before);
    });

    it('refuses a source disabled with source:disable (no request)', async () => {
        await admin(['disable', 'hacker_news', '--reason', 'terms review']);
        const { err, transport } = await supervised();
        expect(err).toBeInstanceOf(collectCli.UsageError);
        // G5: the kill switch records the named approval as its actor.
        expect(err.message).toContain(`disabled by the database kill switch (by ${APPROVER}) — terms review`);
        expect(transport.calls).toHaveLength(0);
    });

    it('refuses a source inside its refusal cooldown (no request); a clean source runs', async () => {
        const { id } = await db.dbGet(`SELECT id FROM data_sources WHERE name = 'hacker_news'`);
        await db.dbRun(
            `INSERT INTO source_collection_state (source_id, access_denied_at, access_denied_status, refused_until, refusal_count)
             VALUES ($1, NOW(), 403, NOW() + INTERVAL '1 hour', 1)
             ON CONFLICT (source_id) DO UPDATE SET access_denied_at = NOW(), access_denied_status = 403,
                 refused_until = NOW() + INTERVAL '1 hour', refusal_count = 1`, [id]);
        const cooling = await supervised();
        expect(cooling.err.message).toMatch(/refusal cooldown: the source refused access \(HTTP 403\)/);
        expect(cooling.transport.calls).toHaveLength(0);
        await db.dbRun(`UPDATE source_collection_state SET access_denied_at = NULL, refused_until = NULL WHERE source_id = $1`, [id]);
        const clean = await supervised();
        expect(clean.err).toBeNull();
        expect(clean.transport.calls.length).toBeGreaterThan(0);
    });
});
