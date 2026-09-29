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
const { retryJobFor, leaveCycle, releaseRetry } = require('../collectors/cycle');
const { dbGet } = require('../db/connection');
const { collectWindowMs } = require('../config/source-registry');

/**
 * @param {{ data: { rawPostId: string, sourceId?: string, jobId: string } }} job
 * @returns {Promise<{ rawPostId, relevance: number, embedJobId: string|null }>}
 */
async function processIngestJob(job) {
    const { rawPostId, jobId, reserved } = job.data || {};
    // jobId is null for posts re-queued by the unscored sweep (G10-4):
    // they score under the current cycle.
    if (!rawPostId) throw new Error('ingest job needs rawPostId');
    const mv = await resolveCurrentMethodology();
    // Copilot 4129565673: a retry queued by a run holds a slot on its job
    // (reserveRetry). While that job is still open it scores UNDER THAT JOB
    // (its counts and bias checks include the post) and releases the slot
    // on success; a failed attempt keeps the slot for BullMQ's next attempt
    // (the last failed attempt releases it — onIngestJobFailed).
    if (reserved && jobId) {
        const own = await dbGet('SELECT status FROM processing_jobs WHERE id = $1', [jobId]);
        if (own && (own.status === 'running' || own.status === 'awaiting_retries')) {
            const { relevance } = await scorePost(rawPostId, jobId, mv);
            await releaseRetry(jobId);
            return embedIfGated(rawPostId, relevance);
        }
        // Closed anyway (hard age cap): the current cycle takes the post.
        await releaseRetry(jobId);
    }
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
    return embedIfGated(rawPostId, relevance);
}

async function embedIfGated(rawPostId, relevance) {
    if (!passesEmbedGate(relevance.score)) {
        return { rawPostId, relevance: Number(relevance.score), embedJobId: null };
    }
    const embedJob = await embedQueue.add('embed-post', { rawPostId });
    return { rawPostId, relevance: Number(relevance.score), embedJobId: embedJob.id };
}

/**
 * BullMQ 'failed' hook: when a reserved retry's LAST attempt fails, its slot
 * is released so the job's bias checks are not held forever.
 * @returns {Promise<boolean>} whether a slot was released
 */
async function onIngestJobFailed(job) {
    const data = (job && job.data) || {};
    const attempts = (job && job.opts && job.opts.attempts) || 1;
    if (!data.reserved || !data.jobId || (job.attemptsMade || 0) < attempts) return false;
    await releaseRetry(data.jobId);
    return true;
}

module.exports = { processIngestJob, onIngestJobFailed, RELEVANCE_EMBED_THRESHOLD: EMBED_GATE_MIN_SCORE };
