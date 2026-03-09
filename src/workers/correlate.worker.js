// src/workers/correlate.worker.js
// BullMQ worker handler for the 'correlate' queue.
//
// Runs cross-platform pseudonymous user correlation for a single post.
// Returns { correlated: false } when confidence is below threshold — not an
// error, so BullMQ marks the job complete rather than retrying.

'use strict';

const { correlateUser } = require('../pipeline/correlation');

/**
 * Process a single correlate job.
 *
 * Job data shape:
 *   { rawPostId, sourceId, signalHash, topicAffinity, confidence }
 *
 * @param {{ data: object }} job
 * @returns {Promise<object>}
 */
async function processCorrelateJob(job) {
    const { sourceId, signalHash, topicAffinity, confidence } = job.data;

    const result = await correlateUser({ sourceId, signalHash, topicAffinity, confidence });

    // correlateUser returns null when confidence < CORRELATION_MIN_CONFIDENCE.
    // This is expected behaviour, not a failure — return a structured non-null value
    // so BullMQ records the job as completed (not failed/retried).
    if (!result) {
        return { correlated: false };
    }

    return { correlated: true, ...result };
}

module.exports = { processCorrelateJob };
