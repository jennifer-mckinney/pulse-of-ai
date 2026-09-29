// src/workers/start.js
// Entry point for the BullMQ worker process.
//
// Run with:  node src/workers/start.js   (compose service `worker`)
//
// Registers a Worker for every queue and keeps running until killed:
//   collect.rss / collect.api / collect.bulk — source runs (collect.worker.js)
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
const { connection } = require('../queues/index');
const { createRedisClient } = require('../queues/connection');
const { startHeartbeat } = require('./heartbeat');
const { processCollectJob }  = require('./collect.worker');
const { processIngestJob }   = require('./ingest.worker');
const { processEmbedJob }    = require('./embed.worker');
const { processCorrelateJob }= require('./correlate.worker');
const { scheduleAllSources } = require('./collector.scheduler');

const int = (v, d) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };
const COLLECT_CONCURRENCY   = int(process.env.COLLECT_CONCURRENCY, 4);
const INGEST_CONCURRENCY    = int(process.env.INGEST_CONCURRENCY, 20);
const EMBED_CONCURRENCY     = int(process.env.EMBED_CONCURRENCY, 4);
const CORRELATE_CONCURRENCY = int(process.env.CORRELATE_CONCURRENCY, 8);
const RESCHEDULE_MS         = int(process.env.COLLECT_RESCHEDULE_MS, 10 * 60 * 1000);

const log = (m) => console.log(m);

const workers = [
    new Worker('collect.rss',  job => processCollectJob(job), { connection, concurrency: COLLECT_CONCURRENCY }),
    new Worker('collect.api',  job => processCollectJob(job), { connection, concurrency: COLLECT_CONCURRENCY }),
    new Worker('collect.bulk', job => processCollectJob(job), { connection, concurrency: 1 }),
    new Worker('ingest',    processIngestJob,    { connection, concurrency: INGEST_CONCURRENCY }),
    new Worker('embed',     processEmbedJob,     { connection, concurrency: EMBED_CONCURRENCY }),
    new Worker('correlate', processCorrelateJob, { connection, concurrency: CORRELATE_CONCURRENCY }),
];

workers.forEach(w => {
    w.on('completed', (job, result) => {
        if (process.env.NODE_ENV === 'test') return;
        if (w.name.startsWith('collect.') && result) {
            log(`[${w.name}] ${result.slug}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''} — `
                + `fetched ${result.fetched}, kept ${result.kept}, new ${result.newPosts}${result.error ? ` — ${result.error}` : ''}`);
        } else {
            log(`[${w.name}] job ${job.id} completed`);
        }
    });
    w.on('failed', (job, err) => {
        console.error(`[${w.name}] job ${job?.id} failed: ${err.message}`);
    });
});

async function schedule() {
    try {
        await scheduleAllSources({ log });
    } catch (err) {
        console.error(`[scheduler] scheduling failed: ${err.message}`);
    }
}

schedule();
const timer = setInterval(schedule, RESCHEDULE_MS);

console.log(
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
        if (err.message !== lastBeatError) console.error(`[heartbeat] ${err.message}`);
        lastBeatError = err.message;
    },
});

// Graceful shutdown on SIGTERM (docker stop) or SIGINT (ctrl+c). w.close()
// waits for in-flight jobs, so compose gives this process a long
// stop_grace_period (docker-compose.yml, worker).
async function shutdown() {
    console.log('Shutting down workers...');
    stopHeartbeat();
    clearInterval(timer);
    await Promise.all(workers.map(w => w.close()));
    await heartbeatRedis.quit().catch(() => {});
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
