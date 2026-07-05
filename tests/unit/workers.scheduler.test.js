// tests/unit/workers.scheduler.test.js
// Tests for src/workers/collector.scheduler.js
//
// The scheduler loads active data sources and upserts one BullMQ v5 job
// scheduler PER SOURCE (id = String(source.id)), staggered across
// COLLECT_WINDOW_MS via `startDate`, and removes stale schedulers whose
// source is no longer active.
//
// Strategy: mock the DB and the queue registry (same pattern as
// tests/unit/workers.ingest.test.js) — no Postgres, no Redis. The Redis-backed
// behavior (distinct schedulers actually coexisting on one queue) is covered
// by tests/integration/scheduler.redis.test.js.

'use strict';

// Mock BullMQ queues before any require() that might connect to Redis
// (factory is self-contained — jest forbids out-of-scope references here)
jest.mock('../../src/queues/index', () => {
    const makeQueueMock = (name) => ({
        name,
        upsertJobScheduler: jest.fn().mockResolvedValue({ id: `job-${name}` }),
        getJobSchedulers:   jest.fn().mockResolvedValue([]),
        removeJobScheduler: jest.fn().mockResolvedValue(true),
    });
    return {
        collectRedditQueue:  makeQueueMock('collect.reddit'),
        collectRssQueue:     makeQueueMock('collect.rss'),
        collectArxivQueue:   makeQueueMock('collect.arxiv'),
        collectScraperQueue: makeQueueMock('collect.scraper'),
    };
});

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

const ALL_QUEUES = [
    collectRedditQueue,
    collectRssQueue,
    collectArxivQueue,
    collectScraperQueue,
];

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

// Deterministic clock so staggered startDates can be asserted exactly
const NOW = 1750000000000;

beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks wipes mockResolvedValue on the module-level queue mocks —
    // restore the default "no existing schedulers" behavior.
    for (const q of ALL_QUEUES) {
        q.upsertJobScheduler.mockResolvedValue({ id: `job-${q.name}` });
        q.getJobSchedulers.mockResolvedValue([]);
        q.removeJobScheduler.mockResolvedValue(true);
    }
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(() => {
    Date.now.mockRestore();
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

describe('COLLECT_WINDOW_MS', () => {
    it('is a positive finite number (guarded default)', () => {
        expect(Number.isFinite(COLLECT_WINDOW_MS)).toBe(true);
        expect(COLLECT_WINDOW_MS).toBeGreaterThan(0);
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

    it('returns 0 and upserts nothing when no sources are active', async () => {
        dbAll.mockResolvedValue([]);

        const count = await scheduleAllSources();

        expect(count).toBe(0);
        for (const q of ALL_QUEUES) {
            expect(q.upsertJobScheduler).not.toHaveBeenCalled();
        }
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
        expect(collectRedditQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
        expect(collectRssQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
        expect(collectArxivQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
        expect(collectScraperQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    });

    it('uses a distinct per-source scheduler id (String(source.id))', async () => {
        dbAll.mockResolvedValue([
            makeSource({ id: 's1', source_type: 'reddit' }),
            makeSource({ id: 42,   source_type: 'reddit' }),   // numeric id → stringified
        ]);

        await scheduleAllSources();

        const ids = collectRedditQueue.upsertJobScheduler.mock.calls.map(([id]) => id);
        expect(ids).toEqual(['s1', '42']);
        expect(new Set(ids).size).toBe(2); // no dedupe collapse
    });

    it('upserts a job template named "collect" carrying the full source payload', async () => {
        const source = makeSource();
        dbAll.mockResolvedValue([source]);

        await scheduleAllSources();

        expect(collectRedditQueue.upsertJobScheduler).toHaveBeenCalledWith(
            String(source.id),
            expect.any(Object),
            {
                name: 'collect',
                data: {
                    sourceId:   source.id,
                    sourceName: source.name,
                    sourceType: source.source_type,
                    config:     source.config,
                },
            },
        );
    });

    it('repeats every COLLECT_WINDOW_MS (one collection per window)', async () => {
        dbAll.mockResolvedValue([makeSource()]);

        await scheduleAllSources();

        expect(collectRedditQueue.upsertJobScheduler).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ every: COLLECT_WINDOW_MS }),
            expect.any(Object),
        );
    });

    it('staggers first runs evenly across the window via startDate', async () => {
        dbAll.mockResolvedValue([
            makeSource({ id: 's1', source_type: 'reddit' }),
            makeSource({ id: 's2', source_type: 'reddit' }),
            makeSource({ id: 's3', source_type: 'reddit' }),
        ]);
        const staggerMs = Math.floor(COLLECT_WINDOW_MS / 3);

        await scheduleAllSources();

        const startDates = collectRedditQueue.upsertJobScheduler.mock.calls
            .map(([, repeatOpts]) => repeatOpts.startDate);
        expect(startDates).toEqual([NOW, NOW + staggerMs, NOW + 2 * staggerMs]);
        expect(new Set(startDates).size).toBe(3); // stagger not discarded
    });

    it('removes stale schedulers whose source is no longer active', async () => {
        dbAll.mockResolvedValue([
            makeSource({ id: 's1', source_type: 'reddit' }),
        ]);
        collectRedditQueue.getJobSchedulers.mockResolvedValue([
            { key: 's1', name: 'collect' },        // still active — keep
            { key: 'gone-source', name: 'collect' }, // deactivated — remove
        ]);
        collectRssQueue.getJobSchedulers.mockResolvedValue([
            { key: 'stale-rss', name: 'collect' },  // whole queue has no active sources
        ]);

        await scheduleAllSources();

        expect(collectRedditQueue.removeJobScheduler).toHaveBeenCalledTimes(1);
        expect(collectRedditQueue.removeJobScheduler).toHaveBeenCalledWith('gone-source');
        expect(collectRssQueue.removeJobScheduler).toHaveBeenCalledWith('stale-rss');
        // active scheduler survives and is re-upserted
        expect(collectRedditQueue.upsertJobScheduler).toHaveBeenCalledWith(
            's1', expect.any(Object), expect.any(Object),
        );
    });

    it('cleans up stale schedulers even when no sources are active at all', async () => {
        dbAll.mockResolvedValue([]);
        collectArxivQueue.getJobSchedulers.mockResolvedValue([
            { key: 'orphan', name: 'collect' },
        ]);

        const count = await scheduleAllSources();

        expect(count).toBe(0);
        expect(collectArxivQueue.removeJobScheduler).toHaveBeenCalledWith('orphan');
    });

    it('skips sources with an unknown source_type without aborting the rest', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        dbAll.mockResolvedValue([
            makeSource({ id: 's1', source_type: 'carrier_pigeon' }),
            makeSource({ id: 's2', source_type: 'rss' }),
        ]);

        const count = await scheduleAllSources();

        expect(count).toBe(1);
        expect(collectRssQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
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
