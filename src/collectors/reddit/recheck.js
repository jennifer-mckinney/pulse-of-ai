// src/collectors/reddit/recheck.js
// Deletion compliance: every 6 hours (src/collectors/reddit/maintenance.js)
// the stored Reddit posts whose text is still kept are re-checked with
// GET /api/info?id=t3_a,t3_b,… in batches of 100 (the endpoint's limit;
// research §1.3). A post is treated as removed upstream — and its text is
// blanked at once (src/collectors/retention.js, ADR 0001 ruling 9) — when:
//   - it is missing from the response (Reddit drops unknown ids);
//   - fields.deletionSignal says so: title or selftext "[deleted]" /
//     "[removed]", removed_by_category set, subreddit_type not 'public',
//     over_18, or an unreadable object;
//   - its stored external id does not parse to a t3_ fullname (it cannot be
//     checked, so it is treated conservatively as removed).
// These signals are MEDIUM confidence (research §5: undocumented, to be
// confirmed on the first authenticated call); every doubt resolves to
// "removed". A batch whose request FAILS is not blanked on that account
// (nothing was learned about it): it is counted, the job is reported
// incomplete and retried on the next maintenance tick, and the 48-hour
// window still bounds how long its text is kept.

'use strict';

const { deletionSignal, fullnameOf } = require('./fields');
const { INFO_BATCH } = require('./api');
const { BudgetExhaustedError } = require('./budget');
const { RateLimitedError } = require('../errors');
const { postsWithText, blankPosts } = require('../retention');

/**
 * @param {{ api: import('./api').RedditApi, slug?: string, log?: Function }} o
 * @returns {Promise<{ checked, blanked, failedBatches, complete, reasons }>}
 */
async function recheckDeletions({ api, slug = 'reddit', log = () => {} }) {
    const stored = await postsWithText(slug);
    const out = { checked: 0, blanked: 0, failedBatches: 0, complete: true, reasons: {} };
    const toBlank = new Map();   // post uuid → reason
    const byFullname = new Map();
    for (const p of stored) {
        const fn = fullnameOf(p.external_id);
        if (!fn) toBlank.set(p.id, 'external id is not a t3 fullname (cannot be re-checked)');
        else byFullname.set(fn, p.id);
    }
    const names = [...byFullname.keys()];
    for (let i = 0; i < names.length; i += INFO_BATCH) {
        const batch = names.slice(i, i + INFO_BATCH);
        let things;
        try {
            things = await api.info(batch);
        } catch (err) {
            if (err instanceof BudgetExhaustedError) { out.complete = false; break; }
            // Grumpy #1 (diagnosis 2026-10-01): Reddit asked us to wait — stop
            // here (retried next tick), never fire the next batch at it.
            if (err instanceof RateLimitedError || (err && err.held === true)) {
                out.complete = false;
                // Copilot review: only a genuine rate limit is reported as one — a held
                // server backoff (a 5xx's Retry-After) pauses the re-check too.
                if (err instanceof RateLimitedError) out.rateLimited = true;
                else out.serverBackoff = true;
                log(`[reddit] deletion re-check paused: ${err.message}`);
                break;
            }
            if (err && [401, 403, 451].includes(err.status)) throw err;
            out.failedBatches++;
            out.complete = false;
            log(`[reddit] deletion re-check batch failed (${err && err.message ? err.message : 'error'})`);
            continue;
        }
        out.checked += batch.length;
        const returned = new Map();
        for (const t of things) {
            const name = t && t.data && typeof t.data.name === 'string' ? t.data.name : null;
            if (name) returned.set(name, t);
        }
        for (const fn of batch) {
            const t = returned.get(fn);
            const reason = t ? deletionSignal(t) : 'missing from /api/info (deleted or inaccessible)';
            if (reason) toBlank.set(byFullname.get(fn), reason);
        }
    }
    // One blanking transaction per reason keeps the batch log readable.
    const groups = new Map();
    for (const [id, reason] of toBlank) {
        if (!groups.has(reason)) groups.set(reason, []);
        groups.get(reason).push(id);
    }
    for (const [reason, ids] of groups) {
        const done = await blankPosts(slug, ids, { reason });
        out.blanked += done.length;
        out.reasons[reason] = done.length;
    }
    return out;
}

module.exports = { recheckDeletions };
