// tests/integration/collect.cycle.test.js
// Scheduled per-source runs share one collection-cycle job
// (src/collectors/cycle.js): the bias checks run ONCE over every source's
// posts when the cycle closes — never on a one-source job, where location
// concentration would read 1.000 by construction.

'use strict';

const { dbAll, dbGet, dbRun } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { currentCycleJob, closeCycles, joinCycle, leaveCycle, hardCapMs } = require('../../src/collectors/cycle');
const state = require('../../src/collectors/state');
const { seedSources, seedMethodology } = require('../../scripts/seed');
const { fixtureTransport, RECORDED_AT, TEST_ENV } = require('../helpers/fixtureTransport');

const WINDOW = 150000;
const ROUTES = [
    ['https://feeds.bbci.co.uk/robots.txt', 'recorded/bbc-robots.txt'],
    ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'recorded/bbc-technology.xml'],
    [/hn\.algolia\.com/, 'recorded/hn-algolia.json'],
];

function cronRun(slug) {
    return runCollection({
        slugs: [slug], triggeredBy: 'cron', cycle: { windowMs: WINDOW }, env: TEST_ENV,
        transport: fixtureTransport(ROUTES), now: () => Date.parse(RECORDED_AT),
        queues: { enqueueEmbeds: async () => {}, enqueueIngestRetry: async () => {} },
    });
}

beforeEach(async () => {
    await seedSources();
    await seedMethodology();
});

it('per-source runs in one window share a cycle job; no per-source bias checks', async () => {
    const a = await cronRun('bbc_news');
    const b = await cronRun('hacker_news');
    expect(a.jobId).toBe(b.jobId);
    expect(a.bias).toBeNull();
    const job = await dbGet('SELECT status, posts_processed, sources_queried FROM processing_jobs WHERE id = $1', [a.jobId]);
    expect(job).toEqual({ status: 'running', posts_processed: a.postsProcessed + b.postsProcessed, sources_queried: 2 });
    expect((await dbGet('SELECT inflight_runs FROM processing_jobs WHERE id = $1', [a.jobId])).inflight_runs).toBe(0);
    expect((await dbGet('SELECT COUNT(*)::int AS n FROM bias_assessments')).n).toBe(0);
});

it('closing a cycle runs the bias checks once over every source\'s posts', async () => {
    const a = await cronRun('bbc_news');
    await cronRun('hacker_news');
    expect(await closeCycles(WINDOW)).toEqual([]);                 // still inside its window
    await dbRun(`UPDATE processing_jobs SET started_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [a.jobId]);
    const closed = await closeCycles(WINDOW);
    expect(closed).toHaveLength(1);
    expect(closed[0].jobId).toBe(a.jobId);
    const bias = await dbAll('SELECT assessment_type, group_value FROM bias_assessments WHERE job_id = $1', [a.jobId]);
    expect(bias).toHaveLength(3);
    // The parity check sees BOTH categories (news, forums) — impossible on a one-source job.
    expect(bias.find(x => x.assessment_type === 'platform_sentiment_parity').group_value).toMatch(/news vs forums|forums vs news/);
    expect((await dbGet('SELECT status FROM processing_jobs WHERE id = $1', [a.jobId])).status).toBe('completed');
    // A later run opens a NEW cycle.
    await dbRun(`UPDATE source_collection_state SET last_attempt_at = NOW() - INTERVAL '1 day'`);
    expect(await currentCycleJob(WINDOW)).not.toBe(a.jobId);
});

it('concurrent workers agree on one cycle job', async () => {
    const ids = await Promise.all([1, 2, 3, 4].map(() => currentCycleJob(WINDOW)));
    expect(new Set(ids).size).toBe(1);
});

it('a cycle whose bias checks cannot run is marked failed, never left running', async () => {
    const id = (await cronRun('hacker_news')).jobId;   // audited posts, run left the cycle
    await dbRun(`UPDATE processing_jobs SET started_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [id]);
    // A cycle module whose methodology lookup fails (no audit row is touched).
    let isolated;
    jest.isolateModules(() => {
        jest.doMock('../../src/pipeline/methodology', () => ({
            resolveCurrentMethodology: jest.fn().mockRejectedValue(new Error('methodology not registered for bias@1.1.0')),
        }));
        isolated = require('../../src/collectors/cycle');
    });
    await isolated.closeCycles(WINDOW);
    const job = await dbGet('SELECT status, error_details FROM processing_jobs WHERE id = $1', [id]);
    expect(job.status).toBe('failed');
    expect(job.error_details).toMatch(/cycle close failed: methodology not registered/);
});

// ─── G10-2: the cycle-close race ──────────────────────────────────────────────
const age = (id, minutes) => dbRun(`UPDATE processing_jobs SET started_at = NOW() - make_interval(mins => $2) WHERE id = $1`, [id, minutes]);

it('a cycle with a run in flight is not closed until the run leaves it', async () => {
    const id = await currentCycleJob(WINDOW);          // a run joined (inflight 1)
    await age(id, 5);
    expect(await closeCycles(WINDOW)).toEqual([]);
    await leaveCycle(id, {});
    expect((await closeCycles(WINDOW)).map(c => c.jobId)).toEqual([id]);
});

it('past the hard age cap a cycle closes even with a run marked in flight (a run that died)', async () => {
    const id = await currentCycleJob(WINDOW);
    await age(id, Math.ceil(hardCapMs(WINDOW) / 60000) + 1);
    expect((await closeCycles(WINDOW)).map(c => c.jobId)).toEqual([id]);
});

it('two workers closing at once: each cycle is claimed and bias-checked exactly once', async () => {
    const a = await cronRun('bbc_news');
    await cronRun('hacker_news');
    await age(a.jobId, 10);
    const [x, y] = await Promise.all([closeCycles(WINDOW), closeCycles(WINDOW)]);
    expect(x.length + y.length).toBe(1);
    expect((await dbGet('SELECT COUNT(*)::int AS n FROM bias_assessments WHERE job_id = $1', [a.jobId])).n).toBe(3);
});

it('posts are counted from decision_audit_log at close, not from the counter', async () => {
    const a = await cronRun('hacker_news');
    await dbRun(`UPDATE processing_jobs SET posts_processed = 999 WHERE id = $1`, [a.jobId]);
    await age(a.jobId, 10);
    const [c] = await closeCycles(WINDOW);
    const audited = (await dbGet('SELECT COUNT(DISTINCT raw_post_id)::int AS n FROM decision_audit_log WHERE job_id = $1', [a.jobId])).n;
    expect(audited).toBeGreaterThan(0);
    expect(c.postsProcessed).toBe(audited);
    expect((await dbGet('SELECT posts_processed FROM processing_jobs WHERE id = $1', [a.jobId])).posts_processed).toBe(audited);
});

it('a closed cycle is never joined: joinCycle falls through to the current cycle', async () => {
    const old = await currentCycleJob(WINDOW);
    await leaveCycle(old, {});
    await age(old, 10);
    await closeCycles(WINDOW);
    const now = await joinCycle(old, WINDOW);
    expect(now).not.toBe(old);
    expect((await dbGet('SELECT inflight_runs, status FROM processing_jobs WHERE id = $1', [now]))).toEqual({ inflight_runs: 1, status: 'running' });
});

it('a run that throws after scoring still accounts its posts and leaves the cycle', async () => {
    const spy = jest.spyOn(state, 'saveOutcome').mockRejectedValueOnce(new Error('db blip'));
    try {
        await expect(cronRun('hacker_news')).rejects.toThrow('db blip');
    } finally {
        spy.mockRestore();
    }
    const job = await dbGet(`SELECT id, inflight_runs, posts_processed FROM processing_jobs WHERE triggered_by = 'cron' ORDER BY started_at DESC LIMIT 1`);
    expect(job.inflight_runs).toBe(0);
    const audited = (await dbGet('SELECT COUNT(DISTINCT raw_post_id)::int AS n FROM decision_audit_log WHERE job_id = $1', [job.id])).n;
    expect(audited).toBeGreaterThan(0);
    expect(job.posts_processed).toBe(audited);
});
