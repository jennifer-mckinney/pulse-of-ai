// src/routes/refresh.js
// POST /api/refresh
//
// Triggers a new data collection + processing job.
// Returns immediately with the job_id — collection runs in background.
//
// Rate limit: 1 request per minute per IP (in-memory; no Redis dependency for MVP).
// Exports _resetRateLimiter() for test isolation.

'use strict';

const { Router } = require('express');
const { dbRun }  = require('../db/connection');

const router = Router();

// ─── In-memory rate limiter (IP → last request timestamp ms) ─────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MS = 60 * 1000;  // 1 minute

/** Reset all rate limit records. Exported for test isolation. */
function _resetRateLimiter() {
    rateLimitMap.clear();
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
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
    try {
        // Rate limiting: 1 request per minute per IP
        const ip      = req.ip;
        const now     = Date.now();
        const lastReq = rateLimitMap.get(ip);

        if (lastReq && (now - lastReq) < RATE_LIMIT_MS) {
            const retryAfterSec = Math.ceil((RATE_LIMIT_MS - (now - lastReq)) / 1000);
            res.set('Retry-After', String(retryAfterSec));
            return res.status(429).json({
                error: 'Rate limit exceeded: 1 request per minute',
                retry_after_seconds: retryAfterSec,
            });
        }

        rateLimitMap.set(ip, now);

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
    } catch (err) {
        console.error('[refresh] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
module.exports._resetRateLimiter = _resetRateLimiter;
