// tests/integration/collect.cycle.test.js
// Scheduled per-source runs share one collection-cycle job
// (src/collectors/cycle.js): the bias checks run ONCE over every source's
// posts when the cycle closes — never on a one-source job, where location
// concentration would read 1.000 by construction.

'use strict';

const { dbAll, dbGet, dbRun } = require('../../src/db/connection');
const { runCollection } = require('../../src/collectors/runner');
const { currentCycleJob, closeCycles } = require('../../src/collectors/cycle');
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
    const id = await currentCycleJob(WINDOW);
    await dbRun(`UPDATE processing_jobs SET posts_processed = 1, started_at = NOW() - INTERVAL '10 minutes' WHERE id = $1`, [id]);
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
