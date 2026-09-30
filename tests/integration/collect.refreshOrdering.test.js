// tests/integration/collect.refreshOrdering.test.js
// A refresh-style (one-shot, non-cycle) job's counts and per-job bias checks
// must not depend on WHEN its queued scoring finishes relative to the end of
// its collection run (scoreVia 'queue', the worker's POST /api/refresh path):
//
//   - scoring AFTER the run ends: the job waits in 'awaiting_retries' and
//     closeCycles finalizes it (posts_processed from decision_audit_log,
//     bias once);
//   - scoring BEFORE the run ends (a fast ingest worker): every reserved
//     slot is already released when the run ends, so the run itself must
//     finalize the job the same way. Before the fix it completed with
//     posts_processed = 0 and never ran the job's bias checks, because it
//     only counted the posts it had scored inline (none, in queue mode).
//
// Real test DB and recorded fixtures; only BullMQ is replaced by direct
// calls to the ingest worker handler.

'use strict';

jest.mock('../../src/queues/index', () => ({ embedQueue: { add: jest.fn().mockResolvedValue({ id: 'e1' }) } }));

const { dbGet, dbRun } = require('../../src/db/connection');
const { closeCycles } = require('../../src/collectors/cycle');
const { runCollection } = require('../../src/collectors/runner');
const { processIngestJob } = require('../../src/workers/ingest.worker');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const HN = [['https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=50', 'recorded/hn-algolia.json']];
const WINDOW_MS = 150000;

const job = id => dbGet('SELECT status, inflight_runs, posts_processed, completed_at FROM processing_jobs WHERE id = $1', [id]);
const audited = async id => (await dbGet(
    'SELECT COUNT(DISTINCT raw_post_id)::int AS n FROM decision_audit_log WHERE job_id = $1', [id])).n;
const biasRows = async id => (await dbGet('SELECT COUNT(*)::int AS n FROM bias_assessments WHERE job_id = $1', [id])).n;
const stored = async () => (await dbGet('SELECT COUNT(*)::int AS n FROM raw_posts')).n;

async function refreshJob() {
    return dbRun(`INSERT INTO processing_jobs (triggered_by, status) VALUES ('api', 'running') RETURNING id`);
}

function collect(jobId, enqueueIngest) {
    return runCollection({
        slugs: ['hacker_news'], env: TEST_ENV, now: () => Date.parse(RECORDED_AT), transport: fixtureTransport(HN),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {}, enqueueIngest },
        collectorCtx: { sleep: () => Promise.resolve() },
        scoreVia: 'queue', jobId, triggeredBy: 'api',
    });
}

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

describe('refresh job finalization is independent of scoring order (scoreVia queue)', () => {
    it('scoring BEFORE the run ends: the run completes the job with the audited count and runs bias once', async () => {
        const pre = await refreshJob();
        // A fast ingest worker: each post is scored as soon as it is queued,
        // so every reserved slot is released before the run ends.
        const s = await collect(pre.id, data => processIngestJob({ data }));

        const n = await audited(pre.id);
        expect(n).toBeGreaterThan(0);
        expect(n).toBe(await stored());
        const row = await job(pre.id);
        expect(row).toMatchObject({ status: 'completed', inflight_runs: 0, posts_processed: n });
        expect(row.completed_at).not.toBeNull();
        expect(await biasRows(pre.id)).toBe(3);
        expect(s.postsProcessed).toBe(n);
        expect(s.bias).toEqual({ checksRun: 3, violationsFound: expect.any(Number) });
        expect(s.awaitingRetries).toBe(false);
        // Nothing is left for closeCycles: the job is not finalized twice.
        expect(await closeCycles(WINDOW_MS)).toEqual([]);
        expect(await biasRows(pre.id)).toBe(3);
    });

    it('scoring AFTER the run ends: awaiting_retries, then closeCycles finalizes it with the same count and bias once', async () => {
        const pre = await refreshJob();
        const queued = [];
        const s = await collect(pre.id, async data => { queued.push(data); });
        expect(queued.length).toBe(await stored());
        expect(s.awaitingRetries).toBe(true);
        expect(await job(pre.id)).toMatchObject({ status: 'awaiting_retries', inflight_runs: queued.length });
        expect(await biasRows(pre.id)).toBe(0);

        for (const data of queued) await processIngestJob({ data });
        const closed = await closeCycles(WINDOW_MS);
        expect(closed.map(c => c.jobId)).toEqual([pre.id]);
        const n = await audited(pre.id);
        expect(n).toBe(queued.length);
        expect(await job(pre.id)).toMatchObject({ status: 'completed', inflight_runs: 0, posts_processed: n });
        expect(await biasRows(pre.id)).toBe(3);
    });

    it('scoring SPLIT across the end of the run: the run leaves it to closeCycles, which counts every post once', async () => {
        const pre = await refreshJob();
        const late = [];
        let i = 0;
        // Every other post is scored at once, the rest after the run ends.
        await collect(pre.id, async data => { if (i++ % 2 === 0) await processIngestJob({ data }); else late.push(data); });
        expect(late.length).toBeGreaterThan(0);
        expect(await job(pre.id)).toMatchObject({ status: 'awaiting_retries', inflight_runs: late.length });
        expect(await biasRows(pre.id)).toBe(0);

        for (const data of late) await processIngestJob({ data });
        await closeCycles(WINDOW_MS);
        const n = await audited(pre.id);
        expect(n).toBe(await stored());
        expect(await job(pre.id)).toMatchObject({ status: 'completed', posts_processed: n });
        expect(await biasRows(pre.id)).toBe(3);
    });

    it('a run that stores nothing new completes with 0 processed and no bias rows', async () => {
        const pre = await refreshJob();
        await collect(pre.id, data => processIngestJob({ data }));
        // Same fixture again: every item is a duplicate, nothing is queued.
        const second = await refreshJob();
        const s = await collect(second.id, () => { throw new Error('nothing should be queued'); });
        expect(await job(second.id)).toMatchObject({ status: 'completed', posts_processed: 0 });
        expect(await biasRows(second.id)).toBe(0);
        expect(s.bias).toBeNull();
    });

    it('a job the stale-job sweeper closed mid-run is left as it is: no bias, no completion', async () => {
        const pre = await refreshJob();
        await collect(pre.id, async (data) => {
            await processIngestJob({ data });
            // The sweeper closes the job while the run is still going.
            await dbRun(`UPDATE processing_jobs SET status = 'failed', error_details = 'stale' WHERE id = $1`, [pre.id]);
        });
        const row = await job(pre.id);
        expect(row.status).toBe('failed');
        expect(await biasRows(pre.id)).toBe(0);
    });
});

describe('inline scoring (CLI / populate) counts retries that scored before the run ended', () => {
    it('a retry that scored under the job before the run ended is in posts_processed', async () => {
        let runner;
        jest.isolateModules(() => {
            const real = jest.requireActual('../../src/pipeline/ingest');
            let failed = false;
            jest.doMock('../../src/pipeline/ingest', () => ({
                ...real,
                scorePost: async (...a) => { if (!failed) { failed = true; throw new Error('db blip'); } return real.scorePost(...a); },
            }));
            ({ runCollection: runner } = require('../../src/collectors/runner'));
        });
        const pre = await refreshJob();
        const s = await runner({
            slugs: ['hacker_news'], env: TEST_ENV, now: () => Date.parse(RECORDED_AT), transport: fixtureTransport(HN),
            // The retry is picked up and scored before the run ends.
            queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: data => processIngestJob({ data }) },
            collectorCtx: { sleep: () => Promise.resolve() }, jobId: pre.id, triggeredBy: 'api',
        });
        const n = await audited(pre.id);
        expect(n).toBe(await stored());
        expect(s.scoringRetries).toBe(1);
        expect(s.postsProcessed).toBe(n);
        expect(await job(pre.id)).toMatchObject({ status: 'completed', posts_processed: n });
        expect(await biasRows(pre.id)).toBe(3);
    });
});
