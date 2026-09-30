// tests/integration/governance.test.js
// P10-14: source_gate_events (seed never activates silently; every enable,
// disable, gate open and close with who and when) and dated terms snapshots
// (hash where reachable; walled / refused / Reddit recorded, never worked
// around). Migration 035.

'use strict';

const db = require('../../src/db/connection');
const { seedSources } = require('../../scripts/seed');
const admin = require('../../scripts/source-admin');
const governance = require('../../src/collectors/governance');
const { recordGateTransitions, recordCorrelationGate, snapshotTerms, saveTermsSnapshots } = governance;
const { HttpClient } = require('../../src/collectors/http');
const { fixtureTransport, TEST_ENV } = require('../helpers/fixtureTransport');
const { SOURCES } = require('../../src/config/source-registry');

const events = (slug) => db.dbAll('SELECT event, gate_status, actor, reason FROM source_gate_events WHERE slug = $1 ORDER BY occurred_at, id', [slug]);

describe('source_gate_events', () => {
    it('seed records every row it creates or re-activates, and nothing when it changes nothing', async () => {
        await seedSources({ actor: 'test-seed' });
        expect(await db.dbGet(`SELECT COUNT(*)::int AS n FROM source_gate_events WHERE event = 'seeded_active'`)).toEqual({ n: SOURCES.length });
        await seedSources({ actor: 'test-seed' });
        expect(await db.dbGet(`SELECT COUNT(*)::int AS n FROM source_gate_events`)).toEqual({ n: SOURCES.length });
        await db.dbRun(`UPDATE data_sources SET active = FALSE WHERE name = 'npr'`);
        await seedSources({ actor: 'test-seed' });
        const npr = await events('npr');
        expect(npr.map(e => e.event)).toEqual(['seeded_active', 'seeded_active']);
        expect(npr[1]).toMatchObject({ actor: 'test-seed', reason: expect.stringMatching(/re-activated/) });
    });

    it('source:disable / source:enable record who and why', async () => {
        await seedSources({ actor: 'test-seed' });
        // G5 / security L6: the actor is the named approval, not $USER.
        const io = { out: () => {}, err: () => {}, env: { GATE_APPROVED_BY: 'Jennifer McKinney 2026-09-29' } };
        expect(await admin.main(['disable', 'npr', '--reason', 'publisher asked'], io)).toBe(0);
        expect(await admin.main(['enable', 'npr', '--note', 'resolved'], io)).toBe(0);
        const e = (await events('npr')).slice(1);
        expect(e).toEqual([
            { event: 'disabled', gate_status: null, actor: 'Jennifer McKinney 2026-09-29', reason: 'publisher asked' },
            { event: 'enabled', gate_status: null, actor: 'Jennifer McKinney 2026-09-29', reason: 'resolved' },
        ]);
    });

    it('the scheduler records a gate opening and closing once per change', async () => {
        await seedSources({ actor: 'test-seed' });
        const first = await recordGateTransitions({ env: TEST_ENV });
        expect(first.length).toBe(SOURCES.length);                      // first observation of each
        expect(await recordGateTransitions({ env: TEST_ENV })).toEqual([]);
        const closed = await recordGateTransitions({ env: { ...TEST_ENV, SOURCE_NPR_ENABLED: 'false' } });
        expect(closed).toEqual([{ slug: 'npr', event: 'gate_closed', gate_status: 'disabled', approved_by: null }]);
        const reopened = await recordGateTransitions({ env: TEST_ENV });
        expect(reopened).toEqual([{ slug: 'npr', event: 'gate_opened', gate_status: 'collecting', approved_by: null }]);
    });

    // PR #22 decision G5: a gated route opens only under a named approval,
    // and the opening records who approved it (actor and approved_by).
    it('a gated source stays closed "awaiting named approval" until GATE_APPROVED_BY names who approved it', async () => {
        await seedSources({ actor: 'test-seed' });
        const { GATE_APPROVED_BY: _drop, ...unapproved } = TEST_ENV;
        await recordGateTransitions({ env: unapproved });
        const [closed] = await db.dbAll(`SELECT event, gate_status, actor, approved_by, reason, routes FROM source_gate_events
                                         WHERE slug = 'bbc_news' AND event LIKE 'gate_%'`);
        expect(closed).toMatchObject({ event: 'gate_closed', gate_status: 'awaiting_approval', actor: 'worker scheduler (runtime env)',
            approved_by: null, routes: [], reason: expect.stringMatching(/^awaiting named approval: technology-rss is configured but stays closed.*GATE_APPROVED_BY is not set/) });
        // Keyless sources are not gated: they open without it.
        expect((await db.dbGet(`SELECT event, approved_by FROM source_gate_events WHERE slug = 'npr' AND event LIKE 'gate_%'`)))
            .toEqual({ event: 'gate_opened', approved_by: null });

        const opened = await recordGateTransitions({ env: TEST_ENV });
        expect(opened).toContainEqual({ slug: 'bbc_news', event: 'gate_opened', gate_status: 'collecting', approved_by: 'Test Operator 2026-09-29' });
        expect(opened.find(e => e.slug === 'npr')).toBeUndefined();
        const row = await db.dbGet(`SELECT actor, approved_by, routes FROM source_gate_events
                                    WHERE slug = 'bbc_news' AND event = 'gate_opened'`);
        expect(row).toEqual({ actor: 'Test Operator 2026-09-29', approved_by: 'Test Operator 2026-09-29', routes: ['technology-rss'] });
        // A new approver of an open gate is a new, recorded opening.
        const again = await recordGateTransitions({ env: { ...TEST_ENV, GATE_APPROVED_BY: 'Jennifer McKinney 2026-09-30' } });
        expect(again).toContainEqual({ slug: 'bbc_news', event: 'gate_opened', gate_status: 'collecting', approved_by: 'Jennifer McKinney 2026-09-30' });
        expect(await recordGateTransitions({ env: { ...TEST_ENV, GATE_APPROVED_BY: 'Jennifer McKinney 2026-09-30' } })).toEqual([]);
    });

    // Grumpy L14: the database kill switch closes the recorded gate.
    it('a source disabled by the database kill switch is recorded closed, whatever the env says', async () => {
        await seedSources({ actor: 'test-seed' });
        await recordGateTransitions({ env: TEST_ENV });
        const io = { out: () => {}, err: () => {}, env: { GATE_APPROVED_BY: 'Jennifer McKinney 2026-09-29' } };
        expect(await admin.main(['disable', 'npr', '--reason', 'takedown'], io)).toBe(0);
        expect(await recordGateTransitions({ env: TEST_ENV })).toEqual([{ slug: 'npr', event: 'gate_closed', gate_status: 'disabled', approved_by: null }]);
        const row = await db.dbGet(`SELECT reason, routes FROM source_gate_events WHERE slug = 'npr' AND event = 'gate_closed'`);
        expect(row).toEqual({ reason: 'database kill switch (Jennifer McKinney 2026-09-29): takedown', routes: [] });
        expect(await recordGateTransitions({ env: TEST_ENV })).toEqual([]);
        expect(await admin.main(['enable', 'npr'], io)).toBe(0);
        expect(await recordGateTransitions({ env: TEST_ENV })).toEqual([{ slug: 'npr', event: 'gate_opened', gate_status: 'collecting', approved_by: null }]);
    });

    // Grumpy L16: seed's upsert and its 'seeded_active' event are one transaction.
    it('a failed seeded_active write rolls the upsert back', async () => {
        const spy = jest.spyOn(governance, 'recordGateEvent').mockRejectedValueOnce(new Error('event insert failed'));
        try {
            await expect(seedSources({ actor: 'test-seed' })).rejects.toThrow(/event insert failed/);
        } finally { spy.mockRestore(); }
        expect(await db.dbGet(`SELECT COUNT(*)::int AS n FROM data_sources WHERE name = $1`, [SOURCES[0].slug])).toEqual({ n: 0 });
        expect(await db.dbGet(`SELECT COUNT(*)::int AS n FROM source_gate_events`)).toEqual({ n: 0 });
    });
});

// Principal #19: every change of the correlation DPIA gate is recorded.
describe('correlation_gate_events', () => {
    const rows = () => db.dbAll('SELECT status, enabled, dpia_ref, actor, approved_by, reason FROM correlation_gate_events ORDER BY occurred_at, id');

    it('records the first observation and every change of status or DPIA reference, with who', async () => {
        expect(await recordCorrelationGate({ env: {} })).toMatchObject({ status: 'awaiting_dpia', enabled: false, dpia_ref: null,
            actor: 'worker scheduler (runtime env)', approved_by: null });
        expect(await recordCorrelationGate({ env: {} })).toBeNull();
        const approver = { GATE_APPROVED_BY: 'Jennifer McKinney 2026-09-29' };
        expect(await recordCorrelationGate({ env: { ...approver, CORRELATION_DPIA_REF: 'DPIA-1' } }))
            .toMatchObject({ status: 'disabled', dpia_ref: 'DPIA-1', actor: 'Jennifer McKinney 2026-09-29', approved_by: 'Jennifer McKinney 2026-09-29' });
        expect(await recordCorrelationGate({ env: { ...approver, CORRELATION_DPIA_REF: 'DPIA-2' } })).toMatchObject({ status: 'disabled', dpia_ref: 'DPIA-2' });
        const all = { ...approver, CORRELATION_DPIA_REF: 'DPIA-2', CORRELATION_ENABLED: 'true', CORRELATION_SALT: 'c4554f4f1956b970ee9140dc82f241cb' };
        expect(await recordCorrelationGate({ env: all })).toMatchObject({ status: 'not_implemented', enabled: false,
            reason: expect.stringMatching(/^not implemented: signal design pending DPIA/) });
        expect(await recordCorrelationGate({ env: all })).toBeNull();
        expect((await rows()).map(r => [r.status, r.dpia_ref])).toEqual([
            ['awaiting_dpia', null], ['disabled', 'DPIA-1'], ['disabled', 'DPIA-2'], ['not_implemented', 'DPIA-2']]);
    });

    it('is append-only (migration 056 trigger)', async () => {
        await recordCorrelationGate({ env: {} });
        await expect(db.dbRun(`UPDATE correlation_gate_events SET actor = 'x'`)).rejects.toThrow(/append-only/);
        await expect(db.dbRun(`DELETE FROM correlation_gate_events`)).rejects.toThrow(/append-only/);
    });
});

describe('terms snapshots', () => {
    it('hashes a reachable page, records refusals, walls and Reddit without fetching around them', async () => {
        await seedSources({ actor: 'test-seed' });
        const transport = fixtureTransport([
            ['https://www.npr.org/robots.txt', { status: 404, body: '' }],
            ['https://www.npr.org/about-npr/179876898/terms-of-use', { status: 200, body: '<html>NPR terms</html>' }],
            ['https://www.bbc.co.uk/robots.txt', { status: 404, body: '' }],
            ['https://www.bbc.co.uk/usingthebbc/terms-of-use', { status: 403, body: 'denied' }],
        ]);
        const rows = await snapshotTerms({ http: new HttpClient({ env: TEST_ENV, transport, sleep: () => Promise.resolve() }),
            slugs: ['npr', 'bbc_news', 'cato', 'reddit'] });
        const by = Object.fromEntries(rows.map(r => [r.slug, r]));
        expect(by.npr).toMatchObject({ status: 'fetched', http_status: 200, bytes: 22 });
        expect(by.npr.sha256).toBe(require('crypto').createHash('sha256').update('<html>NPR terms</html>').digest('hex'));
        expect(by.bbc_news).toMatchObject({ status: 'unreachable', reason: expect.stringMatching(/refused access \(HTTP 403\)/) });
        expect(by.cato).toMatchObject({ status: 'unreachable', reason: expect.stringMatching(/blocked source.*never worked around/) });
        expect(by.reddit).toMatchObject({ status: 'not_fetched', reason: expect.stringMatching(/never contacted/) });
        await saveTermsSnapshots(rows);
        expect((await db.dbAll('SELECT slug, status, captured_at FROM source_terms_snapshots ORDER BY slug')).map(r => [r.slug, r.status]))
            .toEqual([['bbc_news', 'unreachable'], ['cato', 'unreachable'], ['npr', 'fetched'], ['reddit', 'not_fetched']]);
    });

    // PR #22 P1-13 / grumpy #15: the normalised text is stored and hashed;
    // noise (nonces, scripts) does not change the hash; a real change opens
    // ONE terms_changed alert.
    it('stores the normalised terms text with a reproducible hash; only a text change alerts', async () => {
        await seedSources({ actor: 'test-seed' });
        const page = (nonce, clause) => `<html><head><script>window.n="${nonce}"</script></head><body><h1>NPR Terms</h1>`
            + `<p>You may read &amp; share.</p><p>${clause}</p></body></html>`;
        let body = page('a1', 'Clause 7: no scraping.');
        const transport = fixtureTransport([
            ['https://www.npr.org/robots.txt', { status: 404, body: '' }],
            ['https://www.npr.org/about-npr/179876898/terms-of-use', () => ({ status: 200, headers: { 'content-type': 'text/html' }, body })],
        ]);
        const http = () => new HttpClient({ env: TEST_ENV, transport, sleep: () => Promise.resolve() });
        const snap = async () => saveTermsSnapshots(await snapshotTerms({ http: http(), slugs: ['npr'] }));
        expect(await snap()).toEqual({ saved: 1, changed: [] });
        const first = await db.dbGet(`SELECT terms_text, text_sha256, normaliser FROM source_terms_snapshots WHERE slug = 'npr'`);
        expect(first.terms_text).toBe('NPR Terms\nYou may read & share.\nClause 7: no scraping.');
        expect(first.text_sha256).toBe(require('crypto').createHash('sha256').update(first.terms_text).digest('hex'));
        expect(first.normaliser).toBe('terms-text@1');
        body = page('b2', 'Clause 7: no scraping.');                  // only the nonce changed
        expect(await snap()).toEqual({ saved: 1, changed: [] });
        body = page('c3', 'Clause 7: no scraping or AI training.');   // the terms changed
        expect(await snap()).toEqual({ saved: 1, changed: ['npr'] });
        body = page('d4', 'Clause 7: again different.');
        await snap();
        const alerts = await db.dbAll(`SELECT severity, details FROM alert_events WHERE alert_type = 'terms_changed' AND resolved_at IS NULL`);
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toMatchObject({ severity: 'warning', details: { slug: 'npr' } });
    });

    it('terms:snapshot parses --only / --json strictly (--json is never a slug)', () => {
        const { parseArgs } = require('../../scripts/terms-snapshot');
        expect(parseArgs(['--only', 'npr,bbc_news', '--json'])).toEqual({ slugs: ['npr', 'bbc_news'], json: true });
        expect(parseArgs(['--json'])).toEqual({ slugs: undefined, json: true });
        expect(() => parseArgs(['--only', '--json'])).toThrow(/--only needs/);
        expect(() => parseArgs(['--only', 'nope'])).toThrow(/unknown source slug\(s\): nope/);
    });

    it('the weekly terms step is skipped (recorded) without a contact URL', async () => {
        const { termsSnapshotStep } = require('../../src/workers/maintenance.worker');
        expect(await termsSnapshotStep({ env: {} })).toEqual({ skipped: expect.stringMatching(/COLLECTOR_CONTACT_URL/) });
    });
});
