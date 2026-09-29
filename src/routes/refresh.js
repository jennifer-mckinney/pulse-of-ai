// src/routes/refresh.js
// POST /api/refresh
//
// Triggers a REAL collection job over the source registry (ADR 0001).
// Returns immediately with the job_id — collection runs in background and
// completes the processing_jobs row with genuine counts.
//
// Rate limit (F2): a GLOBAL in-process debounce — 429 whenever ANY refresh ran
// within the last 60s, regardless of caller IP. The previous per-IP map was
// trivially bypassed (rotating IPs / spoofed forwarding headers) and a global
// gate subsumes it: one collection cycle per minute is the whole budget.
// The frontend's 150s poll cadence sits comfortably outside the window.
// Exports _resetRateLimiter() for test isolation.
//
// Cross-site guard (PR #8 review): the endpoint is unauthenticated and
// state-changing, and a cross-site "simple" POST (HTML form) needs no CORS
// preflight — so requireSameOrigin rejects it with 403 BEFORE the debounce
// runs (a rejected request never consumes the global budget). See
// src/middleware/same-origin.js for the Sec-Fetch-Site / Origin / Referer
// rules. OPTIONS /api/refresh is answered here with an explicit 403 and
// never reaches the read-only surface's cors().

'use strict';

const { Router } = require('express');
const { dbRun }  = require('../db/connection');
const { SOURCES } = require('../config/source-registry');
const { requireSameOrigin } = require('../middleware/same-origin');

const router = Router();

// Preflight: never approved. Answered here with an explicit 403 (no
// Access-Control-Allow-* headers) so it can never fall through to the
// read-only surface's cors() handler.
router.options('/refresh', (req, res) => {
    res.set('Allow', 'POST');
    return res.status(403).json({ error: 'Refresh preflight is not allowed' });
});

// ─── In-process global debounce ──────────────────────────────────────────────
let lastRefreshAt = 0;            // epoch ms of the last accepted refresh (any caller)
const RATE_LIMIT_MS = 60 * 1000;  // 1 minute

/** Reset the debounce window. Exported for test isolation. */
function _resetRateLimiter() {
    lastRefreshAt = 0;
}

// ─── Background collection ────────────────────────────────────────────────────
// A real collection job over every registry source (src/collectors/runner.js):
// each source is gated (collecting only — kill switches, missing credentials
// and the blocked 4 never run) and claimed against its poll interval, so a
// refresh never hammers a source the worker schedule just collected. The job
// row gets the GENUINE counts: posts_collected (items kept), posts_processed
// (new posts scored through sentiment / relevance / discourse with audit
// rows), sources_queried; bias checks and embed jobs follow as in the worker.
//
// Test seam: _setCollectionOptions({ transport, queues, slugs, env }) injects
// a fixture transport so integration tests never touch the network.
let collectionOptions = {};

/** Override runner options (tests only). */
function _setCollectionOptions(opts) {
    collectionOptions = opts || {};
}

async function runCollectionJob(jobId) {
    try {
        const { runCollection } = require('../collectors/runner');
        await runCollection({ ...collectionOptions, jobId, triggeredBy: 'api' });
    } catch (err) {
        // runCollection marks the job failed itself; this only logs.
        console.error(`[refresh] collection job ${jobId} failed: ${err.message}`);
    }
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post('/refresh', requireSameOrigin, async (req, res) => {
    try {
        // Global debounce: one refresh per minute TOTAL — caller-independent.
        const now = Date.now();
        if (lastRefreshAt && (now - lastRefreshAt) < RATE_LIMIT_MS) {
            const retryAfterSec = Math.ceil((RATE_LIMIT_MS - (now - lastRefreshAt)) / 1000);
            res.set('Retry-After', String(retryAfterSec));
            return res.status(429).json({
                error: 'Rate limit exceeded: 1 refresh per minute (global)',
                retry_after_seconds: retryAfterSec,
            });
        }

        lastRefreshAt = now;

        // Create the processing job record
        const job = await dbRun(
            `INSERT INTO processing_jobs (triggered_by, status, sources_queried)
             VALUES ('api', 'running', $1)
             RETURNING id`,
            [(collectionOptions.slugs || SOURCES).length],
        );

        // Fire-and-forget — the job row records the outcome.
        runCollectionJob(job.id);

        return res.status(201).json({
            job_id:       job.id,
            status:       'started',
            triggered_by: 'api',
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[refresh] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
module.exports._resetRateLimiter = _resetRateLimiter;
module.exports._setCollectionOptions = _setCollectionOptions;
