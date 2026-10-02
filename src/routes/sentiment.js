// src/routes/sentiment.js
// GET /api/sentiment/latest
//
// Returns:
//   200 {
//     summary: { total, positive, neutral, negative, avg_comparative, last_updated },
//     recent_posts: [ { id, content_snippet, sentiment_indicator, score, comparative,
//                       location, source_category, source_name, collected_at, audit_id,
//                       attribution, credit, source_url, published_at, data_origin } ],
//                     (K1: credit + validated link back, src/config/attribution.js)
//     refreshed_at: ISO8601
//   }
//
// Query params:
//   ?limit=20      max posts in recent_posts (default 20, max 100)
//   ?platform=     filter by source category

'use strict';

const { logRouteError } = require('../middleware/log-error');

const { Router } = require('express');
const { dbGet, dbAll } = require('../db/connection');
const { postAttribution } = require('../config/attribution');

const router = Router();

router.get('/sentiment/latest', async (req, res) => {
    try {
        const rawLimit = parseInt(req.query.limit, 10);
        const limit    = isNaN(rawLimit) ? 20 : Math.min(Math.max(rawLimit, 1), 100);
        const platform = req.query.platform || null;

        // Build optional platform filter
        const platformParam  = platform ? [platform] : [];
        const platformClause = platform
            ? `AND ds.category = $${platformParam.length}`
            : '';

        // Aggregate summary across all time
        const summary = await dbGet(
            `SELECT
                COUNT(*)::int                                             AS total,
                COUNT(*) FILTER (WHERE sr.indicator = 'positive')::int   AS positive,
                COUNT(*) FILTER (WHERE sr.indicator = 'neutral')::int    AS neutral,
                COUNT(*) FILTER (WHERE sr.indicator = 'negative')::int   AS negative,
                AVG(sr.comparative)                                       AS avg_comparative,
                MAX(rp.collected_at)                                      AS last_updated
             FROM sentiment_results sr
             JOIN raw_posts rp    ON rp.id = sr.raw_post_id
             JOIN data_sources ds ON ds.id = rp.source_id
             WHERE 1=1 ${platformClause}`,
            platformParam,
        );

        // Most recent posts
        const recentParams = [...platformParam, limit];
        const recentPosts  = await dbAll(
            `SELECT
                rp.id,
                LEFT(rp.content, 120)  AS content_snippet,
                sr.indicator           AS sentiment_indicator,
                sr.score,
                sr.comparative,
                rp.location,
                ds.category            AS source_category,
                ds.name                AS source_name,
                rp.collected_at,
                sr.audit_id,
                rp.raw_payload->>'url'          AS stored_url,
                rp.raw_payload->>'published_at' AS stored_published_at,
                ds.source_type                  AS stored_source_type
             FROM sentiment_results sr
             JOIN raw_posts rp    ON rp.id = sr.raw_post_id
             JOIN data_sources ds ON ds.id = rp.source_id
             WHERE 1=1 ${platformClause}
             ORDER BY rp.collected_at DESC
             LIMIT $${recentParams.length}`,
            recentParams,
        );

        return res.json({
            summary: {
                total:           summary?.total           ?? 0,
                positive:        summary?.positive        ?? 0,
                neutral:         summary?.neutral         ?? 0,
                negative:        summary?.negative        ?? 0,
                avg_comparative: parseFloat(summary?.avg_comparative ?? 0) || 0,
                last_updated:    summary?.last_updated ?? null,
            },
            // K1: each post carries its source credit and the validated link
            // back to the original (src/config/attribution.js).
            recent_posts: recentPosts.map(({ stored_url, stored_published_at, stored_source_type, ...row }) => ({
                ...row,
                ...postAttribution({
                    sourceName: row.source_name, sourceType: stored_source_type,
                    url: stored_url, publishedAt: stored_published_at,
                }),
            })),
            refreshed_at: new Date().toISOString(),
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('sentiment', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
