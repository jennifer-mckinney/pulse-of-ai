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

module.exports = { processCollectJob };
