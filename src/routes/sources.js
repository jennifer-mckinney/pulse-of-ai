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
//   200 [ { category, series: [ { hour, positive, neutral, negative, total } ] } ]
//        series has EXACTLY `hours` buckets (oldest → newest, zero-filled);
//        categories with no posts in the window are omitted entirely
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
    } catch (err) {
        console.error('[sources] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
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

        // ─── Fold flat rows into [{ category, series }] ───────────────────────
        // Rows arrive ordered by category then hour, so a simple accumulator keeps
        // both the category ordering and the oldest→newest bucket ordering
        const byCategory = [];
        for (const row of rows) {
            let entry = byCategory[byCategory.length - 1];
            if (!entry || entry.category !== row.category) {
                entry = { category: row.category, series: [] };
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
    } catch (err) {
        console.error('[sources] Timeseries error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
