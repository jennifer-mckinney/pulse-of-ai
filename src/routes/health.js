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
//                    stored_posts, stored_demo_posts }     ← every stored post
//   active_sources registry sources flagged active, EXCLUDING demo feeds
//   demo_feeds     number of demo feed sources (never counted as sources)
//
//   redis          { reachable } — an authenticated PING answered (P9-7)
//   worker         { alive, last_heartbeat } — the worker's heartbeat
//                  (src/workers/heartbeat.js); alive = a beat within its TTL
//
// Redis probes are bounded (REDIS_PROBE_TIMEOUT_MS): a down or hanging Redis
// reports reachable:false, never fails or stalls the endpoint.
//
// Used by the frontend dashboard status indicator.
// Mirrors GET /api/health in the API contract.

'use strict';

const { Router }     = require('express');
const { isConnected, dbGet, dbAll } = require('../db/connection');
const { DEMO_SOURCE_TYPE, deriveDataMode } = require('../config/data-mode');
// Same registry the globe resolves cities with (see routes/posts.js for why
// server code reads this public/ file).
const { findCity } = require('../../public/js/config/cities.config.js');

const { createRedisClient } = require('../queues/connection');
const { readHeartbeat } = require('../workers/heartbeat');

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

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
    ]).finally(() => clearTimeout(timer));
}

/** { redis: { reachable }, worker: { alive, last_heartbeat } } — never throws. */
async function queueStatus() {
    const client = redis();
    try {
        await withTimeout(Promise.resolve().then(() => client.ping()), REDIS_PROBE_TIMEOUT_MS);
    } catch {
        return { redis: { reachable: false }, worker: { alive: false, last_heartbeat: null } };
    }
    let worker = { alive: false, last_heartbeat: null };
    try {
        worker = await withTimeout(readHeartbeat(client), REDIS_PROBE_TIMEOUT_MS);
    } catch { /* reachable, but the read failed: worker unknown */ }
    return { redis: { reachable: true }, worker };
}

router.get('/health', async (req, res) => {
    try {
        const dbConnected = await isConnected();

        // Most recent processing job (null if none)
        const lastJob = await dbGet(
            `SELECT id, status, triggered_by, posts_processed, started_at, completed_at
             FROM processing_jobs
             ORDER BY started_at DESC
             LIMIT 1`,
        ) || null;

        // Unresolved alert events for the active_alerts field
        const activeAlerts = await dbAll(
            `SELECT id, alert_type, severity, created_at
             FROM alert_events
             WHERE resolved_at IS NULL
             ORDER BY created_at DESC`,
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

        return res.json({
            status:        dbConnected ? 'healthy' : 'degraded',
            db_connected:  dbConnected,
            last_job:      lastJob,
            active_alerts: activeAlerts,
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
            ...(await queueStatus()),
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[health] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
module.exports._setRedisClientForTests = _setRedisClientForTests;
