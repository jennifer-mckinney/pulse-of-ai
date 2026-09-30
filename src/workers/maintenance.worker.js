// src/workers/maintenance.worker.js
// The worker's repeatable `maintenance` jobs (P10-2; cadence split by PR #22
// principal #7). Two BullMQ job schedulers on the `maintenance` queue:
//
//   'retention'  every MAINTENANCE_EVERY_MS (default 5 minutes) — the short
//                platform-terms windows (Reddit 48 h) need it:
//     1. text retention for every source (src/collectors/retention.js):
//        platform-terms windows and the §19 detail window
//        (RETENTION_DETAIL_DAYS);
//     2. stale jobs: api / standup / demo / manual rows whose run stopped
//        making progress marked failed (src/collectors/stale-jobs.js).
//
//   'daily'      every MAINTENANCE_DAILY_EVERY_MS (default 24 hours):
//     1. compaction (scripts/compact.js runCompaction): the demo purge, then
//        every month that ended before the detail window, into rollups
//        (spec §19 "monthly" — a new month becomes due at most once a
//        month, so a daily check is enough);
//     2. source_runs: raw rows older than 30 days rolled up into
//        source_run_daily and removed (src/collectors/run-retention.js).
//   processing_jobs are never removed (spec §19 Tier 3, decision G4).
//
// Each step is independent: a failing step is reported in the result and
// logged (scrubbed) and the others still run. BullMQ's job scheduler makes
// the schedule shared across worker processes (one job per tick), and the
// worker runs the queue at concurrency 1.

'use strict';

const { blankExpired } = require('../collectors/retention');
const { scrub } = require('../collectors/redact');
const { rollupSourceRuns } = require('../collectors/run-retention');
const { sweepStaleJobs } = require('../collectors/stale-jobs');

const DEFAULT_MAINTENANCE_EVERY_MS = 5 * 60 * 1000;
const DEFAULT_DAILY_EVERY_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_SCHEDULER_ID = 'retention';
const DAILY_SCHEDULER_ID = 'daily';

function maintenanceEveryMs(env = process.env) {
    const n = parseInt(env.MAINTENANCE_EVERY_MS || '', 10);
    return Number.isFinite(n) && n >= 10000 ? n : DEFAULT_MAINTENANCE_EVERY_MS;
}

function dailyEveryMs(env = process.env) {
    const n = parseInt(env.MAINTENANCE_DAILY_EVERY_MS || '', 10);
    return Number.isFinite(n) && n >= 60000 ? n : DEFAULT_DAILY_EVERY_MS;
}

/** The two tasks: scheduler id and cadence. */
const TASKS = Object.freeze({
    retention: { schedulerId: MAINTENANCE_SCHEDULER_ID, every: maintenanceEveryMs },
    daily: { schedulerId: DAILY_SCHEDULER_ID, every: dailyEveryMs },
});

/** The steps of a task, in order: [name, run]. Exported so tests can inject and extend. */
function defaultSteps({ log, task = 'retention' }) {
    if (task === 'daily') {
        return [
            ['compaction', () => require('../../scripts/compact').runCompaction({ log })],
            // P10-9: 30 days of raw source_runs, then daily rollups. Jobs
            // are kept permanently (G4).
            ['source_runs', () => rollupSourceRuns()],
        ];
    }
    return [
        ['retention', () => blankExpired({ log })],
        // P10-18: one-shot jobs left 'running' by a process that died.
        ['stale_jobs', () => sweepStaleJobs()],
    ];
}

/** The task a job runs (a job from before the split has no task: retention). */
function taskOf(job) {
    const t = job && job.data && job.data.task;
    return TASKS[t] ? t : 'retention';
}

/**
 * @param {object} [job]  the BullMQ job ({ data: { task } })
 * @param {{ steps?: Array<[string, Function]>, log?: Function }} [o]
 * @returns {Promise<Record<string, { ok: boolean, result?: unknown, error?: string }>>}
 */
async function processMaintenanceJob(job, { steps, log = () => {} } = {}) {
    const out = {};
    for (const [name, run] of steps || defaultSteps({ log, task: taskOf(job) })) {
        try {
            out[name] = { ok: true, result: await run() };
        } catch (err) {
            out[name] = { ok: false, error: scrub(err && err.message) };
            log(`[maintenance] ${name} failed: ${out[name].error}`);
        }
    }
    return out;
}

/** Register (or update) both repeatable jobs. Idempotent across processes. */
async function scheduleMaintenance(queue, env = process.env) {
    const out = [];
    for (const [task, t] of Object.entries(TASKS)) {
        out.push(await queue.upsertJobScheduler(t.schedulerId, { every: t.every(env) }, { name: 'maintenance', data: { task } }));
    }
    return out;
}

module.exports = {
    processMaintenanceJob, scheduleMaintenance, maintenanceEveryMs, dailyEveryMs, defaultSteps, taskOf, TASKS,
    DEFAULT_MAINTENANCE_EVERY_MS, DEFAULT_DAILY_EVERY_MS, MAINTENANCE_SCHEDULER_ID, DAILY_SCHEDULER_ID,
};
