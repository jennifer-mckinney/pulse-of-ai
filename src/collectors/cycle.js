// src/collectors/cycle.js
// Collection CYCLES for the scheduled (per-source) runs.
//
// The worker runs each registry source on its own schedule, but the job-level
// fairness checks (src/pipeline/bias.js) compare source CATEGORIES and
// CITIES across a job's posts. A job holding one source is degenerate for
// them: every located BBC post is in London, so location concentration reads
// 1.000 — a critical alert that measures the job's shape, not the discourse.
// Scheduled runs therefore share one processing_jobs row per collection
// window (triggered_by 'cron'):
//
//   currentCycleJob(windowMs)  the running cron job started inside the window,
//                              or a new one (advisory-locked: concurrent
//                              workers agree on one row)
//   addToCycle(jobId, counts)  per-run counters, added atomically
//   closeCycles(windowMs)      cron jobs older than window + grace: run the
//                              bias checks once over ALL their posts (when
//                              any), then mark them completed
//
// POST /api/refresh and the standup population run every source in one job
// already, so they keep their own job-level checks (src/collectors/runner.js).

'use strict';

const { dbAll, dbRun, dbTransaction } = require('../db/connection');
const { runBiasChecks } = require('../pipeline/bias');
const { resolveCurrentMethodology } = require('../pipeline/methodology');

const CYCLE_LOCK_KEY = 7310001;          // pg advisory lock id for cycle creation
const CYCLE_GRACE_MS = 60 * 1000;        // in-flight runs finish before a cycle closes

async function currentCycleJob(windowMs) {
    return dbTransaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock($1)', [CYCLE_LOCK_KEY]);
        const open = await client.query(
            `SELECT id FROM processing_jobs
             WHERE triggered_by = 'cron' AND status = 'running'
               AND started_at > NOW() - make_interval(secs => $1)
             ORDER BY started_at DESC LIMIT 1`,
            [windowMs / 1000],
        );
        if (open.rows[0]) return open.rows[0].id;
        const created = await client.query(
            `INSERT INTO processing_jobs (triggered_by, status, sources_queried) VALUES ('cron', 'running', 0) RETURNING id`,
        );
        return created.rows[0].id;
    });
}

async function addToCycle(jobId, { collected = 0, processed = 0, sources = 0 }) {
    await dbRun(
        `UPDATE processing_jobs
         SET posts_collected = posts_collected + $2,
             posts_processed = posts_processed + $3,
             sources_queried = sources_queried + $4
         WHERE id = $1`,
        [jobId, collected, processed, sources],
    );
}

/**
 * Close every cron cycle older than the window + grace.
 * @returns {Promise<Array<{ jobId, postsProcessed, violations }>>}
 */
async function closeCycles(windowMs) {
    const due = await dbAll(
        `SELECT id, posts_processed FROM processing_jobs
         WHERE triggered_by = 'cron' AND status = 'running'
           AND started_at <= NOW() - make_interval(secs => $1)
         ORDER BY started_at ASC`,
        [(windowMs + CYCLE_GRACE_MS) / 1000],
    );
    const closed = [];
    for (const job of due) {
        let violations = null;
        try {
            if (job.posts_processed > 0) {
                const mv = await resolveCurrentMethodology();
                violations = (await runBiasChecks(job.id, mv.biasMvId)).violationsFound;
            }
            await dbRun(`UPDATE processing_jobs SET status = 'completed', completed_at = NOW() WHERE id = $1`, [job.id]);
        } catch (err) {
            await dbRun(
                `UPDATE processing_jobs SET status = 'failed', error_details = $2, completed_at = NOW() WHERE id = $1`,
                [job.id, `cycle close failed: ${err.message}`],
            ).catch(() => {});
        }
        closed.push({ jobId: job.id, postsProcessed: job.posts_processed, violations });
    }
    return closed;
}

module.exports = { currentCycleJob, addToCycle, closeCycles, CYCLE_GRACE_MS, CYCLE_LOCK_KEY };
