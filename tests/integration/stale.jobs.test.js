// tests/integration/stale.jobs.test.js
// P10-18: the stale-job sweeper fails one-shot jobs left 'running' by a
// dead process (api, standup, demo, manual), never cron cycles or fresh
// jobs, and says why.

'use strict';

const { dbAll, dbGet, dbRun } = require('../../src/db/connection');
const { sweepStaleJobs } = require('../../src/collectors/stale-jobs');
const { runCollection } = require('../../src/collectors/runner');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { refreshDeadlineMs } = require('../../src/workers/collect.worker');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const job = async (trigger, minutesAgo, status = 'running') => (await dbRun(
    `INSERT INTO processing_jobs (triggered_by, status, started_at) VALUES ($1, $2, NOW() - make_interval(mins => $3::int)) RETURNING id`,
    [trigger, status, minutesAgo])).id;

it('fails stale one-shot jobs with the reason; leaves cron cycles, fresh and finished jobs alone', async () => {
    const standup = await job('standup', 45);
    const manual = await job('manual', 45);
    const demo = await job('demo', 45);
    const api = await job('api', 45);
    const freshStandup = await job('standup', 5);
    const startup = await job('startup', 45);
    const cron = await job('cron', 45);
    const done = await job('manual', 45, 'completed');

    const r = await sweepStaleJobs({ env: {} });
    expect(r.failed.map(x => x.id).sort()).toEqual([standup, manual, demo, api, startup].sort());
    const rows = Object.fromEntries((await dbAll('SELECT id, status, error_details FROM processing_jobs')).map(x => [x.id, x]));
    expect(rows[standup]).toMatchObject({ status: 'failed', error_details: expect.stringMatching(/stale: no progress for 30 minutes/) });
    for (const id of [freshStandup, cron]) expect(rows[id].status).toBe('running');
    expect(rows[done].status).toBe('completed');
    expect((await sweepStaleJobs({ env: {} })).failed).toEqual([]);   // idempotent
});

it('leaves a fresh api (refresh) row alone', async () => {
    const freshApi = await job('api', 5);
    expect((await sweepStaleJobs({ env: {} })).failed).toEqual([]);
    expect((await dbGet('SELECT status FROM processing_jobs WHERE id = $1', [freshApi])).status).toBe('running');
});

it('uses REFRESH_STALE_MINUTES for api rows and STALE_JOB_MINUTES for the rest', async () => {
    const api = await job('api', 20);
    const standup = await job('standup', 20);
    const r = await sweepStaleJobs({ env: { REFRESH_STALE_MINUTES: '15', STALE_JOB_MINUTES: '60' } });
    expect(r.failed.map(x => x.id)).toEqual([api]);
    expect((await dbAll('SELECT status FROM processing_jobs WHERE id = $1', [standup]))[0].status).toBe('running');
});

// PR #22 P1-4 / grumpy #4: progress, not age; guarded transitions.
it('never sweeps a long job that is still making progress (heartbeat), only one that stopped', async () => {
    const live = await job('manual', 120);
    const dead = await job('manual', 120);
    await dbRun(`UPDATE processing_jobs SET last_progress_at = NOW() - INTERVAL '2 minutes' WHERE id = $1`, [live]);
    await dbRun(`UPDATE processing_jobs SET last_progress_at = NOW() - INTERVAL '45 minutes' WHERE id = $1`, [dead]);
    expect((await sweepStaleJobs({ env: {} })).failed.map(x => x.id)).toEqual([dead]);
});

it('a run whose job the sweeper closed mid-run starts no further source and never flips it back to completed', async () => {
    await seedSources();
    await seedMethodology();
    const jobId = await job('manual', 0);
    const inner = fixtureTransport([
        ['https://feeds.bbci.co.uk/robots.txt', 'recorded/bbc-robots.txt'],
        ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'recorded/bbc-technology.xml'],
        [/hn\.algolia\.com/, 'recorded/hn-algolia.json'],
    ]);
    let swept = false;
    const transport = async (url, init) => {
        // The sweeper fires while the first source is being fetched.
        if (!swept) {
            swept = true;
            await dbRun(`UPDATE processing_jobs SET status = 'failed', error_details = 'stale: closed by the stale-job sweeper' WHERE id = $1`, [jobId]);
        }
        return inner(url, init);
    };
    const queues = { enqueueEmbeds: jest.fn().mockResolvedValue(), enqueueIngestRetry: jest.fn().mockResolvedValue() };
    const s = await runCollection({ slugs: ['bbc_news', 'hacker_news'], jobId, triggeredBy: 'manual', env: TEST_ENV, transport, queues,
        now: () => Date.parse(RECORDED_AT), collectorCtx: { sleep: () => Promise.resolve() } });
    expect(s.sources.find(x => x.slug === 'hacker_news').reason).toMatch(/closed as stale/);
    const row = await dbGet('SELECT status, error_details FROM processing_jobs WHERE id = $1', [jobId]);
    expect(row).toEqual({ status: 'failed', error_details: 'stale: closed by the stale-job sweeper' });
    expect(s.swept).toBe(true);
});

it('gives refresh runs a deadline shorter than the staleness bound', () => {
    expect(refreshDeadlineMs({})).toBe(24 * 60000);
    expect(refreshDeadlineMs({ REFRESH_STALE_MINUTES: '10' })).toBe(8 * 60000);
    expect(refreshDeadlineMs({ REFRESH_STALE_MINUTES: '1' })).toBe(60000);
});
