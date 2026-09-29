// tests/integration/collect.retryAccounting.test.js — Copilot 4129565673:
// a scoring retry accounts to the job that queued it, and that job's bias
// checks wait for it (a refresh job goes to 'awaiting_retries'; a cycle does
// not close) until the retry has scored.

'use strict';

jest.mock('../../src/queues/index', () => ({ embedQueue: { add: jest.fn().mockResolvedValue({ id: 'e1' }) } }));

const { dbGet, dbAll, dbRun } = require('../../src/db/connection');
const { closeCycles } = require('../../src/collectors/cycle');
const { processIngestJob, onIngestJobFailed } = require('../../src/workers/ingest.worker');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const HN = [['https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=50', 'recorded/hn-algolia.json']];

/** A runner whose first scorePost call fails (so one retry is queued). */
function runnerWithOneScoringFailure() {
    let runCollection;
    jest.isolateModules(() => {
        const real = jest.requireActual('../../src/pipeline/ingest');
        let failed = false;
        jest.doMock('../../src/pipeline/ingest', () => ({
            ...real,
            scorePost: async (...a) => { if (!failed) { failed = true; throw new Error('db blip'); } return real.scorePost(...a); },
        }));
        ({ runCollection } = require('../../src/collectors/runner'));
    });
    return runCollection;
}
async function run(extra) {
    const queued = [];
    const s = await runnerWithOneScoringFailure()({
        slugs: ['hacker_news'], env: TEST_ENV, now: () => Date.parse(RECORDED_AT), transport: fixtureTransport(HN),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async d => queued.push(d) },
        collectorCtx: { sleep: () => Promise.resolve() }, ...extra,
    });
    return { s, queued };
}
const job = id => dbGet('SELECT status, inflight_runs, posts_processed FROM processing_jobs WHERE id = $1', [id]);
const audited = async id => (await dbGet('SELECT COUNT(DISTINCT raw_post_id)::int AS n FROM decision_audit_log WHERE job_id = $1', [id])).n;
const biasRows = async id => (await dbGet('SELECT COUNT(*)::int AS n FROM bias_assessments WHERE job_id = $1', [id])).n;

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

it('a refresh-style job waits for its retry: awaiting_retries, then finalized with the retried post and bias once', async () => {
    const pre = await dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('api', 'running') RETURNING id`);
    const { s, queued } = await run({ jobId: pre.id, triggeredBy: 'api' });
    expect(queued).toEqual([expect.objectContaining({ jobId: pre.id, reserved: true })]);
    expect(await job(pre.id)).toMatchObject({ status: 'awaiting_retries', inflight_runs: 1 });
    expect(await biasRows(pre.id)).toBe(0);                     // bias waits
    expect(await closeCycles(150000)).toEqual([]);             // retry outstanding

    await processIngestJob({ data: queued[0] });                // the retry scores under ITS job
    expect(await job(pre.id)).toMatchObject({ status: 'awaiting_retries', inflight_runs: 0 });
    const closed = await closeCycles(150000);
    expect(closed.map(c => c.jobId)).toEqual([pre.id]);
    const n = await audited(pre.id);
    expect(n).toBe(s.postsProcessed + 1);                       // the retried post is this job's
    expect(await job(pre.id)).toMatchObject({ status: 'completed', posts_processed: n });
    expect(await biasRows(pre.id)).toBe(3);                     // bias once, after the retry
});

it('a cycle does not close while a queued retry is outstanding; the retried post is counted in it', async () => {
    const { s, queued } = await run({ triggeredBy: 'cron', cycle: { windowMs: 150000 } });
    expect(await job(s.jobId)).toMatchObject({ status: 'running', inflight_runs: 1 });
    await dbRun(`UPDATE processing_jobs SET started_at = NOW() - interval '5 minutes' WHERE id = $1`, [s.jobId]);
    expect(await closeCycles(150000)).toEqual([]);
    await processIngestJob({ data: queued[0] });
    const [c] = await closeCycles(150000);
    expect(c.jobId).toBe(s.jobId);
    expect(c.postsProcessed).toBe(s.postsProcessed + 1);
});

it('a retry\'s last failed attempt releases its slot (the job is not held forever); earlier attempts do not', async () => {
    const pre = await dbRun(`INSERT INTO processing_jobs (triggered_by, status, inflight_runs) VALUES ('api', 'awaiting_retries', 1) RETURNING id`);
    const data = { rawPostId: '00000000-0000-4000-8000-000000000001', jobId: pre.id, reserved: true };
    expect(await onIngestJobFailed({ data, attemptsMade: 2, opts: { attempts: 5 } })).toBe(false);
    expect((await job(pre.id)).inflight_runs).toBe(1);
    expect(await onIngestJobFailed({ data, attemptsMade: 5, opts: { attempts: 5 } })).toBe(true);
    expect((await job(pre.id)).inflight_runs).toBe(0);
    expect(await onIngestJobFailed({ data: { ...data, reserved: false }, attemptsMade: 5, opts: { attempts: 5 } })).toBe(false);
});

it('without retries a refresh-style job completes at once, with bias', async () => {
    const pre = await dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('api', 'running') RETURNING id`);
    const { runCollection } = require('../../src/collectors/runner');
    await runCollection({
        slugs: ['hacker_news'], env: TEST_ENV, now: () => Date.parse(RECORDED_AT), transport: fixtureTransport(HN),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} }, jobId: pre.id, triggeredBy: 'api',
        collectorCtx: { sleep: () => Promise.resolve() },
    });
    expect(await job(pre.id)).toMatchObject({ status: 'completed', inflight_runs: 0 });
    expect(await biasRows(pre.id)).toBe(3);
    expect(await dbAll(`SELECT id FROM processing_jobs WHERE status = 'awaiting_retries'`)).toEqual([]);
});
