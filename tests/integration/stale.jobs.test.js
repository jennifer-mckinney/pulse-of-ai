// tests/integration/stale.jobs.test.js
// P10-18: the stale-job sweeper fails one-shot jobs left 'running' by a
// dead process (api, standup, demo, manual), never cron cycles or fresh
// jobs, and says why.

'use strict';

const { dbAll, dbRun } = require('../../src/db/connection');
const { sweepStaleJobs } = require('../../src/collectors/stale-jobs');

const job = async (trigger, minutesAgo, status = 'running') => (await dbRun(
    `INSERT INTO processing_jobs (triggered_by, status, started_at) VALUES ($1, $2, NOW() - make_interval(mins => $3::int)) RETURNING id`,
    [trigger, status, minutesAgo])).id;

it('fails stale one-shot jobs with the reason; leaves cron cycles, fresh and finished jobs alone', async () => {
    const standup = await job('standup', 45);
    const manual = await job('manual', 45);
    const demo = await job('demo', 45);
    const api = await job('api', 45);
    const freshApi = await job('standup', 5);
    const cron = await job('cron', 45);
    const done = await job('manual', 45, 'completed');

    const r = await sweepStaleJobs({ env: {} });
    expect(r.failed.map(x => x.id).sort()).toEqual([standup, manual, demo, api].sort());
    const rows = Object.fromEntries((await dbAll('SELECT id, status, error_details FROM processing_jobs')).map(x => [x.id, x]));
    expect(rows[standup]).toMatchObject({ status: 'failed', error_details: expect.stringMatching(/stale: still running after 30 minutes/) });
    for (const id of [freshApi, cron]) expect(rows[id].status).toBe('running');
    expect(rows[done].status).toBe('completed');
    expect((await sweepStaleJobs({ env: {} })).failed).toEqual([]);   // idempotent
});

it('uses REFRESH_STALE_MINUTES for api rows and STALE_JOB_MINUTES for the rest', async () => {
    const api = await job('api', 20);
    const standup = await job('standup', 20);
    const r = await sweepStaleJobs({ env: { REFRESH_STALE_MINUTES: '15', STALE_JOB_MINUTES: '60' } });
    expect(r.failed.map(x => x.id)).toEqual([api]);
    expect((await dbAll('SELECT status FROM processing_jobs WHERE id = $1', [standup]))[0].status).toBe('running');
});
