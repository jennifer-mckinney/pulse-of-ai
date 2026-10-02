// tests/integration/migration.036.test.js
// PR #22 decision G1 and principal #9 / security L6, against the real test
// DB: alerts closed by migrations 028 / 032 are SUPERSEDED (approved by
// Jennifer McKinney), recorded additively; migration 032 never edits 028's
// rows; the governance tables are append-only (UPDATE / DELETE raise).

'use strict';

const fs = require('fs');
const path = require('path');
const { dbAll, dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { seedMethodology } = require('../../scripts/seed');
const { insertSource, insertJob } = require('./helpers');
const { useServer } = require('../helpers/server');

const request = useServer(require('../../src/server'));   // one listener per file (tests/helpers/server.js)

const sql = (f) => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', f), 'utf8');
const SQL_028 = sql('028_bias_min_sample.sql');
const SQL_032 = sql('032_bias_sample_rules.sql');
const SQL_036 = sql('036_alert_supersession_and_append_only.sql');

const alert = async (type, jobId) => (await dbRun(
    `INSERT INTO alert_events (alert_type, severity, source_table, details)
     VALUES ($1, 'critical', 'bias_assessments', jsonb_build_object('jobId', $2::text)) RETURNING id`, [type, jobId])).id;

it('032 contains no UPDATE of alert_resolutions (028 rows are never edited)', () => {
    expect(SQL_032).not.toMatch(/UPDATE\s+alert_resolutions/i);
    expect(SQL_028).not.toMatch(/UPDATE\s+alert_resolutions/i);
});

describe('migration 036', () => {
    beforeEach(() => seedMethodology());

    it('records Jennifer McKinney\'s approval and the superseded status for 028 / 032 closures only', async () => {
        const j1 = await insertJob('completed');
        const j2 = await insertJob('completed');
        const aLoc = await alert('location_concentration', j1);     // 0 located posts: 028 closes it
        const aNeg = await alert('negative_dominance', j2);          // 0 posts: 032 closes it
        const open = await alert('source_refused', j1);
        await dbTransaction(c => c.query(SQL_028));
        await dbTransaction(c => c.query(SQL_032));
        // A resolution by anything else (e.g. the source-health evaluator) is 'resolved'.
        const src = await insertSource('m036', 'news');
        const fixed = (await dbRun(`INSERT INTO alert_events (alert_type, severity, source_table, source_id, resolved_at)
            VALUES ('source_stale', 'warning', 'data_sources', $1, NOW()) RETURNING id`, [src])).id;
        await dbRun(`INSERT INTO alert_resolutions (alert_id, resolved_by, resolution, basis) VALUES ($1, 'source-health evaluator', 'a new post was stored', '{}')`, [fixed]);

        await dbTransaction(c => c.query(SQL_036));
        await dbTransaction(c => c.query(SQL_036));   // idempotent

        const ap = await dbAll(`SELECT r.alert_id, a.kind, a.approved_by, a.ruling_date::text AS d, a.ruling, mv.version
                                FROM alert_resolution_approvals a JOIN alert_resolutions r ON r.id = a.resolution_id
                                LEFT JOIN methodology_versions mv ON mv.id = a.methodology_version_id`);
        expect(ap).toHaveLength(2);
        expect(Object.fromEntries(ap.map(r => [r.alert_id, r.version]))).toEqual({ [aLoc]: '1.3.0', [aNeg]: '1.4.0' });
        for (const r of ap) {
            expect(r).toMatchObject({ kind: 'superseded', approved_by: 'Jennifer McKinney', d: '2026-09-29' });
            expect(r.ruling).toMatch(/G1/);
        }
        const st = Object.fromEntries((await dbAll('SELECT alert_id, status, approved_by FROM alert_status')).map(r => [r.alert_id, r]));
        expect(st[aLoc]).toMatchObject({ status: 'superseded', approved_by: 'Jennifer McKinney' });
        expect(st[aNeg].status).toBe('superseded');
        expect(st[fixed]).toMatchObject({ status: 'resolved', approved_by: null });
        expect(st[open].status).toBe('open');

        // The dashboard tells superseded closures apart from genuine fixes.
        const h = await request().get('/api/health');
        expect(h.body.alerts_closed).toEqual({ resolved: 1, superseded: 2 });
    });

    it.each([
        ['alert_resolutions'], ['alert_resolution_approvals'], ['source_gate_events'], ['source_terms_snapshots'], ['methodology_errata'],
    ])('%s is append-only: UPDATE and DELETE raise', async (table) => {
        const src = await insertSource('m036-ao', 'news');
        const job = await insertJob('completed');
        const a = await alert('location_concentration', job);
        const res = (await dbRun(`INSERT INTO alert_resolutions (alert_id, resolved_by, resolution, basis) VALUES ($1, 't', 't', '{}') RETURNING id`, [a])).id;
        const mv = (await dbGet(`SELECT id FROM methodology_versions WHERE component = 'bias' LIMIT 1`)).id;
        const rows = {
            alert_resolutions: res,
            alert_resolution_approvals: (await dbRun(`INSERT INTO alert_resolution_approvals (resolution_id, kind, approved_by, ruling_date, ruling)
                VALUES ($1, 'resolved', 't', '2026-09-29', 't') RETURNING id`, [res])).id,
            source_gate_events: (await dbRun(`INSERT INTO source_gate_events (source_id, slug, event, actor) VALUES ($1, 'm036-ao', 'gate_opened', 't') RETURNING id`, [src])).id,
            source_terms_snapshots: (await dbRun(`INSERT INTO source_terms_snapshots (slug, terms_url, status) VALUES ('m036-ao', 'https://x', 'not_fetched') RETURNING id`)).id,
            methodology_errata: (await dbRun(`INSERT INTO methodology_errata (methodology_version_id, erratum_key, erratum) VALUES ($1, $2, 't') RETURNING id`, [mv, `k-${Date.now()}`])).id,
        };
        const col = table === 'alert_resolutions' ? 'resolution' : table === 'methodology_errata' ? 'erratum'
            : table === 'alert_resolution_approvals' ? 'ruling' : table === 'source_gate_events' ? 'actor' : 'reason';
        await expect(dbRun(`UPDATE ${table} SET ${col} = 'changed' WHERE id = $1`, [rows[table]])).rejects.toThrow(/append-only/);
        await expect(dbRun(`DELETE FROM ${table} WHERE id = $1`, [rows[table]])).rejects.toThrow(/append-only/);
    });
});
