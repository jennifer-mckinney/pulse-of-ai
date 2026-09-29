// PulseCityRegistry — the CANONICAL city registry (gazetteer) for Pulse of AI.
//
// Single source of truth for city geography, consumed by BOTH sides of the
// stack (per docs/research/2026-07-06-city-layer-configurability.md — the
// "registry as data, layers declare joins" pattern used by Grafana gazetteers,
// kepler.gl datasets, and MapLibre sources):
//   1. Backend  — src/routes/posts.js resolves raw_posts.location values to
//                 lat/lng/country via findCity() (case-insensitive + aliases).
//   2. Frontend — public/js/data.js derives the demo dataset and the live
//                 zero-baseline city list from CITY_REGISTRY.
// The backend require() of a public/ file deliberately bends layering: the
// alternative (duplicate registries with a sync test, or a build-step copy)
// is worse for a no-build project. This file is the registry of record.
//
// Entry shape:
//   id       short stable id — the 30 tier-1 ids/names MATCH the prototype's
//            launch-city list (exported-assets/prototype-globe-artifact/
//            design_handoff_pulse_of_ai/data.js) so story/globe parity holds.
//   aliases  alternate spellings resolved by findCity (Grafana gazetteer
//            semantics: lookup keys are the uppercased name + every alias).
//   country  ISO 3166-1 alpha-2 (city-detail header, GDPR city granularity).
//   region   coarse feature property for data-driven styling and the demo
//            generator's region-keyed source templates.
//   tier     1 = launch city (rendered by default: demo set + live zero
//                baseline — the prototype's 30);
//            2 = extended coverage (resolved when posts mention them — kept
//                from the pre-registry CITY_COORDS so seeded/collected posts
//                for these cities never lose their coordinates).
//
// Selection criterion (record for future additions): top global cities by
// population from Natural Earth Populated Places (public domain — no
// attribution obligation), curated so every continent is represented and
// AI-discourse hubs the pipeline's sources actually geotag are preferred.
// Coordinates cross-checked against Natural Earth populated places points
// (4-decimal precision). Population is deliberately NOT stored yet: no
// consumer exists; add pop_max from the same dataset when one does.
//
// Dual export guard: CommonJS (module.exports) for Node/jest, and
// window.PulseCityRegistry for browser script tags (same pattern as
// utils.js / data.js / api.config.js).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();              // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseCityRegistry = factory();      // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const CITY_REGISTRY = [
        // ── Tier 1 — the 30 launch cities (prototype parity) ────────────────
        // North America
        { id: 'sf',   name: 'San Francisco', aliases: ['SF', 'San Francisco Bay Area'],
            lat: 37.7749,  lng: -122.4194, country: 'US', region: 'north_america', tier: 1 },
        { id: 'nyc',  name: 'New York',      aliases: ['NYC', 'New York City'],
            lat: 40.7128,  lng:  -74.0060, country: 'US', region: 'north_america', tier: 1 },
        { id: 'aus',  name: 'Austin',        aliases: [],
            lat: 30.2672,  lng:  -97.7431, country: 'US', region: 'north_america', tier: 1 },
        { id: 'tor',  name: 'Toronto',       aliases: [],
            lat: 43.6532,  lng:  -79.3832, country: 'CA', region: 'north_america', tier: 1 },
        { id: 'mex',  name: 'Mexico City',   aliases: ['CDMX', 'Ciudad de México'],
            lat: 19.4326,  lng:  -99.1332, country: 'MX', region: 'north_america', tier: 1 },
        // South America
        { id: 'sao',  name: 'São Paulo',     aliases: ['Sao Paulo'],
            lat: -23.5505, lng:  -46.6333, country: 'BR', region: 'south_america', tier: 1 },
        { id: 'bue',  name: 'Buenos Aires',  aliases: [],
            lat: -34.6037, lng:  -58.3816, country: 'AR', region: 'south_america', tier: 1 },
        // Europe
        { id: 'lon',  name: 'London',        aliases: [],
            lat: 51.5074,  lng:   -0.1278, country: 'GB', region: 'europe', tier: 1 },
        { id: 'par',  name: 'Paris',         aliases: [],
            lat: 48.8566,  lng:    2.3522, country: 'FR', region: 'europe', tier: 1 },
        { id: 'ber',  name: 'Berlin',        aliases: [],
            lat: 52.5200,  lng:   13.4050, country: 'DE', region: 'europe', tier: 1 },
        { id: 'bru',  name: 'Brussels',      aliases: ['Bruxelles'],
            lat: 50.8503,  lng:    4.3517, country: 'BE', region: 'europe', tier: 1 },
        { id: 'ams',  name: 'Amsterdam',     aliases: [],
            lat: 52.3676,  lng:    4.9041, country: 'NL', region: 'europe', tier: 1 },
        { id: 'sto',  name: 'Stockholm',     aliases: [],
            lat: 59.3293,  lng:   18.0686, country: 'SE', region: 'europe', tier: 1 },
        { id: 'zur',  name: 'Zurich',        aliases: ['Zürich'],
            lat: 47.3769,  lng:    8.5417, country: 'CH', region: 'europe', tier: 1 },
        { id: 'war',  name: 'Warsaw',        aliases: ['Warszawa'],
            lat: 52.2297,  lng:   21.0122, country: 'PL', region: 'europe', tier: 1 },
        // Africa
        { id: 'lag',  name: 'Lagos',         aliases: [],
            lat:  6.5244,  lng:    3.3792, country: 'NG', region: 'africa', tier: 1 },
        { id: 'nai',  name: 'Nairobi',       aliases: [],
            lat: -1.2921,  lng:   36.8219, country: 'KE', region: 'africa', tier: 1 },
        { id: 'cpt',  name: 'Cape Town',     aliases: [],
            lat: -33.9249, lng:   18.4241, country: 'ZA', region: 'africa', tier: 1 },
        // Middle East
        { id: 'tlv',  name: 'Tel Aviv',      aliases: ['Tel Aviv-Yafo'],
            lat: 32.0853,  lng:   34.7818, country: 'IL', region: 'middle_east', tier: 1 },
        { id: 'dxb',  name: 'Dubai',         aliases: [],
            lat: 25.2048,  lng:   55.2708, country: 'AE', region: 'middle_east', tier: 1 },
        // Asia
        { id: 'blr',  name: 'Bangalore',     aliases: ['Bengaluru'],
            lat: 12.9716,  lng:   77.5946, country: 'IN', region: 'asia', tier: 1 },
        { id: 'mum',  name: 'Mumbai',        aliases: ['Bombay'],
            lat: 19.0760,  lng:   72.8777, country: 'IN', region: 'asia', tier: 1 },
        { id: 'sin',  name: 'Singapore',     aliases: [],
            lat:  1.3521,  lng:  103.8198, country: 'SG', region: 'asia', tier: 1 },
        { id: 'jak',  name: 'Jakarta',       aliases: [],
            lat: -6.2088,  lng:  106.8456, country: 'ID', region: 'asia', tier: 1 },
        { id: 'tok',  name: 'Tokyo',         aliases: [],
            lat: 35.6762,  lng:  139.6503, country: 'JP', region: 'asia', tier: 1 },
        { id: 'seo',  name: 'Seoul',         aliases: [],
            lat: 37.5665,  lng:  126.9780, country: 'KR', region: 'asia', tier: 1 },
        { id: 'bei',  name: 'Beijing',       aliases: ['Peking'],
            lat: 39.9042,  lng:  116.4074, country: 'CN', region: 'asia', tier: 1 },
        { id: 'sha',  name: 'Shanghai',      aliases: [],
            lat: 31.2304,  lng:  121.4737, country: 'CN', region: 'asia', tier: 1 },
        // Oceania
        { id: 'syd',  name: 'Sydney',        aliases: [],
            lat: -33.8688, lng:  151.2093, country: 'AU', region: 'oceania', tier: 1 },
        { id: 'mel',  name: 'Melbourne',     aliases: [],
            lat: -37.8136, lng:  144.9631, country: 'AU', region: 'oceania', tier: 1 },

        // ── Tier 2 — extended coverage (pre-registry CITY_COORDS carryover) ──
        // These are NOT launch cities; they resolve coordinates for posts the
        // pipeline/seeds geotag there so the loud unknown-location warn stays
        // reserved for genuine registry holes.
        { id: 'van',  name: 'Vancouver',     aliases: [],
            lat: 49.2827,  lng: -123.1207, country: 'CA', region: 'north_america', tier: 2 },
        { id: 'chi',  name: 'Chicago',       aliases: [],
            lat: 41.8781,  lng:  -87.6298, country: 'US', region: 'north_america', tier: 2 },
        { id: 'la',   name: 'Los Angeles',   aliases: ['LA'],
            lat: 34.0522,  lng: -118.2437, country: 'US', region: 'north_america', tier: 2 },
        { id: 'sea',  name: 'Seattle',       aliases: [],
            lat: 47.6062,  lng: -122.3321, country: 'US', region: 'north_america', tier: 2 },
        { id: 'bos',  name: 'Boston',        aliases: [],
            lat: 42.3601,  lng:  -71.0589, country: 'US', region: 'north_america', tier: 2 },
        { id: 'dub',  name: 'Dublin',        aliases: [],
            lat: 53.3498,  lng:   -6.2603, country: 'IE', region: 'europe', tier: 2 },
        { id: 'mos',  name: 'Moscow',        aliases: ['Moskva'],
            lat: 55.7558,  lng:   37.6173, country: 'RU', region: 'europe', tier: 2 },
        { id: 'cai',  name: 'Cairo',         aliases: [],
            lat: 30.0444,  lng:   31.2357, country: 'EG', region: 'africa', tier: 2 },
    ];

    // ── Lookup index (Grafana gazetteer semantics) ──────────────────────────
    // Keys are the uppercased trimmed name plus every uppercased alias, so
    // "new york", "NYC" and "New York" all resolve to the same entry. This
    // replaces the old exact-match CITY_COORDS lookup whose silent-null
    // failure mode dropped cities from the globe over casing/alias drift.
    const LOOKUP = new Map();
    for (const entry of CITY_REGISTRY) {
        LOOKUP.set(entry.name.toUpperCase(), entry);
        for (const alias of entry.aliases) {
            LOOKUP.set(alias.toUpperCase(), entry);
        }
    }

    // findCity(name): registry entry for a location string, or null.
    // Case-insensitive, alias-aware, whitespace-tolerant. Never throws on
    // non-string input (raw_posts.location is untrusted upstream data).
    function findCity(name) {
        if (typeof name !== 'string') return null;
        const key = name.trim().toUpperCase();
        if (key === '') return null;
        return LOOKUP.get(key) || null;
    }

    // launchCities(): the tier-1 slice — the 30 cities the globe renders by
    // default (demo dataset + live zero-baseline).
    function launchCities() {
        return CITY_REGISTRY.filter((c) => c.tier === 1);
    }

    // Deep-freeze: shared data-only state (same contract as api.config.js) —
    // a consumer mutating an entry would corrupt every other module.
    function deepFreeze(node) {
        if (node && typeof node === 'object' && !Object.isFrozen(node)) {
            Object.freeze(node);
            for (const key of Object.keys(node)) deepFreeze(node[key]);
        }
        return node;
    }
    deepFreeze(CITY_REGISTRY);

    return Object.freeze({ CITY_REGISTRY, findCity, launchCities });
}));
