// tests/integration/retention.config.test.js
// PR #22 security M1 against the real test DB: with a bad retention window
// the maintenance steps FAIL and change nothing — no text is blanked, no
// demo post purged, no month compacted, no run row removed.

'use strict';

const db = require('../../src/db/connection');
const { blankExpired } = require('../../src/collectors/retention');
const { runCompaction } = require('../../scripts/compact');
const { rollupSourceRuns } = require('../../src/collectors/run-retention');
const { insertSource, insertJob, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

const DAY = 24 * 3600000;
const saved = process.env.RETENTION_DETAIL_DAYS;
afterEach(() => { process.env.RETENTION_DETAIL_DAYS = saved; });

let real; let demo;
beforeEach(async () => {
    const mv = await insertMethodologyVersions();
    const job = await insertJob();
    const srcId = await insertSource('some-real-source', 'news');
    const demoId = (await db.dbRun(`INSERT INTO data_sources (name, display_name, source_type, category)
        VALUES ('demo_cfg', 'Demo', 'demo', 'news') RETURNING id`)).id;
    real = await insertPostWithFullPipeline(srcId, job, mv, { externalId: 'r1', collectedAt: new Date(Date.now() - 200 * DAY) });
    demo = await insertPostWithFullPipeline(demoId, job, mv, { externalId: 'd1', collectedAt: new Date(Date.now() - 200 * DAY) });
});

it.each(['0', '-30', 'abc', '1e3'])('RETENTION_DETAIL_DAYS=%s: every destructive step refuses and nothing changes', async (v) => {
    process.env.RETENTION_DETAIL_DAYS = v;
    await expect(blankExpired({ env: process.env })).rejects.toThrow(/RETENTION_DETAIL_DAYS/);
    await expect(runCompaction({ log: () => {}, removeEmbedJobs: async () => ({}) })).rejects.toThrow(/RETENTION_DETAIL_DAYS/);
    expect((await db.dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [real])).text_removed_at).toBeNull();
    expect(await db.dbGet('SELECT id FROM raw_posts WHERE id = $1', [demo])).toBeTruthy();
    expect((await db.dbGet('SELECT COUNT(*)::int AS n FROM compaction_log')).n).toBe(0);
    expect((await db.dbGet('SELECT COUNT(*)::int AS n FROM data_retention_log WHERE action <> $1', ['collected'])).n).toBe(0);
});

it('SOURCE_RUNS_RAW_DAYS=0: the run rollup refuses', async () => {
    await expect(rollupSourceRuns({ env: { SOURCE_RUNS_RAW_DAYS: '0' } })).rejects.toThrow(/SOURCE_RUNS_RAW_DAYS/);
});
