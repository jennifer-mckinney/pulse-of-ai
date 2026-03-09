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

'use strict';

const { Router }       = require('express');
const { dbGet, dbAll } = require('../db/connection');

const router = Router();

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
    } catch (err) {
        console.error('[bias] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
