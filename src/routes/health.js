// src/routes/health.js
// GET /api/health — system health check
//
// Returns:
//   200 { status, db_connected, last_job, active_alerts,
//         data_mode, data_window, active_sources, demo_feeds }
//
//   data_mode      'demo' | 'live' | 'mixed' | 'none' — where the posts in the
//                  trailing hour (the window the dashboard shows) came from,
//                  classified by source (src/config/data-mode.js)
//   data_window    { hours: 1, posts, demo_posts }
//   active_sources registry sources flagged active, EXCLUDING demo feeds
//   demo_feeds     number of demo feed sources (never counted as sources)
//
// Used by the frontend dashboard status indicator.
// Mirrors GET /api/health in the API contract.

'use strict';

const { Router }     = require('express');
const { isConnected, dbGet, dbAll } = require('../db/connection');
const { DEMO_SOURCE_TYPE, deriveDataMode } = require('../config/data-mode');

const router = Router();

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
        // renders (public/js/data.js TRAILING_WINDOW_MS).
        const windowCounts = await dbGet(
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
            data_mode:     deriveDataMode(windowCounts.demo_posts, windowCounts.posts),
            data_window:   {
                hours:      1,
                posts:      windowCounts.posts,
                demo_posts: windowCounts.demo_posts,
            },
            active_sources: sourceCounts.active_sources,
            demo_feeds:     sourceCounts.demo_feeds,
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[health] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
