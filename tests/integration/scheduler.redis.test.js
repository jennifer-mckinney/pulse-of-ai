// tests/integration/scheduler.redis.test.js
// Redis-backed integration test for src/workers/collector.scheduler.js.
//
// Purpose: prove against a REAL Redis (docker compose, localhost:6379) that
// two same-type sources produce TWO coexisting job schedulers with distinct
// ids and distinct next-run times — the exact behavior the legacy `repeat`
// API collapsed into one deduplicated job.
//
// Deliberately DB-independent: the db module is stubbed (this suite runs
// under the main jest config whose setup.js truncates Postgres tables per
// file — stubbing keeps this test orthogonal to that). The queue registry is
// replaced with throwaway uniquely-named real BullMQ queues so nothing here
// touches the app's collect.* queues; afterAll obliterates them and closes
// every connection (no open handles).

'use strict';

jest.mock('../../src/db/connection', () => ({ dbAll: jest.fn() }));

// Throwaway real queues — unique name per run so parallel/aborted runs never
// collide; all four registry exports must exist because the scheduler
// destructures them (only the reddit queue is exercised).
jest.mock('../../src/queues/index', () => {
    const { Queue } = require('bullmq');
    const connection = {
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
    };
    const suffix = `${Date.now()}-${process.pid}`;
    return {
        collectRedditQueue:  new Queue(`test-sched-reddit-${suffix}`,  { connection }),
        collectRssQueue:     new Queue(`test-sched-rss-${suffix}`,     { connection }),
        collectArxivQueue:   new Queue(`test-sched-arxiv-${suffix}`,   { connection }),
        collectScraperQueue: new Queue(`test-sched-scraper-${suffix}`, { connection }),
    };
});

const { dbAll } = require('../../src/db/connection');
const queues = require('../../src/queues/index');
const { scheduleAllSources, COLLECT_WINDOW_MS } = require('../../src/workers/collector.scheduler');

const ALL_QUEUES = [
    queues.collectRedditQueue,
    queues.collectRssQueue,
    queues.collectArxivQueue,
    queues.collectScraperQueue,
];

function makeSource(overrides = {}) {
    return {
        id:          'src-a',
        name:        'r/MachineLearning',
        source_type: 'reddit',
        config:      { subreddit: 'MachineLearning' },
        ...overrides,
    };
}

afterAll(async () => {
    // Leave no trace and no open handles: wipe the throwaway queues from
    // Redis entirely, then close their connections.
    for (const q of ALL_QUEUES) {
        await q.obliterate({ force: true });
        await q.close();
    }
});

describe('scheduleAllSources() against real Redis', () => {
    test('two same-type sources coexist as two schedulers with distinct ids and next runs', async () => {
        dbAll.mockResolvedValue([
            makeSource({ id: 'src-a', name: 'r/MachineLearning' }),
            makeSource({ id: 'src-b', name: 'r/artificial' }),
        ]);

        const count = await scheduleAllSources();
        expect(count).toBe(2);

        const schedulers = await queues.collectRedditQueue.getJobSchedulers();
        expect(schedulers).toHaveLength(2); // legacy repeat collapsed this to 1

        const ids = schedulers.map(s => s.key).sort();
        expect(ids).toEqual(['src-a', 'src-b']);

        // Stagger survives: first runs are COLLECT_WINDOW_MS/2 apart
        const nextById = Object.fromEntries(schedulers.map(s => [s.key, s.next]));
        expect(Number.isFinite(nextById['src-a'])).toBe(true);
        expect(Number.isFinite(nextById['src-b'])).toBe(true);
        expect(nextById['src-a']).not.toBe(nextById['src-b']);
        // src-a's first run is "now" (clamped server-side, so allow a little
        // clock skew); src-b's is one stagger step later — the gap must be
        // the stagger, not zero (the legacy behavior discarded it entirely).
        const gap = nextById['src-b'] - nextById['src-a'];
        const staggerMs = Math.floor(COLLECT_WINDOW_MS / 2);
        expect(gap).toBeGreaterThan(staggerMs - 5000);
        expect(gap).toBeLessThanOrEqual(staggerMs);
    });

    test('a re-run without a source removes its now-stale scheduler', async () => {
        // First run (above) left schedulers for src-a and src-b. Now only
        // src-a is active — src-b's scheduler must be cleaned up.
        dbAll.mockResolvedValue([makeSource({ id: 'src-a' })]);

        const count = await scheduleAllSources();
        expect(count).toBe(1);

        const schedulers = await queues.collectRedditQueue.getJobSchedulers();
        expect(schedulers.map(s => s.key)).toEqual(['src-a']);
    });
});
