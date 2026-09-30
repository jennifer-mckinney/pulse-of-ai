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
//        source_run_daily and removed (src/collectors/run-retention.js);
//     3. bias_window: the fairness checks over the rolling 24 h window
//        (bias@1.5.0, PR #22 decision G2; src/pipeline/bias-window.js).
//   'terms'      every MAINTENANCE_TERMS_EVERY_MS (default 7 days; PR #22
//                P1-13): a polite snapshot of every source's terms page with
//                its normalised text (src/collectors/governance.js); a changed
//                text opens a terms_changed alert. Skipped (recorded) while
//                COLLECTOR_CONTACT_URL is unset — nothing collects then.
//   processing_jobs are never removed (spec §19 Tier 3, decision G4).
//
// Each step is independent: a failing step is reported in the result and
// logged (scrubbed, error level) and the others still run. PR #22 P0-1 /
// grumpy #6: a run with ANY failed step then FAILS the job (BullMQ's failed
// count, visible in /api/health), and every run records its outcome in
// maintenance_state (migration 039): /api/health reports the last
// successful run per task and the watchdog alerts when it is overdue.
// BullMQ's job scheduler makes
// the schedule shared across worker processes (one job per tick), and the
// worker runs the queue at concurrency 1.

'use strict';

const { blankExpired } = require('../collectors/retention');
const { scrub } = require('../collectors/redact');
const { rollupSourceRuns } = require('../collectors/run-retention');
const { sweepStaleJobs } = require('../collectors/stale-jobs');
const { dbRun } = require('../db/connection');

const DEFAULT_MAINTENANCE_EVERY_MS = 5 * 60 * 1000;
const DEFAULT_DAILY_EVERY_MS = 24 * 60 * 60 * 1000;
const MAINTENANCE_SCHEDULER_ID = 'retention';
const DAILY_SCHEDULER_ID = 'daily';
const DEFAULT_TERMS_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
const TERMS_SCHEDULER_ID = 'terms';

function maintenanceEveryMs(env = process.env) {
    const n = parseInt(env.MAINTENANCE_EVERY_MS || '', 10);
    return Number.isFinite(n) && n >= 10000 ? n : DEFAULT_MAINTENANCE_EVERY_MS;
}

function dailyEveryMs(env = process.env) {
    const n = parseInt(env.MAINTENANCE_DAILY_EVERY_MS || '', 10);
    return Number.isFinite(n) && n >= 60000 ? n : DEFAULT_DAILY_EVERY_MS;
}

function termsEveryMs(env = process.env) {
    const n = parseInt(env.MAINTENANCE_TERMS_EVERY_MS || '', 10);
    return Number.isFinite(n) && n >= 3600000 ? n : DEFAULT_TERMS_EVERY_MS;
}

/** The tasks: scheduler id and cadence. */
const TASKS = Object.freeze({
    retention: { schedulerId: MAINTENANCE_SCHEDULER_ID, every: maintenanceEveryMs },
    daily: { schedulerId: DAILY_SCHEDULER_ID, every: dailyEveryMs },
    terms: { schedulerId: TERMS_SCHEDULER_ID, every: termsEveryMs },
});

/** P1-13: the weekly terms snapshot (governance.js), stored with change alerts. */
async function termsSnapshotStep({ env = process.env, log = () => {} } = {}) {
    if (!String(env.COLLECTOR_CONTACT_URL || '').trim()) {
        return { skipped: 'COLLECTOR_CONTACT_URL is not set: no request may be made without a contact' };
    }
    const { HttpClient } = require('../collectors/http');
    const { snapshotTerms, saveTermsSnapshots } = require('../collectors/governance');
    const rows = await snapshotTerms({ http: new HttpClient({ env }), log });
    const { changed } = await saveTermsSnapshots(rows);
    return { fetched: rows.filter(r => r.status === 'fetched').length, total: rows.length, changed };
}

/** The steps of a task, in order: [name, run]. Exported so tests can inject and extend. */
function defaultSteps({ log, task = 'retention' }) {
    if (task === 'terms') return [['terms_snapshot', () => termsSnapshotStep({ log })]];
    if (task === 'daily') {
        return [
            ['compaction', () => require('../../scripts/compact').runCompaction({ log })],
            // P10-9: 30 days of raw source_runs, then daily rollups. Jobs
            // are kept permanently (G4).
            ['source_runs', () => rollupSourceRuns()],
            // PR #22 G2 (bias@1.5.0): the fairness checks over the rolling
            // 24 h window, so their minimum samples are reachable.
            ['bias_window', () => require('../pipeline/bias-window').runBiasWindow({ triggeredBy: 'schedule' })],
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

/** Upsert the task's row in maintenance_state (migration 039). */
async function recordMaintenanceRun(task, out) {
    const failed = Object.entries(out).filter(([, s]) => !s.ok);
    const error = failed.length ? failed.map(([n, s]) => `${n}: ${s.error}`).join('; ') : null;
    const steps = Object.fromEntries(Object.entries(out).map(([n, s]) => [n, s.ok ? { ok: true } : { ok: false, error: s.error }]));
    await dbRun(
        `INSERT INTO maintenance_state (task, last_run_at, last_ok_at, last_failed_at, last_error, last_steps)
         VALUES ($1, NOW(), CASE WHEN $2::text IS NULL THEN NOW() END, CASE WHEN $2::text IS NOT NULL THEN NOW() END, $2, $3::jsonb)
         ON CONFLICT (task) DO UPDATE SET
             last_run_at = EXCLUDED.last_run_at,
             last_ok_at = COALESCE(EXCLUDED.last_ok_at, maintenance_state.last_ok_at),
             last_failed_at = COALESCE(EXCLUDED.last_failed_at, maintenance_state.last_failed_at),
             last_error = EXCLUDED.last_error,
             last_steps = EXCLUDED.last_steps`,
        [task, error, JSON.stringify(steps)],
    );
}

/** Thrown when any step of a run failed: the job is recorded as failed. */
class MaintenanceStepsFailed extends Error {
    constructor(task, out) {
        const failed = Object.entries(out).filter(([, s]) => !s.ok).map(([n, s]) => `${n} (${s.error})`);
        super(`maintenance ${task}: ${failed.length} step(s) failed: ${failed.join('; ')}`);
        this.name = 'MaintenanceStepsFailed';
        this.steps = out;
    }
}

/**
 * Runs every step; records the outcome; THROWS MaintenanceStepsFailed when
 * any step failed (after all of them ran and the outcome was recorded).
 * @param {object} [job]  the BullMQ job ({ data: { task } })
 * @param {{ steps?: Array<[string, Function]>, log?: Function, logError?: Function, record?: Function }} [o]
 * @returns {Promise<Record<string, { ok: boolean, result?: unknown, error?: string }>>}
 */
async function processMaintenanceJob(job, { steps, log = () => {}, logError = log, record = recordMaintenanceRun } = {}) {
    const task = taskOf(job);
    const out = {};
    for (const [name, run] of steps || defaultSteps({ log, task })) {
        try {
            out[name] = { ok: true, result: await run() };
        } catch (err) {
            out[name] = { ok: false, error: scrub(err && err.message) };
            logError(`[maintenance] ${task}/${name} failed: ${out[name].error}`);
        }
    }
    await record(task, out);
    if (Object.values(out).some(s => !s.ok)) throw new MaintenanceStepsFailed(task, out);
    return out;
}

/** Register (or update) every repeatable job. Idempotent across processes. */
async function scheduleMaintenance(queue, env = process.env) {
    const out = [];
    for (const [task, t] of Object.entries(TASKS)) {
        out.push(await queue.upsertJobScheduler(t.schedulerId, { every: t.every(env) }, { name: 'maintenance', data: { task } }));
    }
    return out;
}

module.exports = {
    processMaintenanceJob, scheduleMaintenance, maintenanceEveryMs, dailyEveryMs, defaultSteps, taskOf, TASKS,
    recordMaintenanceRun, MaintenanceStepsFailed, termsEveryMs, termsSnapshotStep, DEFAULT_TERMS_EVERY_MS, TERMS_SCHEDULER_ID,
    DEFAULT_MAINTENANCE_EVERY_MS, DEFAULT_DAILY_EVERY_MS, MAINTENANCE_SCHEDULER_ID, DAILY_SCHEDULER_ID,
};
