// tests/unit/workers.scheduler.test.js
// Tests for src/workers/collector.scheduler.js
//
// The scheduler loads active data sources and registers one repeating BullMQ
// job per source, staggered evenly across COLLECT_WINDOW_MS so all sources do
// not fire simultaneously (thundering-herd guard).
//
// Strategy: mock the DB and the queue registry (same pattern as
// tests/unit/workers.ingest.test.js) — no Postgres, no Redis. The scheduler
// uses BullMQ's repeat option rather than node-cron, so tests assert the
// repeat/delay job options instead of a cron pattern.

'use strict';

// Mock BullMQ queues before any require() that might connect to Redis
jest.mock('../../src/queues/index', () => ({
    collectRedditQueue:  { name: 'collect.reddit',  add: jest.fn().mockResolvedValue({ id: 'job-reddit' }) },
    collectRssQueue:     { name: 'collect.rss',     add: jest.fn().mockResolvedValue({ id: 'job-rss' }) },
    collectArxivQueue:   { name: 'collect.arxiv',   add: jest.fn().mockResolvedValue({ id: 'job-arxiv' }) },
    collectScraperQueue: { name: 'collect.scraper', add: jest.fn().mockResolvedValue({ id: 'job-scraper' }) },
}));

// Mock the DB layer — sources come from a plain array, no Postgres needed
jest.mock('../../src/db/connection', () => ({ dbAll: jest.fn() }));

const { dbAll } = require('../../src/db/connection');
const {
    collectRedditQueue,
    collectRssQueue,
    collectArxivQueue,
    collectScraperQueue,
} = require('../../src/queues/index');
const {
    scheduleAllSources,
    COLLECT_WINDOW_MS,
    QUEUE_BY_TYPE,
} = require('../../src/workers/collector.scheduler');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeSource(overrides = {}) {
    return {
        id:          'src-uuid-1',
        name:        'r/MachineLearning',
        source_type: 'reddit',
        config:      { subreddit: 'MachineLearning' },
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('QUEUE_BY_TYPE', () => {
    it('maps every source type to its collect queue', () => {
        expect(QUEUE_BY_TYPE).toEqual({
            reddit:  collectRedditQueue,
            rss:     collectRssQueue,
            arxiv:   collectArxivQueue,
            scraper: collectScraperQueue,
        });
    });
});

describe('scheduleAllSources()', () => {
    it('queries only active data sources', async () => {
        dbAll.mockResolvedValue([]);

        await scheduleAllSources();

        expect(dbAll).toHaveBeenCalledWith(
            expect.stringMatching(/FROM data_sources\s+WHERE active = true/i),
        );
    });

    it('returns 0 and enqueues nothing when no sources are active', async () => {
        dbAll.mockResolvedValue([]);

        const count = await scheduleAllSources();

        expect(count).toBe(0);
        expect(collectRedditQueue.add).not.toHaveBeenCalled();
        expect(collectRssQueue.add).not.toHaveBeenCalled();
        expect(collectArxivQueue.add).not.toHaveBeenCalled();
        expect(collectScraperQueue.add).not.toHaveBeenCalled();
    });

    it('routes each source to the queue matching its source_type', async () => {
        dbAll.mockResolvedValue([
            makeSource({ id: 's1', source_type: 'reddit' }),
            makeSource({ id: 's2', source_type: 'rss' }),
            makeSource({ id: 's3', source_type: 'arxiv' }),
            makeSource({ id: 's4', source_type: 'scraper' }),
        ]);

        const count = await scheduleAllSources();

        expect(count).toBe(4);
        expect(collectRedditQueue.add).toHaveBeenCalledTimes(1);
        expect(collectRssQueue.add).toHaveBeenCalledTimes(1);
        expect(collectArxivQueue.add).toHaveBeenCalledTimes(1);
        expect(collectScraperQueue.add).toHaveBeenCalledTimes(1);
    });

    it('enqueues jobs carrying the full source payload', async () => {
        const source = makeSource();
        dbAll.mockResolvedValue([source]);

        await scheduleAllSources();

        expect(collectRedditQueue.add).toHaveBeenCalledWith(
            'collect',
            {
                sourceId:   source.id,
                sourceName: source.name,
                sourceType: source.source_type,
                config:     source.config,
            },
            expect.any(Object),
        );
    });

    it('schedules each job to repeat once per collection window', async () => {
        dbAll.mockResolvedValue([makeSource()]);

        await scheduleAllSources();

        expect(collectRedditQueue.add).toHaveBeenCalledWith(
            expect.any(String),
            expect.any(Object),
            expect.objectContaining({ repeat: { every: COLLECT_WINDOW_MS } }),
        );
    });

    it('staggers sources evenly across the window (delay = i * window/total)', async () => {
        dbAll.mockResolvedValue([
            makeSource({ id: 's1', source_type: 'reddit' }),
            makeSource({ id: 's2', source_type: 'reddit' }),
            makeSource({ id: 's3', source_type: 'reddit' }),
        ]);
        const staggerMs = Math.floor(COLLECT_WINDOW_MS / 3);

        await scheduleAllSources();

        const delays = collectRedditQueue.add.mock.calls.map(([, , opts]) => opts.delay);
        expect(delays).toEqual([0, staggerMs, 2 * staggerMs]);
    });

    it('skips sources with an unknown source_type without aborting the rest', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        dbAll.mockResolvedValue([
            makeSource({ id: 's1', source_type: 'carrier_pigeon' }),
            makeSource({ id: 's2', source_type: 'rss' }),
        ]);

        const count = await scheduleAllSources();

        expect(count).toBe(1);
        expect(collectRssQueue.add).toHaveBeenCalledTimes(1);
        expect(warnSpy).toHaveBeenCalledWith(
            expect.stringContaining('carrier_pigeon'),
        );
        warnSpy.mockRestore();
    });

    it('propagates DB errors to the caller (no swallowed failures)', async () => {
        dbAll.mockRejectedValue(new Error('connection refused'));

        await expect(scheduleAllSources()).rejects.toThrow('connection refused');
    });
});
