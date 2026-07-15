// PulseApiConfig — API endpoint map + polling constants (DATA ONLY).
// Single source of truth for every route the story frontend calls, so a
// route rename is a one-line change here instead of a grep across modules.
// Zero functions by contract; invariants locked by
// tests/unit/pure/config.test.js.
//
// Dual export guard: CommonJS (module.exports) for jest,
// window.PulseApiConfig for browser script tags (same pattern as utils.js).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();          // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseApiConfig = factory();     // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Deep-freeze: config is shared, data-only state — a consumer mutating
    // the endpoint map would silently corrupt every other module. Frozen
    // exports make mutation attempts throw in strict mode instead.
    function deepFreeze(node) {
        if (node && typeof node === 'object' && !Object.isFrozen(node)) {
            Object.freeze(node);
            for (const key of Object.keys(node)) deepFreeze(node[key]);
        }
        return node;
    }

    const ENDPOINTS = {
        aggregated:  '/api/posts/aggregated-by-location', // city sentiment snapshot
        query:       '/api/query',                        // per-city post drill-down
        audit:       '/api/audit/',                       // + postId → audit receipt
        health:      '/api/health',                       // service/source health
        bias:        '/api/bias/latest',                  // bias monitor alerts
        methodology: '/api/methodology',                  // versioned model table
        timeseries:  '/api/sources/timeseries',           // ribbon sparklines
        themes:      '/api/themes',                       // warm/cold theme rows
        refresh:     '/api/refresh',                      // manual refresh trigger
    };

    // Snapshot polling interval: 2.5 min — inside the design's "refresh
    // cycle 2–3 min" window.
    const REFRESH_MS = 150000;

    // Posts shown per city in the detail panel (matches the prototype's 3).
    const CITY_POSTS_LIMIT = 3;

    // Hours of history requested for the source-ribbon sparklines.
    const TIMESERIES_HOURS = 12;

    return deepFreeze({ ENDPOINTS, REFRESH_MS, CITY_POSTS_LIMIT, TIMESERIES_HOURS });
}));
