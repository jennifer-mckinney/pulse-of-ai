// tests/integration/governance.test.js
// P10-14: source_gate_events (seed never activates silently; every enable,
// disable, gate open and close with who and when) and dated terms snapshots
// (hash where reachable; walled / refused / Reddit recorded, never worked
// around). Migration 035.

'use strict';

const db = require('../../src/db/connection');
const { seedSources } = require('../../scripts/seed');
const admin = require('../../scripts/source-admin');
const { recordGateTransitions, snapshotTerms, saveTermsSnapshots } = require('../../src/collectors/governance');
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
        const io = { out: () => {}, err: () => {}, who: 'jennifer' };
        expect(await admin.main(['disable', 'npr', '--reason', 'publisher asked'], io)).toBe(0);
        expect(await admin.main(['enable', 'npr', '--note', 'resolved'], io)).toBe(0);
        const e = (await events('npr')).slice(1);
        expect(e).toEqual([
            { event: 'disabled', gate_status: null, actor: 'jennifer', reason: 'publisher asked' },
            { event: 'enabled', gate_status: null, actor: 'jennifer', reason: 'resolved' },
        ]);
    });

    it('the scheduler records a gate opening and closing once per change', async () => {
        await seedSources({ actor: 'test-seed' });
        const first = await recordGateTransitions({ env: TEST_ENV });
        expect(first.length).toBe(SOURCES.length);                      // first observation of each
        expect(await recordGateTransitions({ env: TEST_ENV })).toEqual([]);
        const closed = await recordGateTransitions({ env: { ...TEST_ENV, SOURCE_NPR_ENABLED: 'false' } });
        expect(closed).toEqual([{ slug: 'npr', event: 'gate_closed', gate_status: 'disabled' }]);
        const reopened = await recordGateTransitions({ env: TEST_ENV });
        expect(reopened).toEqual([{ slug: 'npr', event: 'gate_opened', gate_status: 'collecting' }]);
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
