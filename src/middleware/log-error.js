// src/middleware/log-error.js
// Route-level error logging through the secret scrubber (security audit,
// 2026-09-29): an error message can carry a connection string, a key in a
// URL or an upstream response, so EVERY route-level error line is scrubbed
// (src/collectors/redact.js: every non-empty secret env value, raw or
// URL-encoded, and credential query parameters) before it is written.
//
// PR #22 security L4: a route error can quote REQUEST data (a malformed JSON
// body's parse error echoes the raw body, newlines included), so a client
// could forge extra log lines ("x\n[health] FAKE …"). Every control
// character (C0, DEL and the C1 range, plus the Unicode line and paragraph
// separators) is escaped to a visible form before the line is written, so
// one error is always exactly one log line.

'use strict';

const { scrub } = require('../collectors/redact');

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const NAMED = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Escape control characters so the text cannot break or forge a log line. */
function neutralizeControl(text) {
    return String(text).replace(CONTROL_RE, c => NAMED[c] || `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** console.error one scrubbed line: "[tag] <message>". */
function logRouteError(tag, err, { sink = console.error } = {}) {
    const msg = err && typeof err.message === 'string' ? err.message : String(err);
    sink(scrub(neutralizeControl(`[${tag}] ${msg}`)));
}

module.exports = { logRouteError, neutralizeControl };
