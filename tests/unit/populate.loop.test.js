// tests/unit/populate.loop.test.js
// scripts/populate.js --loop: prompt, clean shutdown on SIGTERM / SIGINT
// (Copilot review 4129574059).
//
// The demo feed sleeps DEMO_FEED_INTERVAL_MS (150 s) between batches. A
// signal that arrives WHILE a batch runs used to be followed by that full
// sleep, so `docker compose down` / `stop` SIGKILLed the container before
// the queues and the DB pool were closed. These tests drive runLoop with an
// injected batch function and a 10-minute interval: any path that still
// sleeps would blow the per-test timeout.
//
// No Redis and no database: the DB module and the queue registry are mocked,
// and signals are delivered with process.emit (handlers run, nothing is killed).

'use strict';

jest.mock('../../src/db/connection', () => ({
    dbAll: jest.fn(), dbGet: jest.fn(), dbRun: jest.fn(),
    closePool: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/queues/index', () => ({
    embedQueue: { addBulk: jest.fn().mockResolvedValue([]), close: jest.fn().mockResolvedValue(undefined) },
    ingestQueue: { close: jest.fn().mockResolvedValue(undefined) },
}));

const db = require('../../src/db/connection');
const queues = require('../../src/queues/index');
const populate = require('../../scripts/populate');

const TEN_MINUTES = 10 * 60 * 1000;
const opts = { mode: 'loop', size: 14, embed: false, waitEmbeddings: 0, force: false };

let stdoutSpy;
beforeEach(() => {
    stdoutSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => stdoutSpy.mockRestore());

const output = () => stdoutSpy.mock.calls.map(c => String(c[0])).join('');

/** A batch that runs until the test releases it. */
function heldBatch() {
    let release;
    let started;
    const startedP = new Promise((r) => { started = r; });
    const fn = jest.fn(() => {
        started();
        return new Promise((r) => { release = r; });
    });
    return { fn, started: startedP, release: () => release({ postIds: [], embed: false }) };
}

describe('scripts/populate.js runLoop — signal handling', () => {
    it.each(['SIGTERM', 'SIGINT'])('%s during a batch finishes that batch, then exits without sleeping', async (signal) => {
        const batch = heldBatch();
        const t0 = Date.now();
        const loop = populate.runLoop(opts, { populateOnce: batch.fn, intervalMs: TEN_MINUTES });

        await batch.started;
        process.emit(signal, signal);          // arrives mid-batch
        let settled = false;
        loop.then(() => { settled = true; });
        await new Promise(r => setImmediate(r));
        expect(settled).toBe(false);           // the in-flight batch is not abandoned

        batch.release();
        await expect(loop).resolves.toBe(0);
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(batch.fn).toHaveBeenCalledTimes(1);
        expect(output()).toMatch(new RegExp(`${signal} received`));
        expect(output()).toMatch(/demo feed stopped/);
    }, 5000);

    it('SIGTERM during the sleep cancels the timer at once', async () => {
        let ran;
        const ranP = new Promise((r) => { ran = r; });
        const once = jest.fn(async () => { ran(); return { postIds: [], embed: false }; });
        const clearSpy = jest.spyOn(global, 'clearTimeout');
        const t0 = Date.now();
        const loop = populate.runLoop(opts, { populateOnce: once, intervalMs: TEN_MINUTES });

        await ranP;
        await new Promise(r => setImmediate(r));   // now inside the interval sleep
        process.emit('SIGTERM', 'SIGTERM');
        await expect(loop).resolves.toBe(0);

        expect(Date.now() - t0).toBeLessThan(2000);
        expect(once).toHaveBeenCalledTimes(1);
        expect(clearSpy).toHaveBeenCalled();       // the pending timer was cancelled
        clearSpy.mockRestore();
    }, 5000);

    it('a failing batch followed by SIGTERM still exits promptly', async () => {
        const once = jest.fn(async () => {
            process.emit('SIGTERM', 'SIGTERM');
            throw new Error('db down');
        });
        await expect(populate.runLoop(opts, { populateOnce: once, intervalMs: TEN_MINUTES })).resolves.toBe(0);
        expect(output()).toMatch(/cycle failed: db down/);
    }, 5000);

    it('removes its signal handlers when it returns', async () => {
        const before = [process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')];
        const once = jest.fn(async () => { process.emit('SIGINT', 'SIGINT'); return { postIds: [] }; });
        await populate.runLoop(opts, { populateOnce: once, intervalMs: TEN_MINUTES });
        expect([process.listenerCount('SIGTERM'), process.listenerCount('SIGINT')]).toEqual(before);
    });

    it('keeps cycling on the interval until signalled', async () => {
        let n = 0;
        const once = jest.fn(async () => {
            n += 1;
            if (n === 3) process.emit('SIGTERM', 'SIGTERM');
            return { postIds: [] };
        });
        await populate.runLoop(opts, { populateOnce: once, intervalMs: 5 });
        expect(once).toHaveBeenCalledTimes(3);
    });
});

describe('scripts/populate.js shutdown — queue and DB cleanup', () => {
    beforeEach(() => jest.clearAllMocks());

    it('closes the database pool when no queue was ever opened', async () => {
        await populate.shutdown();
        expect(db.closePool).toHaveBeenCalledTimes(1);
        expect(queues.embedQueue.close).not.toHaveBeenCalled();
        expect(output()).toMatch(/connections closed \(database pool\)/);
    });

    it('closes every loaded BullMQ queue, then the pool', async () => {
        const order = [];
        queues.embedQueue.close.mockImplementationOnce(async () => { order.push('embed'); });
        queues.ingestQueue.close.mockImplementationOnce(async () => { order.push('ingest'); });
        db.closePool.mockImplementationOnce(async () => { order.push('pool'); });

        // An embed run loads the queue registry (as a healthy feed cycle does).
        await populate.enqueueEmbeddingsForTest(['00000000-0000-0000-0000-000000000001']);
        expect(queues.embedQueue.addBulk).toHaveBeenCalledTimes(1);

        await populate.shutdown();
        expect(order.slice(0, 2).sort()).toEqual(['embed', 'ingest']);
        expect(order[2]).toBe('pool');
        expect(output()).toMatch(/connections closed \(queues, database pool\)/);
    });

    it('a failing pool close does not throw', async () => {
        db.closePool.mockRejectedValueOnce(new Error('already ended'));
        await expect(populate.shutdown()).resolves.toBeUndefined();
    });
});
