// src/collectors/errors.js
// Error types the collector framework distinguishes.
//
//   AccessDeniedError   401 / 403 / 451 or a bot challenge: the source said
//                       no. NEVER retried and never worked around (ADR 0001
//                       ruling 5) — the run stops and the error is recorded.
//   RobotsDisallowedError  robots.txt disallows the path for our User-Agent.
//   GateClosedError     a collector was constructed without the credential
//                       or permission its route requires (the blocked-4
//                       classes throw this before any network call).
//   HttpError           any other non-2xx after retries.

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
class RobotsDisallowedError extends CollectorError {}
class GateClosedError extends CollectorError {}

module.exports = { CollectorError, HttpError, AccessDeniedError, RobotsDisallowedError, GateClosedError };
