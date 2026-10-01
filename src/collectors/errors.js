// src/collectors/errors.js
// Error types the collector framework distinguishes, and their public
// classification.
//
//   AccessDeniedError   401 / 403 / 451 or a bot challenge: the source said
//                       no. NEVER retried and never worked around (ADR 0001
//                       ruling 5) — the run stops and the error is recorded.
//   RateLimitedError    the source RATE-LIMITED us, on positive evidence only
//                       (src/collectors/rate-limit.js rateLimitSignal: HTTP
//                       429; a 403 with x-ratelimit-remaining 0, or whose
//                       JSON message is GitHub's rate-limit wording —
//                       Retry-After alone never classifies). NOT a refusal:
//                       no refusal count, probation or critical alert — the
//                       host is backed off until the source's reset time
//                       (diagnosis 2026-10-01, GitHub). The 5th body-only
//                       one in a row is an AccessDeniedError (fail closed).
//                       `held: true` marks a request that was never sent
//                       because its host is still backing off.
//   RobotsDisallowedError  robots.txt disallows the path for our User-Agent.
//   GateClosedError     a collector was constructed without the credential
//                       or permission its route requires (the blocked-4
//                       classes throw this before any network call).
//   HttpError           any other non-2xx after retries, or a transport
//                       failure (timeout, DNS, TLS, connection).
//   ParseError          an unparseable body (JSON, RSS/Atom, XML). Its
//                       message never quotes the body (F10-13).
//
// Messages are built from REDACTED URLs (src/collectors/redact.js) and the
// runner scrubs them again before storing or logging. The public surface
// (GET /api/sources) serves only classifyError(): { error_kind, http_status }.

'use strict';

class CollectorError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = this.constructor.name;
        Object.assign(this, details);
    }
}

class HttpError extends CollectorError {}
class AccessDeniedError extends CollectorError {}
class RateLimitedError extends CollectorError {}
class RobotsDisallowedError extends CollectorError {}
class GateClosedError extends CollectorError {}
class ParseError extends CollectorError {}

/** The public error kinds (source_collection_state.last_error_kind, source_runs.error_kind). */
const ERROR_KINDS = Object.freeze([
    'access_denied', 'robots', 'robots_unreachable', 'gate', 'parse', 'timeout', 'network', 'http_4xx', 'http_5xx',
    'too_large', 'redirect_refused', 'host_refused', 'deadline', 'store', 'queue', 'internal',
    // Diagnosis 2026-10-01: a rate limit is its own kind, never 'access_denied'.
    'rate_limited',
]);

const TIMEOUT_RE = /\b(timeout|timed out|aborted due to timeout)\b/i;

/**
 * Classify an error for the public surface. Never returns free text.
 * @param {unknown} err
 * @returns {{ error_kind: string, http_status: number|null }}
 */
function classifyError(err) {
    const e = err || {};
    const status = Number.isInteger(e.status) ? e.status : null;
    if (e.kind && ERROR_KINDS.includes(e.kind)) return { error_kind: e.kind, http_status: status };
    if (e instanceof AccessDeniedError) return { error_kind: 'access_denied', http_status: status };
    if (e instanceof RateLimitedError) return { error_kind: 'rate_limited', http_status: status };
    if (e instanceof RobotsDisallowedError) return { error_kind: 'robots', http_status: null };
    if (e instanceof GateClosedError) return { error_kind: 'gate', http_status: null };
    if (e instanceof ParseError || e instanceof SyntaxError) return { error_kind: 'parse', http_status: status };
    if (status !== null && status >= 500) return { error_kind: 'http_5xx', http_status: status };
    if (status !== null && status >= 400) return { error_kind: 'http_4xx', http_status: status };
    const cause = e.cause || {};
    if (e.name === 'TimeoutError' || cause.name === 'TimeoutError' || TIMEOUT_RE.test(`${e.message} ${cause.message || ''}`)) {
        return { error_kind: 'timeout', http_status: null };
    }
    if (e instanceof HttpError) return { error_kind: 'network', http_status: status };
    return { error_kind: 'internal', http_status: status };
}

module.exports = {
    CollectorError, HttpError, AccessDeniedError, RateLimitedError, RobotsDisallowedError, GateClosedError, ParseError,
    ERROR_KINDS, classifyError,
};
