// src/routes/posts.js
// GET /api/posts/aggregated-by-location
//
// Returns sentiment counts grouped by city for the globe frontend.
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

// ─── Static city geocoder (lat/lng + ISO country code for known cities) ──────
// Covers the top cities likely to appear in AI discourse data, INCLUDING all
// 30 prototype launch cities (gap G26 closed: Mexico City, Brussels, Warsaw,
// Cape Town, Dubai, Melbourne added). country is the ISO 3166-1 alpha-2 code
// the city-detail header renders (gap G22).
// Unknown cities are returned with lat/lng/country null — and LOGGED loudly
// below, because the frontend drops null-coord rows from the globe.
// Replace with a registry table / geocoding API in Phase E (cities.config.js
// redesign is tracked separately).
const CITY_COORDS = {
    'San Francisco': { lat: 37.7749,  lng: -122.4194, country: 'US' },
    'New York':      { lat: 40.7128,  lng:  -74.0060, country: 'US' },
    'London':        { lat: 51.5074,  lng:   -0.1278, country: 'GB' },
    'Tokyo':         { lat: 35.6762,  lng:  139.6503, country: 'JP' },
    'Berlin':        { lat: 52.5200,  lng:   13.4050, country: 'DE' },
    'Paris':         { lat: 48.8566,  lng:    2.3522, country: 'FR' },
    'Seoul':         { lat: 37.5665,  lng:  126.9780, country: 'KR' },
    'Beijing':       { lat: 39.9042,  lng:  116.4074, country: 'CN' },
    'Shanghai':      { lat: 31.2304,  lng:  121.4737, country: 'CN' },
    'Bangalore':     { lat: 12.9716,  lng:   77.5946, country: 'IN' },
    'Mumbai':        { lat: 19.0760,  lng:   72.8777, country: 'IN' },
    'Sydney':        { lat: -33.8688, lng:  151.2093, country: 'AU' },
    'Toronto':       { lat: 43.6532,  lng:  -79.3832, country: 'CA' },
    'Vancouver':     { lat: 49.2827,  lng: -123.1207, country: 'CA' },
    'Amsterdam':     { lat: 52.3676,  lng:    4.9041, country: 'NL' },
    'Stockholm':     { lat: 59.3293,  lng:   18.0686, country: 'SE' },
    'Singapore':     { lat:  1.3521,  lng:  103.8198, country: 'SG' },
    'Zurich':        { lat: 47.3769,  lng:    8.5417, country: 'CH' },
    'Tel Aviv':      { lat: 32.0853,  lng:   34.7818, country: 'IL' },
    'Chicago':       { lat: 41.8781,  lng:  -87.6298, country: 'US' },
    'Los Angeles':   { lat: 34.0522,  lng: -118.2437, country: 'US' },
    'Seattle':       { lat: 47.6062,  lng: -122.3321, country: 'US' },
    'Boston':        { lat: 42.3601,  lng:  -71.0589, country: 'US' },
    'Austin':        { lat: 30.2672,  lng:  -97.7431, country: 'US' },
    'Lagos':         { lat:  6.5244,  lng:    3.3792, country: 'NG' },
    'Nairobi':       { lat: -1.2921,  lng:   36.8219, country: 'KE' },
    'São Paulo':     { lat: -23.5505, lng:  -46.6333, country: 'BR' },
    'Buenos Aires':  { lat: -34.6037, lng:  -58.3816, country: 'AR' },
    'Cairo':         { lat: 30.0444,  lng:   31.2357, country: 'EG' },
    'Moscow':        { lat: 55.7558,  lng:   37.6173, country: 'RU' },
    'Dublin':        { lat: 53.3498,  lng:   -6.2603, country: 'IE' },
    'Jakarta':       { lat: -6.2088,  lng:  106.8456, country: 'ID' },
    // ── Prototype launch cities previously missing (gap G26) ────────────────
    'Mexico City':   { lat: 19.4326,  lng:  -99.1332, country: 'MX' },
    'Brussels':      { lat: 50.8503,  lng:    4.3517, country: 'BE' },
    'Warsaw':        { lat: 52.2297,  lng:   21.0122, country: 'PL' },
    'Cape Town':     { lat: -33.9249, lng:   18.4241, country: 'ZA' },
    'Dubai':         { lat: 25.2048,  lng:   55.2708, country: 'AE' },
    'Melbourne':     { lat: -37.8136, lng:  144.9631, country: 'AU' },
};

// Locations already warned about — warn ONCE per unknown city per process so
// a silent registry hole shows up in the logs without flooding them.
const warnedUnknownLocations = new Set();

/**
 * Log (once per process per city) every location that has no CITY_COORDS
 * entry. The frontend silently drops null-coord rows from the globe, so a
 * registry hole makes cities vanish — this makes the drop LOUD (gap G26).
 * @param {string[]} cityNames  location values from the aggregation query
 */
function warnUnknownLocations(cityNames) {
    const fresh = cityNames.filter(
        name => !CITY_COORDS[name] && !warnedUnknownLocations.has(name),
    );
    if (fresh.length === 0) return;
    for (const name of fresh) warnedUnknownLocations.add(name);
    console.warn(
        `[posts] No coordinates registered for ${fresh.length} location(s): `
        + `${fresh.join(', ')} — these rows are served with lat/lng null and `
        + 'the globe frontend drops them. Add entries to CITY_COORDS.',
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

        // Registry-hole visibility: unknown locations are logged loudly (once
        // per city per process) because the frontend drops null-coord rows.
        warnUnknownLocations(rows.map(r => r.city));

        // Attach lat/lng/country, dominant indicator, and per-source breakdown
        const cities = rows.map(r => ({
            city:         r.city,
            lat:          CITY_COORDS[r.city]?.lat     ?? null,
            lng:          CITY_COORDS[r.city]?.lng     ?? null,
            country:      CITY_COORDS[r.city]?.country ?? null,
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
// Exposed for tests: registry-completeness checks assert every prototype
// launch city resolves to coordinates + country (gap G26).
module.exports.CITY_COORDS = CITY_COORDS;
