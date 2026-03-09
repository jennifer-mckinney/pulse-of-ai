// src/workers/ingest.worker.js
// BullMQ worker handler for the 'ingest' queue.
//
// Responsibilities:
//   1. Run sentiment + relevance + discourse in parallel (all CPU-bound, no I/O wait)
//   2. Write the consolidated result to the DB via saveProcessedPost
//   3. Gate on relevance score — only high-relevance posts proceed to embed + correlate
//   4. Enqueue downstream jobs (embed, correlate) after a successful DB write
//
// The relevance gate is critical for throughput at scale:
//   - At 10K+ posts/cycle, embedding every post via the Python service would
//     take ~8+ minutes serially at ~50ms per post
//   - Only posts scoring above RELEVANCE_EMBED_THRESHOLD enter the embedding pipeline
//
// This module exports processIngestJob() so it can be unit-tested in isolation
// without a live Redis connection. The Worker registration is in src/workers/start.js.

'use strict';

const { analyzeSentiment } = require('../pipeline/sentiment');
const { scoreRelevance }   = require('../pipeline/relevance');
const { scoreDQI }         = require('../pipeline/discourse');
const { saveProcessedPost }= require('../pipeline/ingest');
const { embedQueue, correlateQueue } = require('../queues/index');

// Posts scoring below this relevance threshold skip embedding and correlation.
// Threshold matches the value defined in TECHNICAL_SPEC.md §15.
const RELEVANCE_EMBED_THRESHOLD = 0.40;

/**
 * Process a single raw post through the full ingest pipeline.
 *
 * Job data shape:
 *   { rawPostId, sourceId, content, metadata }
 *
 * @param {{ data: object }} job  BullMQ job object
 * @returns {Promise<{
 *   processingJobId: string,
 *   embedJobId:      string | null,
 *   correlateJobId:  string | null,
 * }>}
 */
async function processIngestJob(job) {
    const { rawPostId, sourceId, content } = job.data;

    // Run all three scoring functions in parallel — they are independent and
    // each reads only the post content string, so there is no shared state.
    const [sentiment, relevance, discourse] = await Promise.all([
        analyzeSentiment(content),
        scoreRelevance(content),
        scoreDQI(content),
    ]);

    // Write consolidated result — throws on DB failure, which causes BullMQ
    // to retry the job per the queue's backoff configuration.
    const { processingJobId } = await saveProcessedPost({
        rawPostId,
        sourceId,
        sentiment,
        relevance,
        discourse,
    });

    // Relevance gate: skip expensive downstream stages for low-signal posts
    if (relevance.score < RELEVANCE_EMBED_THRESHOLD) {
        return { processingJobId, embedJobId: null, correlateJobId: null };
    }

    // Enqueue embed and correlate jobs sequentially after the DB write succeeds.
    // Both jobs are idempotent — BullMQ will retry them independently if they fail.
    const embedJob = await embedQueue.add('embed-post', { rawPostId });

    const correlateJob = await correlateQueue.add('correlate-post', {
        rawPostId,
        sourceId,
    });

    return {
        processingJobId,
        embedJobId:    embedJob.id,
        correlateJobId: correlateJob.id,
    };
}

module.exports = { processIngestJob, RELEVANCE_EMBED_THRESHOLD };
