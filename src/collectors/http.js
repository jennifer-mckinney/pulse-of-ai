// src/collectors/http.js
// The one HTTP client every collector uses. Politeness is enforced here, not
// per adapter:
//   - User-Agent: "PulseOfAI/<version> (+<COLLECTOR_CONTACT_URL>; non-commercial
//     AI discourse research)" (Wikimedia's policy requires the contact);
//   - per-host spacing (the source's rateLimit.minIntervalMs);
//   - timeouts (default 20 s) via AbortSignal;
//   - retries with exponential backoff on 429 / 5xx / network errors,
//     at most 2 retries; NOT for a DNS failure (ENOTFOUND / EAI_AGAIN: the
//     next cadence tick is the retry) or an undecodable body (deterministic)
//     — diagnosis 2026-09-30. A source's Retry-After (or, on a 429 with the
//     limit spent, x-ratelimit-reset) is honoured WHOLE: never retried
//     before it; a wait longer than MAX_IN_RUN_WAIT_MS (10 s) is not slept
//     at all (diagnosis 2026-10-01: the old 60 s cap retried early, and two
//     60 s waits overran TLDR's run deadline — PR #44);
//   - rate limits (src/collectors/rate-limit.js, diagnosis 2026-10-01) →
//     RateLimitedError, never retried past the above and NEVER a refusal:
//     HTTP 429, or a 403 with positive evidence (x-ratelimit-remaining 0, or
//     GitHub's rate-limit wording as the JSON message; Retry-After only
//     lengthens — security F2). The HOSTNAME is held in this client's one
//     holds map (this.holds) until the source's time (60 s floor doubling
//     per consecutive limit, 24 h cap — F1); EVERY transport call (raw():
//     requests, redirect hops, robots.txt, the governance terms fetch) to a
//     held host is refused unsent (RateLimitedError { held: true } — F5). A
//     success from the host resets its streak; the ESCALATE_AFTER-th
//     consecutive body-only rate limit, 5th consecutive strong 403 or 14th
//     consecutive rate limit of any kind is a refusal (fail closed — F1). A
//     5xx whose Retry-After is too long to wait in-run holds the host too
//     (signal retry_after_5xx, grumpy #7). A hold learned BEHIND a redirect
//     holds the requested URL's host as well (PR #44), so a fresh client
//     sends nothing at all — not robots.txt, not the first hop. This is the
//     ONE hold path: PR #44's TLDR Retry-After holds are a case of it;
//   - 401 / 451, any other 403, and bot challenges (a challenge page or
//     cf-mitigated: challenge — F6, src/collectors/challenge.js) → AccessDeniedError,
//     never retried; it carries an ALLOW-LIST of the refusal's response
//     headers (server, date, retry-after, x-ratelimit-*, cache / edge
//     request ids …; never Set-Cookie, auth or any body), scrubbed and
//     control-character free, so operators can see which layer refused
//     (diagnosis 2026-09-30, option D);
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
const { AccessDeniedError, HttpError, RateLimitedError, RobotsDisallowedError, ParseError } = require('./errors');
const { RobotsPolicy, SHARED_CACHE } = require('./robots');
const { redactUrl, redactUrlsIn, scrub } = require('./redact');
const { checkUrl, RedirectRefusedError } = require('./netguard');
const { createNetworkTransport, ROBOTS_MAX_BYTES } = require('./transport');
const { neutralizeControl } = require('../middleware/log-error');
const rateLimit = require('./rate-limit');
const { CHALLENGE_RE, challengeHeader, isChallenge } = require('./challenge');

const DEFAULT_TIMEOUT_MS = 20000;
// Holds are keyed by the NORMALISED hostname (rate-limit.js normHost: lower
// case, no trailing dot — security review F4).
const hostnameOf = url => rateLimit.normHost(new URL(url).hostname);
// Security review P2: a source's HTTP validator cache never grows past this many
// URLs (a hostile redirect chain could add keys for ever); the oldest go first.
const VALIDATOR_CACHE_MAX = 500;
// A 2xx is a bot wall (not content) when it is an HTML page this small that
// matches a known challenge page — a JSON / feed / text payload that merely
// MENTIONS a vendor (an article about DataDome) is content.
const WALL_PAGE_MAX_BYTES = 64 * 1024;
// A redirect INTO a challenge platform URL is the wall too, whatever it answers next.
const CHALLENGE_LOCATION_RE = /\/cdn-cgi\/challenge-platform\//i;

/** Whether a 2xx response is a bot-wall page (an HTML page matching CHALLENGE_RE, or Cloudflare's header). */
function isWallPage(res) {
    if (challengeHeader(res.headers)) return true;
    // Only an explicitly HTML page can be a challenge page (a wall always is one);
    // a response with no content type, or any payload type, is content.
    const type = String((res.headers && res.headers['content-type']) || '').toLowerCase();
    const body = typeof res.body === 'string' ? res.body : '';
    // No content type: an HTML-looking body is a page (a wall), anything else is content.
    if (type ? !/html/.test(type) : !/^\s*<(!doctype|html)/i.test(body)) return false;
    return body.length <= WALL_PAGE_MAX_BYTES && CHALLENGE_RE.test(body);
}
const MAX_RETRIES = 2;
// Diagnosis 2026-10-01: the longest wait slept INSIDE a run before a retry
// (rate-limit.js MAX_IN_RUN_WAIT_MS, 10 s — PR #44: two waits stay inside
// the run's deadline). A longer Retry-After is never shortened: the request
// ends and a 429 becomes the host's backoff.
const { MAX_IN_RUN_WAIT_MS } = rateLimit;
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
    'x-amz-cf-id', 'x-amz-cf-pop', 'x-rq',
    // Diagnosis 2026-10-01: the headers that tell a rate limit (primary or
    // secondary) from a refusal — numbers and a bucket name, no identity.
    'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-used', 'x-ratelimit-resource',
]);
// Security review L3: x-powered-by (a software fingerprint) and x-request-id
// (can carry a session-correlated id) are deliberately NOT kept; nor is
// x-github-request-id (the same class).
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

// The statuses that are the source refusing us (never retried).
const REFUSAL_STATUSES = Object.freeze([401, 403, 451]);

/**
 * The wait before an in-run retry: the source's Retry-After WHOLE (never
 * shortened — diagnosis 2026-10-01), else exponential. withRetries does not
 * retry at all when this is longer than MAX_IN_RUN_WAIT_MS.
 */
function retryAfterMs(headers, attempt, now = Date.now()) {
    const ra = rateLimit.parseRetryAfter(headers, now);
    return ra !== null ? ra : 1000 * 2 ** attempt;
}

class HttpClient {
    /**
     * @param {object} opts
     * @param {Function} [opts.transport]
     * @param {object}   [opts.env]      for the User-Agent contact
     * @param {HostLimiter} [opts.limiter]
     * @param {Function} [opts.sleep]
     * @param {number}   [opts.timeoutMs]
     * @param {Function} [opts.now]  wall clock (epoch ms) for rate-limit times
     * @param {object}   [opts.holds] the rate-limit holds map (hostname →
     *                   hold, rate-limit.js), shared by every request of
     *                   this client; usually loaded from the database
     */
    constructor({
        transport = defaultTransport, env = process.env, limiter, sleep, timeoutMs = DEFAULT_TIMEOUT_MS, robotsCache, signal,
        now = () => Date.now(), holds = Object.create(null),
    } = {}) {
        // G10-9 / G10-16: the run's deadline. Once it fires no new request
        // starts and in-flight ones are aborted (error kind 'deadline').
        this.signal = signal || null;
        this.transport = transport;
        this.env = env;
        this.ua = userAgent(env);
        // Security review F7: the default sleep ends when the run's deadline
        // fires (the next checkDeadline then reports it), so a hostile
        // Retry-After cannot hold a request past the deadline.
        this.sleep = sleep || (ms => new Promise((resolve) => {
            if (this.signal && this.signal.aborted) return resolve();
            const done = () => { clearTimeout(timer); if (this.signal) this.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, ms);
            if (this.signal) this.signal.addEventListener('abort', done, { once: true });
        }));
        this.limiter = limiter || new HostLimiter({ sleep: this.sleep });
        this.timeoutMs = timeoutMs;
        this.requests = 0;
        // F10-9: the network transport shares the process-level robots cache
        // across runs; an injected (fixture) transport gets its own unless a
        // cache is passed, so recorded fixtures never leak between tests.
        const cache = robotsCache || (transport === defaultTransport ? SHARED_CACHE : new Map());
        this.robots = new RobotsPolicy({ fetchRobots: url => this.fetchRobots(url), cache });
        this.now = now;
        // Security F5: ONE holds map per client, keyed by hostname, checked
        // before every transport call (raw()). holdChanges: the hosts whose
        // hold was set (entry) or cleared by a success (null) since the last
        // drainHoldChanges() — what the caller persists.
        this.holds = holds || Object.create(null);
        this.holdChanges = new Map();
    }

    /** Merge stored holds (rate-limit.js sanitizeHolds) into this client's map. */
    loadHolds(stored) {
        rateLimit.mergeHolds(this.holds, stored, this.now());
        return this.holds;
    }

    /** The hold changes since the last call (hostname → entry, or null when cleared), then forgotten. */
    drainHoldChanges() {
        const out = this.holdChanges;
        this.holdChanges = new Map();
        return out;
    }

    /** The RateLimitedError for a request to a held host, or null when it is not held. */
    heldError(hostname, url) {
        const hold = rateLimit.heldUntil(this.holds, hostname, this.now());
        if (!hold) return null;
        // Copilot review: a 5xx's Retry-After hold (retry_after_5xx) is honoured
        // but is not a rate limit — it stays an http_5xx server failure (never
        // the rate_limited kind), with `held: true` so callers still suppress
        // the request.
        if (hold.signal === 'retry_after_5xx') {
            return new HttpError(`not requested: ${rateLimit.publicHostName(hostname)} is backing off after a server error (HTTP ${hold.http_status || '5xx'})`
                + ` — backing off until ${new Date(hold.until).toISOString()}, honoured; not a rate limit`, {
                held: true, host: hostname, url: redactUrl(url), retryAt: hold.until,
                status: Number.isInteger(hold.http_status) && hold.http_status >= 500 ? hold.http_status : 503,
            });
        }
        return new RateLimitedError(`not requested: ${rateLimit.publicHostName(hostname)} is rate-limiting us (HTTP ${hold.http_status || '?'}`
            + `${hold.signal ? `, ${hold.signal}` : ''}) — backing off until ${new Date(hold.until).toISOString()}, honoured`, {
            held: true, host: hostname, url: redactUrl(url), retryAt: hold.until,
        });
    }

    /**
     * A success from a host ends its streak (security F1: only a success
     * resets it). Only an EXPIRED hold is cleared: an active one cannot have
     * been in force when the request was sent (raw() refuses a held host),
     * so it was set meanwhile by a concurrent request of this client — it
     * stands (PR #44: a success never clears a hold set while in flight).
     */
    clearHold(hostname) {
        for (const key of rateLimit.hostKeys(hostname)) {
            if (!Object.prototype.hasOwnProperty.call(this.holds, key)) continue;
            const until = Date.parse(this.holds[key].until);
            if (Number.isFinite(until) && until > this.now()) continue;
            delete this.holds[key];
            this.holdChanges.set(key, null);
        }
    }

    /**
     * PR #44 (Copilot review): a hold learned on a redirect TARGET also holds
     * the host the route asked for, so a fresh client (a restart, another
     * replica) sends nothing at all during it — not robots.txt, not the
     * first hop. The same record (combineHold: never shortens a longer hold
     * already there). No-op when the hosts are the same.
     */
    holdAlso(hostname, entry) {
        if (!entry || !hostname || this.holds[hostname] === entry) return;
        const next = rateLimit.combineHold(this.holds[hostname] || null, entry);
        this.holds[hostname] = next;
        this.holdChanges.set(hostname, next);
    }

    /** The hold entry that stops `hostname` (its own, or its www. twin's), or null. */
    holdEntryOf(hostname) {
        let best = null;
        for (const key of rateLimit.hostKeys(hostname)) {
            const e = Object.prototype.hasOwnProperty.call(this.holds, key) ? this.holds[key] : null;
            if (e && (!best || Date.parse(e.until) > Date.parse(best.until))) best = e;
        }
        return best;
    }

    /** Record the next hold of a host (rate-limit.js nextHold). @returns {{ entry, escalate }} */
    recordHold(hostname, sig) {
        const next = rateLimit.nextHold(this.holds[hostname] || null, sig, this.now());
        // Security review F9: an escalation (the refused state takes over for the
        // source) still HOLDS the host for every other source and route sharing
        // it, and keeps its streak: only a success ends a streak.
        this.holds[hostname] = next.entry;
        this.holdChanges.set(hostname, next.entry);
        return next;
    }

    /**
     * Diagnosis 2026-10-01: a final 403 / 429 that is a RATE LIMIT (positive
     * evidence only, rate-limit.js) → the RateLimitedError to throw, after
     * holding the hostname until the source's time (60 s floor doubling per
     * consecutive limit, 24 h cap). The ESCALATE_AFTER-th consecutive
     * body-only (weak) rate limit → an AccessDeniedError instead (security
     * F1: fail closed). null for anything else — a plain 403 stays a
     * refusal. The body is matched, never kept.
     */
    rateLimitError(url, res) {
        // The FINAL response's hostname (after redirects) decides whether
        // GitHub's wording is evidence at all (rate-limit.js BODY_HOSTS).
        const host = hostnameOf(url);
        const sig = rateLimit.rateLimitSignal(res, this.now(), host);
        if (!sig) return null;
        const { entry, escalate } = this.recordHold(host, { ...sig, status: res.status });
        if (escalate) {
            // L3: a body-only streak (ESCALATE_AFTER) or a long run of strong 403s.
            const why = sig.weak
                ? `${rateLimit.ESCALATE_AFTER} rate limits in a row on body text alone`
                : (entry.strong403 >= rateLimit.ESCALATE_STRONG_403_AFTER
                    ? `${rateLimit.ESCALATE_STRONG_403_AFTER} rate-limit 403s in a row`
                    : `${rateLimit.ESCALATE_ANY_AFTER} rate limits in a row with no success`);
            return new AccessDeniedError(`${rateLimit.publicHostName(host)} refused access (HTTP ${res.status}): ${why}`
                + ' — treated as a refusal (fail closed), not retried, not worked around', {
                status: res.status, url: redactUrl(url), headers: refusalHeaders(res.headers, this.env), refusal: 'escalated',
            });
        }
        return new RateLimitedError(`${rateLimit.publicHostName(host)} rate-limited us (HTTP ${res.status}, ${sig.signal}) — not a refusal; not retried,`
            + ` backing off until ${entry.until}`, {
            status: res.status, url: redactUrl(url), host, signal: sig.signal, retryAt: Date.parse(entry.until),
            headers: refusalHeaders(res.headers, this.env),
        });
    }

    /** The refusal for a bot wall (a challenge page or marker, at any status): never retried, never a rate limit. */
    wallError(url, res) {
        return new AccessDeniedError(`${rateLimit.publicHostName(hostnameOf(url))} refused access (HTTP ${res.status}, bot wall) — not retried, not worked around`,
            { status: res.status, url: redactUrl(url), headers: refusalHeaders(res.headers, this.env), refusal: 'bot_wall' });
    }

    /**
     * Grumpy #7: a 5xx whose Retry-After is too long to wait in-run (withRetries)
     * holds the host (signal retry_after_5xx — never a rate limit: no streak,
     * 1 h cap) so the next poll, or a restarted worker, does not ask before the
     * source's time either. Shared by request() and robots.txt (Copilot review).
     * @param {string} hostname  the host that answered
     * @param {{ status: number, headers: object }} res
     * @param {string} firstHost the host first asked (a redirect's hold is also its)
     * @returns {object|null} the hold entry, or null when the response names no long time
     */
    hold5xx(hostname, res, firstHost) {
        const now = this.now();
        const ra = rateLimit.parseRetryAfter(res.headers, now);
        if (ra === null || ra <= MAX_IN_RUN_WAIT_MS) return null;
        const { entry } = this.recordHold(hostname, { retryAt: now + ra, status: res.status, signal: 'retry_after_5xx', weak: false });
        if (firstHost !== hostname) this.holdAlso(firstHost, entry);
        return entry;
    }

    /**
     * Copilot review: a robots.txt response goes through the same response
     * state as any request — a RATE LIMIT holds the host (thrown, never
     * cached as "unreachable" or read as "allow all"), a BOT WALL is a
     * refusal (never worked around), and a success ends the host's streak.
     * RobotsPolicy rethrows both errors uncached. A plain 4xx without either
     * still means "allow all" (RFC 9309).
     */
    classifyRobots(url, res, firstHost = null) {
        const host = hostnameOf(url);
        if (res.status === 429 || res.status === 403) {
            const limited = this.rateLimitError(url, res);
            if (limited) throw limited;
        }
        // Copilot review: whatever the status — a 2xx bot-wall page is not a
        // robots policy (parsing it as allow-all would then request the page). A 2xx
        // is a wall only as a small HTML page (isWallPage: a robots.txt that merely
        // names a vendor is rules, not a wall); from 3xx up the body test applies as before.
        if (res.status >= 200 && res.status < 300 ? isWallPage(res) : isChallenge(res)) {
            throw new AccessDeniedError(`${rateLimit.publicHostName(host)} refused access (HTTP ${res.status}, bot wall on robots.txt) — not retried, not worked around`,
                { status: res.status, url: redactUrl(url), headers: refusalHeaders(res.headers, this.env), refusal: 'bot_wall' });
        }
        // Security review P1 (ADR 0001 ruling 5): a 401 / 403 / 451 on robots.txt is
        // the source saying no — a refusal, never "no rules" (that would then ask
        // for the page itself). A 404 / 410 still means "no robots.txt" (RFC 9309).
        if (REFUSAL_STATUSES.includes(res.status)) {
            throw new AccessDeniedError(`${rateLimit.publicHostName(host)} refused access (HTTP ${res.status}, robots.txt) — not retried, not worked around`,
                { status: res.status, url: redactUrl(url), headers: refusalHeaders(res.headers, this.env) });
        }
        // A success ends the streak of every host the request touched: the one
        // that answered and the one robots.txt was first asked of (request() does
        // the same for a page).
        if (res.status >= 200 && res.status < 300) {
            this.clearHold(host);
            if (firstHost && firstHost !== host) this.clearHold(firstHost);
        }
    }

    /**
     * robots.txt itself: follows up to 5 redirects (RFC 9309 §2.3.1.2 — they
     * may cross authorities; no credential is ever sent). Every hop is
     * checked: https, public host (F10-2). Capped at 500 KiB (F10-4).
     */
    async fetchRobots(url) {
        let current = url;
        const firstHost = hostnameOf(url);
        // Copilot review: a rate limit (or a hold) met on a redirect target
        // also holds the host robots.txt was asked of, as request() does for
        // a redirected page — the target need not be one of the source's
        // hosts, so its hold alone would never be saved.
        const aliasHold = (err, at) => {
            const h = hostnameOf(at);
            const entry = h !== firstHost ? this.holdEntryOf(h) : null;
            if ((err instanceof RateLimitedError || err instanceof AccessDeniedError || (err && err.held === true)) && entry) this.holdAlso(firstHost, entry);
            return err;
        };
        for (let hop = 0; hop < 5; hop++) {
            checkUrl(current);
            let res;
            try {
                res = await this.raw(current, { headers: {}, maxBytes: ROBOTS_MAX_BYTES }, 0);
            } catch (err) {
                // Copilot review: an undecodable robots.txt is classified like
                // any response from its headers (the body cannot be read).
                if (!(err && err.decode && Number.isInteger(err.status))) throw aliasHold(err, current);
                try {
                    this.classifyRobots(current, { status: err.status, headers: err.headers || {}, body: '' }, firstHost);
                } catch (cerr) {
                    throw aliasHold(cerr, current);
                }
                // An undecodable 5xx robots.txt with a long Retry-After holds the host too.
                if (err.status >= 500) this.hold5xx(hostnameOf(current), { status: err.status, headers: err.headers || {} }, firstHost);
                throw err;
            }
            try {
                this.classifyRobots(current, res, firstHost);
            } catch (err) {
                throw aliasHold(err, current);
            }
            // Copilot review: a 5xx robots.txt with a long Retry-After holds the
            // host as a page's 5xx does (it stays a server failure: the policy
            // reads it as unreachable, not as a rate limit).
            if (res.status >= 500) this.hold5xx(hostnameOf(current), res, firstHost);
            if (!REDIRECTS.includes(res.status) || !res.headers.location) return res;
            current = new URL(res.headers.location, current).toString();
            if (CHALLENGE_LOCATION_RE.test(current)) throw this.wallError(current, res);
        }
        return { status: 508, headers: {}, body: '' };
    }

    /** Throw when the run's deadline has passed (never retried). */
    checkDeadline() {
        if (this.signal && this.signal.aborted) {
            throw new HttpError('collection deadline reached — the rest of this run is skipped', { kind: 'deadline' });
        }
    }

    /** One transport call with UA + timeout (no retries, no robots). */
    async raw(url, { method = 'GET', headers = {}, body, maxBytes }, minIntervalMs = 0) {
        const u = checkUrl(url);
        this.checkDeadline();
        // Security F5: the one place every transport call passes — a held
        // host is never sent anything (redirect hops, robots.txt and its
        // redirects, the governance terms fetch included).
        const held = this.heldError(rateLimit.normHost(u.hostname), url);
        if (held) throw held;
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
        // PR #44: the host the route asked for — held too when a redirect
        // target holds (holdAlso), cleared too by a success through it.
        const firstHost = hostnameOf(url);
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
            // Diagnosis 2026-10-01: a host that rate-limited us is not asked
            // again (not even for robots.txt) until its time has passed.
            const uh = rateLimit.normHost(u.hostname);
            const held = this.heldError(uh, current);
            if (held) {
                // A redirect into a host that is already backing off holds the host
                // the route asked for too (grumpy 8): a fresh client then sends
                // nothing at all — not even the first hop.
                if (firstHost !== uh) this.holdAlso(firstHost, this.holdEntryOf(uh));
                throw held;
            }
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
            // Copilot review: a bot wall is a refusal at any status — checked BEFORE a
            // redirect is followed (a 301/302 carrying cf-mitigated: challenge, or a
            // challenge page, is the source saying no, never a hop to follow). A 2xx is
            // a wall when it is a small HTML page matching a challenge page (isWallPage;
            // a JSON / feed payload that mentions a vendor is content), and — security
            // review F2 — it is checked BEFORE a success clears the host's streaks. A
            // redirect INTO a challenge-platform URL is the wall too.
            if (res.status !== 304 && (challengeHeader(res.headers) || (res.status >= 300 && isChallenge(res))
                || (res.status >= 200 && res.status < 300 && isWallPage(res))
                || (REDIRECTS.includes(res.status) && CHALLENGE_LOCATION_RE.test(String(res.headers.location || ''))))) {
                throw this.wallError(current, res);
            }
            if (REDIRECTS.includes(res.status) && res.headers.location) {
                current = new URL(res.headers.location, current).toString();
                if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
                    method = 'GET';
                    body = undefined;
                }
                continue;
            }
            if (res.status === 304) {
                this.clearHold(uh);
                if (firstHost !== uh) this.clearHold(firstHost);
                return { ...res, notModified: true, url: current };
            }
            // Checked BEFORE the refusal statuses: a 403 with positive
            // rate-limit evidence is not a refusal (a bot wall still is; the
            // 5th body-only one is one again — rateLimitError).
            const limited = this.rateLimitError(current, res);
            if (limited) {
                if (firstHost !== uh) this.holdAlso(firstHost, this.holdEntryOf(uh));
                throw limited;
            }
            if (REFUSAL_STATUSES.includes(res.status) || (res.status >= 400 && isChallenge(res)) || challengeHeader(res.headers)) {
                throw new AccessDeniedError(`${rateLimit.publicHostName(hostnameOf(current))} refused access (HTTP ${res.status}) — not retried, not worked around`,
                    { status: res.status, url: redactUrl(current), headers: refusalHeaders(res.headers, this.env) });
            }
            if (res.status < 200 || res.status >= 300) {
                // Grumpy #7: a 5xx whose Retry-After was too long to wait
                // in-run (withRetries) holds the host until then, so the
                // next poll does not ask before the source's time either.
                const extra = {};
                const entry = res.status >= 500 ? this.hold5xx(uh, res, firstHost) : null;
                if (entry) Object.assign(extra, { host: uh, retryAt: Date.parse(entry.until) });
                throw new HttpError(`HTTP ${res.status} from ${redactUrl(current)}`, { status: res.status, url: redactUrl(current), ...extra });
            }
            this.clearHold(uh);
            if (firstHost !== uh) this.clearHold(firstHost);
            if (o.cache && method === 'GET' && (res.headers.etag || res.headers['last-modified'])) {
                // Security review P2: bounded — the oldest validators go first.
                if (!Object.prototype.hasOwnProperty.call(o.cache, current)) {
                    const keys = Object.keys(o.cache);
                    for (const k of keys.slice(0, Math.max(0, keys.length - VALIDATOR_CACHE_MAX + 1))) delete o.cache[k];
                }
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
                // Grumpy 1: a hold set while this request was between attempts (a
                // concurrent request of the client), a rate limit or a refusal is the
                // answer — never retried, never wrapped into a plain failure.
                if (err && (err.held === true || err instanceof RateLimitedError || err instanceof AccessDeniedError)) throw err;
                // Diagnosis 2026-10-01: an undecodable 429, or 403 whose
                // HEADERS prove a rate limit (x-ratelimit-remaining 0 — the
                // body cannot be checked), is handed back to request() as a
                // bodiless response, which classifies it as a rate limit.
                // Security F6: never with cf-mitigated: challenge.
                if (err && err.decode && (err.status === 429 || err.status === 403)
                    && rateLimit.rateLimitSignal({ status: err.status, headers: err.headers, body: '' }, this.now())) {
                    return { status: err.status, headers: err.headers || {}, body: '' };
                }
                // Security review H1 / grumpy #1: a 401 / 403 / 451 whose body
                // cannot be decoded (a WAF page mislabelled gzip) is still the
                // source saying no — a refusal, never a parse error. So is
                // any 4xx that Cloudflare marks as a challenge (F6).
                if (err && err.decode && (REFUSAL_STATUSES.includes(err.status)
                    || challengeHeader(err.headers))) {
                    throw new AccessDeniedError(`${rateLimit.publicHostName(hostnameOf(url))} refused access (HTTP ${err.status}; body undecodable) — not retried, not worked around`,
                        { status: err.status, url: redactUrl(url), headers: refusalHeaders(err.headers, this.env),
                            ...(challengeHeader(err.headers) ? { refusal: 'bot_wall' } : {}) });
                }
                // Grumpy 14: an undecodable 5xx is a 5xx — handed back bodiless so
                // request() holds the host for a long Retry-After like any other.
                if (err && err.decode && Number.isInteger(err.status) && err.status >= 500) {
                    return { status: err.status, headers: err.headers || {}, body: '' };
                }
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
            if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES && !isChallenge(res)) {
                // Diagnosis 2026-10-01: never before the source's time. A
                // 429 whose limit is spent waits for x-ratelimit-reset too;
                // a wait longer than MAX_IN_RUN_WAIT_MS is not slept — the
                // response goes back to request() (a 429 → the backoff).
                const now = this.now();
                const sig = res.status === 429 ? rateLimit.rateLimitSignal(res, now) : null;
                const wait = sig && sig.retryAt !== null ? Math.max(0, sig.retryAt - now) : retryAfterMs(res.headers, attempt, now);
                if (wait <= MAX_IN_RUN_WAIT_MS) {
                    await this.sleep(wait);
                    continue;
                }
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
    REFUSAL_HEADER_ALLOWLIST, refusalHeaders, isDeterministic, NO_RETRY_CODES, MAX_IN_RUN_WAIT_MS,
};
