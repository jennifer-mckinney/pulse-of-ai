// src/workers/collect.worker.js
// Consumer of the collect.{rss|api|bulk} queues. One job = one run of one
// registry source through the real pipeline (src/collectors/runner.js):
// gate check → poll-interval claim → fetch → store → score (audited) →
// bias → embed jobs, recorded in processing_jobs and source_runs.

'use strict';

const { runCollection } = require('../collectors/runner');

/**
 * @param {{ data: { slug: string } }} job
 * @param {object} [opts]  runner options (tests inject transport / queues)
 * @returns {Promise<object>} compact summary stored as the BullMQ return value
 */
async function processCollectJob(job, opts = {}) {
    const { slug } = job.data || {};
    if (!slug) throw new Error('collect job without a source slug');
    const s = await runCollection({ ...opts, slugs: [slug], triggeredBy: 'cron' });
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
