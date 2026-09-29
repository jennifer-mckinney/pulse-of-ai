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
            REDIS_PASSWORD: process.env.REDIS_PASSWORD,
            REDIS_DB: process.env.REDIS_DB,
        };
        delete process.env.REDIS_HOST;
        delete process.env.REDIS_PORT;
        delete process.env.REDIS_PASSWORD;
        delete process.env.REDIS_DB;
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

        // F9-1: compose runs Redis with --requirepass; every BullMQ queue,
        // worker and the health probe authenticate with REDIS_PASSWORD.
        it('authenticates with REDIS_PASSWORD when it is set', () => {
            const { registry } = loadRegistry({ REDIS_PASSWORD: 's3cret' });
            expect(registry.connection).toEqual({ host: '127.0.0.1', port: 6379, password: 's3cret' });
        });

        it('sends no password when REDIS_PASSWORD is empty', () => {
            const { registry } = loadRegistry({ REDIS_PASSWORD: '' });
            expect(registry.connection).not.toHaveProperty('password');
        });

        it('redisConnection() builds the same config from any env object', () => {
            const { registry } = loadRegistry();
            expect(registry.redisConnection({ REDIS_HOST: 'r', REDIS_PORT: '1', REDIS_PASSWORD: 'p' }))
                .toEqual({ host: 'r', port: 1, password: 'p' });
        });

        it('selects a logical database only when REDIS_DB is a positive integer', () => {
            expect(loadRegistry({ REDIS_DB: '5' }).registry.connection).toEqual({ host: '127.0.0.1', port: 6379, db: 5 });
            expect(loadRegistry({ REDIS_DB: 'x' }).registry.connection).toEqual({ host: '127.0.0.1', port: 6379 });
            expect(loadRegistry({ REDIS_DB: '0' }).registry.connection).toEqual({ host: '127.0.0.1', port: 6379 });
        });

        it('the heartbeat / health probe config selects the same database', () => {
            const { redisConnection } = require('../../src/queues/connection');
            expect(redisConnection({ REDIS_DB: '3', REDIS_PASSWORD: 'p' })).toEqual({ host: '127.0.0.1', port: 6379, password: 'p', db: 3 });
        });
    });

    describe('queue topology', () => {
        it('creates exactly the seven pipeline queues; collect queues use the DB source_type vocabulary', () => {
            const { Queue } = loadRegistry();
            const names = Queue.mock.calls.map(([name]) => name).sort();
            expect(names).toEqual([
                'collect.api',
                'collect.bulk',
                'collect.refresh',
                'collect.rss',
                'correlate',
                'embed',
                'ingest',
            ]);
            const { SOURCE_TYPES } = require('../../src/config/source-registry');
            expect(names.filter(n => n.startsWith('collect.') && n !== 'collect.refresh').map(n => n.slice(8)).sort()).toEqual([...SOURCE_TYPES].sort());
        });

        it('exports each queue keyed by pipeline stage', () => {
            const { registry } = loadRegistry();
            expect(registry.collectRssQueue.name).toBe('collect.rss');
            expect(registry.collectApiQueue.name).toBe('collect.api');
            expect(registry.collectBulkQueue.name).toBe('collect.bulk');
            // F10-3 / F10-8: POST /api/refresh enqueues here; the worker collects.
            expect(registry.refreshQueue.name).toBe('collect.refresh');
            expect(registry.COLLECT_QUEUES.rss).toBe(registry.collectRssQueue);
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

        it('keeps the base retry strategy on ingest and correlate', () => {
            const { Queue, registry } = loadRegistry();
            const calls = Queue.mock.calls.filter(([name]) => name === 'ingest' || name === 'correlate');
            expect(calls).toHaveLength(2);  // guard: loop below must not be vacuous
            for (const [, opts] of calls) {
                expect(opts.defaultJobOptions).toBe(registry.BASE_JOB_OPTIONS);
            }
        });

        it('runs each collection once: the next scheduled run is the retry', () => {
            const { Queue, registry } = loadRegistry();
            const calls = Queue.mock.calls.filter(([name]) => name.startsWith('collect.'));
            expect(calls).toHaveLength(4);
            for (const [, opts] of calls) {
                expect(opts.defaultJobOptions).toBe(registry.COLLECT_JOB_OPTIONS);
                expect(opts.defaultJobOptions.attempts).toBe(1);
            }
        });
    });
});
