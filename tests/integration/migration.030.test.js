// tests/integration/migration.030.test.js
// P10-16: the relevance@1.0.0 erratum is a NEW row (methodology_errata),
// never an edit of the released methodology row; migration 030 and
// scripts/seed.js agree with the registry, are idempotent, and
// GET /api/methodology serves the erratum next to the version it corrects.

'use strict';

const fs = require('fs');
const path = require('path');
const { useServer } = require('../helpers/server');
const app = require('../../src/server');
const request = useServer(app);   // one listener per file (tests/helpers/server.js)
const { dbAll, dbGet, dbTransaction } = require('../../src/db/connection');
const { METHODOLOGY_ERRATA } = require('../../src/config/methodology-registry');
const { seedMethodology, seedErrata } = require('../../scripts/seed');

const SQL_030 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/030_methodology_errata.sql'), 'utf8');

describe('migration 030_methodology_errata.sql (relevance@1.0.0 erratum)', () => {
    it('adds the erratum as a new row, leaves relevance@1.0.0 untouched, and is idempotent', async () => {
        await seedMethodology();
        const before = await dbGet(`SELECT * FROM methodology_versions WHERE component = 'relevance' AND version = '1.0.0'`);
        await dbTransaction(c => c.query(SQL_030));
        await dbTransaction(c => c.query(SQL_030));
        await seedErrata();
        const after = await dbGet(`SELECT * FROM methodology_versions WHERE component = 'relevance' AND version = '1.0.0'`);
        expect(after).toEqual(before);

        // Only migration 030's relevance@1.0.0 row (later errata, e.g. the
        // bias ones of migration 061, are seeded too and checked there).
        const rows = await dbAll(`SELECT methodology_version_id, erratum_key, corrected_by, erratum FROM methodology_errata
                                  WHERE erratum_key = 'relevance-1.0.0-config-mismatch'`);
        expect(rows).toHaveLength(1);
        const e = METHODOLOGY_ERRATA[0];
        expect(rows[0]).toEqual({
            methodology_version_id: before.id, erratum_key: e.erratum_key, corrected_by: e.corrected_by, erratum: e.erratum,
        });
    });

    it('is a no-op when the corrected row is not registered', async () => {
        await dbTransaction(c => c.query(SQL_030));
        expect(await dbAll('SELECT id FROM methodology_errata')).toEqual([]);
    });

    it('GET /api/methodology serves the erratum with relevance@1.0.0, and the bias and ingest ones with their versions only', async () => {
        await seedMethodology();
        await seedErrata();
        const res = await request().get('/api/methodology');
        expect(res.status).toBe(200);
        const v100 = res.body.find(r => r.component === 'relevance' && r.version === '1.0.0');
        expect(v100.errata).toHaveLength(1);
        expect(v100.errata[0]).toMatchObject({ corrected_by: 'relevance@1.1.0' });
        expect(v100.errata[0].erratum).toMatch(/does not describe the code that produced its decisions/);
        // Migration 061 (audit drift D-2): bias@1.4.0 and 1.5.0 each carry
        // the parity erratum, corrected by bias@1.6.0.
        const corrected = [['relevance', '1.0.0'], ['bias', '1.4.0'], ['bias', '1.5.0']];
        for (const [component, version] of corrected.slice(1)) {
            const row = res.body.find(r => r.component === component && r.version === version);
            expect(row.errata).toHaveLength(1);
            expect(row.errata[0]).toMatchObject({ corrected_by: 'bias@1.6.0' });
            expect(row.errata[0].erratum).toMatch(/recorded metric_value 0/);
        }
        // Migration 066 (content-hash wording): every released ingest row,
        // 1.0.0 to 1.7.0, carries an erratum corrected by ingest@1.8.0.
        const ingestCorrected = ['1.0.0', '1.1.0', '1.2.0', '1.3.0', '1.4.0', '1.5.0', '1.6.0', '1.7.0'].map(v => ['ingest', v]);
        for (const [component, version] of ingestCorrected) {
            const row = res.body.find(r => r.component === component && r.version === version);
            expect(row.errata).toHaveLength(1);
            expect(row.errata[0]).toMatchObject({ corrected_by: 'ingest@1.8.0' });
            expect(row.errata[0].erratum).toMatch(/describes the SHA-256 content hash as a join key/);
        }
        corrected.push(...ingestCorrected);
        for (const r of res.body.filter(x => !corrected.some(([c, v]) => x.component === c && x.version === v))) {
            expect(r.errata).toEqual([]);
        }
    });

    it('the migration text mirrors the registry erratum field for field', () => {
        const e = METHODOLOGY_ERRATA[0];
        expect(SQL_030).toContain(`'${e.erratum_key}', '${e.corrected_by}', $err$${e.erratum}$err$`);
        expect(SQL_030).toContain(`mv.component = '${e.component}' AND mv.version = '${e.version}'`);
        expect(SQL_030).not.toMatch(/UPDATE methodology_versions|DELETE|DROP/);
    });
});
