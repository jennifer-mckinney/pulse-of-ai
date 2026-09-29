// src/routes/posts.js
// GET /api/posts/aggregated-by-location
//
// Returns sentiment counts grouped by city for the globe frontend.
// Includes lat/lng from a hardcoded lookup of major cities (Phase E: geocoding service).
// Every row also carries its data origin: demo_posts (posts from demo feeds,
// source_type 'demo') and data_mode ('demo' | 'live' | 'mixed') — the
// response stays a plain array so existing consumers are unaffected; the
// frontend sums demo_posts across rows to label the whole view.
//
// Query params:
//   ?platform=social      filter by source category
//   ?from=ISO8601         start of date range
//   ?to=ISO8601           end of date range
//
// City coordinates come from the CANONICAL city registry
// (public/js/config/cities.config.js) — the same file the browser loads, so
// backend geocoding and frontend rendering can never drift (see
// docs/research/2026-07-06-city-layer-configurability.md). findCity is
// case-insensitive and alias-aware (Grafana gazetteer lookup semantics).
// Replace with a registry-seeded cities table / geocoding API in Phase E.

'use strict';

const { Router }   = require('express');
const { dbAll }    = require('../db/connection');
// Layering note: server code requiring a public/-served file is deliberate —
// the registry is UMD dual-export and this repo has no build step to copy a
// shared src/config file into public/. The registry file is the source of
// record for both consumers.
const { findCity } = require('../../public/js/config/cities.config.js');
const { CATEGORY_SLUGS, isCanonicalCategory } = require('../config/categories');
const { responseCache } = require('../middleware/response-cache');
const { DEMO_SOURCE_TYPE, deriveDataMode } = require('../config/data-mode');

const router = Router();

// Locations already warned about — warn ONCE per unknown city per process so
// a silent registry hole shows up in the logs without flooding them.
const warnedUnknownLocations = new Set();

/**
 * Log (once per process per city) every location the city registry cannot
 * resolve. The frontend drops null-coord rows from the globe, so a registry
 * hole makes cities vanish — this makes the drop LOUD (gap G26).
 * @param {string[]} cityNames  location values from the aggregation query
 */
function warnUnknownLocations(cityNames) {
    const fresh = cityNames.filter(
        name => !findCity(name) && !warnedUnknownLocations.has(name),
    );
    if (fresh.length === 0) return;
    for (const name of fresh) warnedUnknownLocations.add(name);
    console.warn(
        `[posts] No coordinates registered for ${fresh.length} location(s): `
        + `${fresh.join(', ')} — these rows are served with lat/lng null and `
        + 'the globe frontend drops them. Add entries to '
        + 'public/js/config/cities.config.js.',
    );
}

/**
 * Determine the dominant sentiment indicator for a city row.
 * @param {{ positive: number, neutral: number, negative: number }} row
 * @returns {'positive'|'neutral'|'negative'}
 */
function getDominant(row) {
    const counts = { positive: row.positive, neutral: row.neutral, negative: row.negative };
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

// F3: 10s in-process cache, keyed per query-string (platform/from/to windows
// cache independently). The story frontend re-requests this snapshot on every
// poll and beat change; the underlying data moves on the 2-3 minute cycle.
router.get('/posts/aggregated-by-location', responseCache(10000), async (req, res) => {
    try {
        const { platform, from, to } = req.query;

        // Build dynamic WHERE clauses + params
        const conditions = [
            `rp.location IS NOT NULL`,
            `rp.location != ''`,
        ];
        const params = [];

        if (platform) {
            // Validate against the canonical taxonomy (src/config/categories
            // — the same registry the frontend renders): a non-canon value
            // is a caller error, not an empty result set.
            if (!isCanonicalCategory(platform)) {
                return res.status(400).json({
                    error: 'platform must be a canonical source category: '
                        + CATEGORY_SLUGS.join(', '),
                });
            }
            params.push(platform);
            conditions.push(`ds.category = $${params.length}`);
        }

        if (from) {
            const fromDate = new Date(from);
            if (isNaN(fromDate)) return res.status(400).json({ error: 'Invalid from date' });
            params.push(fromDate.toISOString());
            conditions.push(`rp.collected_at >= $${params.length}`);
        }

        if (to) {
            const toDate = new Date(to);
            if (isNaN(toDate)) return res.status(400).json({ error: 'Invalid to date' });
            params.push(toDate.toISOString());
            conditions.push(`rp.collected_at <= $${params.length}`);
        }

        const whereClause = conditions.map(c => `(${c})`).join(' AND ');

        // Main query: sentiment totals per city
        const rows = await dbAll(
            `SELECT
                rp.location                                                AS city,
                COUNT(*) FILTER (WHERE sr.indicator = 'positive')::int    AS positive,
                COUNT(*) FILTER (WHERE sr.indicator = 'neutral')::int     AS neutral,
                COUNT(*) FILTER (WHERE sr.indicator = 'negative')::int    AS negative,
                COUNT(*)::int                                              AS total,
                COUNT(*) FILTER (WHERE ds.source_type = '${DEMO_SOURCE_TYPE}')::int AS demo_posts,
                MAX(rp.collected_at)                                       AS last_updated
             FROM raw_posts rp
             JOIN sentiment_results sr ON sr.raw_post_id = rp.id
             JOIN data_sources ds      ON ds.id = rp.source_id
             WHERE ${whereClause}
             GROUP BY rp.location
             HAVING COUNT(*) > 0
             ORDER BY total DESC`,
            params,
        );

        // Per-source breakdown query: same WHERE clause, additionally grouped by source
        // Powers the stacked source bar in the 3D map visualization
        const sourceRows = await dbAll(
            `SELECT
                rp.location                                                AS city,
                ds.name                                                    AS source_name,
                ds.category                                                AS source_category,
                COUNT(*) FILTER (WHERE sr.indicator = 'positive')::int    AS positive,
                COUNT(*) FILTER (WHERE sr.indicator = 'neutral')::int     AS neutral,
                COUNT(*) FILTER (WHERE sr.indicator = 'negative')::int    AS negative,
                COUNT(*)::int                                              AS total
             FROM raw_posts rp
             JOIN sentiment_results sr ON sr.raw_post_id = rp.id
             JOIN data_sources ds      ON ds.id = rp.source_id
             WHERE ${whereClause}
             GROUP BY rp.location, ds.name, ds.category
             ORDER BY rp.location, total DESC`,
            params,
        );

        // Group source rows by city name for O(1) lookup when building response
        const sourcesByCity = {};
        for (const row of sourceRows) {
            if (!sourcesByCity[row.city]) sourcesByCity[row.city] = [];
            sourcesByCity[row.city].push({
                source_name:     row.source_name,
                source_category: row.source_category,
                positive:        row.positive,
                neutral:         row.neutral,
                negative:        row.negative,
                total:           row.total,
            });
        }

        // Registry-hole visibility: unknown locations are logged loudly (once
        // per city per process) because the frontend drops null-coord rows.
        warnUnknownLocations(rows.map(r => r.city));

        // Attach lat/lng/country from the registry (case-insensitive +
        // alias-aware), dominant indicator, and per-source breakdown
        const cities = rows.map(r => {
            const entry = findCity(r.city);
            return {
                city:         r.city,
                lat:          entry ? entry.lat     : null,
                lng:          entry ? entry.lng     : null,
                country:      entry ? entry.country : null,
                positive:     r.positive,
                neutral:      r.neutral,
                negative:     r.negative,
                total:        r.total,
                dominant:     getDominant(r),
                // Data origin (src/config/data-mode.js): posts from demo
                // feeds in this row, and the row's mode. The frontend sums
                // demo_posts across rows to label the whole view.
                demo_posts:   r.demo_posts,
                data_mode:    deriveDataMode(r.demo_posts, r.total),
                last_updated: r.last_updated,
                sources:      sourcesByCity[r.city] || [],   // per-source stacked bar
            };
        });

        return res.json(cities);
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[posts] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
