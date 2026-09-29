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
const { joinCycle, leaveCycle } = require('../collectors/cycle');
const { collectWindowMs } = require('../config/source-registry');

/**
 * @param {{ data: { rawPostId: string, sourceId?: string, jobId: string } }} job
 * @returns {Promise<{ rawPostId, relevance: number, embedJobId: string|null }>}
 */
async function processIngestJob(job) {
    const { rawPostId, jobId } = job.data || {};
    if (!rawPostId || !jobId) throw new Error('ingest job needs rawPostId and jobId');
    const mv = await resolveCurrentMethodology();
    // G10-2: score under the post's cycle only while it is still running
    // (then it cannot close mid-score); a retry against a closed or non-cycle
    // job scores under the CURRENT cycle, whose bias checks will include it.
    const cycleId = await joinCycle(jobId, collectWindowMs());
    let relevance;
    try {
        ({ relevance } = await scorePost(rawPostId, cycleId, mv));
    } finally {
        await leaveCycle(cycleId, {});
    }
    if (!passesEmbedGate(relevance.score)) {
        return { rawPostId, relevance: Number(relevance.score), embedJobId: null };
    }
    const embedJob = await embedQueue.add('embed-post', { rawPostId });
    return { rawPostId, relevance: Number(relevance.score), embedJobId: embedJob.id };
}

module.exports = { processIngestJob, RELEVANCE_EMBED_THRESHOLD: EMBED_GATE_MIN_SCORE };
