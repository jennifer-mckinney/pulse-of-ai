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
//   currentCycleJob(windowMs)  JOIN the running cron job started inside the
//                              window, or a new one (advisory-locked:
//                              concurrent workers agree on one row), and
//                              increment its inflight_runs (G10-2)
//   joinCycle(jobId, windowMs) join a given cycle if it is still running,
//                              else the current one — scoring retries use it
//   leaveCycle(jobId, counts)  add the run's counters and decrement
//                              inflight_runs — always, in a finally, so a
//                              run that throws after scoring still counts
//   closeCycles(windowMs)      atomically claim (FOR UPDATE SKIP LOCKED →
//                              status 'closing') every cron cycle past its
//                              window + grace with NO run in flight (or past
//                              the hard age cap), then run the bias checks
//                              ONCE over its posts, counted from
//                              decision_audit_log by job_id, and complete it
//
// POST /api/refresh and the standup population run every source in one job
// already, so they keep their own job-level checks (src/collectors/runner.js).

'use strict';

const { dbGet, dbRun, dbTransaction } = require('../db/connection');
const { runBiasChecks } = require('../pipeline/bias');
const { resolveCurrentMethodology } = require('../pipeline/methodology');

const CYCLE_LOCK_KEY = 7310001;          // pg advisory lock id for cycle creation
const CYCLE_GRACE_MS = 60 * 1000;        // in-flight runs finish before a cycle closes
const MIN_HARD_CAP_MS = 15 * 60 * 1000;  // a run that died without leaving

/** Age after which a cycle is closed even with runs marked in flight. */
function hardCapMs(windowMs) {
    return Math.max(MIN_HARD_CAP_MS, 4 * windowMs);
}

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
        if (open.rows[0]) {
            // Re-checked under the row lock: a cycle claimed for closing
            // meanwhile ('closing') is not joined.
            const joined = await client.query(
                `UPDATE processing_jobs SET inflight_runs = inflight_runs + 1
                 WHERE id = $1 AND status = 'running' RETURNING id`,
                [open.rows[0].id],
            );
            if (joined.rows[0]) return joined.rows[0].id;
        }
        const created = await client.query(
            `INSERT INTO processing_jobs (triggered_by, status, sources_queried, inflight_runs)
             VALUES ('cron', 'running', 0, 1) RETURNING id`,
        );
        return created.rows[0].id;
    });
}

/**
 * Join `jobId` when it is a running cron cycle, else the current cycle.
 * @returns {Promise<string>} the joined cycle's id (leave it with leaveCycle)
 */
async function joinCycle(jobId, windowMs) {
    if (jobId) {
        const joined = await dbGet(
            `UPDATE processing_jobs SET inflight_runs = inflight_runs + 1
             WHERE id = $1 AND triggered_by = 'cron' AND status = 'running' RETURNING id`,
            [jobId],
        );
        if (joined) return joined.id;
    }
    return currentCycleJob(windowMs);
}

async function leaveCycle(jobId, { collected = 0, processed = 0, sources = 0 } = {}) {
    await dbRun(
        `UPDATE processing_jobs
         SET posts_collected = posts_collected + $2,
             posts_processed = posts_processed + $3,
             sources_queried = sources_queried + $4,
             inflight_runs = GREATEST(inflight_runs - 1, 0)
         WHERE id = $1`,
        [jobId, collected, processed, sources],
    );
}

/** Kept for callers that only add counters (no membership change). */
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

/** Atomically claim the cycles due for closing (status → 'closing'). */
async function claimDueCycles(windowMs) {
    const dueSec = (windowMs + CYCLE_GRACE_MS) / 1000;
    const capSec = hardCapMs(windowMs) / 1000;
    return dbTransaction(async (client) => {
        const due = await client.query(
            `SELECT id FROM processing_jobs
             WHERE triggered_by = 'cron'
               AND ((status = 'running'
                     AND started_at <= NOW() - make_interval(secs => $1)
                     AND (inflight_runs <= 0 OR started_at <= NOW() - make_interval(secs => $2)))
                 -- a closer that died mid-close
                 OR (status = 'closing' AND started_at <= NOW() - make_interval(secs => $2 * 2)))
             ORDER BY started_at ASC
             FOR UPDATE SKIP LOCKED`,
            [dueSec, capSec],
        );
        const ids = due.rows.map(r => r.id);
        if (ids.length) {
            await client.query(`UPDATE processing_jobs SET status = 'closing' WHERE id = ANY($1::uuid[])`, [ids]);
        }
        return ids;
    });
}

/**
 * Close every due cron cycle, each exactly once across workers.
 * @returns {Promise<Array<{ jobId, postsProcessed, violations }>>}
 */
async function closeCycles(windowMs) {
    const closed = [];
    for (const jobId of await claimDueCycles(windowMs)) {
        let violations = null;
        let posts = 0;
        try {
            // The genuine count: posts scored under this cycle (audited).
            posts = (await dbGet(
                `SELECT COUNT(DISTINCT raw_post_id)::int AS n FROM decision_audit_log WHERE job_id = $1`, [jobId])).n;
            if (posts > 0) {
                const mv = await resolveCurrentMethodology();
                violations = (await runBiasChecks(jobId, mv.biasMvId)).violationsFound;
            }
            await dbRun(
                `UPDATE processing_jobs SET status = 'completed', posts_processed = $2, completed_at = NOW() WHERE id = $1`,
                [jobId, posts],
            );
        } catch (err) {
            await dbRun(
                `UPDATE processing_jobs SET status = 'failed', error_details = $2, completed_at = NOW() WHERE id = $1`,
                [jobId, `cycle close failed: ${err.message}`],
            ).catch(() => {});
        }
        closed.push({ jobId, postsProcessed: posts, violations });
    }
    return closed;
}

module.exports = {
    currentCycleJob, joinCycle, leaveCycle, addToCycle, closeCycles, claimDueCycles, hardCapMs,
    CYCLE_GRACE_MS, CYCLE_LOCK_KEY,
};
