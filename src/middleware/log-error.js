// src/middleware/log-error.js
// Route-level error logging through the secret scrubber (security audit,
// 2026-09-29): an error message can carry a connection string, a key in a
// URL or an upstream response, so EVERY route-level error line is scrubbed
// (src/collectors/redact.js: every non-empty secret env value, raw or
// URL-encoded, and credential query parameters) before it is written.

'use strict';

const { scrub } = require('../collectors/redact');

/** console.error one scrubbed line: "[tag] <message>". */
function logRouteError(tag, err, { sink = console.error } = {}) {
    const msg = err && typeof err.message === 'string' ? err.message : String(err);
    sink(scrub(`[${tag}] ${msg}`));
}

module.exports = { logRouteError };
