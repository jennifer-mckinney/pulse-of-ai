// src/db/pool-size.js
// PostgreSQL pool sizing against worker concurrency (P10-12).
//
// src/db/connection.js reads PG_POOL_MAX (default 10: the web process). The
// worker runs many jobs at once, each needing connections:
//   collect   one connection at a time per run (sequential awaits):
//             collect.rss + collect.api at COLLECT_CONCURRENCY each,
//             collect.bulk and collect.refresh at 1
//   ingest    up to 3 at once per job (sentiment, relevance and discourse
//             run in parallel): 3 × INGEST_CONCURRENCY
//   embed     1 per job; correlate 1 per job; maintenance 1
//   timers    the cycle close / sweep / source-health / Reddit maintenance: 2
// When PG_POOL_MAX is not set, the worker sizes its pool to that sum
// (capped at MAX_POOL, so the worker plus web stay well under PostgreSQL's
// default max_connections of 100); an explicit PG_POOL_MAX smaller than the
// sum is kept but logged, since jobs would then wait for connections.

'use strict';

const MAX_POOL = 60;
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
function requiredWorkerPool(c = workerConcurrency()) {
    return 2 * c.collect + 1 + 1 + 3 * c.ingest + c.embed + c.correlate + 1 + 2;
}

/**
 * The pool size the worker should use, and whether an explicit setting is
 * short. @returns {{ size: number, required: number, explicit: boolean, short: boolean }}
 */
function workerPoolSize(env = process.env) {
    const required = requiredWorkerPool(workerConcurrency(env));
    const explicit = int(env.PG_POOL_MAX, 0);
    if (explicit) return { size: explicit, required, explicit: true, short: explicit < required };
    return { size: Math.min(required, MAX_POOL), required, explicit: false, short: required > MAX_POOL };
}

module.exports = { workerConcurrency, requiredWorkerPool, workerPoolSize, MAX_POOL };
