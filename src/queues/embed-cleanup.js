// src/queues/embed-cleanup.js
// Remove the pending embed jobs of posts that no longer exist (the demo
// purge, scripts/compact.js), so a purge does not leave embed work orphaned.
//
// Embed jobs carry { rawPostId } and a BullMQ-generated id, so the pending
// states are scanned page by page and the matching jobs removed. A job that
// is already ACTIVE (locked by a worker) cannot be removed; it is counted as
// `inFlight` and the worker completes it as a no-op (src/pipeline/embeddings.js
// embedPost: the purge record says why). Completed / failed jobs are history
// and are left alone.

'use strict';

// Every state a job waits in before a worker takes it (a retry after a
// failed attempt waits in 'delayed').
const PENDING_STATES = Object.freeze(['wait', 'paused', 'prioritized', 'delayed']);
const PAGE_SIZE = 500;

/**
 * @param {import('bullmq').Queue} queue  the embed queue
 * @param {string[]} postIds             raw_posts ids that were deleted
 * @param {{ pageSize?: number }} [o]
 * @returns {Promise<{ scanned: number, removed: number, inFlight: number }>}
 */
async function removePendingEmbedJobs(queue, postIds, { pageSize = PAGE_SIZE } = {}) {
    const wanted = new Set((postIds || []).map(String));
    const out = { scanned: 0, removed: 0, inFlight: 0 };
    if (wanted.size === 0) return out;

    // Collect first, then remove: removing while paging would shift the
    // ranges and skip jobs.
    const matches = [];
    for (const state of PENDING_STATES) {
        for (let start = 0; ; start += pageSize) {
            const jobs = (await queue.getJobs([state], start, start + pageSize - 1, true)).filter(Boolean);
            out.scanned += jobs.length;
            for (const job of jobs) {
                if (job.data && wanted.has(String(job.data.rawPostId))) matches.push(job);
            }
            if (jobs.length < pageSize) break;
        }
    }
    for (const job of matches) {
        try {
            await job.remove();
            out.removed++;
        } catch {
            // Taken by a worker between the scan and the removal (locked):
            // that worker completes it as a no-op.
            out.inFlight++;
        }
    }
    return out;
}

module.exports = { removePendingEmbedJobs, PENDING_STATES };
