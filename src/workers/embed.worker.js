// src/workers/embed.worker.js
// BullMQ worker handler for the 'embed' queue.
//
// Calls the Python Infinity service (or sentence-transformers fallback) to generate
// a 384-dimensional embedding for a raw post, then saves it to post_embeddings.
//
// Errors propagate upward — BullMQ retries with exponential backoff per the
// embedQueue configuration in src/queues/index.js (2s, 4s, 8s, 16s, 32s).
//
// A job whose post was legitimately removed after it was queued — a demo
// post purged at the retention boundary, or a post whose text retention
// replaced by a notice — COMPLETES as a no-op: its return value (kept on the
// completed job) is { skipped: true, reason, at } and the worker logs the
// reason. No correlation is queued for it. A post missing with no purge
// record is a real error: "Post not found" is thrown and the job fails.

'use strict';

const { embedPost } = require('../pipeline/embeddings');
const { correlationStatus } = require('../pipeline/correlation-gate');
const { computeSignalHash } = require('../pipeline/correlation');
const { dbGet } = require('../db/connection');

/**
 * Process a single embed job.
 *
 * Job data shape: { rawPostId }
 *
 * @param {{ data: { rawPostId: string } }} job
 * @returns {Promise<{ postId: string, embeddingId: string, dimensions: number }>}
 */
async function processEmbedJob(job, { env = process.env, enqueueCorrelate = defaultEnqueueCorrelate, buildSignals = buildCorrelationSignals } = {}) {
    const { rawPostId } = job.data;
    const result = await embedPost(rawPostId);
    if (result.skipped) return { ...result, correlation: { queued: false, status: 'skipped' } };
    // Spec §20: correlation is the background step after the embedding is
    // stored — enqueued only while the DPIA gate is open
    // (src/pipeline/correlation-gate.js); otherwise the reason is returned.
    const gate = correlationStatus(env);
    if (!gate.enabled) return { ...result, correlation: { queued: false, status: gate.status } };
    const signals = await buildSignals(rawPostId, env);
    await enqueueCorrelate(signals);
    return { ...result, correlation: { queued: true, status: gate.status } };
}

/* istanbul ignore next -- binds the real BullMQ queue; tests inject */
function defaultEnqueueCorrelate(data) {
    return require('../queues/index').correlateQueue.add('correlate-post', data, { jobId: `correlate-${data.rawPostId}` });
}

/**
 * The post-level signals available on identity-free data (spec §20 table):
 * the post's topic affinity (its relevance terms) and a keyed hash of them
 * with the posting hour; the source it came from. Collectors never store an
 * author, so there is no author-level evidence and the confidence is 0 —
 * correlateUser then links nothing (threshold 0.85). The DPIA decides
 * whether author-level signals may ever be collected.
 */
async function buildCorrelationSignals(rawPostId, env = process.env) {
    const row = await dbGet(
        `SELECT rp.source_id, EXTRACT(HOUR FROM rp.collected_at)::int AS hour,
                COALESCE((SELECT matched_keywords FROM relevance_results WHERE raw_post_id = rp.id LIMIT 1), '{}') AS topics
         FROM raw_posts rp WHERE rp.id = $1`, [rawPostId]);
    if (!row) throw new Error(`correlation: post ${rawPostId} not found`);
    const topicAffinity = (row.topics || []).slice(0, 5);
    return {
        rawPostId, sourceId: row.source_id, topicAffinity,
        signalHash: computeSignalHash({ topics: topicAffinity, hour: row.hour }, env.CORRELATION_SALT),
        confidence: 0,
    };
}

module.exports = { processEmbedJob, buildCorrelationSignals };
