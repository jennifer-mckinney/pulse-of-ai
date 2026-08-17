// src/routes/posts.js
// GET /api/posts/aggregated-by-location
//
// Returns sentiment counts grouped by city for the Mapbox map.
// Includes lat/lng from a hardcoded lookup of major cities (Phase E: geocoding service).
//
// Query params:
//   ?platform=social      filter by source category
//   ?from=ISO8601         start of date range
//   ?to=ISO8601           end of date range
//
// City coordinates: common AI-discourse cities hardcoded for MVP.
// Replace with a PostGIS lookup or geocoding API in Phase E.

'use strict';

const { Router } = require('express');
const { dbAll }  = require('../db/connection');

const router = Router();

// ─── Static city geocoder (lat/lng for known cities) ─────────────────────────
// Covers the top cities likely to appear in AI discourse data.
// Unknown cities are returned with lat/lng omitted (frontend handles gracefully).
const CITY_COORDS = {
    'San Francisco': { lat: 37.7749,  lng: -122.4194 },
    'New York':      { lat: 40.7128,  lng:  -74.0060 },
    'London':        { lat: 51.5074,  lng:   -0.1278 },
    'Tokyo':         { lat: 35.6762,  lng:  139.6503 },
    'Berlin':        { lat: 52.5200,  lng:   13.4050 },
    'Paris':         { lat: 48.8566,  lng:    2.3522 },
    'Seoul':         { lat: 37.5665,  lng:  126.9780 },
    'Beijing':       { lat: 39.9042,  lng:  116.4074 },
    'Shanghai':      { lat: 31.2304,  lng:  121.4737 },
    'Bangalore':     { lat: 12.9716,  lng:   77.5946 },
    'Mumbai':        { lat: 19.0760,  lng:   72.8777 },
    'Sydney':        { lat: -33.8688, lng:  151.2093 },
    'Toronto':       { lat: 43.6532,  lng:  -79.3832 },
    'Vancouver':     { lat: 49.2827,  lng: -123.1207 },
    'Amsterdam':     { lat: 52.3676,  lng:    4.9041 },
    'Stockholm':     { lat: 59.3293,  lng:   18.0686 },
    'Singapore':     { lat:  1.3521,  lng:  103.8198 },
    'Zurich':        { lat: 47.3769,  lng:    8.5417 },
    'Tel Aviv':      { lat: 32.0853,  lng:   34.7818 },
    'Chicago':       { lat: 41.8781,  lng:  -87.6298 },
    'Los Angeles':   { lat: 34.0522,  lng: -118.2437 },
    'Seattle':       { lat: 47.6062,  lng: -122.3321 },
    'Boston':        { lat: 42.3601,  lng:  -71.0589 },
    'Austin':        { lat: 30.2672,  lng:  -97.7431 },
    'Lagos':         { lat:  6.5244,  lng:    3.3792 },
    'Nairobi':       { lat: -1.2921,  lng:   36.8219 },
    'São Paulo':     { lat: -23.5505, lng:  -46.6333 },
    'Buenos Aires':  { lat: -34.6037, lng:  -58.3816 },
    'Cairo':         { lat: 30.0444,  lng:   31.2357 },
    'Moscow':        { lat: 55.7558,  lng:   37.6173 },
    'Dublin':        { lat: 53.3498,  lng:   -6.2603 },
    'Jakarta':       { lat: -6.2088,  lng:  106.8456 },
};

/**
 * Determine the dominant sentiment indicator for a city row.
 * @param {{ positive: number, neutral: number, negative: number }} row
 * @returns {'positive'|'neutral'|'negative'}
 */
function getDominant(row) {
    const counts = { positive: row.positive, neutral: row.neutral, negative: row.negative };
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
}

router.get('/posts/aggregated-by-location', async (req, res) => {
    try {
        const { platform, from, to } = req.query;

        // Build dynamic WHERE clauses + params
        const conditions = [
            `rp.location IS NOT NULL`,
            `rp.location != ''`,
        ];
        const params = [];

        if (platform) {
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

        // Attach lat/lng, dominant indicator, and per-source breakdown
        const cities = rows.map(r => ({
            city:         r.city,
            lat:          CITY_COORDS[r.city]?.lat  ?? null,
            lng:          CITY_COORDS[r.city]?.lng  ?? null,
            positive:     r.positive,
            neutral:      r.neutral,
            negative:     r.negative,
            total:        r.total,
            dominant:     getDominant(r),
            last_updated: r.last_updated,
            sources:      sourcesByCity[r.city] || [],   // per-source breakdown for stacked bar
        }));

        return res.json(cities);
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        console.error('[posts] Error:', err.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
