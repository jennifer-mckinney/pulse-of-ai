// src/collectors/http.js
// The one HTTP client every collector uses. Politeness is enforced here, not
// per adapter:
//   - User-Agent: "PulseOfAI/<version> (+<COLLECTOR_CONTACT_URL>; non-commercial
//     AI discourse research)" (Wikimedia's policy requires the contact);
//   - per-host spacing (the source's rateLimit.minIntervalMs);
//   - timeouts (default 20 s) via AbortSignal;
//   - retries with exponential backoff on 429 / 5xx / network errors,
//     honouring Retry-After (capped), at most 2 retries;
//   - 401 / 403 / 451 and bot challenges → AccessDeniedError, never retried;
//   - conditional GET: ETag / Last-Modified validators in a per-source cache
//     object; 304 → { notModified: true };
//   - robots.txt check before every gated request AND every redirect hop
//     (redirects are followed manually so a hop into a disallowed path is
//     refused, never fetched).
//
// Transport: an injectable function (url, { method, headers, body, signal })
// → { status, headers, body }. The default uses global fetch. Under
// NODE_ENV=test the default REFUSES the network unless
// PULSE_ALLOW_NETWORK=1 — unit and integration tests run on recorded
// fixtures (tests/fixtures/collectors), so CI never hits the network.

'use strict';

const { version } = require('../../package.json');
const { AccessDeniedError, HttpError, RobotsDisallowedError } = require('./errors');
const { RobotsPolicy } = require('./robots');

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

async function fetchTransport(url, { method = 'GET', headers = {}, body, signal }) {
    const res = await fetch(url, { method, headers, body, signal, redirect: 'manual' });
    const out = {};
    res.headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    return { status: res.status, headers: out, body: await res.text() };
}

/** Default transport: real network, except under tests. */
function defaultTransport(url, opts) {
    if (process.env.NODE_ENV === 'test' && process.env.PULSE_ALLOW_NETWORK !== '1') {
        return Promise.reject(new Error(`network disabled under NODE_ENV=test (${url}) — use a fixture transport`));
    }
    return fetchTransport(url, opts);
}

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
    constructor({ transport = defaultTransport, env = process.env, limiter, sleep, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
        this.transport = transport;
        this.ua = userAgent(env);
        this.sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
        this.limiter = limiter || new HostLimiter({ sleep: this.sleep });
        this.timeoutMs = timeoutMs;
        this.requests = 0;
        this.robots = new RobotsPolicy({ fetchRobots: url => this.fetchRobots(url) });
    }

    /** robots.txt itself: follows up to 3 redirects (http→https, apex→www). */
    async fetchRobots(url) {
        let current = url;
        for (let hop = 0; hop < 3; hop++) {
            const res = await this.raw(current, { headers: {} }, 0);
            if (![301, 302, 303, 307, 308].includes(res.status) || !res.headers.location) return res;
            current = new URL(res.headers.location, current).toString();
        }
        return { status: 508, headers: {}, body: '' };
    }

    /** One transport call with UA + timeout (no retries, no robots). */
    async raw(url, { method = 'GET', headers = {}, body }, minIntervalMs = 0) {
        await this.limiter.wait(new URL(url).host, minIntervalMs);
        this.requests++;
        return this.transport(url, {
            method,
            headers: { 'User-Agent': this.ua, ...headers },
            body,
            signal: AbortSignal.timeout(this.timeoutMs),
        });
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
     * @returns {Promise<{ status, headers, body, notModified, url }>}
     */
    async request(url, o = {}) {
        let current = url;
        let method = o.method || 'GET';
        let body = o.body;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (o.robots) {
                const verdict = await this.robots.check(current, { conservative: o.robotsConservative !== false });
                if (!verdict.allowed) throw new RobotsDisallowedError(verdict.reason, { url: current });
            }
            const headers = { ...(o.headers || {}) };
            const validators = o.cache && o.cache[current];
            if (validators && method === 'GET') {
                if (validators.etag) headers['If-None-Match'] = validators.etag;
                if (validators.last_modified) headers['If-Modified-Since'] = validators.last_modified;
            }
            const res = await this.withRetries(current, { method, headers, body }, o.minIntervalMs);
            if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
                current = new URL(res.headers.location, current).toString();
                if (res.status === 303) { method = 'GET'; body = undefined; }
                continue;
            }
            if (res.status === 304) return { ...res, notModified: true, url: current };
            if ([401, 403, 451].includes(res.status) || (res.status >= 400 && CHALLENGE_RE.test(res.body || ''))) {
                throw new AccessDeniedError(`${new URL(current).host} refused access (HTTP ${res.status}) — not retried, not worked around`,
                    { status: res.status, url: current });
            }
            if (res.status < 200 || res.status >= 300) {
                throw new HttpError(`HTTP ${res.status} from ${current}`, { status: res.status, url: current });
            }
            if (o.cache && method === 'GET' && (res.headers.etag || res.headers['last-modified'])) {
                o.cache[current] = { etag: res.headers.etag || null, last_modified: res.headers['last-modified'] || null };
            }
            return { ...res, notModified: false, url: current };
        }
        throw new HttpError(`too many redirects from ${url}`, { url });
    }

    async withRetries(url, init, minIntervalMs) {
        let lastErr;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            let res;
            try {
                res = await this.raw(url, init, minIntervalMs);
            } catch (err) {
                lastErr = err;
                if (attempt < MAX_RETRIES && !/network disabled/.test(err.message)) {
                    await this.sleep(1000 * 2 ** attempt);
                    continue;
                }
                throw new HttpError(`request to ${url} failed: ${err.message}`, { url, cause: err });
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
        } catch (err) {
            throw new HttpError(`invalid JSON from ${url}: ${err.message}`, { url });
        }
    }
}

module.exports = { HttpClient, HostLimiter, userAgent, defaultTransport, fetchTransport, retryAfterMs, CHALLENGE_RE };
