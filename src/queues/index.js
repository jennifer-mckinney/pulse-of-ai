// src/queues/index.js
// Central BullMQ queue registry for the Pulse of AI event pipeline.
//
// Architecture: producer/consumer separation for 10K+ events per 2-3 min cycle.
//
// Queue topology:
//
//   [Collector Scheduler] — cron per source, staggered to avoid thundering herd
//       ↓
//   collect.{reddit|rss|arxiv|scraper} — one job per fetch (source-level)
//       ↓ each collector produces N raw posts
//   ingest — one job per raw post (fan-out from collector)
//       ↓ sentiment + relevance + discourse inline (fast, CPU-bound)
//   embed  — one job per post_id (calls Python Infinity service, I/O-bound)
//   correlate — one job per post_id + signals (DB-bound, privacy-sensitive)
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

/**
 * Shared Redis connection config used by all queues and workers.
 * In production override with REDIS_URL (e.g. redis://user:pass@host:6379).
 */
const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
};

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

// Collector queues — one per source type.
// Each job carries: { sourceId, sourceName, config }
const collectRedditQueue  = new Queue('collect.reddit',  { connection, defaultJobOptions: BASE_JOB_OPTIONS });
const collectRssQueue     = new Queue('collect.rss',     { connection, defaultJobOptions: BASE_JOB_OPTIONS });
const collectArxivQueue   = new Queue('collect.arxiv',   { connection, defaultJobOptions: BASE_JOB_OPTIONS });
const collectScraperQueue = new Queue('collect.scraper', { connection, defaultJobOptions: BASE_JOB_OPTIONS });

// Ingest queue — one job per raw post.
// Each job carries: { rawPostId, sourceId, content, metadata }
// Workers run sentiment + relevance + discourse in-process (CPU-bound, no I/O wait).
const ingestQueue = new Queue('ingest', { connection, defaultJobOptions: BASE_JOB_OPTIONS });

// Embed queue — one job per raw post after ingest completes.
// Each job carries: { rawPostId }
// Workers call the Python Infinity service (I/O-bound — isolated to prevent
// embedding latency from blocking sentiment throughput).
const embedQueue = new Queue('embed', {
    connection,
    defaultJobOptions: {
        ...BASE_JOB_OPTIONS,
        // Embedding service may be slow to warm up; allow a longer initial delay
        backoff: { type: 'exponential', delay: 2000 },
    },
});

// Correlate queue — one job per post after embed completes.
// Each job carries: { rawPostId, sourceId, signalHash, topicAffinity, confidence }
// Workers write to pseudonymous_users + user_platform_sightings (DB-bound, GDPR-sensitive).
const correlateQueue = new Queue('correlate', { connection, defaultJobOptions: BASE_JOB_OPTIONS });

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    connection,
    BASE_JOB_OPTIONS,
    collectRedditQueue,
    collectRssQueue,
    collectArxivQueue,
    collectScraperQueue,
    ingestQueue,
    embedQueue,
    correlateQueue,
};
