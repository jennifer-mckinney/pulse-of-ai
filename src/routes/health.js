// src/routes/health.js
// GET /api/health — system health check
//
// Returns:
//   200 { status, db_connected, last_job, active_alerts }
//
// Used by the frontend dashboard status indicator.
// Mirrors GET /api/health in the API contract.

'use strict';

const { Router }     = require('express');
const { isConnected, dbGet, dbAll } = require('../db/connection');

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

        return res.json({
            status:        dbConnected ? 'healthy' : 'degraded',
            db_connected:  dbConnected,
            last_job:      lastJob,
            active_alerts: activeAlerts,
        });
    } catch (err) {
        console.error('[health] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
