// tests/integration/migration.009.test.js
// P0-2: migration 009 against a REAL PostgreSQL — the rows it registers equal
// the shared registry (the seed.js source) once stored as JSONB, re-running
// it is a no-op, and it never overwrites a row that is already registered.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbRun, dbAll, dbTransaction } = require('../../src/db/connection');
const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');

const SQL_009 = fs.readFileSync(
    path.join(__dirname, '../../src/db/migrations/009_methodology_registration.sql'),
    'utf8',
);
const COMPONENTS = ['audit_narration', 'bias', 'ingest'];

// Apply the migration the way scripts/migrate.js does: the whole file as one
// multi-statement query inside a transaction.
function run009() {
    return dbTransaction(client => client.query(SQL_009));
}

async function registeredRows() {
    return dbAll(
        `SELECT component, version, model_name, config, justification
         FROM methodology_versions
         WHERE component = ANY($1)
         ORDER BY component, version`,
        [COMPONENTS],
    );
}

describe('migration 009_methodology_registration.sql', () => {
    it('registers bias, ingest and audit_narration exactly as the registry defines them', async () => {
        await run009();
        const rows = await registeredRows();
        // 009 is released: it registers exactly these versions (later ones,
        // e.g. audit_narration@1.2.0, ship in later migrations).
        const REGISTERED_BY_009 = ['bias@1.1.0', 'ingest@1.0.0', 'audit_narration@1.1.0'];
        const expected = METHODOLOGY_VERSIONS
            .filter(m => REGISTERED_BY_009.includes(`${m.component}@${m.version}`))
            .sort((a, b) => a.component.localeCompare(b.component))
            .map(m => ({
                component: m.component,
                version: m.version,
                model_name: m.model_name,
                config: m.config,
                justification: m.justification,
            }));
        expect(rows).toEqual(expected);
    });

    it('is idempotent: a second run inserts nothing and changes nothing', async () => {
        await run009();
        const first = await registeredRows();
        await run009();
        expect(await registeredRows()).toEqual(first);
    });

    it('never overwrites an already-registered (component, version) row', async () => {
        await dbRun(
            `INSERT INTO methodology_versions (component, version, model_name, config, justification)
             VALUES ('bias', '1.1.0', 'pre-existing', '{"marker":true}'::jsonb, 'pre-existing row')`,
        );
        await run009();
        const bias = (await registeredRows()).filter(r => r.component === 'bias');
        expect(bias).toHaveLength(1);
        expect(bias[0]).toMatchObject({ model_name: 'pre-existing', config: { marker: true } });
    });
});
