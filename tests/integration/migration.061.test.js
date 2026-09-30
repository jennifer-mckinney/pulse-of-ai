// tests/integration/migration.061.test.js
// Audit drift D-2: migration 061 registers bias@1.6.0 (a platform-parity
// "insufficient sample" row states its computed gap) and attaches an
// erratum to bias@1.4.0 and bias@1.5.0, whose released rows stay unedited.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbAll, dbGet, dbTransaction } = require('../../src/db/connection');
const { seedMethodology } = require('../../scripts/seed');
const { METHODOLOGY_VERSIONS, METHODOLOGY_ERRATA } = require('../../src/config/methodology-registry');

const SQL_061 = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/061_bias_parity_stated_value.sql'), 'utf8');
const row = v => dbGet(`SELECT * FROM methodology_versions WHERE component = 'bias' AND version = $1`, [v]);

describe('migration 061_bias_parity_stated_value.sql', () => {
    it('registers bias@1.6.0 as in the registry, adds the two errata, edits no released row, and is idempotent', async () => {
        await seedMethodology();
        const v14 = await row('1.4.0');
        const v15 = await row('1.5.0');
        await dbTransaction(c => c.query(SQL_061));
        await dbTransaction(c => c.query(SQL_061));

        expect(await row('1.4.0')).toEqual(v14);
        expect(await row('1.5.0')).toEqual(v15);
        const v16 = await row('1.6.0');
        const reg = METHODOLOGY_VERSIONS.find(m => m.component === 'bias' && m.version === '1.6.0');
        expect(v16).toMatchObject({ model_name: reg.model_name, config: reg.config, justification: reg.justification });

        const errata = await dbAll(
            `SELECT e.methodology_version_id, e.erratum_key, e.corrected_by, e.erratum
             FROM methodology_errata e WHERE e.corrected_by = 'bias@1.6.0' ORDER BY e.erratum_key`);
        const expected = METHODOLOGY_ERRATA.filter(e => e.corrected_by === 'bias@1.6.0');
        expect(errata).toEqual([
            { methodology_version_id: v14.id, erratum_key: expected[0].erratum_key, corrected_by: 'bias@1.6.0', erratum: expected[0].erratum },
            { methodology_version_id: v15.id, erratum_key: expected[1].erratum_key, corrected_by: 'bias@1.6.0', erratum: expected[1].erratum },
        ]);
    });

    it('on its own inserts exactly the registry\'s bias@1.6.0 row, and no erratum when the corrected rows are absent', async () => {
        await dbTransaction(c => c.query(SQL_061));
        const reg = METHODOLOGY_VERSIONS.find(m => m.component === 'bias' && m.version === '1.6.0');
        expect(await row('1.6.0')).toMatchObject({ model_name: reg.model_name, config: reg.config, justification: reg.justification });
        expect(await dbAll(`SELECT id FROM methodology_errata WHERE corrected_by = 'bias@1.6.0'`)).toEqual([]);
    });
});
