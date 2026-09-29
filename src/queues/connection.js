// src/queues/connection.js
// Redis connection settings shared by BullMQ (src/queues/index.js), the
// worker heartbeat and the /api/health probe. Kept apart from index.js,
// which opens the queues on require — web only needs a probe client.

'use strict';

/**
 * Redis connection config from an environment object.
 * REDIS_PASSWORD (F9-1): the compose stack runs Redis with requirepass,
 * so every queue, worker and the /api/health probe authenticates. When it
 * is unset or empty no password is sent (a local, auth-less Redis).
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ host: string, port: number, password?: string, db?: number }}
 */
function redisConnection(env) {
    const conn = {
        host: env.REDIS_HOST || '127.0.0.1',
        port: parseInt(env.REDIS_PORT || '6379', 10),
    };
    if (env.REDIS_PASSWORD) conn.password = env.REDIS_PASSWORD;
    // Optional logical database (REDIS_DB): isolates a second stack or a
    // local run's queues, job schedulers and heartbeat from the dev keyspace
    // on a shared Redis. Applied here so the queues, the worker heartbeat and
    // the /api/health probe always read and write the same database.
    const db = parseInt(env.REDIS_DB || '', 10);
    if (Number.isInteger(db) && db > 0) conn.db = db;
    return conn;
}

/**
 * A plain ioredis client (heartbeat, health probe). Fails fast: a command
 * never waits more than one retry, and reconnects back off to 5 s.
 * @param {object} [extra] extra ioredis options
 */
/* istanbul ignore next -- thin constructor; exercised by the running stack */
function createRedisClient(extra = {}) {
    const Redis = require('ioredis');
    return new Redis({
        ...redisConnection(process.env),
        connectTimeout: 2000,
        maxRetriesPerRequest: 1,
        retryStrategy: times => Math.min(times * 500, 5000),
        ...extra,
    });
}

module.exports = { redisConnection, createRedisClient };
