// src/workers/embed.worker.js
// BullMQ worker handler for the 'embed' queue.
//
// Calls the Python Infinity service (or sentence-transformers fallback) to generate
// a 384-dimensional embedding for a raw post, then saves it to post_embeddings.
//
// Errors propagate upward — BullMQ retries with exponential backoff per the
// embedQueue configuration in src/queues/index.js (2s, 4s, 8s, 16s, 32s).

'use strict';

const { embedPost } = require('../pipeline/embeddings');

/**
 * Process a single embed job.
 *
 * Job data shape: { rawPostId }
 *
 * @param {{ data: { rawPostId: string } }} job
 * @returns {Promise<{ postId: string, embeddingId: string, dimensions: number }>}
 */
async function processEmbedJob(job) {
    const { rawPostId } = job.data;
    return embedPost(rawPostId);
}

module.exports = { processEmbedJob };
