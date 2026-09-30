// src/collectors/http.js
// The one HTTP client every collector uses. Politeness is enforced here, not
// per adapter:
//   - User-Agent: "PulseOfAI/<version> (+<COLLECTOR_CONTACT_URL>; non-commercial
//     AI discourse research)" (Wikimedia's policy requires the contact);
//   - per-host spacing (the source's rateLimit.minIntervalMs);
//   - timeouts (default 20 s) via AbortSignal;
//   - retries with exponential backoff on 429 / 5xx / network errors,
//     honouring Retry-After (capped), at most 2 retries; NOT for a DNS
//     failure (ENOTFOUND / EAI_AGAIN: the next cadence tick is the retry) or
//     an undecodable body (deterministic) — diagnosis 2026-09-30;
//   - 401 / 403 / 451 and bot challenges → AccessDeniedError, never retried;
//     it carries an ALLOW-LIST of the refusal's response headers (server,
//     date, retry-after, cache / edge request ids …; never Set-Cookie, auth
//     or any body), scrubbed and control-character free, so operators can
//     see which layer refused (diagnosis 2026-09-30, option D);
//   - conditional GET: ETag / Last-Modified validators in a per-source cache
//     object; 304 → { notModified: true };
//   - robots.txt check before every gated request AND every redirect hop
//     (redirects are followed manually so a hop into a disallowed path is
//     refused, never fetched);
//   - error messages carry REDACTED URLs only (F10-1: API keys travel in
//     query strings) and never quote a response body (F10-13);
//   - every hop (the first request, each redirect, robots.txt) is checked
//     BEFORE it is sent (F10-2, src/collectors/netguard.js): https only (so
//     never a downgrade), no local / internal / private host, and — for
//     collector requests — only the route's allowed hosts. A request that
//     carries credentials (an Authorization / token / API-key header, a
//     cookie, or a body) is NEVER sent across origins: a cross-origin
//     redirect of it is refused (RedirectRefusedError). An uncredentialed
//     GET may follow one, with every credential header dropped anyway;
//   - responses are size-capped (F10-4): 5 MB decoded by default
//     (o.maxBytes per route), 500 KiB for robots.txt.
//
// Transport: an injectable function (url, { method, headers, body, signal,
// maxBytes }) → { status, headers, body }. The default is the guarded
// node:https transport (src/collectors/transport.js: DNS answers checked and
// pinned, streaming size cap). Under NODE_ENV=test the default REFUSES the
// network unless PULSE_ALLOW_NETWORK=1 — unit and integration tests run on
// recorded fixtures (tests/fixtures/collectors), so CI never hits the network.

'use strict';

const { version } = require('../../package.json');
const { AccessDeniedError, HttpError, RobotsDisallowedError, ParseError } = require('./errors');
const { RobotsPolicy, SHARED_CACHE } = require('./robots');
const { redactUrl, redactUrlsIn, scrub } = require('./redact');
const { checkUrl, RedirectRefusedError } = require('./netguard');
const { createNetworkTransport, ROBOTS_MAX_BYTES } = require('./transport');
const { neutralizeControl } = require('../middleware/log-error');

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RETRIES = 2;
const MAX_RETRY_AFTER_MS = 60000;
const MAX_REDIRECTS = 4;

/** The collector User-Agent. @throws when the contact URL is missing */
function userAgent(env = process.env) {
    const contact = (env.COLLECTOR_CONTACT_URL || '').trim();
    if (!contact) throw new Error('COLLECTOR_CONTACT_URL is not set — collectors must identify a contact');
    return `PulseOfAI/${version} (+${contact}; non-commercial AI discourse research)`;
}

let networkTransport = null;

/** Default transport: the guarded network transport, except under tests. */
function defaultTransport(url, opts) {
    if (process.env.NODE_ENV === 'test' && process.env.PULSE_ALLOW_NETWORK !== '1') {
        return Promise.reject(new Error(`network disabled under NODE_ENV=test (${redactUrl(url)}) — use a fixture transport`));
    }
    networkTransport = networkTransport || createNetworkTransport();
    return networkTransport(url, opts);
}

// Headers that carry a credential. Never sent across origins; a request that
// has one (or a body) is refused a cross-origin redirect altogether.
const SENSITIVE_HEADERS = Object.freeze([
    'authorization', 'proxy-authorization', 'cookie', 'private-token', 'x-api-key', 'x-els-apikey',
    'api-key', 'x-goog-api-key',
]);

function isSensitive(name, extra) {
    const n = name.toLowerCase();
    return SENSITIVE_HEADERS.includes(n) || (extra || []).some(x => x.toLowerCase() === n);
}

const REDIRECTS = [301, 302, 303, 307, 308];

/** Per-host spacing: resolves when `minIntervalMs` has passed since the last request to the host. */
class HostLimiter {
    constructor({ now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
        this.next = new Map();
        this.now = now;
        this.sleep = sleep;
    }

    async wait(host, minIntervalMs) {
        const at = this.next.get(host) || 0;
        const t = this.now();
        const start = Math.max(t, at);
        this.next.set(host, start + (minIntervalMs || 0));
        if (start > t) await this.sleep(start - t);
    }
}

// DNS failures are not transient within a second: the next cadence tick is
// the retry (diagnosis 2026-09-30: Pew's ENOTFOUND was retried twice in 4 s).
const NO_RETRY_CODES = Object.freeze(['ENOTFOUND', 'EAI_AGAIN']);

/** Whether a transport error must not be retried inside the same run. */
function isDeterministic(err) {
    return !!err && (NO_RETRY_CODES.includes(err.code) || err.decode === true);
}

// The response headers kept from a refusal (401 / 403 / 451 / bot wall):
// enough to tell the refusing layer (origin, CDN, WAF) apart, nothing that
// identifies us or a session. Everything else — Set-Cookie, auth challenges,
// any body — is dropped.
const REFUSAL_HEADER_ALLOWLIST = Object.freeze([
    'server', 'date', 'content-type', 'retry-after', 'via', 'age',
    'x-cache', 'x-cache-status', 'cf-cache-status', 'cf-ray', 'cf-mitigated', 'x-served-by',
    'x-request-id', 'x-amz-cf-id', 'x-amz-cf-pop', 'x-rq', 'x-powered-by',
]);
const REFUSAL_HEADER_MAX = 200;   // characters per value

/**
 * The allow-listed refusal headers, each value scrubbed (every secret env
 * value, credential URL parameters), control characters neutralized (PR #22
 * security L4: one header, one line) and capped.
 * @returns {object} { name: value } — only allow-listed names, never empty strings
 */
function refusalHeaders(headers, env = process.env) {
    const out = {};
    const h = headers || {};
    for (const name of REFUSAL_HEADER_ALLOWLIST) {
        const v = h[name];
        if (v === undefined || v === null) continue;
        const raw = Array.isArray(v) ? v.join(', ') : String(v);
        let clean = neutralizeControl(scrub(raw, env) || '');
        if (clean.length > REFUSAL_HEADER_MAX) clean = `${clean.slice(0, REFUSAL_HEADER_MAX - 1)}…`;
        if (clean) out[name] = clean;
    }
    return out;
}

// A body that is a bot-wall challenge page, whatever the status code.
const CHALLENGE_RE = /(cf-chl|challenge-platform|_Incapsula_Resource|datadome|captcha-delivery|Attention Required! \| Cloudflare)/i;

function retryAfterMs(headers, attempt) {
    const ra = headers && headers['retry-after'];
    if (ra) {
        const sec = Number(ra);
        const ms = Number.isFinite(sec) ? sec * 1000 : Date.parse(ra) - Date.now();
        if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, MAX_RETRY_AFTER_MS);
    }
    return 1000 * 2 ** attempt;
}

class HttpClient {
    /**
     * @param {object} opts
     * @param {Function} [opts.transport]
     * @param {object}   [opts.env]      for the User-Agent contact
     * @param {HostLimiter} [opts.limiter]
     * @param {Function} [opts.sleep]
     * @param {number}   [opts.timeoutMs]
     */
    constructor({ transport = defaultTransport, env = process.env, limiter, sleep, timeoutMs = DEFAULT_TIMEOUT_MS, robotsCache, signal } = {}) {
        // G10-9 / G10-16: the run's deadline. Once it fires no new request
        // starts and in-flight ones are aborted (error kind 'deadline').
        this.signal = signal || null;
        this.transport = transport;
        this.env = env;
        this.ua = userAgent(env);
        this.sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
        this.limiter = limiter || new HostLimiter({ sleep: this.sleep });
        this.timeoutMs = timeoutMs;
        this.requests = 0;
        // F10-9: the network transport shares the process-level robots cache
        // across runs; an injected (fixture) transport gets its own unless a
        // cache is passed, so recorded fixtures never leak between tests.
        const cache = robotsCache || (transport === defaultTransport ? SHARED_CACHE : new Map());
        this.robots = new RobotsPolicy({ fetchRobots: url => this.fetchRobots(url), cache });
    }

    /**
     * robots.txt itself: follows up to 5 redirects (RFC 9309 §2.3.1.2 — they
     * may cross authorities; no credential is ever sent). Every hop is
     * checked: https, public host (F10-2). Capped at 500 KiB (F10-4).
     */
    async fetchRobots(url) {
        let current = url;
        for (let hop = 0; hop < 5; hop++) {
            checkUrl(current);
            const res = await this.raw(current, { headers: {}, maxBytes: ROBOTS_MAX_BYTES }, 0);
            if (!REDIRECTS.includes(res.status) || !res.headers.location) return res;
            current = new URL(res.headers.location, current).toString();
        }
        return { status: 508, headers: {}, body: '' };
    }

    /** One transport call with UA + timeout (no retries, no robots). */
    /** Throw when the run's deadline has passed (never retried). */
    checkDeadline() {
        if (this.signal && this.signal.aborted) {
            throw new HttpError('collection deadline reached — the rest of this run is skipped', { kind: 'deadline' });
        }
    }

    async raw(url, { method = 'GET', headers = {}, body, maxBytes }, minIntervalMs = 0) {
        checkUrl(url);
        this.checkDeadline();
        await this.limiter.wait(new URL(url).host, minIntervalMs);
        this.checkDeadline();
        this.requests++;
        const timeout = AbortSignal.timeout(this.timeoutMs);
        try {
            return await this.transport(url, {
                method,
                headers: { 'User-Agent': this.ua, ...headers },
                body,
                maxBytes,
                signal: this.signal ? AbortSignal.any([timeout, this.signal]) : timeout,
            });
        } catch (err) {
            this.checkDeadline();   // aborted by the deadline: report it as such
            throw err;
        }
    }

    /**
     * @param {string} url
     * @param {object} [o]
     * @param {string} [o.method]
     * @param {object} [o.headers]
     * @param {string} [o.body]
     * @param {object} [o.cache]          { [url]: { etag, last_modified } } — mutated
     * @param {boolean} [o.robots]        check robots.txt (publisher-site routes)
     * @param {boolean} [o.robotsConservative]  default true
     * @param {number} [o.minIntervalMs]  per-host spacing
     * @param {string[]} [o.allowedHosts] every hop must be on these hosts (F10-2)
     * @param {string[]} [o.sensitiveHeaders] extra credential header names
     * @param {number} [o.maxBytes]       decoded response cap (F10-4)
     * @returns {Promise<{ status, headers, body, notModified, url }>}
     */
    async request(url, o = {}) {
        let current = url;
        let method = o.method || 'GET';
        let body = o.body;
        let baseHeaders = { ...(o.headers || {}) };
        const credentialed = body !== undefined && body !== null
            || Object.keys(baseHeaders).some(h => isSensitive(h, o.sensitiveHeaders));
        let origin = null;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            const u = checkUrl(current, { allowedHosts: o.allowedHosts });
            if (origin && u.origin !== origin) {
                if (credentialed) {
                    throw new RedirectRefusedError(`refused: cross-origin redirect to ${u.host} of a request carrying credentials`,
                        { url: redactUrl(current) });
                }
                // Uncredentialed GET: follow, but never forward a credential.
                baseHeaders = Object.fromEntries(Object.entries(baseHeaders).filter(([h]) => !isSensitive(h, o.sensitiveHeaders)));
                method = 'GET';
                body = undefined;
            }
            origin = u.origin;
            if (o.robots) {
                const verdict = await this.robots.check(current, { conservative: o.robotsConservative !== false });
                // An unreachable robots.txt blocks this run (RFC 9309) but is
                // not the source refusing us: it is classified apart from a
                // real disallow and does not enter the refused state (F10-5).
                if (!verdict.allowed) {
                    throw new RobotsDisallowedError(verdict.reason, {
                        url: redactUrl(current), ...(verdict.unreachable ? { kind: 'robots_unreachable' } : {}),
                    });
                }
            }
            const headers = { ...baseHeaders };
            const validators = o.cache && o.cache[current];
            if (validators && method === 'GET') {
                if (validators.etag) headers['If-None-Match'] = validators.etag;
                if (validators.last_modified) headers['If-Modified-Since'] = validators.last_modified;
            }
            const res = await this.withRetries(current, { method, headers, body, maxBytes: o.maxBytes }, o.minIntervalMs);
            if (REDIRECTS.includes(res.status) && res.headers.location) {
                current = new URL(res.headers.location, current).toString();
                if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
                    method = 'GET';
                    body = undefined;
                }
                continue;
            }
            if (res.status === 304) return { ...res, notModified: true, url: current };
            if ([401, 403, 451].includes(res.status) || (res.status >= 400 && CHALLENGE_RE.test(res.body || ''))) {
                throw new AccessDeniedError(`${new URL(current).host} refused access (HTTP ${res.status}) — not retried, not worked around`,
                    { status: res.status, url: redactUrl(current), headers: refusalHeaders(res.headers, this.env) });
            }
            if (res.status < 200 || res.status >= 300) {
                throw new HttpError(`HTTP ${res.status} from ${redactUrl(current)}`, { status: res.status, url: redactUrl(current) });
            }
            if (o.cache && method === 'GET' && (res.headers.etag || res.headers['last-modified'])) {
                o.cache[current] = { etag: res.headers.etag || null, last_modified: res.headers['last-modified'] || null };
            }
            return { ...res, notModified: false, url: current };
        }
        throw new HttpError(`too many redirects from ${redactUrl(url)}`, { url: redactUrl(url) });
    }

    async withRetries(url, init, minIntervalMs) {
        let lastErr;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            let res;
            try {
                res = await this.raw(url, init, minIntervalMs);
            } catch (err) {
                lastErr = err;
                if (err && err.kind === 'deadline') throw err;
                if (attempt < MAX_RETRIES && !/network disabled/.test(err.message) && !isDeterministic(err)) {
                    await this.sleep(1000 * 2 ** attempt);
                    continue;
                }
                // The transport's own message may quote the URL: redact it too.
                // An undecodable body keeps its 'parse' classification.
                throw new HttpError(`request to ${redactUrl(url)} failed: ${redactUrlsIn(err.message)}`, {
                    url: redactUrl(url), cause: { name: err.name, message: redactUrlsIn(err.message) },
                    ...(err.code ? { code: err.code } : {}), ...(err.decode ? { kind: 'parse' } : {}),
                });
            }
            // A bot challenge is a refusal, never something to retry into.
            if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES && !CHALLENGE_RE.test(res.body || '')) {
                await this.sleep(retryAfterMs(res.headers, attempt));
                continue;
            }
            return res;
        }
        /* istanbul ignore next -- loop always returns or throws */
        throw lastErr;
    }

    async text(url, o) {
        return this.request(url, o);
    }

    /** GET/POST expecting JSON. @returns {Promise<{ data, notModified, headers, status }>} */
    async json(url, o = {}) {
        const res = await this.request(url, { ...o, headers: { Accept: 'application/json', ...(o.headers || {}) } });
        if (res.notModified) return { data: null, notModified: true, headers: res.headers, status: res.status };
        try {
            return { data: JSON.parse(res.body), notModified: false, headers: res.headers, status: res.status };
        } catch {
            // F10-13: JSON.parse's message quotes the body — never kept.
            throw new ParseError(`invalid JSON from ${redactUrl(url)}`, { url: redactUrl(url), status: res.status });
        }
    }
}

module.exports = {
    HttpClient, HostLimiter, userAgent, defaultTransport, retryAfterMs, CHALLENGE_RE, redactUrl, SENSITIVE_HEADERS,
    REFUSAL_HEADER_ALLOWLIST, refusalHeaders, isDeterministic, NO_RETRY_CODES,
};
