// src/routes/sources.js
// GET /api/sources
//
// Returns the data source registry for dashboard display and collector configuration.
//
// Query params:
//   ?include_inactive=true    include inactive sources (default: active only)
//
// Returns:
//   200 [ { id, name, display_name, source_type, category, active } ]

'use strict';

const { Router } = require('express');
const { dbAll }  = require('../db/connection');

const router = Router();

router.get('/sources', async (req, res) => {
    try {
        const includeInactive = req.query.include_inactive === 'true';

        const rows = await dbAll(
            `SELECT
                id,
                name,
                display_name,
                source_type,
                category,
                active
             FROM data_sources
             ${includeInactive ? '' : 'WHERE active = true'}
             ORDER BY category ASC, name ASC`,
        );

        return res.json(rows);
    } catch (err) {
        console.error('[sources] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
