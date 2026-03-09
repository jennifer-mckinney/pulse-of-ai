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

const { Router } = require('express');
const { dbAll }  = require('../db/connection');

const router = Router();

router.get('/methodology', async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT
                component,
                version,
                model_name,
                config,
                justification,
                effective_from,
                deprecated_at
             FROM methodology_versions
             WHERE deprecated_at IS NULL
             ORDER BY component ASC, effective_from DESC`,
        );

        return res.json(rows);
    } catch (err) {
        console.error('[methodology] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
