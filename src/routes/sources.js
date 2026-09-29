// src/routes/sources.js
// GET /api/sources
//
// Returns the source registry of record (src/config/source-registry.js, the
// workbook's 51 sources) with each source's RUNTIME status — for the health
// drawer's per-source list and "Sources online N/51".
//
// Query params:
//   ?include_inactive=true    also inactive rows: demo feeds (registry: false)
//                             and retired pre-registry rows (retired: true)
//
// Returns (registry order, then others):
//   200 [ { id, name, display_name, source_type, category, active, retired,
//           registry,                         // true for the 51
//           slug, rank, region, auth_kind, program, signup_url,
//           status,                           // collecting | awaiting_key |
//                                             // awaiting_approval | awaiting_licence |
//                                             // blocked | disabled
//           status_reason, missing_env,       // env var NAMES only, never values
//           open_routes, licence_refs_on_file, kill_switch_env,
//           online,                           // collecting + success in the last hour
//           last_attempt_at, last_success_at, last_item_count, last_error,
//           consecutive_failures,
//           terms_url, terms_note, attribution, license, blocked, ruling } ]
//   Non-registry rows carry only the first block plus registry: false.
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
//        one row per CANONICAL category (src/config/categories.js — the
//        prototype's 8-category taxonomy), ALWAYS, in canon order: the
//        enumeration comes from the canon config, never SELECT DISTINCT
//        over the data, so a category with no posts in the window (or no
//        sources at all — forums) is served as an honest all-zero series
//        with top_site null and words [];
//        series has EXACTLY `hours` buckets (oldest → newest, zero-filled);
//        top_site = display_name of the category's busiest source in the
//        window (post count DESC, name ASC tie-break);
//        words = up to 2 most-matched relevance keywords for the category's
//        posts in the window (ribbon cue-words line; [] when none matched)
//   400 when hours is not an integer

'use strict';

const { Router } = require('express');
const { dbAll }  = require('../db/connection');
const clock      = require('../db/clock');
const { CATEGORY_SLUGS } = require('../config/categories');
const { responseCache } = require('../middleware/response-cache');
const { sourceRows } = require('../collectors/status');

const router = Router();

router.get('/sources', async (req, res) => {
    try {
        const rows = await sourceRows({ includeInactive: req.query.include_inactive === 'true' });
        return res.json(rows);
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[sources] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

// F3: 10s in-process cache, keyed per query-string (each hours= window caches
// independently). Three window-scoped aggregations per request otherwise.
router.get('/sources/timeseries', responseCache(10000), async (req, res) => {
    try {
        // ─── Validate + clamp the window size ─────────────────────────────────
        let hours = 12;
        if (req.query.hours !== undefined) {
            // Strict integer check: parseInt would silently accept '1.5' as 1,
            // so validate the raw string before parsing. Digits only (F5) — a
            // negative window is a caller error, not a value to clamp.
            if (!/^\d+$/.test(req.query.hours)) {
                return res.status(400).json({ error: 'hours must be an integer' });
            }
            hours = parseInt(req.query.hours, 10);
        }
        // Out-of-range values are clamped rather than rejected: the window size
        // is a display preference, not a correctness input
        hours = Math.min(48, Math.max(1, hours));
        // ONE window anchor — date_trunc('hour', NOW()) read once from the
        // database (src/db/clock.js) — shared by the counts, top-site and
        // cue-word queries below, so an hour boundary can never fall
        // between them (PR #8 review).
        const anchor = await clock.hourAnchor();

        // ─── Bucketed counts, zero-filled in SQL ──────────────────────────────
        // Buckets are the last `hours` whole clock-hours ending at the anchor
        // (date_trunc('hour', NOW())). The row window starts at the OLDEST
        // bucket (anchor - (hours-1)h) rather than a raw
        // NOW() - hours interval — a raw interval can pick up rows that truncate
        // to an hour older than the oldest returned bucket, which would silently
        // drop their counts. generate_series × category cross join produces the
        // zero-filled buckets; the database timestamp anchor above is reused by
        // every aggregation, so bucket boundaries and metadata cannot disagree.
        //
        // Category enumeration is the CANON (unnest over the canonical slug
        // array, ordinality preserving canon order) — never SELECT DISTINCT
        // over the data: every canonical category gets a row, and a quiet or
        // source-less category (forums) is an honest all-zero series. A
        // non-canonical category in the data (impossible after migration
        // 007) would be excluded rather than served.
        const rows = await dbAll(
            `WITH buckets AS (
                SELECT generate_series(
                    $3::timestamptz - ($1::int - 1) * INTERVAL '1 hour',
                    $3::timestamptz,
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
                WHERE rp.collected_at >= $3::timestamptz - ($1::int - 1) * INTERVAL '1 hour'
                  -- Upper bound: end of the CURRENT hour (the newest bucket).
                  -- Future-timestamped rows (bad upstream clocks) truncate to
                  -- buckets that are never returned, but without this bound
                  -- they still put their category into counts — resurrecting
                  -- it as an all-zero series via the cross join below.
                  AND rp.collected_at < $3::timestamptz + INTERVAL '1 hour'
                GROUP BY ds.category, date_trunc('hour', rp.collected_at)
            )
            SELECT
                cat.category,
                b.hour,
                COALESCE(c.positive, 0) AS positive,
                COALESCE(c.neutral,  0) AS neutral,
                COALESCE(c.negative, 0) AS negative,
                COALESCE(c.total,    0) AS total
            FROM unnest($2::text[]) WITH ORDINALITY AS cat(category, ord)
            CROSS JOIN buckets b
            LEFT JOIN counts c ON c.category = cat.category AND c.hour = b.hour
            ORDER BY cat.ord ASC, b.hour ASC`,
            [hours, CATEGORY_SLUGS, anchor],
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
                WHERE rp.collected_at >= $2::timestamptz - ($1::int - 1) * INTERVAL '1 hour'
                  AND rp.collected_at <  $2::timestamptz + INTERVAL '1 hour'
                GROUP BY ds.category, ds.display_name
             ) ranked
             WHERE rn = 1`,
            [hours, anchor],
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
                WHERE rp.collected_at >= $2::timestamptz - ($1::int - 1) * INTERVAL '1 hour'
                  AND rp.collected_at <  $2::timestamptz + INTERVAL '1 hour'
                GROUP BY ds.category, kw.keyword
             ) ranked
             WHERE rn <= 2
             ORDER BY category ASC, rn ASC`,
            [hours, anchor],
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
