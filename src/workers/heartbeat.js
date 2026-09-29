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

'use strict';

const fs = require('fs');

const HEARTBEAT_KEY = 'pulse:worker:heartbeat';
const HEARTBEAT_INTERVAL_MS = 15000;
const HEARTBEAT_TTL_S = 90;             // 6 missed beats
const HEARTBEAT_FILE = process.env.WORKER_HEARTBEAT_FILE || '/tmp/pulse-worker-heartbeat';
const HEALTHCHECK_MAX_AGE_MS = 60000;   // 4 missed beats → unhealthy

/** One beat: Redis first; the file is touched only when Redis took it. */
async function beat(redis, { file = HEARTBEAT_FILE, now = new Date() } = {}) {
    const at = now.toISOString();
    await redis.set(HEARTBEAT_KEY, at, 'EX', HEARTBEAT_TTL_S);
    fs.writeFileSync(file, at);
}

/**
 * Beat now and every intervalMs. Failures go to onError (the worker keeps
 * running; the stale file makes its healthcheck fail). Returns stop().
 */
function startHeartbeat(redis, { file = HEARTBEAT_FILE, intervalMs = HEARTBEAT_INTERVAL_MS, onError = () => {} } = {}) {
    const tick = () => beat(redis, { file }).catch(onError);
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

module.exports = {
    HEARTBEAT_KEY, HEARTBEAT_INTERVAL_MS, HEARTBEAT_TTL_S, HEARTBEAT_FILE, HEALTHCHECK_MAX_AGE_MS,
    beat, startHeartbeat, fileIsFresh, readHeartbeat,
};
