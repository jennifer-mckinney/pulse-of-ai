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
    const s = await runCollection({ cycle: { windowMs: collectWindowMs() }, ...opts, slugs: [slug], triggeredBy: 'cron' });
    const src = s.sources[0] || {};
    return {
        slug,
        jobId: s.jobId,
        status: src.status,
        outcome: src.outcome,
        fetched: src.fetched || 0,
        kept: src.kept || 0,
        newPosts: s.postsProcessed,
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
async function processRefreshJob(job, opts = {}) {
    const { jobId } = job.data || {};
    if (!jobId) throw new Error('refresh job without a processing job id');
    const { dbGet } = require('../db/connection');
    const row = await dbGet('SELECT status FROM processing_jobs WHERE id = $1', [jobId]);
    if (!row || row.status !== 'running') return { jobId, skipped: true, status: row ? row.status : null };
    const s = await runCollection({ ...opts, jobId, triggeredBy: 'api' });
    return {
        jobId: s.jobId, sourcesQueried: s.sourcesQueried, collected: s.postsCollected,
        processed: s.postsProcessed, embedQueued: s.embedQueued, errors: s.errors.length,
    };
}

module.exports = { processCollectJob, processRefreshJob };
