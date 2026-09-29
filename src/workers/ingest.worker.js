// src/workers/ingest.worker.js
// BullMQ worker handler for the 'ingest' queue — the scoring RETRY path.
//
// The collection runner (src/collectors/runner.js) stores and scores every
// collected post inline; when scoring a stored post fails (a transient DB
// error, say), it queues { rawPostId, sourceId, jobId } here. This worker:
//   1. runs sentiment + relevance + discourse via scorePost — each stage is
//      idempotent, so only the missing stages write (with audit rows) under
//      the CURRENT methodology versions (resolveCurrentMethodology);
//   2. applies the relevance embed gate (relevance@1.1.0: score >= 1/20, one
//      lexicon match) and enqueues an embed job for a passing post.
// Errors propagate so BullMQ retries with backoff.
//
// Previously this file imported a saveProcessedPost that never existed and
// gated on 0.40, which needed 8 of 20 keywords (ADR 0001).

'use strict';

const { scorePost } = require('../pipeline/ingest');
const { passesEmbedGate, EMBED_GATE_MIN_SCORE } = require('../pipeline/relevance');
const { resolveCurrentMethodology } = require('../pipeline/methodology');
const { embedQueue } = require('../queues/index');
const { retryJobFor, leaveCycle } = require('../collectors/cycle');
const { collectWindowMs } = require('../config/source-registry');

/**
 * @param {{ data: { rawPostId: string, sourceId?: string, jobId: string } }} job
 * @returns {Promise<{ rawPostId, relevance: number, embedJobId: string|null }>}
 */
async function processIngestJob(job) {
    const { rawPostId, jobId } = job.data || {};
    // jobId is null for posts re-queued by the unscored sweep (G10-4):
    // they score under the current cycle.
    if (!rawPostId) throw new Error('ingest job needs rawPostId');
    const mv = await resolveCurrentMethodology();
    // G10-2: score under the post's own job while it is still running (a
    // cron cycle is joined so it cannot close mid-score; a running refresh
    // job keeps its posts); a retry against a closed job, or a sweep retry
    // with no job, scores under the CURRENT cycle, whose bias checks
    // will include it.
    const target = await retryJobFor(jobId, collectWindowMs());
    let relevance;
    try {
        ({ relevance } = await scorePost(rawPostId, target.jobId, mv));
    } finally {
        if (target.joined) await leaveCycle(target.jobId, {});
    }
    if (!passesEmbedGate(relevance.score)) {
        return { rawPostId, relevance: Number(relevance.score), embedJobId: null };
    }
    const embedJob = await embedQueue.add('embed-post', { rawPostId });
    return { rawPostId, relevance: Number(relevance.score), embedJobId: embedJob.id };
}

module.exports = { processIngestJob, RELEVANCE_EMBED_THRESHOLD: EMBED_GATE_MIN_SCORE };
