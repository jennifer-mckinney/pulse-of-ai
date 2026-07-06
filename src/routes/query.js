// src/routes/query.js
// POST /api/query
//
// Filtered, paginated query over scored posts.
// Designed for non-real-time research queries (journalists, researchers, policy makers).
//
// Request body:
//   { platform?: string, location?: string, from?: ISO8601, to?: ISO8601, limit?: number (max 100) }
//
// Returns:
//   200 { results: [...], total: number, query: { platform, location, from, to, limit } }
//   400 on validation errors (limit > 100, invalid dates, non-string location)

'use strict';

const { Router } = require('express');
const { dbAll }  = require('../db/connection');

const router = Router();

router.post('/query', async (req, res) => {
    try {
        const {
            platform = null,
            location = null,
            from     = null,
            to       = null,
            limit    = 20,
        } = req.body || {};

        // ─── Validation ───────────────────────────────────────────────────────

        // location is an exact-match filter on raw_posts.location (city-level).
        // Reject non-string values early; null/undefined means "no filter".
        if (location !== null && location !== undefined && typeof location !== 'string') {
            return res.status(400).json({ error: 'location must be a string' });
        }

        const parsedLimit = parseInt(limit, 10);
        if (isNaN(parsedLimit) || parsedLimit < 1) {
            return res.status(400).json({ error: 'limit must be a positive integer' });
        }
        if (parsedLimit > 100) {
            return res.status(400).json({ error: 'limit must be <= 100' });
        }

        let fromDate = null;
        if (from !== null && from !== undefined) {
            fromDate = new Date(from);
            if (isNaN(fromDate.getTime())) {
                return res.status(400).json({ error: 'Invalid from date' });
            }
        }

        let toDate = null;
        if (to !== null && to !== undefined) {
            toDate = new Date(to);
            if (isNaN(toDate.getTime())) {
                return res.status(400).json({ error: 'Invalid to date' });
            }
        }

        // ─── Build parameterised query ────────────────────────────────────────

        const conditions = [];
        const params     = [];

        if (platform) {
            params.push(platform);
            conditions.push(`ds.category = $${params.length}`);
        }

        // Exact match by design: raw_posts.location stores normalized city names,
        // so pattern matching would only invite false positives.
        if (location) {
            params.push(location);
            conditions.push(`rp.location = $${params.length}`);
        }

        if (fromDate) {
            params.push(fromDate.toISOString());
            conditions.push(`rp.collected_at >= $${params.length}`);
        }

        if (toDate) {
            params.push(toDate.toISOString());
            conditions.push(`rp.collected_at <= $${params.length}`);
        }

        const whereClause = conditions.length > 0
            ? `WHERE ${conditions.join(' AND ')}`
            : '';

        params.push(parsedLimit);
        const limitClause = `LIMIT $${params.length}`;

        const results = await dbAll(
            `SELECT
                rp.id,
                LEFT(rp.content, 120)   AS content_snippet,
                sr.indicator,
                sr.score,
                sr.comparative,
                rp.location,
                ds.category             AS platform,
                rp.collected_at
             FROM sentiment_results sr
             JOIN raw_posts rp    ON rp.id = sr.raw_post_id
             JOIN data_sources ds ON ds.id = rp.source_id
             ${whereClause}
             ORDER BY rp.collected_at DESC
             ${limitClause}`,
            params,
        );

        return res.json({
            results,
            total: results.length,
            query: {
                platform: platform ?? null,
                location: location ?? null,
                from:     from     ?? null,
                to:       to       ?? null,
                limit:    parsedLimit,
            },
        });
    } catch (err) {
        console.error('[query] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
