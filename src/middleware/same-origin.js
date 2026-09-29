// src/middleware/same-origin.js
// Server-side cross-site request guard for state-changing, unauthenticated
// endpoints (POST /api/refresh).
//
// Why CORS is not enough (PR #8 review): omitting Access-Control-Allow-Origin
// only hides the RESPONSE from a cross-origin page. A bodyless "simple" POST
// (an HTML <form>, fetch with mode:'no-cors') needs no preflight, so the
// browser still delivers it and the side effect (a new processing job, the
// 60 s global refresh budget) happens anyway. The request must be rejected
// on the server.
//
// Decision order:
//   1. Sec-Fetch-Site present (every current browser sends it and page
//      script cannot forge it): allow only 'same-origin' or 'none'
//      (user-initiated, e.g. typed URL). 'same-site' (a sibling subdomain)
//      and 'cross-site' are rejected.
//   2. Sec-Fetch-Site absent (older browsers, non-browser clients): allow
//      only when Origin — or, failing that, Referer — names this server's own
//      host. Origin 'null' (sandboxed iframe, file://) never matches.
//   3. Anything else → 403. A request that proves nothing about where it
//      came from is treated as cross-site.
//
// "This server's own host" is the request's Host header (host[:port]). A
// cross-site browser request cannot choose the Host it is sent to, so
// comparing the Origin's host to it is sound; comparing host rather than
// scheme+host keeps the check correct behind a TLS-terminating proxy.

'use strict';

const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none']);

/**
 * host[:port] of an absolute URL, or null when the value is missing,
 * 'null', or not a parseable absolute URL.
 * @param {string|undefined} value
 * @returns {string|null}
 */
function hostOf(value) {
    if (!value || value === 'null') return null;
    try {
        return new URL(value).host.toLowerCase() || null;
    } catch {
        return null;
    }
}

/**
 * Decide whether a request is same-origin. Pure — exported for unit tests.
 * @param {{ secFetchSite?: string, origin?: string, referer?: string, host?: string }} h
 * @returns {boolean}
 */
function isSameOriginRequest({ secFetchSite, origin, referer, host }) {
    if (secFetchSite !== undefined && secFetchSite !== '') {
        return ALLOWED_FETCH_SITES.has(String(secFetchSite).toLowerCase());
    }
    const ownHost = host ? String(host).toLowerCase() : null;
    if (!ownHost) return false;
    // Origin wins when present: a present-but-foreign Origin is a rejection
    // even if a Referer happens to match.
    if (origin !== undefined && origin !== '') {
        return hostOf(origin) === ownHost;
    }
    return hostOf(referer) === ownHost;
}

/** Express middleware: 403 unless the request is provably same-origin. */
function requireSameOrigin(req, res, next) {
    const ok = isSameOriginRequest({
        secFetchSite: req.get('Sec-Fetch-Site'),
        origin:       req.get('Origin'),
        referer:      req.get('Referer'),
        host:         req.get('Host'),
    });
    if (ok) return next();
    return res.status(403).json({ error: 'Cross-site request rejected' });
}

module.exports = { requireSameOrigin, isSameOriginRequest };
