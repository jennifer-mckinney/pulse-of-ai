// src/routes/refresh.js
// POST /api/refresh
//
// Requests a REAL collection job over the source registry (ADR 0001). The
// route creates the processing_jobs row and ENQUEUES the collection to the
// worker (queue 'collect.refresh', src/workers/collect.worker.js
// processRefreshJob) — the public web process does no network work and
// parses no upstream content (F10-3, F10-8). Returns 202 with the job_id;
// the worker completes the row with genuine counts.
//
// Guards, in order:
//   1. Cross-site guard (PR #8 review): requireSameOrigin rejects cross-site
//      requests with 403 before anything else runs. OPTIONS is answered here
//      with an explicit 403 and never reaches the read-only surface's cors().
//   2. Shared secret (F10-8): when REFRESH_TOKEN is set, the request must
//      carry it in X-Refresh-Token. When the site is bound beyond loopback
//      (PULSE_BIND_ADDR or HOST not a loopback address) a REFRESH_TOKEN is
//      REQUIRED — without one, refresh is refused (403), because the
//      same-origin headers are unforgeable only from browsers.
//   3. In flight (F10-8): while a refresh job is running, 409 with its
//      job_id. A refresh row still 'running' after REFRESH_STALE_MINUTES
//      (worker crash) is marked failed first. Migration 019's partial unique
//      index holds this across web processes.
//   4. Rate limit (F2): a GLOBAL in-process debounce — 429 whenever ANY
//      refresh was accepted within the last 60 s, regardless of caller.
// Exports _resetRateLimiter() and _setEnqueue() for tests.

'use strict';

const { logRouteError } = require('../middleware/log-error');

const crypto = require('crypto');
const { Router } = require('express');
const { dbGet, dbRun }  = require('../db/connection');
const { SOURCES } = require('../config/source-registry');
const { requireSameOrigin } = require('../middleware/same-origin');
const { scrub } = require('../collectors/redact');

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

// ─── Enqueue (the worker runs the collection) ────────────────────────────────
function defaultEnqueue(jobId) {
    const { refreshQueue } = require('../queues/index');
    return refreshQueue.add('collect-all', { jobId }, { jobId: `refresh-${jobId}` });
}
let enqueue = defaultEnqueue;

/** Replace the enqueue function (tests only); null restores the default. */
function _setEnqueue(fn) {
    enqueue = fn || defaultEnqueue;
}

// ─── Shared secret ───────────────────────────────────────────────────────────
const LOOPBACK_RE = /^(127(?:\.\d{1,3}){3}|::1|\[::1\]|localhost)$/i;

const LOOPBACK_BOUND_RE = /^(127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/i;

/**
 * Whether the site is reachable beyond this machine.
 *   1. In the compose web container: PULSE_CONTAINER_PUBLISHED_ADDR is the
 *      address Docker publishes the port on — authoritative.
 *   2. HOST or PULSE_BIND_ADDR naming a non-loopback address.
 *   3. The ACTUAL address the server bound (app.locals.boundAddress, set by
 *      src/server.js start()): 0.0.0.0 / :: or any non-loopback address is
 *      beyond loopback (the dev bind gap: bare `npm run dev` used to listen
 *      everywhere while being treated as loopback).
 */
function boundBeyondLoopback(env = process.env, boundAddress = null) {
    const published = typeof env.PULSE_CONTAINER_PUBLISHED_ADDR === 'string' ? env.PULSE_CONTAINER_PUBLISHED_ADDR.trim() : '';
    if (published) return !LOOPBACK_RE.test(published);
    for (const k of ['PULSE_BIND_ADDR', 'HOST']) {
        const v = typeof env[k] === 'string' ? env[k].trim() : '';
        if (v && !LOOPBACK_RE.test(v)) return true;
    }
    if (typeof boundAddress === 'string' && boundAddress) return !LOOPBACK_BOUND_RE.test(boundAddress);
    return false;
}

function sameSecret(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** @returns {null | { status: number, error: string }} */
function refreshTokenCheck(req, env = process.env) {
    const token = typeof env.REFRESH_TOKEN === 'string' ? env.REFRESH_TOKEN.trim() : '';
    const bound = req && req.app && req.app.locals ? req.app.locals.boundAddress : null;
    if (!token) {
        return boundBeyondLoopback(env, bound)
            ? { status: 403, error: 'Refresh is disabled: the site is bound beyond loopback and no REFRESH_TOKEN is set' }
            : null;
    }
    const given = req.get('X-Refresh-Token') || '';
    return given && sameSecret(given, token) ? null : { status: 403, error: 'Refresh requires a valid X-Refresh-Token' };
}

function stalenessMinutes(env = process.env) {
    const n = parseInt(env.REFRESH_STALE_MINUTES || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.post('/refresh', requireSameOrigin, async (req, res) => {
    try {
        const denied = refreshTokenCheck(req);
        if (denied) return res.status(denied.status).json({ error: denied.error });

        // A worker that died mid-run leaves its row 'running': close it
        // after the staleness bound so refresh does not stay 409 forever.
        await dbRun(
            `UPDATE processing_jobs
             SET status = 'failed', completed_at = NOW(),
                 error_details = 'stale: the refresh job made no progress for ' || $1 || ' minutes'
             WHERE triggered_by = 'api' AND status = 'running'
               AND COALESCE(last_progress_at, started_at) < NOW() - make_interval(mins => $1::int)`,
            [stalenessMinutes()],
        );
        const inflight = await dbGet(
            `SELECT id FROM processing_jobs WHERE triggered_by = 'api' AND status = 'running'
             ORDER BY started_at DESC LIMIT 1`,
        );
        if (inflight) {
            return res.status(409).json({ error: 'A refresh collection is already running', job_id: inflight.id });
        }

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

        let job;
        try {
            job = await dbRun(
                `INSERT INTO processing_jobs (triggered_by, status, sources_queried)
                 VALUES ('api', 'running', $1)
                 RETURNING id`,
                [SOURCES.length],
            );
        } catch (err) {
            // Another process started one between the check and the insert
            // (migration 019's unique index).
            if (err && err.code === '23505') {
                const other = await dbGet(`SELECT id FROM processing_jobs WHERE triggered_by = 'api' AND status = 'running' LIMIT 1`);
                return res.status(409).json({ error: 'A refresh collection is already running', job_id: other ? other.id : null });
            }
            throw err;
        }
        lastRefreshAt = now;

        try {
            await enqueue(job.id);
        } catch (err) {
            console.error(scrub(`[refresh] enqueue failed for job ${job.id}: ${err.message}`));
            await dbRun(
                `UPDATE processing_jobs SET status = 'failed', error_details = 'collection queue unavailable', completed_at = NOW() WHERE id = $1`,
                [job.id],
            );
            lastRefreshAt = 0;   // nothing ran: the budget is not spent
            return res.status(503).json({ error: 'Collection queue unavailable', job_id: job.id });
        }

        return res.status(202).json({
            job_id:       job.id,
            status:       'queued',
            triggered_by: 'api',
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('refresh', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
module.exports._resetRateLimiter = _resetRateLimiter;
module.exports._setEnqueue = _setEnqueue;
module.exports.boundBeyondLoopback = boundBeyondLoopback;
module.exports.refreshTokenCheck = refreshTokenCheck;
