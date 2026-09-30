// tests/integration/collect.topology.test.js
// P10-12 worker topology: a collect job STORES posts and enqueues one
// `ingest` job per new post (scoring leaves the collect event loop), while
//   - G10-2: each queued post holds a slot on its cycle (inflight_runs), so
//     the cycle cannot close — and its bias checks cannot run — before the
//     post is scored; the ingest job scores under that cycle and releases it;
//   - G10-4: an enqueue failure is a run error (never swallowed), its slot
//     is released, and the unscored post is left to the sweep;
// and the PostgreSQL pool is sized against the worker's concurrency.

'use strict';

jest.mock('../../src/queues/index', () => ({ embedQueue: { add: jest.fn().mockResolvedValue({ id: 'e1' }) } }));

const { dbGet, dbAll } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { closeCycles } = require('../../src/collectors/cycle');
const { processIngestJob } = require('../../src/workers/ingest.worker');
const { sweepUnscored } = require('../../src/collectors/sweep');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');
const { workerPoolSize, requiredWorkerPool, workerConcurrency } = require('../../src/db/pool-size');

const HN = [['https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=50', 'recorded/hn-algolia.json']];
const WINDOW = 150000;

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

function run(queues) {
    return runCollection({
        slugs: ['hacker_news'], env: TEST_ENV, now: () => Date.parse(RECORDED_AT), transport: fixtureTransport(HN),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {}, ...queues },
        collectorCtx: { sleep: () => Promise.resolve() }, cycle: { windowMs: WINDOW }, scoreVia: 'queue',
    });
}
const job = id => dbGet('SELECT status, inflight_runs FROM processing_jobs WHERE id = $1', [id]);

it('stores and enqueues; nothing is scored on the collect loop; the cycle waits for every queued post', async () => {
    const queued = [];
    const s = await run({ enqueueIngest: async d => queued.push(d) });
    expect(s.sources[0].outcome).toBe('ok');
    expect(s.queuedForScoring).toBeGreaterThan(0);
    expect(queued).toHaveLength(s.queuedForScoring);
    for (const d of queued) expect(d).toMatchObject({ jobId: s.jobId, reserved: true });
    expect(await dbAll('SELECT id FROM decision_audit_log')).toEqual([]);      // not scored inline
    expect(await job(s.jobId)).toMatchObject({ status: 'running', inflight_runs: queued.length });

    // Even past the window + grace, the cycle does not close with posts queued.
    await require('../../src/db/connection').dbRun(
        `UPDATE processing_jobs SET started_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, [s.jobId]);
    expect(await closeCycles(WINDOW)).toEqual([]);

    for (const d of queued) await processIngestJob({ data: d });              // the ingest worker scores
    expect(await job(s.jobId)).toMatchObject({ inflight_runs: 0 });
    const closed = await closeCycles(WINDOW);
    expect(closed).toEqual([expect.objectContaining({ jobId: s.jobId, postsProcessed: queued.length })]);
    expect((await dbGet('SELECT COUNT(*)::int AS n FROM bias_assessments WHERE job_id = $1', [s.jobId])).n).toBe(3);
});

it('an enqueue failure is a run error, releases its slot, and the sweep re-queues the unscored post', async () => {
    const s = await run({ enqueueIngest: async () => { throw new Error('redis down'); } });
    expect(s.sources[0].outcome).toBe('error');
    expect(s.sources[0].error).toMatch(/scoring job could not be queued \(redis down\)/);
    expect(await job(s.jobId)).toMatchObject({ inflight_runs: 0 });
    await require('../../src/db/connection').dbRun(`UPDATE raw_posts SET collected_at = NOW() - INTERVAL '10 minutes'`);
    const swept = [];
    const r = await sweepUnscored({ enqueue: async d => swept.push(d) });
    expect(r.found).toBeGreaterThan(0);
    expect(swept.length).toBe(r.found);
});

describe('pool sizing (src/db/pool-size.js)', () => {
    const OPEN = { CORRELATION_DPIA_REF: 'DPIA-1', CORRELATION_ENABLED: 'true', CORRELATION_SALT: 'a3f09c1be4d27f6a8c5e0b9d1f2a7c3e' };

    it('sizes the worker pool to its concurrency; correlate counts only while the DPIA gate is open', () => {
        const c = workerConcurrency({});
        expect(c).toEqual({ collect: 4, ingest: 8, embed: 4, correlate: 8 });
        expect(requiredWorkerPool(c)).toBe(2 * 4 + 2 + 24 + 4 + 8 + 1 + 2);
        expect(requiredWorkerPool(c, { correlation: false })).toBe(41);
        expect(workerPoolSize({})).toMatchObject({ size: 41, required: 41, explicit: false, short: false, correlation: false });
        // PR #22 grumpy M7: correlation is not implemented, so even with every switch set the gate stays shut and correlate needs no connections.
        expect(workerPoolSize(OPEN)).toMatchObject({ size: 41, required: 41, correlation: false });
        expect(workerPoolSize({ INGEST_CONCURRENCY: '40' }).size).toBe(60);   // capped
    });

    // PR #22 P1-21: a host PG_POOL_MAX never shrinks the worker pool.
    it('ignores PG_POOL_MAX for the worker; WORKER_PG_POOL_MAX sizes it and a short one is flagged', () => {
        expect(workerPoolSize({ PG_POOL_MAX: '10' })).toMatchObject({ size: 41, explicit: false, hostPoolMaxIgnored: 10 });
        expect(workerPoolSize({ WORKER_PG_POOL_MAX: '10' })).toMatchObject({ size: 10, required: 41, explicit: true, short: true });
    });

    it('budgets every process against max_connections and refuses an over-budget deployment', async () => {
        const { connectionBudget, checkPoolBudget } = require('../../src/db/pool-size');
        expect(connectionBudget({}, 41)).toEqual({ replicas: 1, workerPool: 41, web: 10, watchdog: 2, oneShot: 10, total: 63 });
        expect(connectionBudget({ WORKER_REPLICAS: '2', PG_POOL_MAX: '20' }, 41).total).toBe(2 * 41 + 20 + 2 + 10);
        const pg = (max, reserved) => async sql => (/max_connections/.test(sql) ? { max_connections: String(max) } : { superuser_reserved_connections: String(reserved) });
        expect(await checkPoolBudget({ env: {}, workerPool: 41, get: pg(100, 3) })).toMatchObject({ ok: true, total: 63, available: 97 });
        const over = await checkPoolBudget({ env: { WORKER_REPLICAS: '2' }, workerPool: 41, get: pg(100, 3) });
        expect(over).toMatchObject({ ok: false, total: 104, available: 97 });
        expect(over.message).toMatch(/connection budget exceeded: 2 worker\(s\) × 41 \+ web 10 \+ watchdog 2 \+ one-shot reserve 10 = 104/);
    });

    it('reads the real server settings (test database)', async () => {
        const { checkPoolBudget } = require('../../src/db/pool-size');
        const r = await checkPoolBudget({ env: {}, workerPool: 1, get: sql => dbGet(sql) });
        expect(r.available).toBeGreaterThan(0);
        expect(r.ok).toBe(true);
    });
});
