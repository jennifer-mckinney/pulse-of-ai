// tests/integration/source.health.test.js
// P10-8: last_new_post_at, the registry's expectedNewWithinHours, and the
// source-health evaluator (source_stale / source_failing / source_refused),
// opened once per condition and resolved when it clears.

'use strict';

const db = require('../../src/db/connection');
const { seedSources } = require('../../scripts/seed');
const state = require('../../src/collectors/state');
const { evaluateSourceHealth, conditionsFor, FAILING_AFTER } = require('../../src/collectors/source-health');
const { getSource, SOURCES } = require('../../src/config/source-registry');

const ENV = { COLLECTOR_CONTACT_URL: 'https://example.org/contact' };
const HOUR = 3600000;
let npr;

beforeEach(async () => {
    await seedSources();
    npr = (await db.dbGet(`SELECT id FROM data_sources WHERE name = 'npr'`)).id;
    await state.claim(npr, 0, 150000);
});

const openAlerts = () => db.dbAll(
    `SELECT alert_type, severity, details FROM alert_events WHERE resolved_at IS NULL AND source_id = $1 ORDER BY alert_type`, [npr]);

describe('registry and state', () => {
    it('every source declares expectedNewWithinHours', () => {
        for (const s of SOURCES) expect([s.slug, s.expectedNewWithinHours > 0]).toEqual([s.slug, true]);
    });

    it('saveOutcome sets last_new_post_at only when a run stored new posts', async () => {
        await state.saveOutcome(npr, { ok: true, itemCount: 5, newPosts: 0 });
        expect((await db.dbGet('SELECT last_new_post_at FROM source_collection_state WHERE source_id = $1', [npr])).last_new_post_at).toBeNull();
        await state.saveOutcome(npr, { ok: true, itemCount: 5, newPosts: 2 });
        expect((await db.dbGet('SELECT last_new_post_at FROM source_collection_state WHERE source_id = $1', [npr])).last_new_post_at).not.toBeNull();
    });
});

describe('evaluateSourceHealth', () => {
    it('opens source_stale past expectedNewWithinHours, once, and resolves it when a new post arrives', async () => {
        const hours = getSource('npr').expectedNewWithinHours;
        await db.dbRun(`UPDATE source_collection_state SET last_success_at = NOW(), last_new_post_at = NOW() - make_interval(hours => $2)
                        WHERE source_id = $1`, [npr, hours + 1]);
        let r = await evaluateSourceHealth({ env: ENV });
        expect(r.opened).toEqual([{ slug: 'npr', type: 'source_stale' }]);
        await evaluateSourceHealth({ env: ENV });                       // no duplicate
        const open = await openAlerts();
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ alert_type: 'source_stale', severity: 'warning', details: { slug: 'npr', expected_within_hours: hours } });

        await state.saveOutcome(npr, { ok: true, itemCount: 1, newPosts: 1 });
        r = await evaluateSourceHealth({ env: ENV });
        expect(r.resolved).toEqual([{ slug: 'npr', type: 'source_stale' }]);
        expect(await openAlerts()).toEqual([]);
        expect(await db.dbAll(`SELECT id FROM alert_events WHERE source_id = $1`, [npr])).toHaveLength(1);   // history kept
    });

    it('opens source_failing after consecutive failures and resolves it on success', async () => {
        for (let i = 0; i < FAILING_AFTER; i++) await state.saveOutcome(npr, { ok: false, error: 'timeout', errorKind: 'timeout' });
        await evaluateSourceHealth({ env: ENV });
        expect((await openAlerts()).map(a => a.alert_type)).toEqual(['source_failing']);
        await state.saveOutcome(npr, { ok: true, itemCount: 1, newPosts: 1 });
        await evaluateSourceHealth({ env: ENV });
        expect(await openAlerts()).toEqual([]);
    });

    it('makes sure a refused source has its critical source_refused alert; a closed source raises nothing', async () => {
        await db.dbRun(`UPDATE source_collection_state SET access_denied_at = NOW(), access_denied_status = 403, access_denied_kind = 'access_denied'
                        WHERE source_id = $1`, [npr]);
        await evaluateSourceHealth({ env: ENV });
        expect(await openAlerts()).toEqual([expect.objectContaining({ alert_type: 'source_refused', severity: 'critical' })]);
        // The same source with collection switched off: the alert is resolved, nothing new opens.
        await evaluateSourceHealth({ env: { ...ENV, SOURCE_NPR_ENABLED: 'false' } });
        expect(await openAlerts()).toEqual([]);
    });

    it('conditionsFor never invents a reference date for a source that never succeeded', () => {
        expect(conditionsFor({ last_attempt_at: new Date(), consecutive_failures: 0 }, getSource('npr'), Date.now() + 1000 * HOUR)).toEqual({});
    });
});
