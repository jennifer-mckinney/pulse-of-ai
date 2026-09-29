// tests/integration/compact.test.js
// scripts/compact.js — Tier 1 → Tier 2 compaction, against the real test DB.
//
// P9-3 (part landed here): demo-feed posts (data_sources.source_type =
// 'demo', the standup's FICTIONAL population) are never folded into the
// monthly rollups — rollups describe real discourse only. Removing the demo
// posts themselves at compaction touches the audit tables and is pending
// the owner's explicit confirmation (see the PR notes).

'use strict';

const { dbGet, dbRun, dbTransaction } = require('../../src/db/connection');
const { compactMonth } = require('../../scripts/compact');
const {
    insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline,
} = require('./helpers');

async function insertDemoSource() {
    return (await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category, active)
         VALUES ('demo_social', 'Demo feed — Social (fictional)', 'demo', 'social', FALSE)
         RETURNING id`,
    )).id;
}

describe('scripts/compact.js — demo sources stay out of the rollups (P9-3)', () => {
    it('rolls up real posts only: no demo source row, no demo counts', async () => {
        const at = '2025-01-15T12:00:00Z';
        const job = await insertJob();
        const mv = await insertMethodologyVersions();
        const liveSrc = await insertSource('real-social', 'social');
        const demoSrc = await insertDemoSource();
        for (let i = 0; i < 2; i++) {
            await insertPostWithFullPipeline(liveSrc, job, mv, { externalId: `live-${i}`, collectedAt: at });
            await insertPostWithFullPipeline(demoSrc, job, mv, { externalId: `demo-${i}`, collectedAt: at, indicator: 'negative' });
        }

        // raw_posts.content is NOT NULL in the schema, so compaction's
        // content-nulling step (after the rollups) cannot complete today —
        // tracked with the retention work (PR #10). The rollups are therefore
        // checked inside a transaction that relaxes that constraint and is
        // ALWAYS rolled back: nothing here persists or leaks into other suites.
        const ROLLBACK = new Error('rollback');
        let src;
        let topics;
        await dbTransaction(async (client) => {
            await client.query('ALTER TABLE raw_posts ALTER COLUMN content DROP NOT NULL');
            await compactMonth(client, '2025-01-01', { log: () => {} });
            src = (await client.query('SELECT source_id, post_count, negative_count FROM monthly_source_rollups')).rows;
            topics = (await client.query('SELECT SUM(post_count)::int AS n, SUM(negative_count)::int AS neg FROM monthly_topic_rollups')).rows[0];
            throw ROLLBACK;
        }).catch((err) => { if (err !== ROLLBACK) throw err; });

        expect(src).toEqual([{ source_id: liveSrc, post_count: 2, negative_count: 0 }]);
        expect(topics).toEqual({ n: 2, neg: 0 });
        // The constraint is back (the transaction rolled back).
        const col = await dbGet(`SELECT is_nullable FROM information_schema.columns
                                 WHERE table_name = 'raw_posts' AND column_name = 'content'`);
        expect(col.is_nullable).toBe('NO');
    });

    it('is importable without running the CLI (require.main guard)', () => {
        const mod = require('../../scripts/compact');
        expect(typeof mod.compactMonth).toBe('function');
        expect(typeof mod.getMonthsToCompact).toBe('function');
    });
});
