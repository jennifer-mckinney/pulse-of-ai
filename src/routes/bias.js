// src/routes/bias.js
// GET /api/bias/latest
//
// Returns the most recent bias assessment results.
// Scoped to the most recently completed processing job.
//
// Returns:
//   200 {
//     job_id: uuid | null,
//     assessed_at: ISO8601 | null,
//     violations: [ { assessment_type, group_field, group_value,
//                     metric_name, metric_value, threshold, severity } ],
//     all_assessments: [ ... same shape ... ]
//   }
//
// GET /api/bias/history
//
// Trailing-window alert history for the health drawer ("ALERT HISTORY · LAST
// 12H"). One row per bias assessment in the window, newest first, mapped to
// the frontend severity vocabulary (alert | watch | pass — see
// src/config/bias-vocabulary.js for the mapping) with layer display names and
// literature citations from the VERSIONED 'bias' methodology config.
//
// Query params:
//   ?hours=12    window size in hours (integer, default 12, clamped to 1..48)
//
// Returns:
//   200 { window_hours, generated_at,
//         alerts: [ { id, time, severity, layer, assessment_type, group_value,
//                     metric_name, value, threshold, detail, citation } ] }
//   400 when hours is not an integer

'use strict';

const { Router }       = require('express');
const { dbGet, dbAll } = require('../db/connection');
const { severityLabel, layerName, citationFor, alertDetail } = require('../config/bias-vocabulary');

const router = Router();

// Hard cap on history rows per response — the drawer shows a short list, and
// an unbounded window query must not become a memory hazard.
const HISTORY_ROW_LIMIT = 200;

router.get('/bias/history', async (req, res) => {
    try {
        // Same validate-then-clamp pattern as /api/sources/timeseries: strict
        // integer check first (parseInt would silently accept '1.5'), then
        // clamp — window size is a display preference, not a correctness input.
        let hours = 12;
        if (req.query.hours !== undefined) {
            if (!/^-?\d+$/.test(req.query.hours)) {
                return res.status(400).json({ error: 'hours must be an integer' });
            }
            hours = parseInt(req.query.hours, 10);
        }
        hours = Math.min(48, Math.max(1, hours));

        // Versioned bias methodology config: layer display names, citations.
        const biasMv = await dbGet(
            `SELECT config FROM methodology_versions
             WHERE component = 'bias' AND deprecated_at IS NULL
             ORDER BY effective_from DESC
             LIMIT 1`,
        );
        const biasConfig = biasMv ? biasMv.config : null;

        const rows = await dbAll(
            `SELECT
                id, assessment_type, group_field, group_value,
                metric_name, metric_value, threshold, is_violation, severity,
                created_at
             FROM bias_assessments
             WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
             ORDER BY created_at DESC
             LIMIT ${HISTORY_ROW_LIMIT}`,
            [hours],
        );

        const alerts = rows.map(row => ({
            id:              row.id,
            time:            row.created_at,
            severity:        severityLabel(row),
            layer:           layerName(row.assessment_type, biasConfig),
            assessment_type: row.assessment_type,
            group_value:     row.group_value,
            metric_name:     row.metric_name,
            value:           row.metric_value,
            threshold:       row.threshold,
            detail:          alertDetail(row, biasConfig),
            citation:        citationFor(row.assessment_type, biasConfig),
        }));

        return res.json({
            window_hours: hours,
            generated_at: new Date().toISOString(),
            alerts,
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[bias] History error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

router.get('/bias/latest', async (req, res) => {
    try {
        // Find the most recently completed job (regardless of whether it has assessments).
        // Using INNER JOIN here would exclude jobs with no assessments, incorrectly reporting
        // a stale job as "latest" when a newer job exists but produced no bias findings.
        const latestJob = await dbGet(
            `SELECT id
             FROM processing_jobs
             WHERE status = 'completed'
             ORDER BY started_at DESC
             LIMIT 1`,
        );

        if (!latestJob) {
            return res.json({
                job_id:          null,
                assessed_at:     null,
                violations:      [],
                all_assessments: [],
            });
        }

        const all = await dbAll(
            `SELECT
                id, assessment_type, group_field, group_value,
                metric_name, metric_value, threshold, is_violation, severity,
                evidence, created_at
             FROM bias_assessments
             WHERE job_id = $1
             ORDER BY created_at ASC`,
            [latestJob.id],
        );

        const violations   = all.filter(a => a.is_violation);
        const assessed_at  = all.length > 0 ? all[all.length - 1].created_at : null;

        return res.json({
            job_id:          latestJob.id,
            assessed_at,
            violations,
            all_assessments: all,
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[bias] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
