// tests/integration/migration.010.test.js
// PR #8 review: migration 010 adds bias_assessments.methodology_version_id.
// It must be ADDITIVE (nullable column + index), IDEMPOTENT (safe to
// re-run), and must NOT backfill. Stamping pre-lineage rows with today's
// newest version would permanently record a lineage that may be false.
// Those rows keep NULL and are resolved at read time as lineage 'inferred'.

'use strict';

const fs = require('fs');
const path = require('path');
const { dbGet, dbAll, dbRun, dbTransaction } = require('../../src/db/connection');
const { insertJob, insertBiasMethodology, insertBiasAssessment } = require('./helpers');

const SQL_010 = fs.readFileSync(
    path.join(__dirname, '../../src/db/migrations/010_bias_methodology_lineage.sql'),
    'utf8',
);

function run010() {
    return dbTransaction(client => client.query(SQL_010));
}

describe('migration 010_bias_methodology_lineage.sql', () => {
    it('adds a NULLABLE uuid column referencing methodology_versions, plus its index', async () => {
        const col = await dbGet(
            `SELECT data_type, is_nullable FROM information_schema.columns
             WHERE table_name = 'bias_assessments' AND column_name = 'methodology_version_id'`,
        );
        expect(col).toEqual({ data_type: 'uuid', is_nullable: 'YES' });

        const fk = await dbGet(
            `SELECT ccu.table_name AS ref_table
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu ON kcu.constraint_name = tc.constraint_name
             JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
             WHERE tc.table_name = 'bias_assessments' AND tc.constraint_type = 'FOREIGN KEY'
               AND kcu.column_name = 'methodology_version_id'`,
        );
        expect(fk).toEqual({ ref_table: 'methodology_versions' });

        const idx = await dbGet(
            `SELECT indexname FROM pg_indexes
             WHERE tablename = 'bias_assessments' AND indexname = 'idx_bias_methodology'`,
        );
        expect(idx).toBeDefined();
    });

    it('is idempotent and never backfills or rewrites existing rows', async () => {
        const biasMvId = await insertBiasMethodology();
        const jobId = await insertJob();
        const preLineage = await insertBiasAssessment(jobId);   // NULL lineage (default)
        const recorded   = await insertBiasAssessment(jobId, { methodologyVersionId: biasMvId });

        const before = await dbAll('SELECT * FROM bias_assessments ORDER BY id');
        await run010();
        await run010();
        const after = await dbAll('SELECT * FROM bias_assessments ORDER BY id');

        expect(after).toEqual(before);
        expect(after.find(r => r.id === preLineage).methodology_version_id).toBeNull();
        expect(after.find(r => r.id === recorded).methodology_version_id).toBe(biasMvId);
    });

    it('rejects a methodology_version_id that is not a registered methodology row', async () => {
        const jobId = await insertJob();
        await expect(dbRun(
            `INSERT INTO bias_assessments
                (job_id, assessment_type, group_field, group_value, metric_name,
                 metric_value, threshold, methodology_version_id)
             VALUES ($1, 'x', 'y', 'z', 'm', 0, 0, '00000000-0000-4000-8000-000000000000')`,
            [jobId],
        )).rejects.toThrow(/foreign key/i);
    });
});
