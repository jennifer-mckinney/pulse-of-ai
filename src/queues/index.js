// src/queues/index.js
// Central BullMQ queue registry for the Pulse of AI event pipeline.
//
// Architecture: producer/consumer separation for 10K+ events per 2-3 min cycle.
//
// Queue topology:
//
//   [Collector Scheduler] — one BullMQ job scheduler per collecting source,
//       staggered across the collection window (src/workers/collector.scheduler.js)
//       ↓
//   collect.{rss|api|bulk} — one job per source run; the queue name is the
//       source's data_sources.source_type (the SAME vocabulary as the DB and
//       the registry — src/config/source-registry.js SOURCE_TYPES). The
//       consumer (src/workers/collect.worker.js) fetches, stores and scores
//       the source's posts through the real pipeline (src/collectors/runner.js)
//       ↓
//   ingest — retry path: a post whose inline scoring failed is re-scored here
//   embed  — one job per post passing the relevance gate (Python service, I/O-bound)
//   correlate — reserved: collectors store no identity signals, so nothing
//       enqueues correlation for collected posts
//
// Decoupling embed and correlate from ingest means:
//   - A flaky embedding service doesn't stall sentiment processing
//   - Each stage retries independently with its own backoff strategy
//   - Workers scale horizontally by running additional worker processes
//
// All queues share a single Redis connection config. In production, use a
// Redis cluster or Redis Sentinel URL via REDIS_URL env var.

'use strict';

const { Queue } = require('bullmq');

// ─── Connection ───────────────────────────────────────────────────────────────

// redisConnection (REDIS_HOST / REDIS_PORT / REDIS_PASSWORD / REDIS_DB) lives in
// ./connection so the web process can build a probe client without opening
// these queues.
const { redisConnection } = require('./connection');

/** Shared Redis connection config used by all queues and workers. */
const connection = redisConnection(process.env);

// ─── Default job options ──────────────────────────────────────────────────────

/**
 * Base retry strategy for all pipeline queues.
 * Exponential back-off: 1s → 2s → 4s → 8s → 16s (5 attempts max).
 * Failed jobs after all retries move to the BullMQ failed set for inspection.
 */
const BASE_JOB_OPTIONS = {
    attempts: 5,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 },  // keep last 1000 completed jobs for monitoring
    removeOnFail:     { count: 5000 },  // keep last 5000 failures for audit
};

// ─── Queue definitions ────────────────────────────────────────────────────────

// Collector queues — one per data_sources.source_type ('rss' | 'api' | 'bulk').
// Each job carries: { slug, sourceId, sourceType }. A collection run is not
// retried by BullMQ: the source's next scheduled run is the retry (the HTTP
// client already retries transient errors, and a refusal must not be retried).
const COLLECT_JOB_OPTIONS = { ...BASE_JOB_OPTIONS, attempts: 1 };
const collectRssQueue  = new Queue('collect.rss',  { connection, defaultJobOptions: COLLECT_JOB_OPTIONS });
const collectApiQueue  = new Queue('collect.api',  { connection, defaultJobOptions: COLLECT_JOB_OPTIONS });
const collectBulkQueue = new Queue('collect.bulk', { connection, defaultJobOptions: COLLECT_JOB_OPTIONS });

// Refresh queue (F10-3, F10-8) — POST /api/refresh enqueues ONE 'collect-all'
// job carrying { jobId } (the processing_jobs row the route created); the
// worker runs the collection (src/workers/collect.worker.js
// processRefreshJob), so the public web process does no network work.
const refreshQueue = new Queue('collect.refresh', { connection, defaultJobOptions: COLLECT_JOB_OPTIONS });

/** source_type → collect queue (the DB vocabulary). */
const COLLECT_QUEUES = Object.freeze({ rss: collectRssQueue, api: collectApiQueue, bulk: collectBulkQueue });

// Ingest queue — scoring of stored posts (P10-12): every new post a
// collection run stores (score-<id>), inline-failure retries (retry-<id>)
// and the unscored sweep (sweep-<id>-<hour>).
// Each job carries: { rawPostId, sourceId, jobId, reserved? }
// Workers run sentiment + relevance + discourse in-process (CPU-bound, no I/O wait).
const ingestQueue = new Queue('ingest', { connection, defaultJobOptions: BASE_JOB_OPTIONS });

// Embed queue — one job per raw post after ingest completes.
// Each job carries: { rawPostId }
// Workers call the Python embeddings service (python/embeddings_service.py:
// FastAPI + sentence-transformers, OpenAI-compatible POST /embeddings;
// I/O-bound — isolated to prevent embedding latency from blocking scoring).
const embedQueue = new Queue('embed', {
    connection,
    defaultJobOptions: {
        ...BASE_JOB_OPTIONS,
        // Embedding service may be slow to warm up; allow a longer initial delay
        backoff: { type: 'exponential', delay: 2000 },
    },
});

// Correlate queue — reserved. Cross-platform correlation is NOT IMPLEMENTED
// (PR #22 grumpy M7): nothing enqueues correlate jobs, and the correlate
// worker (src/workers/correlate.worker.js) REFUSES every job that reaches it
// with the DPIA gate's status and reason. It writes nothing (no
// pseudonymous_users / user_platform_sightings rows).
const correlateQueue = new Queue('correlate', { connection, defaultJobOptions: BASE_JOB_OPTIONS });

// P10-2 / P10-9 / P10-18: the worker's three repeatable maintenance jobs
// (src/workers/maintenance.worker.js): 'retention' — text retention +
// stale-job sweep every MAINTENANCE_EVERY_MS; 'daily' — compaction +
// run-table rollup + the rolling 24 h bias window every
// MAINTENANCE_DAILY_EVERY_MS; 'terms' — terms-page snapshots every
// MAINTENANCE_TERMS_EVERY_MS. One attempt: the next tick is the retry.
const maintenanceQueue = new Queue('maintenance', {
    connection,
    defaultJobOptions: { attempts: 1, removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } },
});

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    connection,
    redisConnection,
    BASE_JOB_OPTIONS,
    COLLECT_JOB_OPTIONS,
    COLLECT_QUEUES,
    collectRssQueue,
    collectApiQueue,
    collectBulkQueue,
    refreshQueue,
    ingestQueue,
    embedQueue,
    correlateQueue,
    maintenanceQueue,
};
