// src/workers/maintenance.worker.js
// The worker's repeatable `maintenance` job (P10-2): one BullMQ job
// scheduler, 'retention', on the `maintenance` queue fires every
// MAINTENANCE_EVERY_MS (default 5 minutes) and runs, in order:
//
//   1. text retention for every source (src/collectors/retention.js):
//      platform-terms windows (Reddit 48 h, Guardian 24 h, YouTube and
//      TikTok 30 days) and the §19 detail window (RETENTION_DETAIL_DAYS);
//   2. compaction (scripts/compact.js runCompaction): the demo purge, then
//      every month that ended before the detail window, into rollups;
//   3. source_runs: raw rows older than 30 days rolled up into
//      source_run_daily and removed (src/collectors/run-retention.js, P10-9);
//   4. processing_jobs: empty finished jobs older than 30 days removed.
//
// Each step is independent: a failing step is reported in the result and
// logged (scrubbed) and the others still run. BullMQ's job scheduler makes
// the schedule shared across worker processes (one job per tick), and the
// worker runs the queue at concurrency 1.

'use strict';

const { blankExpired } = require('../collectors/retention');
const { scrub } = require('../collectors/redact');
const { rollupSourceRuns, purgeEmptyJobs } = require('../collectors/run-retention');

const DEFAULT_MAINTENANCE_EVERY_MS = 5 * 60 * 1000;
const MAINTENANCE_SCHEDULER_ID = 'retention';

function maintenanceEveryMs(env = process.env) {
    const n = parseInt(env.MAINTENANCE_EVERY_MS || '', 10);
    return Number.isFinite(n) && n >= 10000 ? n : DEFAULT_MAINTENANCE_EVERY_MS;
}

/** The steps, in order: [name, run]. Exported so tests can inject and extend. */
function defaultSteps({ log }) {
    return [
        ['retention', () => blankExpired({ log })],
        ['compaction', () => require('../../scripts/compact').runCompaction({ log })],
        // P10-9: 30 days of raw source_runs, then daily rollups; empty jobs.
        ['source_runs', () => rollupSourceRuns()],
        ['processing_jobs', () => purgeEmptyJobs()],
    ];
}

/**
 * @param {object} [job]  the BullMQ job (unused)
 * @param {{ steps?: Array<[string, Function]>, log?: Function }} [o]
 * @returns {Promise<Record<string, { ok: boolean, result?: unknown, error?: string }>>}
 */
async function processMaintenanceJob(job, { steps, log = () => {} } = {}) {
    const out = {};
    for (const [name, run] of steps || defaultSteps({ log })) {
        try {
            out[name] = { ok: true, result: await run() };
        } catch (err) {
            out[name] = { ok: false, error: scrub(err && err.message) };
            log(`[maintenance] ${name} failed: ${out[name].error}`);
        }
    }
    return out;
}

/** Register (or update) the repeatable job. Idempotent across processes. */
async function scheduleMaintenance(queue, env = process.env) {
    return queue.upsertJobScheduler(MAINTENANCE_SCHEDULER_ID, { every: maintenanceEveryMs(env) }, { name: 'maintenance', data: {} });
}

module.exports = {
    processMaintenanceJob, scheduleMaintenance, maintenanceEveryMs, defaultSteps,
    DEFAULT_MAINTENANCE_EVERY_MS, MAINTENANCE_SCHEDULER_ID,
};
