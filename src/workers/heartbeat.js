// src/workers/heartbeat.js
// Worker liveness (P9-7).
//
// src/workers/start.js calls startHeartbeat(): every HEARTBEAT_INTERVAL_MS it
// SETs HEARTBEAT_KEY in Redis (with a TTL) and, only after that write
// succeeded, touches HEARTBEAT_FILE. Consumers:
//   - the worker container's healthcheck (src/workers/healthcheck.js) reads
//     the FILE's age — cheap, no Redis connection per check — so a worker
//     that is stuck OR has lost Redis turns unhealthy;
//   - GET /api/health reads the KEY (readHeartbeat) and reports
//     worker.alive / worker.last_heartbeat.
// PR #22 security L1: with each beat the worker also publishes its
// correlation gate status (CORRELATION_KEY, same TTL). Only the worker holds
// CORRELATION_SALT, so only it can say whether the salt is usable;
// /api/health serves that (readCorrelationStatus) instead of giving the web
// process the salt.

'use strict';

const fs = require('fs');

const HEARTBEAT_KEY = 'pulse:worker:heartbeat';
const CORRELATION_KEY = 'pulse:worker:correlation';
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TTL_S = 90;             // 6 missed beats
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE || '/tmp/pulse-worker-heartbeat';
const HEALTHCHECK_MAX_AGE_MS = 60000;   // 4 missed beats → unhealthy

/**
 * One beat: Redis first; the file is touched only when Redis took it.
 * correlation: () => { enabled, status, reason } — published with the beat.
 */
async function beat(redis, { file = HEARTBEAT_FILE, now = new Date(), correlation = null } = {}) {
    const at = now.toISOString();
    await redis.set(HEARTBEAT_KEY, at, 'EX', HEARTBEAT_TTL_S);
    if (typeof correlation === 'function') {
        const { enabled, status, reason } = correlation();
        await redis.set(CORRELATION_KEY, JSON.stringify({ enabled: !!enabled, status, reason, checked_at: at }), 'EX', HEARTBEAT_TTL_S);
    }
    fs.writeFileSync(file, at);
}

/**
 * Beat now and every intervalMs. Failures go to onError (the worker keeps
 * running; the stale file makes its healthcheck fail). Returns stop().
 */
function startHeartbeat(redis, { file = HEARTBEAT_FILE, intervalMs = HEARTBEAT_INTERVAL_MS, onError = () => {}, correlation = null } = {}) {
    const tick = () => beat(redis, { file, correlation }).catch(onError);
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
}

/** True when FILE exists and was written within maxAgeMs of nowMs. */
function fileIsFresh(file, maxAgeMs = HEALTHCHECK_MAX_AGE_MS, nowMs = Date.now()) {
    try {
        return nowMs - fs.statSync(file).mtimeMs <= maxAgeMs;
    } catch {
        return false;
    }
}

/** { alive, last_heartbeat } from the Redis key (alive: a beat within the TTL). */
async function readHeartbeat(redis, now = new Date()) {
    const raw = await redis.get(HEARTBEAT_KEY);
    const t = raw ? Date.parse(raw) : NaN;
    if (Number.isNaN(t)) return { alive: false, last_heartbeat: null };
    return { alive: now.getTime() - t <= HEARTBEAT_TTL_S * 1000, last_heartbeat: raw };
}

/**
 * The correlation status the worker last published, or null (no worker, an
 * expired or unreadable value). Only the fields /api/health serves.
 */
async function readCorrelationStatus(redis) {
    const raw = await redis.get(CORRELATION_KEY);
    if (typeof raw !== 'string' || !raw) return null;
    let v;
    try { v = JSON.parse(raw); } catch { return null; }
    if (!v || typeof v !== 'object' || typeof v.status !== 'string' || typeof v.reason !== 'string') return null;
    return { enabled: v.enabled === true, status: v.status, reason: v.reason, checked_at: typeof v.checked_at === 'string' ? v.checked_at : null };
}

module.exports = {
    CORRELATION_KEY, readCorrelationStatus,
    HEARTBEAT_KEY, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TTL_S, HEARTBEAT_FILE, HEALTHCHECK_MAX_AGE_MS,
    beat, startHeartbeat, fileIsFresh, readHeartbeat,
};
