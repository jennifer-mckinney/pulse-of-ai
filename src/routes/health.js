// src/routes/health.js
// GET /api/health — system health check
//
// Returns:
//   200 { status, db_connected, last_job, active_alerts,
//         data_mode, data_window, active_sources, demo_feeds }
//
//   data_mode      'demo' | 'live' | 'mixed' | 'none' — where the posts the
//                  GLOBE shows for the trailing hour came from, classified by
//                  source (src/config/data-mode.js). Same rule as the globe
//                  (G9-2): posts WITH a sentiment result AT a city the
//                  registry resolves (public/js/config/cities.config.js) —
//                  exactly the rows /api/posts/aggregated-by-location places
//                  and public/js/data.js dataModeOf counts.
//   data_window    { hours: 1, posts, demo_posts,          ← the globe's rule
//                    stored_posts, stored_demo_posts }     ← every post stored in the window (hour)
//   active_sources registry sources flagged active, EXCLUDING demo feeds
//   demo_feeds     number of demo feed sources (never counted as sources)
//   sources        { registry: SOURCES.length (52), seeded, collecting, online, by_status }
//                  from the source registry of record and each source's
//                  runtime gate status + last successful run
//                  (src/collectors/status.js). "Sources online" = online:
//                  collecting AND succeeded within the last hour.
//
//   alerts_closed  { resolved, superseded } — closed alerts by kind (G1,
//                  migration 036 alert_status view)
//   maintenance    { tasks: { retention|daily: { last_run_at, last_ok_at,
//                    last_failed_at, last_error } | null },
//                    (and terms), retention_overdue: { posts, sources: [{ slug, posts,
//                    oldest_collected_at }] } | { error } } — PR #22 P0-1:
//                  the last successful maintenance run per task
//                  (maintenance_state, migration 039) and text held past
//                  its window (src/collectors/retention-overdue.js)
//   jobs           { failed_last_hour } — collection cycles (processing_jobs)
//                  that failed in the last hour (the watchdog's
//                  failed_jobs_abnormal condition reads it)
//   watchdog       { reporting, last_poll_at, poll_interval_s, open,
//                    email: { configured, status, last_sent_at, last_error },
//                    config_errors } — the external watchdog
//                  (scripts/watchdog.js, migration 050). reporting = it
//                  polled within 3 poll intervals; open = the conditions it
//                  holds open. email.status is "email alerting not
//                  configured" when SMTP is unset: web never holds the SMTP
//                  settings, the watchdog reports them. Never-run watchdog:
//                  reporting false, status "watchdog has not reported".
//   bias_sample    { per_cycle: { last_24h, last_7d }, rolling_window:
//                    { latest_run, last_7d } } — per bias check
//                    { assessments, insufficient, share }: how often it could
//                    not reach its minimum sample (PR #22 principal #11, G2)
//   admission      { window_days: 7, day_basis: 'UTC', counted_as,
//                    sources_reporting, evaluated, admitted,
//                    admitted_without_pattern, rejected: { total, out_of_scope,
//                    old, invalid, duplicate }, patterns: [{ admission_filter,
//                    rule_id, admitted, rejected }], retention_days } — why
//                  fetched items were admitted or rejected, all sources
//                  together (relevance-accuracy R1, migration 068). Counts
//                  only: no source, route, id or text; per-source counts are
//                  on GET /api/sources. retention_days is null when
//                  ADMISSION_RULE_HITS_DAYS is invalid.
//   redis          { reachable } — an authenticated PING answered (P9-7)
//   worker         { alive, last_heartbeat, queues } — the worker's heartbeat
//                  (src/workers/heartbeat.js); alive = a beat within its TTL;
//                  queues = { <queue>: { waiting, active, delayed, failed } }
//                  (P10-8), null when unreadable
//
// Redis probes are bounded (REDIS_PROBE_TIMEOUT_MS): a down or hanging Redis
// reports reachable:false, never fails or stalls the endpoint.
//
// Used by the frontend dashboard status indicator.
// Mirrors GET /api/health in the API contract.

'use strict';

const { logRouteError } = require('../middleware/log-error');
const { responseCache } = require('../middleware/response-cache');

const { Router }     = require('express');
const { isConnected, dbGet, dbAll } = require('../db/connection');
const { DEMO_SOURCE_TYPE, deriveDataMode } = require('../config/data-mode');
// Same registry the globe resolves cities with (see routes/posts.js for why
// server code reads this public/ file).
const { findCity } = require('../../public/js/config/cities.config.js');

const { createRedisClient } = require('../queues/connection');
const { readHeartbeat, readCorrelationStatus } = require('../workers/heartbeat');
const { correlationStatus, saltUsableHere } = require('../pipeline/correlation-gate');
const { sourceRows, summarize } = require('../collectors/status');
const { overdueBySource } = require('../collectors/retention-overdue');
const { scrub } = require('../collectors/redact');
const { insufficientSampleReport } = require('../pipeline/bias-window');
const admissionCounters = require('../collectors/admission-counters');

const router = Router();

const REDIS_PROBE_TIMEOUT_MS = 1500;
let redisClient = null;   // created on first use; injectable for tests

/* istanbul ignore next -- real client construction; tests inject a fake */
function redis() {
    if (!redisClient) {
        redisClient = createRedisClient();
        // Connection errors surface as reachable:false on the next probe;
        // without a listener ioredis would log them as unhandled.
        redisClient.on('error', () => {});
    }
    return redisClient;
}

/** Test hook: inject a { ping, get } client (null restores the real one). */
function _setRedisClientForTests(client) {
    redisClient = client;
}

// P10-8: queue depth per BullMQ queue, next to the worker heartbeat.
const QUEUE_NAMES = Object.freeze(['collect.rss', 'collect.api', 'collect.bulk', 'collect.refresh', 'ingest', 'embed', 'correlate', 'maintenance']);
const COUNT_STATES = Object.freeze(['waiting', 'active', 'delayed', 'failed']);

/* istanbul ignore next -- real BullMQ queues; tests inject counts */
function defaultQueueCounts() {
    const q = require('../queues/index');
    const byName = {
        'collect.rss': q.collectRssQueue, 'collect.api': q.collectApiQueue, 'collect.bulk': q.collectBulkQueue,
        'collect.refresh': q.refreshQueue, ingest: q.ingestQueue, embed: q.embedQueue, correlate: q.correlateQueue,
        maintenance: q.maintenanceQueue,
    };
    return Promise.all(QUEUE_NAMES.map(async n => [n, await byName[n].getJobCounts(...COUNT_STATES)]))
        .then(Object.fromEntries);
}
let queueCounts = defaultQueueCounts;

/** Test hook: inject () => Promise<{ [queue]: counts }> (null restores the default). */
function _setQueueCountsForTests(fn) {
    queueCounts = fn || defaultQueueCounts;
}

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]).finally(() => clearTimeout(timer));
}

/** PR #22 P0-1: last run per maintenance task + retention lag. */
async function maintenanceStatus() {
    const rows = await dbAll(
        `SELECT task, last_run_at, last_ok_at, last_failed_at, last_error FROM maintenance_state`);
    const tasks = { retention: null, daily: null, terms: null };
    for (const r of rows) tasks[r.task] = { last_run_at: r.last_run_at, last_ok_at: r.last_ok_at,
        last_failed_at: r.last_failed_at, last_error: r.last_error };
    let overdue;
    try {
        const list = await overdueBySource();
        overdue = { posts: list.reduce((n, r) => n + r.posts, 0),
            sources: list.map(r => ({ slug: r.slug, posts: r.posts, oldest_collected_at: r.oldest_collected_at })) };
    } catch (err) {
        // A misconfigured window (M1): reported, never a fake zero.
        overdue = { error: scrub(err.message) };
    }
    return { tasks, retention_overdue: overdue };
}

const WATCHDOG_NOT_REPORTED = 'watchdog has not reported';

/** PR #22 principal #12: what the external watchdog last reported. */
async function watchdogStatus(now = new Date()) {
    const row = await dbGet(
        `SELECT last_poll_at, poll_interval_s, open_conditions, email_configured, email_status,
                last_email_at, last_email_error, config_errors
         FROM watchdog_state WHERE id = 1`);
    if (!row) {
        return { reporting: false, last_poll_at: null, poll_interval_s: null, open: [],
            email: { configured: false, status: WATCHDOG_NOT_REPORTED, last_sent_at: null, last_error: null },
            config_errors: [] };
    }
    const age = now.getTime() - new Date(row.last_poll_at).getTime();
    return {
        reporting: age <= 3 * row.poll_interval_s * 1000,
        last_poll_at: row.last_poll_at,
        poll_interval_s: row.poll_interval_s,
        open: Array.isArray(row.open_conditions) ? row.open_conditions : [],
        email: { configured: row.email_configured, status: row.email_status,
            last_sent_at: row.last_email_at, last_error: row.last_email_error },
        config_errors: Array.isArray(row.config_errors) ? row.config_errors : [],
    };
}

/**
 * PR #22 security L1: the correlation gate status. The web process does not
 * hold CORRELATION_SALT, so the worker's published status (Redis, with its
 * heartbeat) is authoritative; without it, the web process reports what it
 * can judge from its env (the DPIA and switch, and only a presence flag for
 * the salt: status 'unverified' when the salt is set for the worker).
 */
function correlationReport(published, env = process.env) {
    if (published) {
        return { enabled: published.enabled, status: published.status, reason: published.reason,
            checked_by: 'worker', checked_at: published.checked_at };
    }
    const { enabled, status, reason } = correlationStatus(env, { saltUsable: saltUsableHere(env) });
    return { enabled, status, reason, checked_by: 'web', checked_at: null };
}

/** { redis: { reachable }, worker: { alive, last_heartbeat, queues }, published } — never throws. */
async function queueStatus() {
    const client = redis();
    try {
        await withTimeout(Promise.resolve().then(() => client.ping()), REDIS_PROBE_TIMEOUT_MS);
    } catch {
        return { redis: { reachable: false }, worker: { alive: false, last_heartbeat: null, queues: null }, published: null };
    }
    let published = null;
    try {
        published = await withTimeout(Promise.resolve().then(() => readCorrelationStatus(client)), REDIS_PROBE_TIMEOUT_MS);
    } catch { /* unreadable: the web-side report is used */ }
    let worker = { alive: false, last_heartbeat: null };
    try {
        worker = await withTimeout(readHeartbeat(client), REDIS_PROBE_TIMEOUT_MS);
    } catch { /* reachable, but the read failed: worker unknown */ }
    // P10-8: backlog per queue (waiting / active / delayed / failed); null
    // when the counts could not be read in time — never a fake zero.
    let queues = null;
    try {
        const raw = await withTimeout(Promise.resolve().then(() => queueCounts()), REDIS_PROBE_TIMEOUT_MS);
        queues = {};
        for (const n of QUEUE_NAMES) {
            const c = (raw && raw[n]) || {};
            queues[n] = Object.fromEntries(COUNT_STATES.map(k => [k, Number.isFinite(Number(c[k])) ? Number(c[k]) : 0]));
        }
    } catch { /* counts unavailable */ }
    return { redis: { reachable: true }, worker: { ...worker, queues }, published };
}

// PR #22 security L2: /api/health is public and fans out to Redis (8
// queues) and Postgres on every call. A 5 s response cache, keyed on the
// path alone (the route takes no parameters, so a varying query string
// cannot bypass it), bounds that load; the dashboard polls far less often.
const HEALTH_CACHE_TTL_MS = 5000;

router.get('/health', responseCache(HEALTH_CACHE_TTL_MS, { key: () => 'GET /api/health' }), async (req, res) => {
    try {
        const dbConnected = await isConnected();

        // Most recent processing job (null if none)
        const lastJob = await dbGet(
            `SELECT id, status, triggered_by, posts_processed, started_at, completed_at
             FROM processing_jobs
             ORDER BY started_at DESC
             LIMIT 1`,
        ) || null;

        // Unresolved alert events for the active_alerts field. The watchdog's
        // alerts (source_table 'watchdog') carry their one-line summary so
        // the dashboard can name them (principal #12).
        const activeAlerts = await dbAll(
            `SELECT id, alert_type, severity, created_at,
                    CASE WHEN source_table = 'watchdog' THEN details->>'title' END   AS title,
                    CASE WHEN source_table = 'watchdog' THEN details->>'summary' END AS summary,
                    (source_table = 'watchdog')                                      AS system
             FROM alert_events
             WHERE resolved_at IS NULL
             ORDER BY created_at DESC`,
        );

        // PR #22 G1: closed alerts by kind — 'superseded' (closed because a
        // later methodology would not raise them, with the owner's approval,
        // migration 036) apart from genuinely 'resolved'.
        const closed = await dbGet(
            `SELECT COUNT(*) FILTER (WHERE status = 'resolved')::int   AS resolved,
                    COUNT(*) FILTER (WHERE status = 'superseded')::int AS superseded
             FROM alert_status`,
        );

        // Data mode over the trailing hour — the same window the frontend
        // renders (public/js/data.js TRAILING_WINDOW_MS) — by the globe's
        // rule: the aggregated query's joins (sentiment_results, a location)
        // per city, then only cities the registry resolves.
        const cityCounts = await dbAll(
            `SELECT rp.location                                            AS city,
                    COUNT(*)::int                                           AS posts,
                    COUNT(*) FILTER (WHERE ds.source_type = $1)::int        AS demo_posts
             FROM raw_posts rp
             JOIN sentiment_results sr ON sr.raw_post_id = rp.id
             JOIN data_sources ds      ON ds.id = rp.source_id
             WHERE rp.collected_at >= NOW() - INTERVAL '1 hour'
               AND rp.location IS NOT NULL AND rp.location <> ''
             GROUP BY rp.location`,
            [DEMO_SOURCE_TYPE],
        );
        const shown = { posts: 0, demo_posts: 0 };
        for (const row of cityCounts) {
            if (!findCity(row.city)) continue;   // the globe drops unplaced rows
            shown.posts += row.posts;
            shown.demo_posts += row.demo_posts;
        }
        // Everything stored in the hour, reported alongside (never classified).
        const stored = await dbGet(
            `SELECT COUNT(*)::int                                           AS posts,
                    COUNT(*) FILTER (WHERE ds.source_type = $1)::int        AS demo_posts
             FROM raw_posts rp
             JOIN data_sources ds ON ds.id = rp.source_id
             WHERE rp.collected_at >= NOW() - INTERVAL '1 hour'`,
            [DEMO_SOURCE_TYPE],
        );

        // Real registry sources vs demo feeds: demo feeds are never sources.
        const sourceCounts = await dbGet(
            `SELECT COUNT(*) FILTER (WHERE active AND source_type <> $1)::int AS active_sources,
                    COUNT(*) FILTER (WHERE source_type = $1)::int              AS demo_feeds
             FROM data_sources`,
            [DEMO_SOURCE_TYPE],
        );

        const sources = summarize(await sourceRows());
        const maintenance = await maintenanceStatus();
        const failedCycles = await dbGet(
            `SELECT COUNT(*)::int AS n FROM processing_jobs
             WHERE status = 'failed' AND completed_at >= NOW() - INTERVAL '1 hour'`);
        const watchdog = await watchdogStatus();
        const queue = await queueStatus();
        // PR #22 principal #11 / G2: the insufficient-sample share per bias
        // check, per cycle and in the rolling 24 h window.
        const biasSample = await insufficientSampleReport();
        // Relevance-accuracy R1 (migration 068): admission counts over the
        // last 7 UTC days, all sources together — aggregates only.
        // An optional metric must not take the liveness/watchdog signal down
        // (a web deploy ahead of migration 068, a lock, a timeout): null instead.
        const admission = await admissionCounters.admissionTotals().catch((err) => {
            logRouteError('GET /api/health admission', err);
            return null;
        });

        return res.json({
            status:        dbConnected ? 'healthy' : 'degraded',
            db_connected:  dbConnected,
            last_job:      lastJob,
            active_alerts: activeAlerts,
            alerts_closed: { resolved: closed.resolved, superseded: closed.superseded },
            data_mode:     deriveDataMode(shown.demo_posts, shown.posts),
            data_window:   {
                hours:             1,
                posts:             shown.posts,
                demo_posts:        shown.demo_posts,
                stored_posts:      stored.posts,
                stored_demo_posts: stored.demo_posts,
            },
            active_sources: sourceCounts.active_sources,
            demo_feeds:     sourceCounts.demo_feeds,
            redis:          queue.redis,
            worker:         queue.worker,
            sources,
            maintenance,
            jobs:           { failed_last_hour: failedCycles.n },
            watchdog,
            bias_sample: biasSample,
            admission,
            // Spec §20 DPIA gate: correlation is off (explicitly) until a
            // completed DPIA is recorded and the operator enables it.
            // PR #22 security L1: from the worker (which alone holds the
            // salt) when it has published it; checked_by says which.
            correlation: correlationReport(queue.published),
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('health', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
module.exports._setRedisClientForTests = _setRedisClientForTests;
module.exports._setQueueCountsForTests = _setQueueCountsForTests;
module.exports.QUEUE_NAMES = QUEUE_NAMES;
module.exports.WATCHDOG_NOT_REPORTED = WATCHDOG_NOT_REPORTED;
module.exports.HEALTH_CACHE_TTL_MS = HEALTH_CACHE_TTL_MS;
