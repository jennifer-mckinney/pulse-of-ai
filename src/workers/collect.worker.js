// src/workers/collect.worker.js
// Consumer of the collect.{rss|api|bulk} queues. One job = one run of one
// registry source through the real pipeline (src/collectors/runner.js):
// gate check → poll-interval claim → fetch → store → score (audited) →
// embed jobs, recorded in source_runs and in the shared collection-cycle job
// (processing_jobs, triggered_by 'cron'), whose bias checks run when the cycle
// closes (src/collectors/cycle.js, driven by src/workers/start.js).

'use strict';

const { runCollection } = require('../collectors/runner');
const { collectWindowMs } = require('../config/source-registry');

/**
 * @param {{ data: { slug: string } }} job
 * @param {object} [opts]  runner options (tests inject transport / queues)
 * @returns {Promise<object>} compact summary stored as the BullMQ return value
 */
async function processCollectJob(job, opts = {}) {
    const { slug } = job.data || {};
    if (!slug) throw new Error('collect job without a source slug');
    // Scheduled runs share the collection-cycle job (src/collectors/cycle.js).
    // P10-12: new posts are scored by `ingest` jobs, off this event loop.
    const s = await runCollection({ cycle: { windowMs: collectWindowMs() }, scoreVia: 'queue', ...opts, slugs: [slug], triggeredBy: 'cron' });
    const src = s.sources[0] || {};
    return {
        slug,
        jobId: s.jobId,
        status: src.status,
        outcome: src.outcome,
        fetched: src.fetched || 0,
        kept: src.kept || 0,
        newPosts: s.postsProcessed + (s.queuedForScoring || 0),
        queuedForScoring: s.queuedForScoring || 0,
        embedQueued: s.embedQueued,
        error: src.error || null,
        reason: src.reason || null,
    };
}

/**
 * POST /api/refresh's job (F10-3, F10-8): one collection over every registry
 * source, completing the processing_jobs row the route created. A row that
 * is no longer 'running' (marked stale or failed meanwhile) is not re-run.
 * @param {{ data: { jobId: string } }} job
 * @param {object} [opts]  runner options (tests inject transport / queues / slugs)
 */
/** 80 % of REFRESH_STALE_MINUTES (default 30 → 24 min), at least 1 min. */
function refreshDeadlineMs(env = process.env) {
    const n = parseInt(env.REFRESH_STALE_MINUTES || '', 10);
    const staleMin = Number.isFinite(n) && n > 0 ? n : 30;
    return Math.max(60000, Math.floor(staleMin * 60000 * 0.8));
}

async function processRefreshJob(job, opts = {}) {
    const { jobId } = job.data || {};
    if (!jobId) throw new Error('refresh job without a processing job id');
    const { dbGet } = require('../db/connection');
    const row = await dbGet('SELECT status FROM processing_jobs WHERE id = $1', [jobId]);
    if (!row || row.status !== 'running') return { jobId, skipped: true, status: row ? row.status : null };
    // PR #22 P1-4: a refresh run has a deadline shorter than the staleness
    // bound, so it ends (no new source starts, in-flight requests abort)
    // before the sweeper or the route could call it stale.
    const s = await runCollection({ scoreVia: 'queue', deadlineMs: refreshDeadlineMs(), ...opts, jobId, triggeredBy: 'api' });
    return {
        jobId: s.jobId, sourcesQueried: s.sourcesQueried, collected: s.postsCollected,
        processed: s.postsProcessed, queuedForScoring: s.queuedForScoring || 0, embedQueued: s.embedQueued, errors: s.errors.length,
    };
}

module.exports = { processCollectJob, processRefreshJob, refreshDeadlineMs };
