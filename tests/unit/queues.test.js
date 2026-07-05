// tests/unit/queues.test.js
// Tests for src/queues/index.js — the central BullMQ queue registry.
//
// Strategy: mock bullmq so no Redis connection is ever attempted (same pattern
// as tests/unit/workers.ingest.test.js). The registry is pure wiring, so tests
// assert the wiring facts that the workers and scheduler depend on:
//   - one Queue per pipeline stage, with the exact queue names workers listen on
//   - a single shared connection config reused by every queue
//   - retry/backoff defaults, including the embed queue's slower initial backoff

'use strict';

// Mock BullMQ before requiring the registry — the real Queue constructor
// opens a Redis connection lazily and would hang unit tests without Redis.
jest.mock('bullmq', () => ({
    Queue: jest.fn().mockImplementation(function (name, opts) {
        this.name = name;
        this.opts = opts;
    }),
}));

describe('src/queues/index.js', () => {
    /**
     * Fresh require with a controlled environment.
     * jest.resetModules() re-instantiates the bullmq mock, so the Queue spy
     * must be re-required alongside the registry to observe constructor calls.
     */
    function loadRegistry(env = {}) {
        jest.resetModules();
        const saved = {
            REDIS_HOST: process.env.REDIS_HOST,
            REDIS_PORT: process.env.REDIS_PORT,
        };
        delete process.env.REDIS_HOST;
        delete process.env.REDIS_PORT;
        Object.assign(process.env, env);
        try {
            const { Queue } = require('bullmq');
            const registry  = require('../../src/queues/index');
            return { Queue, registry };
        } finally {
            // Restore the outer environment regardless of require() outcome
            for (const [key, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
            }
        }
    }

    describe('connection config', () => {
        it('defaults to 127.0.0.1:6379 when no env vars are set', () => {
            const { registry } = loadRegistry();
            expect(registry.connection).toEqual({ host: '127.0.0.1', port: 6379 });
        });

        it('honours REDIS_HOST and REDIS_PORT env overrides', () => {
            const { registry } = loadRegistry({
                REDIS_HOST: 'redis.internal',
                REDIS_PORT: '6380',
            });
            expect(registry.connection).toEqual({ host: 'redis.internal', port: 6380 });
        });
    });

    describe('queue topology', () => {
        it('creates exactly the seven pipeline queues with expected names', () => {
            const { Queue } = loadRegistry();
            const names = Queue.mock.calls.map(([name]) => name).sort();
            expect(names).toEqual([
                'collect.arxiv',
                'collect.reddit',
                'collect.rss',
                'collect.scraper',
                'correlate',
                'embed',
                'ingest',
            ]);
        });

        it('exports each queue keyed by pipeline stage', () => {
            const { registry } = loadRegistry();
            expect(registry.collectRedditQueue.name).toBe('collect.reddit');
            expect(registry.collectRssQueue.name).toBe('collect.rss');
            expect(registry.collectArxivQueue.name).toBe('collect.arxiv');
            expect(registry.collectScraperQueue.name).toBe('collect.scraper');
            expect(registry.ingestQueue.name).toBe('ingest');
            expect(registry.embedQueue.name).toBe('embed');
            expect(registry.correlateQueue.name).toBe('correlate');
        });

        it('reuses the single shared connection object for every queue', () => {
            const { Queue, registry } = loadRegistry();
            expect(Queue.mock.calls).toHaveLength(7);  // guard: loop below must not be vacuous
            for (const [, opts] of Queue.mock.calls) {
                expect(opts.connection).toBe(registry.connection);  // identity, not equality
            }
        });
    });

    describe('default job options', () => {
        it('applies the base retry strategy (5 attempts, exponential 1s backoff)', () => {
            const { registry } = loadRegistry();
            expect(registry.BASE_JOB_OPTIONS).toMatchObject({
                attempts: 5,
                backoff: { type: 'exponential', delay: 1000 },
                removeOnComplete: { count: 1000 },
                removeOnFail:     { count: 5000 },
            });
            expect(registry.ingestQueue.opts.defaultJobOptions).toBe(registry.BASE_JOB_OPTIONS);
        });

        it('gives the embed queue a slower initial backoff (2s) for service warm-up', () => {
            const { registry } = loadRegistry();
            expect(registry.embedQueue.opts.defaultJobOptions).toMatchObject({
                attempts: 5,
                backoff: { type: 'exponential', delay: 2000 },
            });
        });

        it('keeps the base retry strategy on all non-embed queues', () => {
            const { Queue, registry } = loadRegistry();
            const nonEmbedCalls = Queue.mock.calls.filter(([name]) => name !== 'embed');
            expect(nonEmbedCalls).toHaveLength(6);  // guard: loop below must not be vacuous
            for (const [, opts] of nonEmbedCalls) {
                expect(opts.defaultJobOptions).toBe(registry.BASE_JOB_OPTIONS);
            }
        });
    });
});
