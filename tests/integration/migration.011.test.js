// tests/integration/migration.011.test.js
// Migration 011 registers audit_narration@1.2.0 against a REAL PostgreSQL:
// field-for-field equal to the registry, ordered AFTER 009's 1.1.0 even when
// both run in the same transaction (scripts/migrate.js applies all pending
// migrations in one), idempotent, and never touching the released row.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbAll, dbTransaction } = require('../../src/db/connection');
const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');

const read = (f) => fs.readFileSync(path.join(__dirname, '../../src/db/migrations', f), 'utf8');
const SQL_009 = read('009_methodology_registration.sql');
const SQL_011 = read('011_audit_narration_demo.sql');

function narrationRows() {
    return dbAll(
        `SELECT version, model_name, config, justification, effective_from, deprecated_at
         FROM methodology_versions WHERE component = 'audit_narration'
         ORDER BY effective_from DESC, version DESC`,
    );
}

describe('migration 011_audit_narration_demo.sql', () => {
    it('registers 1.2.0 as the latest audit_narration row, even in one transaction with 009', async () => {
        await dbTransaction(async (client) => {
            await client.query(SQL_009);
            await client.query(SQL_011);
        });
        const rows = await narrationRows();
        expect(rows.map(r => r.version)).toEqual(['1.2.0', '1.1.0']);
        expect(rows[0].effective_from.getTime()).toBeGreaterThan(rows[1].effective_from.getTime());

        const reg = METHODOLOGY_VERSIONS.find(m => m.component === 'audit_narration' && m.version === '1.2.0');
        expect(rows[0]).toMatchObject({
            model_name: reg.model_name, config: reg.config, justification: reg.justification,
            deprecated_at: null,
        });
    });

    it('is idempotent and leaves the released 1.1.0 row untouched', async () => {
        await dbTransaction(client => client.query(SQL_009));
        const before = (await narrationRows()).find(r => r.version === '1.1.0');
        await dbTransaction(client => client.query(SQL_011));
        await dbTransaction(client => client.query(SQL_011));
        const rows = await narrationRows();
        expect(rows.map(r => r.version)).toEqual(['1.2.0', '1.1.0']);
        expect(rows.find(r => r.version === '1.1.0')).toEqual(before);
    });
});
