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
//   maintenance — two repeatable jobs (maintenance.worker.js, P10-2, PR #22
//               P1-7): every MAINTENANCE_EVERY_MS text retention + stale
//               jobs; every MAINTENANCE_DAILY_EVERY_MS compaction + run rollup
// and the Reddit maintenance timer (deletion re-check, subreddit
// discovery — src/collectors/reddit/maintenance.js),
// and starts the collection scheduler (collector.scheduler.js): at start and
// every RESCHEDULE_MS it (re)schedules every collecting registry source, so a
// kill switch or a new credential takes effect without a code change.
//
// Concurrency rationale:
//   collect:   4 per type — I/O-bound; per-host spacing lives in the HTTP client
//   ingest:    8 — scoring; each job holds up to 3 DB connections (P10-12)
//   embed:     4 — the Python service is the bottleneck
//   correlate: 8 — DB-bound

'use strict';

// P10-12: size the PostgreSQL pool against this process's job concurrency
// BEFORE anything opens the pool (src/db/pool-size.js).
const { workerPoolSize, workerConcurrency } = require('../db/pool-size');
const POOL = workerPoolSize();
if (!POOL.explicit) process.env.PG_POOL_MAX = String(POOL.size);

const { Worker } = require('bullmq');
const { connection, ingestQueue, maintenanceQueue } = require('../queues/index');
const { processMaintenanceJob, scheduleMaintenance } = require('./maintenance.worker');
const { sweepUnscored } = require('../collectors/sweep');
const { anyPending } = require('../queues/pending');
const { createRedisClient } = require('../queues/connection');
const { startHeartbeat } = require('./heartbeat');
const { processCollectJob, processRefreshJob } = require('./collect.worker');
const { processIngestJob, onIngestJobFailed } = require('./ingest.worker');
const { processEmbedJob }    = require('./embed.worker');
const { processCorrelateJob }= require('./correlate.worker');
const { scheduleAllSources } = require('./collector.scheduler');
const { collectWindowMs } = require('../config/source-registry');
const { closeCycles } = require('../collectors/cycle');
const { evaluateSourceHealth } = require('../collectors/source-health');
const { evaluateRetentionOverdue } = require('../collectors/retention-overdue');
const { runRedditMaintenance, MAINTENANCE_MS } = require('../collectors/reddit/maintenance');
const { nonReentrant } = require('./guard');

const int = (v, d) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };
const CONC = workerConcurrency();
const COLLECT_CONCURRENCY   = CONC.collect;
const INGEST_CONCURRENCY    = CONC.ingest;     // P10-12: 8 (was 20) — each job holds up to 3 DB connections
const EMBED_CONCURRENCY     = CONC.embed;
const CORRELATE_CONCURRENCY = CONC.correlate;
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
    // P10-2: text retention + compaction (repeatable, one at a time).
    new Worker('maintenance', job => processMaintenanceJob(job, { log, logError }), { connection, concurrency: 1 }),
];

workers.forEach(w => {
    w.on('completed', (job, result) => {
        if (process.env.NODE_ENV === 'test') return;
        if (w.name.startsWith('collect.') && result && result.slug) {
            log(`[${w.name}] ${result.slug}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''} — `
                + `fetched ${result.fetched}, kept ${result.kept}, new ${result.newPosts}${result.error ? ` — ${result.error}` : ''}`);
        } else if (result && result.skipped) {
            // A no-op with a recorded reason (embed: post purged / text removed).
            log(`[${w.name}] job ${job.id} completed without work: post ${result.postId} ${result.reason}`);
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
    // PR #22 grumpy #6: (re-)register the maintenance schedulers on every
    // reschedule (upsertJobScheduler is idempotent), so a Redis blip at boot
    // does not stop retention until the next restart.
    try {
        await scheduleMaintenance(maintenanceQueue);
    } catch (err) {
        logError(`[maintenance] scheduling failed (retried in ${Math.round(RESCHEDULE_MS / 1000)}s): ${err.message}`);
    }
}

// Close collection cycles past their window: bias checks once over every
// source's posts in the cycle (src/collectors/cycle.js). Non-reentrant
// (PR #22 principal #6): a tick still running makes the next one skip.
const closeDueCycles = nonReentrant(closeDueCyclesOnce);
async function closeDueCyclesOnce() {
    try {
        for (const c of await closeCycles(collectWindowMs())) {
            log(`[cycle] job ${c.jobId} closed: ${c.postsProcessed} posts, `
                + `${c.violations === null ? 'no bias checks (no posts)' : `${c.violations} bias violation(s)`}`);
        }
    } catch (err) {
        logError(`[cycle] closing failed: ${err.message}`);
    }
    // P10-8: source_stale / source_failing / source_refused alerts, opened
    // and resolved as each condition starts and clears.
    try {
        const h = await evaluateSourceHealth();
        for (const a of h.opened) log(`[source-health] ${a.slug}: ${a.type} opened`);
        for (const a of h.resolved) log(`[source-health] ${a.slug}: ${a.type} resolved`);
    } catch (err) {
        logError(`[source-health] evaluation failed: ${err.message}`);
    }
    // PR #22 P0-1: a critical retention_overdue alert per source while any
    // post holds text past its window (+ grace); resolved once it is gone.
    try {
        const r = await evaluateRetentionOverdue();
        for (const slug of r.opened) logError(`[retention] ${slug}: retention_overdue opened (text past its window)`);
        for (const slug of r.resolved) log(`[retention] ${slug}: retention_overdue resolved`);
    } catch (err) {
        logError(`[retention] overdue check failed: ${err.message}`);
    }
    // G10-4: re-queue posts from the last 24 h that were never scored.
    try {
        // PR #22 P1-5: posts with a scoring job still pending are skipped.
        const s = await sweepUnscored({
            enqueue: (data, key) => ingestQueue.add('ingest-sweep', data, { jobId: key }),
            isPending: ids => anyPending(ingestQueue, ids),
        });
        if (s.found) log(`[sweep] ${s.found} unscored post(s): ${s.queued} re-queued, ${s.pending} still queued, ${s.failed} failed`);
    } catch (err) {
        logError(`[sweep] failed: ${err.message}`);
    }
}

// Reddit (#52): the 48 h text retention always, and — while Reddit's gate is
// open — the 6-hourly deletion re-check and the daily subreddit discovery
// (src/collectors/reddit/maintenance.js; ADR 0001 rulings 8 and 9).
let redditRunning = false;
async function redditMaintenance() {
    if (redditRunning) return;
    redditRunning = true;
    try {
        await runRedditMaintenance({ log });
    } catch (err) {
        logError(`[reddit] maintenance failed: ${err.message}`);
    } finally {
        redditRunning = false;
    }
}

schedule();
redditMaintenance();
const timer = setInterval(schedule, RESCHEDULE_MS);
const cycleTimer = setInterval(closeDueCycles, 30 * 1000);
const redditTimer = setInterval(redditMaintenance, MAINTENANCE_MS);

// M1: a bad retention window is reported at boot (the maintenance steps
// that depend on it fail, and change nothing, until it is fixed).
try {
    require('../config/source-registry').retentionDetailDays();
} catch (err) {
    logError(`[retention] ${err.message}`);
}

if (POOL.short) {
    logError(`[pool] PG_POOL_MAX=${POOL.size} is below the ${POOL.required} connections this worker's concurrency can use; `
        + 'jobs will wait for connections (src/db/pool-size.js)');
}
log(
    `Workers started — pg pool ${POOL.size} (needs ${POOL.required}) — collect:${COLLECT_CONCURRENCY}/type ingest:${INGEST_CONCURRENCY} `
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
    clearInterval(redditTimer);
    await Promise.all(workers.map(w => w.close()));
    await heartbeatRedis.quit().catch(() => {});
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
