// src/watchdog/conditions.js
// What the watchdog alerts on (PR #22 principal #12) — pure functions over
// one poll of GET /api/health plus the watchdog's own database probe.
//
//   condition             raised when
//   web_unreachable       /api/health did not answer 2xx JSON (connection
//                         refused, timeout, 5xx …) — unless the answer was a
//                         5xx while the database is down (then db_unreachable
//                         names the cause)
//   db_unreachable        the watchdog's own SELECT 1 failed, or health says
//                         db_connected false
//   valkey_unreachable    health.redis.reachable is false
//   worker_down           Valkey answers but the worker heartbeat is missing
//                         or older than its TTL (worker.alive false)
//   maintenance_failing   a maintenance task's latest run failed, or its last
//                         successful run is older than its limit (retention
//                         30 min, daily 26 h, terms 8 days by default)
//   retention_overdue     text is still stored past its retention window
//                         (health.maintenance.retention_overdue), or the
//                         window setting is invalid
//   collection_failing    sources are enabled (collecting > 0) but none
//                         collected successfully in the last hour (online 0)
//   queue_backlog         a queue holds more waiting + delayed jobs than
//                         WATCHDOG_MAX_QUEUE_DEPTH
//   failed_jobs_abnormal  queue failures rose by more than
//                         WATCHDOG_MAX_QUEUE_FAILED_PER_HOUR in the last hour,
//                         or more than WATCHDOG_MAX_FAILED_CYCLES_PER_HOUR
//                         collection cycles failed in the last hour
//
// When health cannot be read, only web_unreachable / db_unreachable are
// evaluated: everything else is UNKNOWN, and an unknown is never reported as
// either a problem or a recovery — evaluate() lists them in `unknown` and the
// caller keeps whatever it already had open for them. Likewise, while
// Valkey is unreachable the worker and queue state are unknown.

'use strict';

const CONDITIONS = Object.freeze({
    web_unreachable:      'Web API unreachable',
    db_unreachable:       'Database unreachable',
    valkey_unreachable:   'Valkey (queue store) unreachable',
    worker_down:          'Worker down (heartbeat stale)',
    maintenance_failing:  'Maintenance failing or overdue',
    retention_overdue:    'Text retention overdue',
    collection_failing:   'Collection failing',
    queue_backlog:        'Queue backlog abnormal',
    failed_jobs_abnormal: 'Failed jobs abnormal',
});

const ALERT_PREFIX = 'watchdog_';
const alertType = (condition) => ALERT_PREFIX + condition;
const conditionOf = (type) => (typeof type === 'string' && type.startsWith(ALERT_PREFIX) ? type.slice(ALERT_PREFIX.length) : null);

const HOUR_MS = 3600000;

function ago(ms) {
    if (!Number.isFinite(ms) || ms < 0) return 'unknown';
    const m = Math.round(ms / 60000);
    if (m < 90) return `${m} min`;
    const h = Math.round(ms / HOUR_MS);
    return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
}

const ts = (v) => { const t = Date.parse(v); return Number.isNaN(t) ? null : t; };

/**
 * Failures per queue are cumulative counts (BullMQ keeps the last N failed
 * jobs), so the rate is the rise across polls within the last hour. A count
 * that drops (old failures trimmed or cleaned) contributes nothing.
 */
class FailedJobsWindow {
    constructor(windowMs = HOUR_MS) {
        this.windowMs = windowMs;
        this.samples = [];   // [{ t, counts: { queue: failed } }]
    }

    /** Record one poll's counts; returns the rise over the window. */
    record(nowMs, queues) {
        if (!queues || typeof queues !== 'object') return this.increase(nowMs);
        const counts = {};
        for (const [q, c] of Object.entries(queues)) {
            const f = Number(c && c.failed);
            if (Number.isFinite(f)) counts[q] = f;
        }
        this.samples.push({ t: nowMs, counts });
        // Keep one sample older than the window as the baseline.
        while (this.samples.length > 2 && this.samples[1].t <= nowMs - this.windowMs) this.samples.shift();
        return this.increase(nowMs);
    }

    increase() {
        let rise = 0;
        for (let i = 1; i < this.samples.length; i++) {
            const a = this.samples[i - 1].counts;
            const b = this.samples[i].counts;
            for (const q of Object.keys(b)) {
                if (Number.isFinite(a[q]) && b[q] > a[q]) rise += b[q] - a[q];
            }
        }
        return rise;
    }
}

function maintenanceProblems(maintenance, nowMs, th) {
    const tasks = (maintenance && maintenance.tasks) || {};
    const limits = { retention: th.retentionMaxAgeMs, daily: th.dailyMaxAgeMs, terms: th.termsMaxAgeMs };
    const problems = [];
    for (const [task, limit] of Object.entries(limits)) {
        const s = tasks[task];
        if (!s) continue;   // never ran yet (a fresh stack); worker_down covers a dead worker
        const ok = ts(s.last_ok_at);
        const failed = ts(s.last_failed_at);
        if (failed !== null && (ok === null || failed > ok)) {
            problems.push({ task, reason: 'latest run failed', last_failed_at: s.last_failed_at,
                error: s.last_error ? String(s.last_error).slice(0, 300) : null });
        } else if (ok !== null && nowMs - ok > limit) {
            problems.push({ task, reason: `no successful run for ${ago(nowMs - ok)}`, last_ok_at: s.last_ok_at });
        }
    }
    return problems;
}

/**
 * @param {{ health: object|null, httpStatus: number|null, fetchError: string|null, dbReachable: boolean|null }} probe
 * @param {{ now: Date, thresholds: object, queueFailedRise?: number }} ctx
 * @returns {{ conditions: Array<{ condition, title, summary, details }>, unknown: string[] }}
 */
function evaluate(probe, { now, thresholds: th, queueFailedRise = 0 }) {
    const out = [];
    const add = (condition, summary, details = {}) =>
        out.push({ condition, title: CONDITIONS[condition], summary, details });
    const nowMs = now.getTime();
    const { health, httpStatus, fetchError, dbReachable } = probe;

    const dbDown = dbReachable === false || (health && health.db_connected === false);
    if (!health) {
        const dbCausedIt = dbReachable === false && Number.isInteger(httpStatus) && httpStatus >= 500;
        if (!dbCausedIt) {
            add('web_unreachable', `GET /api/health failed: ${fetchError || `HTTP ${httpStatus}`}`,
                { http_status: httpStatus, error: fetchError });
        }
    }
    if (dbDown) {
        add('db_unreachable', dbReachable === false
            ? 'the watchdog cannot reach PostgreSQL'
            : '/api/health reports db_connected false', { http_status: httpStatus });
    }
    if (!health) {
        return { conditions: out, unknown: Object.keys(CONDITIONS).filter(c => c !== 'web_unreachable' && c !== 'db_unreachable') };
    }
    const unknown = [];

    const redisReachable = health.redis ? health.redis.reachable : undefined;
    if (redisReachable === false) add('valkey_unreachable', '/api/health reports the queue store unreachable');

    const worker = health.worker || {};
    if (redisReachable !== true) unknown.push('worker_down');
    if (!worker.queues || typeof worker.queues !== 'object') unknown.push('queue_backlog', 'failed_jobs_abnormal');
    if (redisReachable === true && worker.alive !== true) {
        const last = ts(worker.last_heartbeat);
        add('worker_down', last === null
            ? 'no worker heartbeat in Valkey (the worker is stopped or never started)'
            : `last worker heartbeat ${ago(nowMs - last)} ago (${worker.last_heartbeat})`,
        { last_heartbeat: worker.last_heartbeat || null });
    }

    const mProblems = maintenanceProblems(health.maintenance, nowMs, th);
    if (mProblems.length) {
        add('maintenance_failing', mProblems.map(p => `${p.task}: ${p.reason}`).join('; '), { tasks: mProblems });
    }

    const overdue = health.maintenance && health.maintenance.retention_overdue;
    if (overdue && overdue.error) {
        add('retention_overdue', `retention window setting invalid: ${String(overdue.error).slice(0, 200)}`, { error: overdue.error });
    } else if (overdue && Number(overdue.posts) > 0) {
        const sources = Array.isArray(overdue.sources) ? overdue.sources : [];
        add('retention_overdue',
            `${overdue.posts} post(s) in ${sources.length} source(s) hold text past the retention window`,
            { posts: overdue.posts, sources: sources.slice(0, 20).map(s => ({ slug: s.slug, posts: s.posts, oldest_collected_at: s.oldest_collected_at })) });
    }

    const src = health.sources;
    if (src && Number(src.collecting) > 0 && Number(src.online) === 0) {
        add('collection_failing',
            `${src.collecting} source(s) enabled, none collected successfully in the last hour`,
            { collecting: src.collecting, online: src.online });
    }

    if (worker.queues && typeof worker.queues === 'object') {
        const deep = [];
        for (const [q, c] of Object.entries(worker.queues)) {
            const depth = Number(c && c.waiting) + Number(c && c.delayed);
            if (Number.isFinite(depth) && depth > th.maxQueueDepth) deep.push({ queue: q, depth });
        }
        if (deep.length) {
            add('queue_backlog', deep.map(d => `${d.queue}: ${d.depth} waiting/delayed`).join('; ')
                + ` (limit ${th.maxQueueDepth})`, { queues: deep, limit: th.maxQueueDepth });
        }
    }

    const failedCycles = Number(health.jobs && health.jobs.failed_last_hour);
    const parts = [];
    if (queueFailedRise > th.maxQueueFailedPerHour) {
        parts.push(`${queueFailedRise} queue job failure(s) in the last hour (limit ${th.maxQueueFailedPerHour})`);
    }
    if (Number.isFinite(failedCycles) && failedCycles > th.maxFailedCyclesPerHour) {
        parts.push(`${failedCycles} failed collection cycle(s) in the last hour (limit ${th.maxFailedCyclesPerHour})`);
    }
    if (parts.length) {
        add('failed_jobs_abnormal', parts.join('; '),
            { queue_failures_last_hour: queueFailedRise, failed_cycles_last_hour: Number.isFinite(failedCycles) ? failedCycles : null });
    }

    return { conditions: out, unknown };
}

module.exports = { evaluate, FailedJobsWindow, CONDITIONS, alertType, conditionOf, ALERT_PREFIX, ago };
