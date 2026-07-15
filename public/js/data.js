// PulseData — city sentiment data for the Pulse of AI frontend.
// DEMO_DATA is moved verbatim from public/js/map.js (lines 219-293) so the
// globe.gl storytelling modules can consume it without loading Mapbox code.
//
// Exports:
//   - DEMO_DATA:            12-city demo fallback set (DB not yet seeded).
//   - normalizeCities(raw): pure adapter — validates lat/lng, coerces counts,
//                           recomputes total/dominant, computes sentiment
//                           shares, drops rows with unusable coordinates.
//   - loadCityData():       fetch /api/posts/aggregated-by-location, returns
//                           { cities, isDemo } — isDemo is true when the demo
//                           fallback was used (error/non-OK/empty/no fetch),
//                           so consumers can visibly label demo numbers;
//                           browser-guarded so it is safe to require in Node.
//
// Dual export guard: CommonJS (module.exports) for jest, window.PulseData
// for browser script tags. Same pattern as public/js/utils.js.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();          // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseData = factory();          // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── Demo fallback data (verbatim from map.js) ───────────────────────────────
    // Used when the API returns empty (DB not yet seeded). Showcases all visual elements.
    const DEMO_DATA = [
        { city:'San Francisco', lat:37.7749,  lng:-122.4194, positive:142, neutral:89,  negative:47,  total:278, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',      source_category:'social',   positive:65, neutral:40, negative:20, total:125 },
                { source_name:'hacker_news', source_category:'tech',     positive:50, neutral:30, negative:15, total:95  },
                { source_name:'arxiv',       source_category:'academic', positive:27, neutral:19, negative:12, total:58  },
            ]},
        { city:'New York',      lat:40.7128,  lng:-74.0060,  positive:178, neutral:134, negative:88,  total:400, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',       source_category:'social',   positive:70, neutral:55, negative:35, total:160 },
                { source_name:'nytimes_tech', source_category:'news',     positive:50, neutral:45, negative:30, total:125 },
                { source_name:'hacker_news',  source_category:'tech',     positive:38, neutral:24, negative:15, total:77  },
                { source_name:'arxiv',        source_category:'academic', positive:20, neutral:10, negative:8,  total:38  },
            ]},
        { city:'London',        lat:51.5074,  lng:-0.1278,   positive:88,  neutral:112, negative:67,  total:267, dominant:'neutral',  last_updated:new Date().toISOString(),
            sources:[
                { source_name:'guardian_tech', source_category:'news',   positive:30, neutral:55, negative:32, total:117 },
                { source_name:'reddit',        source_category:'social', positive:38, neutral:40, negative:22, total:100 },
                { source_name:'bbc_tech',      source_category:'news',   positive:20, neutral:17, negative:13, total:50  },
            ]},
        { city:'Berlin',        lat:52.5200,  lng:13.4050,   positive:55,  neutral:78,  negative:102, total:235, dominant:'negative', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',        source_category:'social',   positive:20, neutral:35, negative:45, total:100 },
                { source_name:'eu_commission', source_category:'policy',   positive:10, neutral:30, negative:42, total:82  },
                { source_name:'arxiv',         source_category:'academic', positive:25, neutral:13, negative:15, total:53  },
            ]},
        { city:'Tokyo',         lat:35.6762,  lng:139.6503,  positive:195, neutral:67,  negative:30,  total:292, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',  source_category:'social',   positive:80, neutral:30, negative:15, total:125 },
                { source_name:'twitter', source_category:'social',   positive:75, neutral:25, negative:8,  total:108 },
                { source_name:'arxiv',   source_category:'academic', positive:40, neutral:12, negative:7,  total:59  },
            ]},
        { city:'Beijing',       lat:39.9042,  lng:116.4074,  positive:210, neutral:80,  negative:40,  total:330, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'weibo',  source_category:'social',   positive:90, neutral:35, negative:20, total:145 },
                { source_name:'arxiv',  source_category:'academic', positive:75, neutral:25, negative:10, total:110 },
                { source_name:'xinhua', source_category:'news',     positive:45, neutral:20, negative:10, total:75  },
            ]},
        { city:'Singapore',     lat:1.3521,   lng:103.8198,  positive:120, neutral:55,  negative:25,  total:200, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',        source_category:'social',   positive:60, neutral:25, negative:10, total:95  },
                { source_name:'arxiv',         source_category:'academic', positive:40, neutral:20, negative:10, total:70  },
                { source_name:'straits_times', source_category:'news',     positive:20, neutral:10, negative:5,  total:35  },
            ]},
        { city:'Seoul',         lat:37.5665,  lng:126.9780,  positive:155, neutral:60,  negative:25,  total:240, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',      source_category:'social',   positive:70, neutral:28, negative:12, total:110 },
                { source_name:'korea_times', source_category:'news',     positive:55, neutral:20, negative:8,  total:83  },
                { source_name:'arxiv',       source_category:'academic', positive:30, neutral:12, negative:5,  total:47  },
            ]},
        { city:'São Paulo',     lat:-23.5505, lng:-46.6333,  positive:65,  neutral:88,  negative:47,  total:200, dominant:'neutral',  last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit', source_category:'social',   positive:35, neutral:40, negative:20, total:95 },
                { source_name:'folha',  source_category:'news',     positive:20, neutral:35, negative:20, total:75 },
                { source_name:'arxiv',  source_category:'academic', positive:10, neutral:13, negative:7,  total:30 },
            ]},
        { city:'Bangalore',     lat:12.9716,  lng:77.5946,   positive:145, neutral:55,  negative:20,  total:220, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',         source_category:'social',   positive:70, neutral:28, negative:10, total:108 },
                { source_name:'times_of_india', source_category:'news',     positive:45, neutral:17, negative:6,  total:68  },
                { source_name:'arxiv',          source_category:'academic', positive:30, neutral:10, negative:4,  total:44  },
            ]},
        { city:'Sydney',        lat:-33.8688, lng:151.2093,  positive:98,  neutral:67,  negative:35,  total:200, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',   source_category:'social',   positive:55, neutral:35, negative:15, total:105 },
                { source_name:'abc_tech', source_category:'news',     positive:30, neutral:22, negative:13, total:65  },
                { source_name:'arxiv',    source_category:'academic', positive:13, neutral:10, negative:7,  total:30  },
            ]},
        { city:'Toronto',       lat:43.6532,  lng:-79.3832,  positive:88,  neutral:72,  negative:40,  total:200, dominant:'positive', last_updated:new Date().toISOString(),
            sources:[
                { source_name:'reddit',   source_category:'social',   positive:45, neutral:35, negative:20, total:100 },
                { source_name:'cbc_tech', source_category:'news',     positive:30, neutral:25, negative:15, total:70  },
                { source_name:'arxiv',    source_category:'academic', positive:13, neutral:12, negative:5,  total:30  },
            ]},
    ];

    // ── Internal coercion helpers ───────────────────────────────────────────────

    // Coerce a coordinate: accept numbers or numeric strings (pg NUMERIC columns
    // serialize as strings over JSON); reject null/undefined, NaN, and values
    // outside ±limit. Returns a finite number or null (null → row is dropped).
    // Note: Number(null) === 0, so the explicit null check must come first.
    function toCoord(value, limit) {
        if (value === null || value === undefined) return null;
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        if (n < -limit || n > limit) return null;
        return n;
    }

    // Coerce a sentiment count: numbers or numeric strings pass through;
    // anything non-finite becomes 0; negative counts are clamped to 0
    // (counts of things cannot be negative — treat as bad upstream data).
    function toCount(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return n < 0 ? 0 : n;
    }

    // Dominant sentiment from coerced counts. Preference order on ties:
    // positive → neutral → negative (matches the optimistic demo authoring).
    function dominantOf(positive, neutral, negative) {
        if (positive >= neutral && positive >= negative) return 'positive';
        if (neutral >= negative) return 'neutral';
        return 'negative';
    }

    // Normalize one raw sources array: coerce/clamp per-source counts and
    // recompute each source total from them. Non-array input tolerated as [].
    function normalizeSources(rawSources) {
        if (!Array.isArray(rawSources)) return [];
        const out = [];
        for (const s of rawSources) {
            if (!s || typeof s !== 'object') continue;
            const positive = toCount(s.positive);
            const neutral  = toCount(s.neutral);
            const negative = toCount(s.negative);
            out.push({
                source_name:     s.source_name,
                source_category: s.source_category,
                positive,
                neutral,
                negative,
                total: positive + neutral + negative,
            });
        }
        return out;
    }

    // ── Public API ──────────────────────────────────────────────────────────────

    // Pure adapter from raw API/demo rows to the shape the globe modules consume.
    //   - drops rows whose lat/lng are missing, non-numeric, or out of range
    //     (lat ±90, lng ±180 — boundary values are kept)
    //   - coerces string counts, clamps negatives to 0
    //   - ALWAYS recomputes total from the coerced counts (the served total is
    //     advisory; disagreement means bad upstream aggregation)
    //   - recomputes dominant sentiment
    //   - adds shares {positive, neutral, negative} summing to 1 (all-zero when
    //     total is 0, so no NaN from 0/0)
    //   - normalizes sources (missing/non-array tolerated as [])
    function normalizeCities(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        for (const row of raw) {
            if (!row || typeof row !== 'object') continue;
            const lat = toCoord(row.lat, 90);
            const lng = toCoord(row.lng, 180);
            if (lat === null || lng === null) continue;

            const positive = toCount(row.positive);
            const neutral  = toCount(row.neutral);
            const negative = toCount(row.negative);
            const total    = positive + neutral + negative;

            out.push({
                city: row.city,
                lat,
                lng,
                positive,
                neutral,
                negative,
                total,
                dominant: dominantOf(positive, neutral, negative),
                shares: total > 0
                    ? { positive: positive / total, neutral: neutral / total, negative: negative / total }
                    : { positive: 0, neutral: 0, negative: 0 },
                sources: normalizeSources(row.sources),
                last_updated: row.last_updated,
            });
        }
        return out;
    }

    // Fetch live city data; fall back to normalized DEMO_DATA if the endpoint
    // errors, returns non-OK, returns nothing usable, or fetch does not exist
    // (Node safety guard — this module is also required by jest without a DOM).
    //
    // Returns { cities, isDemo }: isDemo is TRUE whenever the demo fallback
    // was used, so consumers (resolveChapter → insight cards) can visibly
    // mark the numbers as demo data instead of passing them off as live.
    async function loadCityData() {
        if (typeof fetch !== 'undefined') {
            try {
                const res = await fetch('/api/posts/aggregated-by-location');
                if (res && res.ok) {
                    const cities = normalizeCities(await res.json());
                    if (cities.length > 0) return { cities, isDemo: false };
                }
            } catch (_) { /* network error — fall through to demo data */ }
        }
        return { cities: normalizeCities(DEMO_DATA), isDemo: true };
    }

    return { DEMO_DATA, normalizeCities, loadCityData };
}));
