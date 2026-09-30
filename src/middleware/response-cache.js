// src/middleware/response-cache.js
// F3 — tiny in-process response cache for the hot read-only aggregation
// endpoints (/api/themes, /api/posts/aggregated-by-location,
// /api/sources/timeseries). Those routes run multi-CTE aggregations on every
// poll; a 10s TTL absorbs bursts (many tabs / rapid story scrubbing) without
// meaningfully delaying data freshness (the pipeline cycle is 2-3 minutes).
//
// Deliberately dependency-free and process-local:
//   - keyed on req.originalUrl (method-checked to GET), so every distinct
//     query-string combination caches independently;
//   - only 200 JSON responses are stored;
//   - X-Response-Cache: hit|miss header for observability and tests;
//   - bounded: expired entries are swept on write, and the store is hard-
//     capped (oldest evicted) so hostile query-string churn cannot grow it.
//
// NODE_ENV=test bypasses the cache entirely — integration tests mutate the DB
// between requests and must see fresh reads — EXCEPT when a test explicitly
// re-enables it via _setTestBypass(false) to target the cache itself.

'use strict';

const store = new Map();     // key → { expires, body }
const MAX_ENTRIES = 100;     // hard cap — eviction order is Map insertion order

let testBypass = process.env.NODE_ENV === 'test';

/** Test hook: re-enable (false) / re-disable (true) caching under NODE_ENV=test. */
function _setTestBypass(value) {
    testBypass = value;
}

/** Test hook: drop every cached entry. */
function _clear() {
    store.clear();
}

/**
 * responseCache — middleware factory.
 * @param {number} ttlMs — how long a cached body stays fresh (default 10s)
 * @param {{ key?: (req) => string }} [o] — the cache key (default: the full
 *        URL). A route that takes no query parameters passes a fixed key, so
 *        a varying query string cannot bypass the cache (PR #22 security
 *        L2, /api/health).
 */
function responseCache(ttlMs = 10000, { key: keyOf = req => req.originalUrl } = {}) {
    return (req, res, next) => {
        if (testBypass || req.method !== 'GET') return next();

        const key = keyOf(req);
        const hit = store.get(key);
        if (hit && hit.expires > Date.now()) {
            res.set('X-Response-Cache', 'hit');
            return res.status(200).json(hit.body);
        }

        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (res.statusCode === 200) {
                // Sweep expired entries, then cap size (oldest-first eviction).
                const now = Date.now();
                for (const [k, v] of store) {
                    if (v.expires <= now) store.delete(k);
                }
                if (store.size >= MAX_ENTRIES) {
                    store.delete(store.keys().next().value);
                }
                store.set(key, { expires: now + ttlMs, body });
            }
            res.set('X-Response-Cache', 'miss');
            return originalJson(body);
        };
        next();
    };
}

module.exports = { responseCache, _setTestBypass, _clear };
