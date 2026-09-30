// src/workers/ingest.worker.js
// BullMQ worker handler for the 'ingest' queue — where every collected post
// is SCORED (P10-12).
//
// The collection runner (src/collectors/runner.js) stores each new post and
// queues { rawPostId, sourceId, jobId } here (scoreVia 'queue'); scoring
// retries and the unscored sweep (src/collectors/sweep.js) use the same
// queue. This worker:
//   1. runs sentiment + relevance + discourse via scorePost — each stage is
//      idempotent, so only the missing stages write (with audit rows) under
//      the CURRENT methodology versions (resolveCurrentMethodology), under
//      the post's own job while it is open, else the current cycle;
//   2. applies the relevance embed gate (relevance@1.2.0: at least one of
//      the 21 lexicon terms, score >= 1/21) and enqueues an embed job for a
//      passing post, keyed embed-<post id> so it is queued at most once.
// A post whose text retention already removed completes as a recorded
// no-op ({ skipped: true, reason: 'text_removed' }, PR #22 H1): the notice
// is never scored. Other errors propagate so BullMQ retries with backoff.

'use strict';

const { scorePost } = require('../pipeline/ingest');
const { embedJobId } = require('../queues/pending');
const { passesEmbedGate, EMBED_GATE_MIN_SCORE } = require('../pipeline/relevance');
const { resolveCurrentMethodology } = require('../pipeline/methodology');
const { embedQueue } = require('../queues/index');
const { retryJobFor, leaveCycle, releaseRetry } = require('../collectors/cycle');
const { dbGet } = require('../db/connection');
const { collectWindowMs } = require('../config/source-registry');
const { isTextRemoved } = require('../pipeline/scorable');

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
            let relevance;
            try {
                ({ relevance } = await scorePost(rawPostId, jobId, mv));
            } catch (err) {
                if (!isTextRemoved(err)) throw err;
                await releaseRetry(jobId);
                return textRemoved(rawPostId);
            }
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
    } catch (err) {
        if (!isTextRemoved(err)) throw err;
        return textRemoved(rawPostId);
    } finally {
        if (target.joined) await leaveCycle(target.jobId, {});
    }
    return embedIfGated(rawPostId, relevance);
}

/** H1: the post's text was removed by retention before it was scored. */
function textRemoved(rawPostId) {
    return { rawPostId, skipped: true, reason: 'text_removed', relevance: null, embedJobId: null };
}

async function embedIfGated(rawPostId, relevance) {
    if (!passesEmbedGate(relevance.score)) {
        return { rawPostId, relevance: Number(relevance.score), embedJobId: null };
    }
    // PR #22 P1-5: one embed job per post (deterministic id).
    const embedJob = await embedQueue.add('embed-post', { rawPostId }, { jobId: embedJobId(rawPostId) });
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
