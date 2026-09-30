// tests/integration/run.retention.test.js
// P10-9: source_runs keeps 30 days raw, then daily rollups (source_run_daily,
// migration 034). PR #22 decision G4 (Jennifer, 2026-09-29): EVERY
// processing_jobs row is kept permanently, failed ones included (spec §19
// Tier 3) — nothing in maintenance removes a job.

'use strict';

const db = require('../../src/db/connection');
const runRetention = require('../../src/collectors/run-retention');
const { rollupSourceRuns } = runRetention;
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

describe('processing_jobs: kept permanently (G4)', () => {
    it('no maintenance step removes a job — empty, failed and old jobs all stay after the run-table rollup', async () => {
        const empty = await job(400);
        const failedEmpty = await job(400, 'failed');
        const recent = await job(3);
        await run(40, { jobId: empty });
        await rollupSourceRuns({ env: {} });
        const left = (await db.dbAll('SELECT id FROM processing_jobs')).map(r => r.id).sort();
        expect(left).toEqual([empty, failedEmpty, recent].sort());
        expect(runRetention.purgeEmptyJobs).toBeUndefined();
        const { defaultSteps } = require('../../src/workers/maintenance.worker');
        const names = defaultSteps({ log: () => {} }).map(([n]) => n);
        expect(names.length).toBeGreaterThan(0);
        expect(names).not.toContain('processing_jobs');
    });
});
