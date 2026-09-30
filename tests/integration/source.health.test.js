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

    it('conditionsFor never invents a reference date: no new post and no anchor means no stale verdict', () => {
        expect(conditionsFor({ last_attempt_at: new Date(), consecutive_failures: 0 }, getSource('npr'), Date.now() + 1000 * HOUR)).toEqual({});
    });

    // PR #22 principal P0-2: the frozen-feed failure mode. A source that keeps
    // answering 200 with nothing new was measured from last_success_at, which
    // every run refreshes, so it never went stale.
    it('a source that succeeds repeatedly with zero new posts goes stale (fixed anchor, never last_success_at)', async () => {
        const hours = getSource('npr').expectedNewWithinHours;
        await db.dbRun(`UPDATE source_collection_state SET freshness_anchor_at = NOW() - make_interval(hours => $2), last_new_post_at = NULL
                        WHERE source_id = $1`, [npr, hours + 2]);
        for (let i = 0; i < 3; i++) await state.saveOutcome(npr, { ok: true, itemCount: 10, newPosts: 0 });
        const row = await db.dbGet('SELECT last_success_at, last_new_post_at FROM source_collection_state WHERE source_id = $1', [npr]);
        expect(Date.now() - new Date(row.last_success_at).getTime()).toBeLessThan(60000);   // just succeeded
        expect(row.last_new_post_at).toBeNull();
        const r = await evaluateSourceHealth({ env: ENV });
        expect(r.opened).toEqual([{ slug: 'npr', type: 'source_stale' }]);
    });

    it('a new state row is anchored at its creation (a fixed time)', async () => {
        const row = await db.dbGet('SELECT freshness_anchor_at FROM source_collection_state WHERE source_id = $1', [npr]);
        expect(row.freshness_anchor_at).not.toBeNull();
        await state.saveOutcome(npr, { ok: true, itemCount: 1, newPosts: 0 });
        const again = await db.dbGet('SELECT freshness_anchor_at FROM source_collection_state WHERE source_id = $1', [npr]);
        expect(again.freshness_anchor_at).toEqual(row.freshness_anchor_at);
    });
});

describe('P1-6: one open alert per (type, source), atomically, with audited resolutions', () => {
    it('overlapping evaluations open ONE source_stale alert', async () => {
        const hours = getSource('npr').expectedNewWithinHours;
        await db.dbRun(`UPDATE source_collection_state SET last_new_post_at = NOW() - make_interval(hours => $2) WHERE source_id = $1`, [npr, hours + 1]);
        const results = await Promise.all([1, 2, 3, 4].map(() => evaluateSourceHealth({ env: ENV })));
        expect(results.flatMap(r => r.opened)).toHaveLength(1);
        expect(await openAlerts()).toHaveLength(1);
    });

    it('the database refuses a second open alert for the same (type, source)', async () => {
        const ins = () => db.dbRun(`INSERT INTO alert_events (alert_type, severity, source_table, source_id) VALUES ('source_stale', 'warning', 'data_sources', $1)`, [npr]);
        await ins();
        await expect(ins()).rejects.toThrow(/uq_alerts_open_source|duplicate key/);
    });

    it('a resolution by the evaluator writes an alert_resolutions record', async () => {
        const hours = getSource('npr').expectedNewWithinHours;
        await db.dbRun(`UPDATE source_collection_state SET last_new_post_at = NOW() - make_interval(hours => $2) WHERE source_id = $1`, [npr, hours + 1]);
        await evaluateSourceHealth({ env: ENV });
        await state.saveOutcome(npr, { ok: true, itemCount: 1, newPosts: 1 });
        await evaluateSourceHealth({ env: ENV });
        const r = await db.dbAll(`SELECT r.resolved_by, r.resolution, s.status FROM alert_resolutions r JOIN alert_status s ON s.alert_id = r.alert_id`);
        expect(r).toEqual([expect.objectContaining({ resolved_by: expect.stringMatching(/source-health evaluator/),
            resolution: expect.stringMatching(/a new post was stored/), status: 'resolved' })]);
    });

    it('migration 038 closes existing duplicates (oldest stays open) with records, then enforces uniqueness', async () => {
        const fs = require('fs');
        const path = require('path');
        const SQL = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/038_unique_open_source_alerts.sql'), 'utf8');
        const out = await db.dbTransaction(async (c) => {
            await c.query('DROP INDEX uq_alerts_open_source');
            const ids = [];
            for (let i = 0; i < 3; i++) {
                ids.push((await c.query(`INSERT INTO alert_events (alert_type, severity, source_table, source_id, created_at)
                    VALUES ('source_stale', 'warning', 'data_sources', $1, NOW() - make_interval(mins => $2)) RETURNING id`, [npr, 10 - i])).rows[0].id);
            }
            await c.query(SQL);
            await c.query(SQL);
            const open = (await c.query(`SELECT id FROM alert_events WHERE resolved_at IS NULL AND source_id = $1`, [npr])).rows.map(r => r.id);
            const recs = (await c.query(`SELECT alert_id, basis FROM alert_resolutions ORDER BY alert_id`)).rows;
            const idx = (await c.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'uq_alerts_open_source'`)).rowCount;
            return { ids, open, recs, idx };
        });
        expect(out.open).toEqual([out.ids[0]]);
        expect(out.recs.map(r => r.alert_id).sort()).toEqual([out.ids[1], out.ids[2]].sort());
        for (const r of out.recs) expect(r.basis).toEqual({ kept_alert_id: out.ids[0] });
        expect(out.idx).toBe(1);
    });
});

describe('migration 037: last_new_post_at backfilled from stored posts', () => {
    it('sets last_new_post_at to MAX(collected_at) where it is NULL, and leaves set values alone', async () => {
        const fs = require('fs');
        const path = require('path');
        const SQL = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/037_source_freshness_backfill.sql'), 'utf8');
        const bbc = (await db.dbGet(`SELECT id FROM data_sources WHERE name = 'bbc_news'`)).id;
        await state.claim(bbc, 0, 150000);
        const t1 = new Date(Date.now() - 50 * HOUR); const t2 = new Date(Date.now() - 30 * HOUR);
        for (const [i, t] of [t1, t2].entries()) {
            await db.dbRun(`INSERT INTO raw_posts (source_id, external_id, content, content_hash, collected_at) VALUES ($1, $2, 'x', md5($2), $3)`,
                [npr, `bf-${i}`, t]);
        }
        const fixed = new Date(Date.now() - 5 * HOUR);
        await db.dbRun('UPDATE source_collection_state SET last_new_post_at = NULL WHERE source_id = $1', [npr]);
        await db.dbRun('UPDATE source_collection_state SET last_new_post_at = $2 WHERE source_id = $1', [bbc, fixed]);
        await db.dbTransaction(c => c.query(SQL));
        await db.dbTransaction(c => c.query(SQL));   // idempotent
        const n = await db.dbGet('SELECT last_new_post_at FROM source_collection_state WHERE source_id = $1', [npr]);
        expect(new Date(n.last_new_post_at).getTime()).toBe(t2.getTime());
        const b = await db.dbGet('SELECT last_new_post_at FROM source_collection_state WHERE source_id = $1', [bbc]);
        expect(new Date(b.last_new_post_at).getTime()).toBe(fixed.getTime());
    });
});
