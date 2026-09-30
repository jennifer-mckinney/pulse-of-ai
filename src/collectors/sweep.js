// src/collectors/sweep.js
// G10-4: stored posts that never got scored are not lost. A post whose
// scoring failed is normally retried through the `ingest` queue; if that
// enqueue itself failed (Redis down), or a retry exhausted its attempts,
// the post would stay unscored forever. The worker runs this sweep with the
// cycle close (src/workers/start.js): every post collected in the last
// 24 h (and more than SETTLE_MS ago, so posts still being scored inline
// are left alone) with no sentiment_results row is re-queued for scoring.
// Scoring is idempotent, so a re-queued post only fills its missing stages.
//
// PR #22 P1-5 / grumpy #2: scoring now runs on the ingest queue, so a post
// can be unscored for longer than SETTLE_MS simply because the queue is
// behind. The sweep asks isPending(jobIds) — the worker passes
// src/queues/pending.js anyPending on the ingest queue — and SKIPS every
// post that still has a waiting / delayed / active scoring job (score-,
// retry-, or an earlier sweep- job). A backlog is never fed duplicates, and
// the reserved job keeps the post's cycle attribution.

'use strict';

const { dbAll } = require('../db/connection');

const SWEEP_WINDOW_HOURS = 24;
const SETTLE_MS = 5 * 60 * 1000;
const SWEEP_LIMIT = 500;

/** The ingest job ids that may still be scoring a post (this hour's and the previous hour's sweep). */
function pendingJobIds(rawPostId, bucket) {
    return [`score-${rawPostId}`, `retry-${rawPostId}`, `sweep-${rawPostId}-${bucket}`, `sweep-${rawPostId}-${bucket - 1}`];
}

/**
 * @param {{ enqueue: (data: object, jobKey: string) => Promise<unknown>, now?: () => number,
 *           isPending?: (jobIds: string[]) => Promise<boolean> }} o
 * @returns {Promise<{ found: number, queued: number, pending: number, failed: number }>}
 */
async function sweepUnscored({ enqueue, isPending = async () => false, now = () => Date.now(), limit = SWEEP_LIMIT } = {}) {
    const rows = await dbAll(
        `SELECT rp.id, rp.source_id
         FROM raw_posts rp
         WHERE rp.collected_at > NOW() - make_interval(hours => $1)
           AND rp.collected_at < NOW() - make_interval(secs => $2)
           AND rp.text_removed_at IS NULL   -- H1: a blanked post is never scored
           AND NOT EXISTS (SELECT 1 FROM sentiment_results sr WHERE sr.raw_post_id = rp.id)
         ORDER BY rp.collected_at ASC
         LIMIT $3`,
        [SWEEP_WINDOW_HOURS, SETTLE_MS / 1000, limit],
    );
    // One queued retry per post per hour (BullMQ dedupes on the job key).
    const bucket = Math.floor(now() / 3600000);
    let queued = 0;
    let pending = 0;
    let failed = 0;
    for (const r of rows) {
        try {
            if (await isPending(pendingJobIds(r.id, bucket))) { pending++; continue; }
            await enqueue({ rawPostId: r.id, sourceId: r.source_id, jobId: null }, `sweep-${r.id}-${bucket}`);
            queued++;
        } catch {
            failed++;
        }
    }
    return { found: rows.length, queued, pending, failed };
}

module.exports = { sweepUnscored, pendingJobIds, SWEEP_WINDOW_HOURS, SETTLE_MS };
