// src/queues/pending.js
// Idempotent enqueueing (PR #22 principal P1-5, grumpy #2).
//
// Every per-post job carries a DETERMINISTIC BullMQ job id (score-<post>,
// retry-<post>, sweep-<post>-<hour>, embed-<post>), so BullMQ ignores a
// second add while the first job exists. The unscored sweep additionally
// asks anyPending() whether ANY scoring job for the post is still waiting,
// delayed or running, and skips the post if so: a backlogged queue is not
// fed duplicates (which would score the post under a different cycle).

'use strict';

const PENDING_STATES = Object.freeze(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

/**
 * @param {{ getJob: (id: string) => Promise<{ getState: () => Promise<string> } | undefined> }} queue
 * @param {string[]} jobIds
 * @returns {Promise<boolean>} true when any of the jobs exists in a pending state
 */
async function anyPending(queue, jobIds) {
    for (const id of jobIds) {
        const job = await queue.getJob(id);
        if (!job) continue;
        if (PENDING_STATES.includes(await job.getState())) return true;
    }
    return false;
}

const embedJobId = rawPostId => `embed-${rawPostId}`;

/** addBulk entries for embed jobs, one deterministic id per post. */
const embedJobs = ids => ids.map(rawPostId => ({ name: 'embed-post', data: { rawPostId }, opts: { jobId: embedJobId(rawPostId) } }));

module.exports = { anyPending, embedJobId, embedJobs, PENDING_STATES };
