// src/workers/start.js
// Entry point for the BullMQ worker process.
//
// Run with:  node src/workers/start.js   (compose service `worker`)
//
// Registers a Worker for every queue and keeps running until killed:
//   collect.rss / collect.api / collect.bulk — source runs (collect.worker.js)
//   collect.refresh — POST /api/refresh collections (processRefreshJob)
//   ingest    — scoring retries (ingest.worker.js)
//   embed     — embeddings via the Python service (embed.worker.js)
//   correlate — reserved (collectors store no identity signals)
// and starts the collection scheduler (collector.scheduler.js): at start and
// every RESCHEDULE_MS it (re)schedules every collecting registry source, so a
// kill switch or a new credential takes effect without a code change.
//
// Concurrency rationale:
//   collect:   4 per type — I/O-bound; per-host spacing lives in the HTTP client
//   ingest:   20 — CPU-bound scoring
//   embed:     4 — the Python service is the bottleneck
//   correlate: 8 — DB-bound

'use strict';

const { Worker } = require('bullmq');
const { connection, ingestQueue } = require('../queues/index');
const { sweepUnscored } = require('../collectors/sweep');
const { createRedisClient } = require('../queues/connection');
const { startHeartbeat } = require('./heartbeat');
const { processCollectJob, processRefreshJob } = require('./collect.worker');
const { processIngestJob, onIngestJobFailed } = require('./ingest.worker');
const { processEmbedJob }    = require('./embed.worker');
const { processCorrelateJob }= require('./correlate.worker');
const { scheduleAllSources } = require('./collector.scheduler');
const { collectWindowMs } = require('../config/source-registry');
const { closeCycles } = require('../collectors/cycle');

const int = (v, d) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };
const COLLECT_CONCURRENCY   = int(process.env.COLLECT_CONCURRENCY, 4);
const INGEST_CONCURRENCY    = int(process.env.INGEST_CONCURRENCY, 20);
const EMBED_CONCURRENCY     = int(process.env.EMBED_CONCURRENCY, 4);
const CORRELATE_CONCURRENCY = int(process.env.CORRELATE_CONCURRENCY, 8);
const RESCHEDULE_MS         = int(process.env.COLLECT_RESCHEDULE_MS, 10 * 60 * 1000);

// Every line is scrubbed of secrets (src/workers/logging.js).
const { log, logError } = require('./logging');

const workers = [
    new Worker('collect.rss',  job => processCollectJob(job), { connection, concurrency: COLLECT_CONCURRENCY }),
    new Worker('collect.api',  job => processCollectJob(job), { connection, concurrency: COLLECT_CONCURRENCY }),
    new Worker('collect.bulk', job => processCollectJob(job), { connection, concurrency: 1 }),
    // POST /api/refresh collections (F10-3, F10-8): one at a time.
    new Worker('collect.refresh', job => processRefreshJob(job), { connection, concurrency: 1 }),
    new Worker('ingest',    processIngestJob,    { connection, concurrency: INGEST_CONCURRENCY }),
    new Worker('embed',     processEmbedJob,     { connection, concurrency: EMBED_CONCURRENCY }),
    new Worker('correlate', processCorrelateJob, { connection, concurrency: CORRELATE_CONCURRENCY }),
];

workers.forEach(w => {
    w.on('completed', (job, result) => {
        if (process.env.NODE_ENV === 'test') return;
        if (w.name.startsWith('collect.') && result && result.slug) {
            log(`[${w.name}] ${result.slug}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''} — `
                + `fetched ${result.fetched}, kept ${result.kept}, new ${result.newPosts}${result.error ? ` — ${result.error}` : ''}`);
        } else {
            log(`[${w.name}] job ${job.id} completed`);
        }
    });
    w.on('failed', (job, err) => {
        // A reserved scoring retry's last failed attempt releases its slot
        // (Copilot 4129565673), so the job's bias checks are not held.
        if (w.name === 'ingest') {
            onIngestJobFailed(job).catch(e => logError(`[ingest] could not release a retry slot: ${e.message}`));
        }
        // F10-1: an error text can carry upstream detail — scrubbed.
        logError(`[${w.name}] job ${job?.id} failed: ${err.message}`);
    });
});

async function schedule() {
    try {
        await scheduleAllSources({ log });
    } catch (err) {
        logError(`[scheduler] scheduling failed: ${err.message}`);
    }
}

// Close collection cycles past their window: bias checks once over every
// source's posts in the cycle (src/collectors/cycle.js).
async function closeDueCycles() {
    try {
        for (const c of await closeCycles(collectWindowMs())) {
            log(`[cycle] job ${c.jobId} closed: ${c.postsProcessed} posts, `
                + `${c.violations === null ? 'no bias checks (no posts)' : `${c.violations} bias violation(s)`}`);
        }
    } catch (err) {
        logError(`[cycle] closing failed: ${err.message}`);
    }
    // G10-4: re-queue posts from the last 24 h that were never scored.
    try {
        const s = await sweepUnscored({
            enqueue: (data, key) => ingestQueue.add('ingest-sweep', data, { jobId: key }),
        });
        if (s.found) log(`[sweep] ${s.found} unscored post(s): ${s.queued} re-queued, ${s.failed} failed`);
    } catch (err) {
        logError(`[sweep] failed: ${err.message}`);
    }
}

schedule();
const timer = setInterval(schedule, RESCHEDULE_MS);
const cycleTimer = setInterval(closeDueCycles, 30 * 1000);

log(
    `Workers started — collect:${COLLECT_CONCURRENCY}/type ingest:${INGEST_CONCURRENCY} `
    + `embed:${EMBED_CONCURRENCY} correlate:${CORRELATE_CONCURRENCY}; rescheduling every ${Math.round(RESCHEDULE_MS / 1000)}s`,
);

// Liveness (P9-7): Redis key for /api/health + file for the container
// healthcheck (src/workers/healthcheck.js). A failed beat is logged; the
// stale file then turns the container unhealthy.
const heartbeatRedis = createRedisClient();
heartbeatRedis.on('error', () => {});
let lastBeatError = '';
const stopHeartbeat = startHeartbeat(heartbeatRedis, {
    onError: (err) => {
        if (err.message !== lastBeatError) logError(`[heartbeat] ${err.message}`);
        lastBeatError = err.message;
    },
});

// Graceful shutdown on SIGTERM (docker stop) or SIGINT (ctrl+c). w.close()
// waits for in-flight jobs, so compose gives this process a long
// stop_grace_period (docker-compose.yml, worker).
async function shutdown() {
    log('Shutting down workers...');
    stopHeartbeat();
    clearInterval(timer);
    clearInterval(cycleTimer);
    await Promise.all(workers.map(w => w.close()));
    await heartbeatRedis.quit().catch(() => {});
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
