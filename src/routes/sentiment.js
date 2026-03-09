// src/routes/sentiment.js
// GET /api/sentiment/latest
//
// Returns:
//   200 {
//     summary: { total, positive, neutral, negative, avg_comparative, last_updated },
//     recent_posts: [ { id, content_snippet, sentiment_indicator, score, comparative,
//                       location, source_category, collected_at, audit_id } ],
//     refreshed_at: ISO8601
//   }
//
// Query params:
//   ?limit=20      max posts in recent_posts (default 20, max 100)
//   ?platform=     filter by source category

'use strict';

const { Router } = require('express');
const { dbGet, dbAll } = require('../db/connection');

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
                rp.collected_at,
                sr.audit_id
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
            recent_posts: recentPosts,
            refreshed_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error('[sentiment] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
