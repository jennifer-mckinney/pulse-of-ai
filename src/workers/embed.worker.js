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
// reason. A post missing with no purge record is a real error: "Post not
// found" is thrown and the job fails.
//
// Correlation (spec §20) is NOT enqueued (PR #22 grumpy M7): no identity
// signal exists, so the gate is never enabled
// (src/pipeline/correlation-gate.js). The result carries the gate status
// and nothing is queued. The former post-level signal builder (topics plus
// hour, confidence 0) is removed.

'use strict';

const { embedPost } = require('../pipeline/embeddings');
const { correlationStatus } = require('../pipeline/correlation-gate');

/**
 * Process a single embed job.
 *
 * Job data shape: { rawPostId }
 *
 * @param {{ data: { rawPostId: string } }} job
 * @returns {Promise<{ postId: string, embeddingId: string, dimensions: number,
 *                     correlation: { queued: false, status: string } }>}
 */
async function processEmbedJob(job, { env = process.env } = {}) {
    const { rawPostId } = job.data;
    const result = await embedPost(rawPostId);
    if (result.skipped) return { ...result, correlation: { queued: false, status: 'skipped' } };
    // Spec §20 / M7: never queued; the status says why (awaiting_dpia,
    // disabled, misconfigured or not_implemented).
    return { ...result, correlation: { queued: false, status: correlationStatus(env).status } };
}

module.exports = { processEmbedJob };
