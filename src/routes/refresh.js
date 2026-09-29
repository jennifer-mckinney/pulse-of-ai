// src/routes/refresh.js
// POST /api/refresh
//
// Triggers a new data collection + processing job.
// Returns immediately with the job_id — collection runs in background.
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

// ─── Background collection runner ────────────────────────────────────────────
// Lazy-require the ingest pipeline to avoid circular deps at module load time.
// In production this will call the real collectors; in tests it fails silently
// because no API keys are present — the job row is still created.
async function runCollection(jobId) {
    try {
        // Pull the list of active sources
        const { dbAll, dbRun: dbWrite } = require('../db/connection');
        const sources = await dbAll(
            `SELECT id, source_type FROM data_sources WHERE active = true`,
        );

        if (sources.length === 0) {
            // No sources to collect from — mark job as completed
            await dbWrite(
                `UPDATE processing_jobs SET status = 'completed', completed_at = NOW()
                 WHERE id = $1`,
                [jobId],
            );
            return;
        }

        // Placeholder: real collection happens in Phase E (collectors/).
        // For now, just mark the job as completed with 0 posts to keep the audit trail clean.
        await dbWrite(
            `UPDATE processing_jobs
             SET status = 'completed', posts_processed = 0, completed_at = NOW()
             WHERE id = $1`,
            [jobId],
        );
    /* istanbul ignore start -- Database failure in background job; requires error injection testing infrastructure */
    } catch (err) {
        console.error(`[refresh] Background collection failed for job ${jobId}:`, err.message);
        try {
            await dbRun(
                `UPDATE processing_jobs
                 SET status = 'failed', error_details = $1, completed_at = NOW()
                 WHERE id = $2`,
                [err.message, jobId],
            );
        } catch (updateErr) {
            console.error('[refresh] Failed to update job status:', updateErr.message);
        }
    }
    /* istanbul ignore end */
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
            `INSERT INTO processing_jobs (triggered_by, status)
             VALUES ('api', 'running')
             RETURNING id`,
        );

        // Fire-and-forget — collection errors are caught inside runCollection
        runCollection(job.id).catch(() => {});

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
