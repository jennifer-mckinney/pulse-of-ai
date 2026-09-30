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
// collide; one throwaway queue per source_type (only rss is exercised).
jest.mock('../../src/queues/index', () => {
    const { Queue } = require('bullmq');
    // The app's own connection config, so REDIS_PASSWORD (F9-1 requirepass)
    // is honoured exactly as the worker and web honour it.
    const { redisConnection } = require('../../src/queues/connection');
    const connection = redisConnection(process.env);
    const suffix = `${Date.now()}-${process.pid}`;
    const COLLECT_QUEUES = {
        rss:  new Queue(`test-sched-rss-${suffix}`,  { connection }),
        api:  new Queue(`test-sched-api-${suffix}`,  { connection }),
        bulk: new Queue(`test-sched-bulk-${suffix}`, { connection }),
    };
    return { COLLECT_QUEUES };
});

const { dbAll } = require('../../src/db/connection');
const queues = require('../../src/queues/index');
const { scheduleAllSources, COLLECT_WINDOW_MS } = require('../../src/workers/collector.scheduler');

const ALL_QUEUES = Object.values(queues.COLLECT_QUEUES);
const ENV = { COLLECTOR_CONTACT_URL: 'https://example.org/c', PERMISSION_GATED_FEEDS_ACCEPTED_BY: 'Test Operator 2026-09-29', GATE_APPROVED_BY: 'Test Operator 2026-09-29', COLLECT_WINDOW_MS: String(COLLECT_WINDOW_MS) };

// Two same-type (rss) registry sources.
function makeSource(overrides = {}) {
    return { id: 'src-a', name: 'bbc_news', source_type: 'rss', ...overrides };
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
            makeSource({ id: 'src-a', name: 'bbc_news' }),
            makeSource({ id: 'src-b', name: 'npr' }),
        ]);

        const count = await scheduleAllSources({ env: ENV });
        expect(count).toBe(2);

        const schedulers = await queues.COLLECT_QUEUES.rss.getJobSchedulers();
        expect(schedulers).toHaveLength(2); // legacy repeat collapsed this to 1

        const ids = schedulers.map(s => s.key).sort();
        expect(ids).toEqual(['bbc_news', 'npr']);

        // Stagger survives: first runs are COLLECT_WINDOW_MS/2 apart
        const nextById = Object.fromEntries(schedulers.map(s => [s.key, s.next]));
        expect(Number.isFinite(nextById.bbc_news)).toBe(true);
        expect(Number.isFinite(nextById.npr)).toBe(true);
        expect(nextById.bbc_news).not.toBe(nextById.npr);
        // The first source runs "now" (clamped server-side, so allow a little
        // clock skew); the second one stagger step later — the gap must be
        // the stagger, not zero (the legacy behavior discarded it entirely).
        const gap = nextById.npr - nextById.bbc_news;
        const staggerMs = Math.floor(COLLECT_WINDOW_MS / 2);
        expect(gap).toBeGreaterThan(staggerMs - 5000);
        expect(gap).toBeLessThanOrEqual(staggerMs);
    });

    test('a re-run without a source removes its now-stale scheduler', async () => {
        // First run (above) left schedulers for both. Now only bbc_news is
        // active — npr's scheduler must be cleaned up.
        dbAll.mockResolvedValue([makeSource({ id: 'src-a' })]);

        const count = await scheduleAllSources({ env: ENV });
        expect(count).toBe(1);

        const schedulers = await queues.COLLECT_QUEUES.rss.getJobSchedulers();
        expect(schedulers.map(s => s.key)).toEqual(['bbc_news']);
    });
});
