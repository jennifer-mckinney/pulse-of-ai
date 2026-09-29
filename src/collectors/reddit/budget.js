// src/collectors/reddit/budget.js
// The Reddit request budget: ONE budget for every Reddit call (token,
// collection, subreddit discovery, deletion re-check), in every process.
//
// Reddit's free tier allows 100 queries per minute per OAuth client id,
// averaged over a 10-minute window (Reddit Data API Wiki, edited
// 2026-05-11); exceeding it can mean a permanent block (Data API Terms
// §3.1-3.2). The budget therefore:
//   - counts requests in fixed 10-minute windows (Reddit's own
//     X-Ratelimit-Reset period) and grants at most WINDOW_CAP = 90% of the
//     1,000 allowed, so clock skew and retries stay inside the limit;
//   - honours Reddit's headers: when X-Ratelimit-Remaining falls to
//     UPSTREAM_RESERVE or below, nothing is granted until
//     X-Ratelimit-Reset has passed;
//   - lets background jobs (discovery, the deletion re-check) ask for a
//     `reserve`: they are refused while fewer than `reserve` requests are
//     left in the window, so a collection run always has room.
// The collection run's own share: RUN_ALLOWANCE requests per run (the
// window cap spread over the 2–3 minute cadence), split evenly across the
// selected subreddits (pagesPerSubreddit).
//
// DbBudget keeps the window in reddit_api_budget (migration 025): every
// grant is one atomic UPDATE, so the worker's collection, the maintenance
// jobs and a POST /api/refresh collection share it. MemoryBudget is the same
// rule in one process (unit tests).

'use strict';

const { CollectorError } = require('../errors');

const QPM_LIMIT = 100;
const WINDOW_MS = 10 * 60 * 1000;
const SAFETY = 0.9;
const WINDOW_CAP = Math.floor(QPM_LIMIT * (WINDOW_MS / 60000) * SAFETY);   // 900
const UPSTREAM_RESERVE = 10;
const DEFAULT_CADENCE_MS = 150 * 1000;

/** Requests one collection run may use: the window cap spread over the cadence. */
function runAllowance(cadenceMs = DEFAULT_CADENCE_MS) {
    const ms = Number.isFinite(cadenceMs) && cadenceMs > 0 ? cadenceMs : DEFAULT_CADENCE_MS;
    return Math.max(1, Math.floor(WINDOW_CAP * Math.min(ms, WINDOW_MS) / WINDOW_MS));
}

/**
 * Pages each subreddit may read in one run: the run allowance (minus the
 * token request) shared evenly across the subreddits, at least 1, at most
 * `maxPages`.
 */
function pagesPerSubreddit(subredditCount, { cadenceMs, maxPages = 3 } = {}) {
    const n = Math.max(1, subredditCount || 1);
    return Math.max(1, Math.min(maxPages, Math.floor((runAllowance(cadenceMs) - 1) / n)));
}

/** Refused by the budget: stop and resume on a later run (not an error). */
class BudgetExhaustedError extends CollectorError {
    constructor(message = 'Reddit request budget exhausted for this window — resuming later') {
        super(message);
    }
}

const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(Array.isArray(v) ? v[0] : v);
    return Number.isFinite(n) ? n : null;
};

/** X-Ratelimit-* response headers → numbers (null when absent). */
function parseRateHeaders(headers = {}) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[k.toLowerCase()] = v;
    return {
        used: num(h['x-ratelimit-used']),
        remaining: num(h['x-ratelimit-remaining']),
        resetSec: num(h['x-ratelimit-reset']),
    };
}

class MemoryBudget {
    constructor({ cap = WINDOW_CAP, windowMs = WINDOW_MS, now = () => Date.now() } = {}) {
        this.cap = cap;
        this.windowMs = windowMs;
        this.now = now;
        this.windowStart = null;
        this.used = 0;
        this.blockedUntil = 0;
    }

    /** @returns {Promise<boolean>} whether one request is granted */
    async take({ reserve = 0 } = {}) {
        const t = this.now();
        if (t < this.blockedUntil) return false;
        if (this.windowStart === null || t >= this.windowStart + this.windowMs) {
            this.windowStart = t;
            this.used = 0;
        }
        if (this.used + reserve >= this.cap) return false;
        this.used++;
        return true;
    }

    async observe(headers) {
        const r = parseRateHeaders(headers);
        if (r.remaining !== null && r.remaining <= UPSTREAM_RESERVE) {
            this.blockedUntil = this.now() + Math.max(1, r.resetSec === null ? 60 : r.resetSec) * 1000;
        }
    }
}

class DbBudget {
    constructor({ cap = WINDOW_CAP, windowMs = WINDOW_MS, db = require('../../db/connection') } = {}) {
        this.cap = cap;
        this.windowMs = windowMs;
        this.db = db;
    }

    async take({ reserve = 0 } = {}) {
        await this.db.dbRun('INSERT INTO reddit_api_budget (id) VALUES (1) ON CONFLICT (id) DO NOTHING');
        // One statement: roll an expired window (the first grant of the new
        // window counts as 1) or grant within the cap; never while blocked.
        const row = await this.db.dbGet(
            `UPDATE reddit_api_budget
             SET used = CASE WHEN window_start <= NOW() - make_interval(secs => $2) THEN 1 ELSE used + 1 END,
                 window_start = CASE WHEN window_start <= NOW() - make_interval(secs => $2) THEN NOW() ELSE window_start END,
                 updated_at = NOW()
             WHERE id = 1
               AND (blocked_until IS NULL OR blocked_until <= NOW())
               AND (window_start <= NOW() - make_interval(secs => $2) OR used + $3 < $1)
             RETURNING used`,
            [this.cap, this.windowMs / 1000, Math.max(0, reserve)],
        );
        return !!row;
    }

    async observe(headers) {
        const r = parseRateHeaders(headers);
        if (r.remaining === null) return;
        const reset = Math.max(1, r.resetSec === null ? 60 : r.resetSec);
        await this.db.dbRun(
            `UPDATE reddit_api_budget
             SET upstream_remaining = $1::real,
                 upstream_reset_at = NOW() + make_interval(secs => $2::double precision),
                 blocked_until = CASE WHEN $1::real <= $3::real THEN NOW() + make_interval(secs => $2::double precision) ELSE blocked_until END,
                 updated_at = NOW()
             WHERE id = 1`,
            [r.remaining, reset, UPSTREAM_RESERVE],
        );
    }
}

module.exports = {
    QPM_LIMIT, WINDOW_MS, WINDOW_CAP, UPSTREAM_RESERVE, runAllowance, pagesPerSubreddit, parseRateHeaders,
    MemoryBudget, DbBudget, BudgetExhaustedError,
};
