// src/routes/methodology.js
// GET /api/methodology
//
// Returns all versioned methodology configurations with plain-English justifications.
// This endpoint fulfils the AI Act §13 obligation to explain automated decisions:
// every algorithm configuration is registered here before it processes any data.
//
// Returns:
//   200 [ { component, version, model_name, config, justification, effective_from } ]

'use strict';

const { logRouteError } = require('../middleware/log-error');

const { Router } = require('express');
const { dbAll }  = require('../db/connection');

const router = Router();

router.get('/methodology', async (req, res) => {
    try {
        // P10-16: errata (methodology_errata, migration 030) are served with
        // the version they correct; the corrected row itself is never edited.
        const rows = await dbAll(
            `SELECT
                mv.component,
                mv.version,
                mv.model_name,
                mv.config,
                mv.justification,
                mv.effective_from,
                mv.deprecated_at,
                COALESCE((SELECT json_agg(json_build_object(
                              'erratum', e.erratum, 'corrected_by', e.corrected_by, 'recorded_at', e.recorded_at)
                              ORDER BY e.recorded_at)
                          FROM methodology_errata e WHERE e.methodology_version_id = mv.id), '[]'::json) AS errata
             FROM methodology_versions mv
             WHERE mv.deprecated_at IS NULL
             ORDER BY mv.component ASC, mv.effective_from DESC`,
        );

        return res.json(rows);
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('methodology', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
