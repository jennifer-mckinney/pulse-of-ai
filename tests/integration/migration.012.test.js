// tests/integration/migration.012.test.js
// Migration 012 (P9-5) against a REAL PostgreSQL: registers embedding@1.0.0
// field-for-field equal to the registry, idempotently, and adds the
// additive post_embeddings.methodology_version column.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbAll, dbGet, dbTransaction } = require('../../src/db/connection');
const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');

const SQL_012 = fs.readFileSync(
    path.join(__dirname, '../../src/db/migrations/012_embedding_methodology.sql'), 'utf8');

describe('migration 012_embedding_methodology.sql', () => {
    it('registers embedding@1.0.0 as the registry defines it, idempotently', async () => {
        await dbTransaction(client => client.query(SQL_012));
        await dbTransaction(client => client.query(SQL_012));
        const rows = await dbAll(
            `SELECT version, model_name, config, justification FROM methodology_versions
             WHERE component = 'embedding'`);
        const reg = METHODOLOGY_VERSIONS.find(m => m.component === 'embedding');
        expect(rows).toEqual([{
            version: reg.version, model_name: reg.model_name, config: reg.config,
            justification: reg.justification,
        }]);
        expect(rows[0].config.revision).toMatch(/^[0-9a-f]{40}$/);
    });

    it('post_embeddings has a nullable methodology_version column', async () => {
        const col = await dbGet(
            `SELECT data_type, is_nullable FROM information_schema.columns
             WHERE table_name = 'post_embeddings' AND column_name = 'methodology_version'`);
        expect(col).toEqual({ data_type: 'text', is_nullable: 'YES' });
    });
});
