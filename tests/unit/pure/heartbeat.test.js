// tests/unit/pure/heartbeat.test.js
// P9-7: the worker's liveness signal. src/workers/start.js beats every
// HEARTBEAT_INTERVAL_MS: SET the Redis key (TTL) and, only after that
// succeeded, touch the heartbeat file the container healthcheck reads. So a
// worker that lost Redis turns unhealthy, and /api/health can report the
// last beat. Fake Redis + a temp file: no services needed.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const hb = require('../../../src/workers/heartbeat');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hb-')), 'beat');

function fakeRedis({ failSet = false, value = null, failGet = false } = {}) {
    return {
        set: jest.fn(async () => { if (failSet) throw new Error('down'); return 'OK'; }),
        get: jest.fn(async () => { if (failGet) throw new Error('down'); return value; }),
    };
}

describe('beat', () => {
    test('sets the key with a TTL, then touches the file', async () => {
        const redis = fakeRedis();
        const file = tmpFile();
        const now = new Date('2026-09-28T12:00:00Z');
        await hb.beat(redis, { file, now });
        expect(redis.set).toHaveBeenCalledWith(hb.HEARTBEAT_KEY, now.toISOString(), 'EX', hb.HEARTBEAT_TTL_S);
        expect(fs.readFileSync(file, 'utf8')).toBe(now.toISOString());
    });

    test('a failed Redis write does NOT touch the file (the worker goes unhealthy)', async () => {
        const file = tmpFile();
        await expect(hb.beat(fakeRedis({ failSet: true }), { file })).rejects.toThrow('down');
        expect(fs.existsSync(file)).toBe(false);
    });
});

// PR #22 security L1: the worker publishes its correlation gate status with
// the beat, so the web process never needs CORRELATION_SALT.
describe('correlation status published with the beat (security L1)', () => {
    test('beat publishes { enabled, status, reason, checked_at } with the same TTL; never the salt', async () => {
        const redis = fakeRedis();
        const now = new Date('2026-09-28T12:00:00Z');
        const status = { enabled: false, status: 'awaiting_dpia', reason: 'no DPIA', salt: 'must-not-leak' };
        await hb.beat(redis, { file: tmpFile(), now, correlation: () => status });
        const call = redis.set.mock.calls.find(c => c[0] === hb.CORRELATION_KEY);
        expect(call.slice(2)).toEqual(['EX', hb.HEARTBEAT_TTL_S]);
        expect(JSON.parse(call[1])).toEqual({ enabled: false, status: 'awaiting_dpia', reason: 'no DPIA', checked_at: now.toISOString() });
    });

    test('no correlation function: only the heartbeat key is written', async () => {
        const redis = fakeRedis();
        await hb.beat(redis, { file: tmpFile() });
        expect(redis.set.mock.calls.map(c => c[0])).toEqual([hb.HEARTBEAT_KEY]);
    });

    test('readCorrelationStatus parses a published value; missing or malformed is null', async () => {
        const v = JSON.stringify({ enabled: true, status: 'enabled', reason: 'r', checked_at: 't' });
        expect(await hb.readCorrelationStatus(fakeRedis({ value: v }))).toEqual({ enabled: true, status: 'enabled', reason: 'r', checked_at: 't' });
        expect(await hb.readCorrelationStatus(fakeRedis({ value: null }))).toBeNull();
        expect(await hb.readCorrelationStatus(fakeRedis({ value: 'not json' }))).toBeNull();
        expect(await hb.readCorrelationStatus(fakeRedis({ value: '{"status":"enabled"}' }))).toBeNull();
    });
});

describe('fileIsFresh (container healthcheck)', () => {
    test('fresh within the max age, stale after it, false when missing', () => {
        const file = tmpFile();
        expect(hb.fileIsFresh(file, 60000)).toBe(false);
        fs.writeFileSync(file, 'x');
        const mtime = fs.statSync(file).mtimeMs;
        expect(hb.fileIsFresh(file, 60000, mtime + 1000)).toBe(true);
        expect(hb.fileIsFresh(file, 60000, mtime + 61000)).toBe(false);
    });
});

describe('readHeartbeat (/api/health)', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    test('alive when the last beat is recent', async () => {
        const at = new Date(now.getTime() - 20000).toISOString();
        expect(await hb.readHeartbeat(fakeRedis({ value: at }), now))
            .toEqual({ alive: true, last_heartbeat: at });
    });
    test('not alive when the beat is older than the TTL, or missing', async () => {
        const old = new Date(now.getTime() - (hb.HEARTBEAT_TTL_S + 5) * 1000).toISOString();
        expect(await hb.readHeartbeat(fakeRedis({ value: old }), now)).toEqual({ alive: false, last_heartbeat: old });
        expect(await hb.readHeartbeat(fakeRedis({ value: null }), now)).toEqual({ alive: false, last_heartbeat: null });
        expect(await hb.readHeartbeat(fakeRedis({ value: 'garbage' }), now)).toEqual({ alive: false, last_heartbeat: null });
    });
});

describe('startHeartbeat', () => {
    test('beats immediately and on the interval; stop() ends it; failures are reported, not thrown', async () => {
        jest.useFakeTimers();
        const redis = fakeRedis();
        const onError = jest.fn();
        const stop = hb.startHeartbeat(redis, { file: tmpFile(), intervalMs: 1000, onError });
        await Promise.resolve();
        expect(redis.set).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(2000);
        await Promise.resolve();
        expect(redis.set).toHaveBeenCalledTimes(3);
        stop();
        jest.advanceTimersByTime(5000);
        expect(redis.set).toHaveBeenCalledTimes(3);
        jest.useRealTimers();

        const failing = fakeRedis({ failSet: true });
        const stop2 = hb.startHeartbeat(failing, { file: tmpFile(), intervalMs: 100000, onError });
        await new Promise(r => setImmediate(r));
        expect(onError).toHaveBeenCalled();
        stop2();
    });
});
