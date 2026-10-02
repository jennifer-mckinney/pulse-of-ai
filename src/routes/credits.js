// src/routes/credits.js
// GET /api/credits
//
// K1 (docs/research/k1-attribution-design.md): the credits page's data. Every
// registry source that has stored REAL posts (demo feeds and retired slugs
// with no registry entry are not listed), with the credit its excerpts carry,
// its licence and notice, and its terms link; plus the site-wide notices.
//
// Returns:
//   200 { sources: [ { slug, name, category, terms_url,
//                      credit: { text, required, license, license_url,
//                                modified, cite_date, notice, notice_url } } ],
//         notices: { excerpts, links, demo } }
//   500 on DB error (no stack trace returned to client)

'use strict';

const { logRouteError } = require('../middleware/log-error');

const { Router } = require('express');
const { dbAll } = require('../db/connection');
const { responseCache } = require('../middleware/response-cache');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');
const { creditsCatalogue, SITE_NOTICES } = require('../config/attribution');

const router = Router();

// 60 s: the list changes only when a source first stores a post.
router.get('/credits', responseCache(60000, { key: () => '/api/credits' }), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT ds.name
               FROM data_sources ds
              WHERE ds.source_type <> $1
                AND EXISTS (SELECT 1 FROM raw_posts rp WHERE rp.source_id = ds.id)`,
            [DEMO_SOURCE_TYPE],
        );
        return res.json({
            sources: creditsCatalogue(rows.map(r => r.name)),
            notices: SITE_NOTICES,
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('credits', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
