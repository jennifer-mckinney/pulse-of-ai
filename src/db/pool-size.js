// src/db/pool-size.js
// PostgreSQL pool sizing against worker concurrency (P10-12) and the
// server-wide connection budget (PR #22 principal P1-21).
//
// src/db/connection.js reads PG_POOL_MAX (default 10: the web process, the
// CLI scripts). The WORKER never uses PG_POOL_MAX: a host-oriented value in
// .env (which the worker reads as its env_file) must not silently shrink its
// pool. The worker sizes its pool from its concurrency, or from
// WORKER_PG_POOL_MAX when set:
//   collect   one connection at a time per run (sequential awaits):
//             collect.rss + collect.api at COLLECT_CONCURRENCY each,
//             collect.bulk and collect.refresh at 1
//   ingest    up to 3 at once per job (sentiment, relevance and discourse
//             run in parallel): 3 × INGEST_CONCURRENCY
//   embed     1 per job; maintenance 1
//   correlate 1 per job — counted ONLY while the correlation DPIA gate is
//             open (no correlate job is ever queued while it is closed)
//   timers    the cycle close / sweep / source-health / Reddit maintenance: 2
// capped at MAX_POOL. An explicit WORKER_PG_POOL_MAX smaller than the sum is
// kept but logged, since jobs would then wait for connections.
//
// Budget: WORKER_REPLICAS (default 1) workers × the worker pool + the web
// pool (PG_POOL_MAX, default 10) + ONE_SHOT_RESERVE (10: migrate, populate or
// a CLI script) must fit in PostgreSQL's max_connections minus
// superuser_reserved_connections. The worker checks this at start and
// REFUSES to start (exit 1) when it does not fit (checkPoolBudget).

'use strict';

const MAX_POOL = 60;
const WEB_POOL_DEFAULT = 10;
const ONE_SHOT_RESERVE = 10;
const int = (v, d) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };

/** The worker's concurrency settings (defaults as in src/workers/start.js). */
function workerConcurrency(env = process.env) {
    return {
        collect: int(env.COLLECT_CONCURRENCY, 4),
        ingest: int(env.INGEST_CONCURRENCY, 8),
        embed: int(env.EMBED_CONCURRENCY, 4),
        correlate: int(env.CORRELATE_CONCURRENCY, 8),
    };
}

/** Connections the worker can use at once with these settings. */
function requiredWorkerPool(c = workerConcurrency(), { correlation = true } = {}) {
    return 2 * c.collect + 1 + 1 + 3 * c.ingest + c.embed + (correlation ? c.correlate : 0) + 1 + 2;
}

function correlationOpen(env) {
    return !!require('../pipeline/correlation-gate').correlationStatus(env).enabled;
}

/**
 * The pool size the worker should use, and whether an explicit setting is
 * short. @returns {{ size, required, explicit, short, correlation, hostPoolMaxIgnored }}
 */
function workerPoolSize(env = process.env) {
    const correlation = correlationOpen(env);
    const required = requiredWorkerPool(workerConcurrency(env), { correlation });
    const explicit = int(env.WORKER_PG_POOL_MAX, 0);
    const hostPoolMaxIgnored = int(env.PG_POOL_MAX, 0) || null;
    if (explicit) return { size: explicit, required, explicit: true, short: explicit < required, correlation, hostPoolMaxIgnored };
    return { size: Math.min(required, MAX_POOL), required, explicit: false, short: required > MAX_POOL, correlation, hostPoolMaxIgnored };
}

/** Connections every process can open at once. */
function connectionBudget(env = process.env, workerPool = workerPoolSize(env).size) {
    const replicas = int(env.WORKER_REPLICAS, 1);
    const web = int(env.PG_POOL_MAX, WEB_POOL_DEFAULT);
    return { replicas, workerPool, web, oneShot: ONE_SHOT_RESERVE, total: replicas * workerPool + web + ONE_SHOT_RESERVE };
}

/**
 * Compare the budget with the server. @param {(sql: string) => Promise<object>} get
 * @returns {Promise<{ ok: boolean, total: number, available: number, message: string }>}
 */
async function checkPoolBudget({ env = process.env, workerPool, get }) {
    const b = connectionBudget(env, workerPool);
    const max = parseInt((await get('SHOW max_connections')).max_connections, 10);
    const reserved = parseInt((await get('SHOW superuser_reserved_connections')).superuser_reserved_connections, 10) || 0;
    const available = max - reserved;
    const detail = `${b.replicas} worker(s) × ${b.workerPool} + web ${b.web} + one-shot reserve ${b.oneShot} = ${b.total}; `
        + `PostgreSQL allows ${available} (max_connections ${max} − ${reserved} superuser-reserved)`;
    return b.total <= available
        ? { ok: true, total: b.total, available, message: `connection budget ok: ${detail}` }
        : { ok: false, total: b.total, available, message: `connection budget exceeded: ${detail}. Lower WORKER_REPLICAS, `
            + 'WORKER_PG_POOL_MAX or the *_CONCURRENCY settings, or raise max_connections (src/db/pool-size.js)' };
}

module.exports = {
    workerConcurrency, requiredWorkerPool, workerPoolSize, connectionBudget, checkPoolBudget,
    MAX_POOL, WEB_POOL_DEFAULT, ONE_SHOT_RESERVE,
};
