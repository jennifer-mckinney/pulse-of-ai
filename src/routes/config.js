// src/routes/config.js
// GET /api/config
//
// Returns non-secret client-side configuration values from environment.
// Keeps API tokens out of client JS bundles — the token is stored in .env
// and served here at runtime, never hardcoded in the frontend source.

'use strict';

const { Router } = require('express');

const router = Router();

router.get('/config', (req, res) => {
    const mapboxToken = process.env.MAPBOX_ACCESS_TOKEN;

    if (!mapboxToken) {
        console.warn('[config] MAPBOX_ACCESS_TOKEN is not set — map will not render');
        return res.status(503).json({ error: 'Mapbox token not configured' });
    }

    // Only expose values explicitly safe for client consumption
    return res.json({ mapboxToken });
});

module.exports = router;
