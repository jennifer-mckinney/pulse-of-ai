// tests/helpers/fixtureTransport.js
// HTTP transport for collector tests: answers from recorded / hand-written
// fixture files (tests/fixtures/collectors) — the network is never used.
//
//   const t = fixtureTransport([
//       ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'recorded/bbc-technology.xml'],
//       [/api\.x\.com/, { status: 403, body: 'no' }],
//   ]);
//   t.calls  → [{ url, method, headers, body }]
//
// A string matcher matches origin + pathname AND the query parameters
// exactly (G10-21: order-insensitive, every key and value; a matcher without
// a query matches only a request without one), so a test pins the query an
// adapter actually sends. A RegExp is tested against the full URL; a
// function receives (url, init). An unmatched /robots.txt answers 404 (no
// rules); any other unmatched URL throws, so a test can never silently
// reach the network.

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../fixtures/collectors');

function readFixture(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const RECORDED_AT = JSON.parse(readFixture('recorded/manifest.json')).recordedAt;

/** Sorted [key, value] pairs of a query (repeated keys kept). */
function queryPairs(u) {
    return [...u.searchParams.entries()].sort((a, b) => (a[0] + '\u0000' + a[1]).localeCompare(b[0] + '\u0000' + b[1]));
}

/** Same origin, path and query parameters (G10-21). */
function sameUrl(u, matcher) {
    const m = new URL(matcher);
    return u.origin === m.origin && u.pathname === m.pathname
        && JSON.stringify(queryPairs(u)) === JSON.stringify(queryPairs(m));
}

function fixtureTransport(routes) {
    const calls = [];
    const transport = async (url, init = {}) => {
        calls.push({ url, method: init.method || 'GET', headers: init.headers || {}, body: init.body });
        const u = new URL(url);
        for (const [matcher, response] of routes) {
            const hit = typeof matcher === 'string' ? sameUrl(u, matcher)
                : matcher instanceof RegExp ? matcher.test(url)
                    : matcher(url, init);
            if (!hit) continue;
            const r = typeof response === 'string' ? { status: 200, body: readFixture(response) }
                : typeof response === 'function' ? response(url, init) : response;
            return { status: r.status || 200, headers: r.headers || {}, body: r.body || '' };
        }
        if (u.pathname === '/robots.txt') return { status: 404, headers: {}, body: '' };
        throw new Error(`fixtureTransport: no fixture for ${url}`);
    };
    transport.calls = calls;
    return transport;
}

// An operator environment: a contact URL and the permission-gated feeds'
// acknowledgement (D1) — tests of a fresh clone pass {} instead.
const TEST_ENV = Object.freeze({
    COLLECTOR_CONTACT_URL: 'https://example.org/pulse-contact',
    PERMISSION_GATED_FEEDS_ACCEPTED_BY: 'Test Operator 2026-09-29',
    // PR #22 decision G5: gated routes open only under a named approval.
    GATE_APPROVED_BY: 'Test Operator 2026-09-29',
});

module.exports = { fixtureTransport, readFixture, sameUrl, RECORDED_AT, TEST_ENV, FIXTURE_ROOT: ROOT };
