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
//
// GET /api/sources/timeseries
//
// Hourly sentiment volume per source category for the trailing window.
//
// Query params:
//   ?hours=12    window size in hours (integer, default 12, clamped to 1..48)
//
// Returns:
//   200 [ { category, top_site, words,
//           series: [ { hour, positive, neutral, negative, total } ] } ]
//        series has EXACTLY `hours` buckets (oldest → newest, zero-filled);
//        categories with no posts in the window are omitted entirely;
//        top_site = display_name of the category's busiest source in the
//        window (post count DESC, name ASC tie-break);
//        words = up to 2 most-matched relevance keywords for the category's
//        posts in the window (ribbon cue-words line; [] when none matched)
//   400 when hours is not an integer

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
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[sources] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

router.get('/sources/timeseries', async (req, res) => {
    try {
        // ─── Validate + clamp the window size ─────────────────────────────────
        let hours = 12;
        if (req.query.hours !== undefined) {
            // Strict integer check: parseInt would silently accept '1.5' as 1,
            // so validate the raw string before parsing
            if (!/^-?\d+$/.test(req.query.hours)) {
                return res.status(400).json({ error: 'hours must be an integer' });
            }
            hours = parseInt(req.query.hours, 10);
        }
        // Out-of-range values are clamped rather than rejected: the window size
        // is a display preference, not a correctness input
        hours = Math.min(48, Math.max(1, hours));

        // ─── Bucketed counts, zero-filled in SQL ──────────────────────────────
        // Buckets are the last `hours` whole clock-hours ending at
        // date_trunc('hour', NOW()). The row window starts at the OLDEST bucket
        // (date_trunc('hour', NOW()) - (hours-1)h) rather than a raw
        // NOW() - hours interval — a raw interval can pick up rows that truncate
        // to an hour older than the oldest returned bucket, which would silently
        // drop their counts. generate_series × category cross join produces the
        // zero-filled buckets; NOW() is evaluated once per query, so bucket
        // boundaries and the row window can never disagree (no app/DB clock skew).
        const rows = await dbAll(
            `WITH buckets AS (
                SELECT generate_series(
                    date_trunc('hour', NOW()) - ($1::int - 1) * INTERVAL '1 hour',
                    date_trunc('hour', NOW()),
                    INTERVAL '1 hour'
                ) AS hour
            ),
            counts AS (
                SELECT
                    ds.category,
                    date_trunc('hour', rp.collected_at) AS hour,
                    COUNT(*) FILTER (WHERE sr.indicator = 'positive')::int AS positive,
                    COUNT(*) FILTER (WHERE sr.indicator = 'neutral')::int  AS neutral,
                    COUNT(*) FILTER (WHERE sr.indicator = 'negative')::int AS negative,
                    COUNT(*)::int                                          AS total
                FROM raw_posts rp
                JOIN sentiment_results sr ON sr.raw_post_id = rp.id
                JOIN data_sources ds      ON ds.id = rp.source_id
                WHERE rp.collected_at >= date_trunc('hour', NOW()) - ($1::int - 1) * INTERVAL '1 hour'
                  -- Upper bound: end of the CURRENT hour (the newest bucket).
                  -- Future-timestamped rows (bad upstream clocks) truncate to
                  -- buckets that are never returned, but without this bound
                  -- they still put their category into counts — resurrecting
                  -- it as an all-zero series via the cross join below.
                  AND rp.collected_at < date_trunc('hour', NOW()) + INTERVAL '1 hour'
                GROUP BY ds.category, date_trunc('hour', rp.collected_at)
            )
            SELECT
                cat.category,
                b.hour,
                COALESCE(c.positive, 0) AS positive,
                COALESCE(c.neutral,  0) AS neutral,
                COALESCE(c.negative, 0) AS negative,
                COALESCE(c.total,    0) AS total
            FROM (SELECT DISTINCT category FROM counts) cat
            CROSS JOIN buckets b
            LEFT JOIN counts c ON c.category = cat.category AND c.hour = b.hour
            ORDER BY cat.category ASC, b.hour ASC`,
            [hours],
        );

        // ─── Ribbon metadata: busiest source + cue words per category ────────
        // Same window bounds as the counts CTE so the metadata describes the
        // exact post set the sparkline renders. top_site = display_name of the
        // category's highest-volume source; words = up to 2 most-matched
        // relevance keywords (count DESC, keyword ASC tie-breaks throughout).
        const siteRows = await dbAll(
            `SELECT category, display_name
             FROM (
                SELECT ds.category, ds.display_name,
                       ROW_NUMBER() OVER (
                           PARTITION BY ds.category
                           ORDER BY COUNT(*) DESC, ds.display_name ASC
                       ) AS rn
                FROM raw_posts rp
                JOIN sentiment_results sr ON sr.raw_post_id = rp.id
                JOIN data_sources ds      ON ds.id = rp.source_id
                WHERE rp.collected_at >= date_trunc('hour', NOW()) - ($1::int - 1) * INTERVAL '1 hour'
                  AND rp.collected_at <  date_trunc('hour', NOW()) + INTERVAL '1 hour'
                GROUP BY ds.category, ds.display_name
             ) ranked
             WHERE rn = 1`,
            [hours],
        );
        const topSiteByCategory = {};
        for (const row of siteRows) topSiteByCategory[row.category] = row.display_name;

        const wordRows = await dbAll(
            `SELECT category, keyword
             FROM (
                SELECT ds.category, kw.keyword,
                       ROW_NUMBER() OVER (
                           PARTITION BY ds.category
                           ORDER BY COUNT(*) DESC, kw.keyword ASC
                       ) AS rn
                FROM raw_posts rp
                JOIN sentiment_results sr ON sr.raw_post_id = rp.id
                JOIN data_sources ds      ON ds.id = rp.source_id
                JOIN LATERAL (
                    SELECT DISTINCT unnest(rr.matched_keywords) AS keyword
                    FROM relevance_results rr
                    WHERE rr.raw_post_id = rp.id
                ) kw ON TRUE
                WHERE rp.collected_at >= date_trunc('hour', NOW()) - ($1::int - 1) * INTERVAL '1 hour'
                  AND rp.collected_at <  date_trunc('hour', NOW()) + INTERVAL '1 hour'
                GROUP BY ds.category, kw.keyword
             ) ranked
             WHERE rn <= 2
             ORDER BY category ASC, rn ASC`,
            [hours],
        );
        const wordsByCategory = {};
        for (const row of wordRows) {
            if (!wordsByCategory[row.category]) wordsByCategory[row.category] = [];
            wordsByCategory[row.category].push(row.keyword);
        }

        // ─── Fold flat rows into [{ category, top_site, words, series }] ─────
        // Rows arrive ordered by category then hour, so a simple accumulator keeps
        // both the category ordering and the oldest→newest bucket ordering
        const byCategory = [];
        for (const row of rows) {
            let entry = byCategory[byCategory.length - 1];
            if (!entry || entry.category !== row.category) {
                entry = {
                    category: row.category,
                    top_site: topSiteByCategory[row.category] ?? null,
                    words:    wordsByCategory[row.category]   ?? [],
                    series:   [],
                };
                byCategory.push(entry);
            }
            entry.series.push({
                hour:     row.hour.toISOString(),
                positive: row.positive,
                neutral:  row.neutral,
                negative: row.negative,
                total:    row.total,
            });
        }

        return res.json(byCategory);
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[sources] Timeseries error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
