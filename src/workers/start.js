// src/workers/start.js
// Entry point for the BullMQ worker process.
//
// Run with:  node src/workers/start.js
// Or via:    docker-compose --profile workers up
//
// This process registers Worker instances for every queue and keeps running
// until killed. BullMQ workers poll Redis for jobs and call the corresponding
// processXxxJob() handler.
//
// Concurrency rationale:
//   ingest:    20 — CPU-bound (sentiment/relevance/discourse); one per logical core
//   embed:      4 — I/O-bound but Python service is the bottleneck; 4 concurrent
//                   calls keeps the service saturated without overwhelming it
//   correlate:  8 — DB-bound; limited by PG connection pool size (default 20)

'use strict';

const { Worker } = require('bullmq');
const { connection } = require('../queues/index');
const { createRedisClient } = require('../queues/connection');
const { startHeartbeat } = require('./heartbeat');
const { processIngestJob }   = require('./ingest.worker');
const { processEmbedJob }    = require('./embed.worker');
const { processCorrelateJob }= require('./correlate.worker');

const INGEST_CONCURRENCY    = parseInt(process.env.INGEST_CONCURRENCY    || '20', 10);
const EMBED_CONCURRENCY     = parseInt(process.env.EMBED_CONCURRENCY     || '4',  10);
const CORRELATE_CONCURRENCY = parseInt(process.env.CORRELATE_CONCURRENCY || '8',  10);

const workers = [
    new Worker('ingest',    processIngestJob,    { connection, concurrency: INGEST_CONCURRENCY }),
    new Worker('embed',     processEmbedJob,     { connection, concurrency: EMBED_CONCURRENCY }),
    new Worker('correlate', processCorrelateJob, { connection, concurrency: CORRELATE_CONCURRENCY }),
];

workers.forEach(w => {
    w.on('completed', job => {
        if (process.env.NODE_ENV !== 'test') {
            console.log(`[${w.name}] job ${job.id} completed`);
        }
    });
    w.on('failed', (job, err) => {
        console.error(`[${w.name}] job ${job?.id} failed: ${err.message}`);
    });
});

console.log(
    `Workers started — ingest:${INGEST_CONCURRENCY} embed:${EMBED_CONCURRENCY} correlate:${CORRELATE_CONCURRENCY}`,
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
    await Promise.all(workers.map(w => w.close()));
    await heartbeatRedis.quit().catch(() => {});
    process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
