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
const admin = async (argv) => {
    const lines = [];
    const code = await adminMain(argv, { db, out: l => lines.push(l), err: l => lines.push(l), who: 'tester' });
    return { code, text: lines.join('\n') };
};

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
            reason: 'kill switch (database): disabled by tester — takedown request 2026-09-29' });
        const row = (await sourceRows({ env: TEST_ENV })).find(x => x.slug === 'hacker_news');
        expect(row).toMatchObject({ status: 'disabled', online: false,
            status_reason: 'kill switch (database): disabled by tester — takedown request 2026-09-29' });
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
        expect(err.message).toMatch(/disabled by the database kill switch \(by tester\) — terms review/);
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
