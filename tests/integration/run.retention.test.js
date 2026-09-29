// tests/integration/run.retention.test.js
// P10-9: source_runs keeps 30 days raw, then daily rollups (source_run_daily,
// migration 034); empty finished processing_jobs older than 30 days are
// removed while every job an audit or bias row references is kept.

'use strict';

const db = require('../../src/db/connection');
const { rollupSourceRuns, purgeEmptyJobs } = require('../../src/collectors/run-retention');
const { insertSource, insertMethodologyVersions, insertPostWithFullPipeline } = require('./helpers');

const DAY = 86400000;
let src;

beforeEach(async () => { src = await insertSource('rr-src', 'news'); });

async function run(daysAgo, { outcome = 'ok', items = 2, posts = 1, requests = 1, kind = null, jobId = null } = {}) {
    await db.dbRun(
        `INSERT INTO source_runs (source_id, job_id, gate_status, outcome, items_fetched, posts_new, requests, error_kind, started_at, finished_at)
         VALUES ($1, $2, 'collecting', $3, $4, $5, $6, $7, $8, $8)`,
        [src, jobId, outcome, items, posts, requests, kind, new Date(Date.now() - daysAgo * DAY)]);
}
async function job(daysAgo, status = 'completed') {
    return (await db.dbRun(`INSERT INTO processing_jobs (triggered_by, status, started_at) VALUES ('cron', $1, $2) RETURNING id`,
        [status, new Date(Date.now() - daysAgo * DAY)])).id;
}

describe('source_runs: 30 days raw, then daily rollups', () => {
    it('rolls old rows into one row per day and source, removes them, keeps recent rows, logs true counts; merges on rerun', async () => {
        await run(40, { items: 3, posts: 2, requests: 2 });
        await run(40, { outcome: 'error', items: 0, posts: 0, kind: 'timeout' });
        await run(40, { outcome: 'error', items: 0, posts: 0, kind: 'timeout' });
        await run(5);
        const r = await rollupSourceRuns({ env: {} });
        expect(r.rolledUp).toBe(3);
        expect(await db.dbAll('SELECT id FROM source_runs')).toHaveLength(1);
        const daily = await db.dbAll('SELECT runs, ok_runs, error_runs, items_fetched, posts_new, requests, error_kinds FROM source_run_daily');
        expect(daily).toEqual([{ runs: 3, ok_runs: 1, error_runs: 2, items_fetched: '3', posts_new: '2', requests: '4', error_kinds: { timeout: 2 } }]);
        const log = await db.dbAll(`SELECT action, reason FROM data_retention_log`);
        expect(log.map(l => l.action)).toEqual(['rolled_up_source_runs']);
        expect(JSON.parse(log[0].reason).rows).toBe(3);

        // A late row for the same day merges into the same rollup.
        await run(40, { outcome: 'error', items: 0, posts: 0, kind: 'access_denied' });
        await rollupSourceRuns({ env: {} });
        const merged = await db.dbGet('SELECT runs, error_runs, error_kinds FROM source_run_daily');
        expect(merged).toEqual({ runs: 4, error_runs: 3, error_kinds: { timeout: 2, access_denied: 1 } });
    });
});

describe('processing_jobs: empty old jobs only', () => {
    it('removes finished empty jobs past 30 days; keeps running, recent and referenced jobs', async () => {
        const empty = await job(40);
        const failedEmpty = await job(40, 'failed');
        const recent = await job(3);
        const running = await job(40, 'running');
        const scored = await job(40);
        const mv = await insertMethodologyVersions();
        await insertPostWithFullPipeline(src, scored, mv, { externalId: 'kept' });
        const withRun = await job(40);
        await run(1, { jobId: withRun });

        expect(await purgeEmptyJobs({ env: {} })).toEqual({ removed: 2 });
        const left = (await db.dbAll('SELECT id FROM processing_jobs')).map(r => r.id).sort();
        expect(left).toEqual([recent, running, scored, withRun].sort());
        expect(left).not.toContain(empty);
        expect(left).not.toContain(failedEmpty);
        expect((await db.dbAll(`SELECT action FROM data_retention_log`)).map(r => r.action)).toEqual(['purged_empty_jobs']);
    });
});
