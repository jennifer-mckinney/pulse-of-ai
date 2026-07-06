// src/routes/themes.js
// GET /api/themes
//
// Keyword themes for the scroll-story chapters: aggregates
// relevance_results.matched_keywords across all scored posts.
//
// Per keyword:
//   volume        — number of posts that matched the keyword (sentiment-scored)
//   positive/neutral/negative — sentiment split of those posts
//   top_category  — modal data_sources.category among those posts
//                   (ties broken alphabetically for deterministic output)
//
// Ordered by volume DESC (keyword ASC tie-break), capped at 12 themes.
// Keywords matched by fewer than 3 posts are excluded entirely.
//
// Returns:
//   200 [ { keyword, volume, positive, neutral, negative, top_category } ]
//   200 [] when no relevance results exist

'use strict';

const { Router } = require('express');
const { dbAll }  = require('../db/connection');

const router = Router();

router.get('/themes', async (req, res) => {
    try {
        // ::int casts everywhere — pg returns COUNT() (bigint) as a string,
        // and the frontend needs real numbers.
        const rows = await dbAll(
            `WITH kw_posts AS (
                -- one row per (keyword, post): a post tagged with N keywords
                -- contributes to N themes
                SELECT unnest(rr.matched_keywords) AS keyword, rr.raw_post_id
                FROM relevance_results rr
            ),
            kw_sentiment AS (
                SELECT
                    kp.keyword,
                    COUNT(*)::int                                          AS volume,
                    COUNT(*) FILTER (WHERE sr.indicator = 'positive')::int AS positive,
                    COUNT(*) FILTER (WHERE sr.indicator = 'neutral')::int  AS neutral,
                    COUNT(*) FILTER (WHERE sr.indicator = 'negative')::int AS negative
                FROM kw_posts kp
                JOIN sentiment_results sr ON sr.raw_post_id = kp.raw_post_id
                GROUP BY kp.keyword
                -- Noise guard: keywords matched by fewer than 3 posts are almost
                -- always one-off phrasing artifacts, not real discourse themes —
                -- surfacing them as story chapters would just amplify noise
                HAVING COUNT(*) >= 3
            ),
            kw_category AS (
                -- rank each keyword's categories by post count; rn = 1 is the
                -- modal category, alphabetical order breaks ties deterministically
                SELECT keyword, category,
                       ROW_NUMBER() OVER (
                           PARTITION BY keyword
                           ORDER BY cnt DESC, category ASC
                       ) AS rn
                FROM (
                    SELECT kp.keyword, ds.category, COUNT(*) AS cnt
                    FROM kw_posts kp
                    JOIN raw_posts rp    ON rp.id = kp.raw_post_id
                    JOIN data_sources ds ON ds.id = rp.source_id
                    GROUP BY kp.keyword, ds.category
                ) per_category
            )
            SELECT
                ks.keyword,
                ks.volume,
                ks.positive,
                ks.neutral,
                ks.negative,
                kc.category AS top_category
            FROM kw_sentiment ks
            JOIN kw_category kc ON kc.keyword = ks.keyword AND kc.rn = 1
            ORDER BY ks.volume DESC, ks.keyword ASC
            LIMIT 12`,
        );

        return res.json(rows);
    } catch (err) {
        console.error('[themes] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
