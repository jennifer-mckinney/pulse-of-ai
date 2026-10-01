// src/collectors/rate-limit.js
// Rate limits are NOT refusals (diagnosis 2026-10-01: a single GitHub search
// 403 — JSON body, server Varnish, 1 in ~724 requests, the same bucket
// answering 200 6.5 s later — was escalated as a refusal: 1 h cooldown of
// the whole source, the unaffected github.blog RSS route paused too,
// probation, a critical alert).
//
// What counts as a rate limit — POSITIVE evidence only (rateLimitSignal),
// and fail closed (security review F2 / F6):
//   HTTP 429                                     'http_429'                  strong
//   403 with x-ratelimit-remaining: 0            'ratelimit_remaining_zero'  strong
//   403 whose JSON body `message` STARTS WITH    'body_rate_limit'           WEAK
//       GitHub's own wording ("API rate limit exceeded", "You have exceeded
//       a secondary rate limit", "You have triggered an abuse detection
//       mechanism"). The body is matched, NEVER stored or quoted (F10-13).
// Retry-After never classifies a 403 on its own (F2): it only LENGTHENS the
// hold of a response already classified. A bot wall (a challenge page, or
// Cloudflare's `cf-mitigated: challenge` header — F6) is never a rate limit.
// A 401, a 451 and any 403 without the evidence above stay refusals
// (AccessDeniedError, ADR 0001 ruling 5).
//
// The hold (honoured, never worked around), per HOST (hostname):
//   until  = the LATER of the source's time (Retry-After; x-ratelimit-reset
//            when the primary limit is spent) and a floor of 60 s doubling
//            with each consecutive rate limit of the host (60, 120, 240 s …
//            — security F1), capped at 24 h. An overflowing or non-finite
//            time is the cap (F4).
//   count  = consecutive rate limits of the host; `weak` = consecutive WEAK
//            ones. Only a successful response from the host resets them.
//   escalation: ESCALATE_AFTER consecutive weak rate limits are a REFUSAL
//            (the caller throws AccessDeniedError) — a real block that only
//            looks like a rate limit is not polled forever (F1, fail closed).
//   scope  = one map per HTTP client, keyed by hostname, checked before EVERY
//            transport call (src/collectors/http.js raw(): redirect hops,
//            robots.txt, the governance terms fetch, every source on the
//            host — F5). Persisted per source in
//            source_collection_state.rate_limited_hosts (migration 075),
//            with the routes they hold (rate_limited_routes) computed by the
//            worker, which sees the real env (grumpy #2).
//   never: a refusal count, probation or a critical alert. Persistent
//            throttling opens the WARNING 'source_rate_limited' (a host
//            limited WARN_AFTER times in a row, src/collectors/source-health.js).
//
// In-run retries (http.js withRetries): a 429 is retried inside the run only
// when the source's wait is at most MAX_IN_RUN_WAIT_MS, and never before it;
// a longer (or unparseable-overflow) wait ends the request and becomes the
// hold instead of a sleep.

'use strict';

const { isChallenge } = require('./challenge');

const MIN_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
const MAX_IN_RUN_WAIT_MS = 60 * 1000;
// Security F1: consecutive weak (body-only) rate limits of one host before
// the next one is treated as the refusal it may really be.
const ESCALATE_AFTER = 5;
// Grumpy #5: consecutive rate limits of one host before the source_rate_limited
// warning opens (a run whose other routes succeed never fails, so
// consecutive_failures cannot see this).
const WARN_AFTER = 3;
// A streak whose last hold ended this long ago is forgotten.
const STALE_MS = 7 * 24 * 60 * 60 * 1000;
const STREAK_MAX = 1000;
const RATE_LIMITED = 'rate_limited';
const SIGNALS = Object.freeze(['http_429', 'ratelimit_remaining_zero', 'body_rate_limit', 'retry_after_5xx']);
const WEAK_SIGNALS = Object.freeze(['body_rate_limit']);
// Shown on /api/sources instead of a host that came from the env (a contract
// feed URL — security F3).
const CONFIGURED_HOST = 'configured host';

// GitHub's rate-limit wording, ANCHORED at the start of the JSON `message`
// (security F2: "banned for rate limit abuse" must not match).
const BODY_RE = /^(API rate limit exceeded|You have exceeded a secondary rate limit|You have triggered an abuse detection mechanism)\b/;
// Bodies larger than this are not parsed for the message.
const BODY_PARSE_MAX = 64 * 1024;
// x-ratelimit-reset magnitudes: epoch milliseconds, epoch seconds, else
// seconds until the reset (Reddit, src/collectors/reddit/budget.js).
const EPOCH_MS_MIN = 1e12;
const EPOCH_SECONDS_MIN = 1e9;
const HOST_MAX = 253;
// RFC 9110 §5.6.7 IMF-fixdate, the only HTTP-date form accepted.
const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;
const DECIMAL = /^[+]?(\d+\.?\d*|\.\d+)(e[+]?\d+)?$/i;

const header = (headers, name) => {
    const v = headers ? headers[name] : undefined;
    if (v === undefined || v === null) return null;
    const s = String(Array.isArray(v) ? v[0] : v);
    return s === '' ? null : s;
};

/**
 * A delay in seconds as ms: Infinity when it overflows (security F4: an
 * absurd time is honoured as the cap, never as "none").
 */
const secondsToMs = sec => {
    const ms = sec * 1000;
    return Number.isFinite(ms) ? ms : Infinity;
};

/**
 * Retry-After as a delay from `now` in ms (security F2: strict).
 *   delay-seconds  /^\d+$/ and > 0
 *   HTTP-date      IMF-fixdate only, in the future
 *   overflow       a decimal number too large to honour (1e306, 400 digits)
 *                  → Infinity (F4: the 24 h cap, never "no time")
 * Anything else (0, negative, hex, fractions, past dates, padding, garbage)
 * → null: no time given.
 */
function parseRetryAfter(headers, now = Date.now()) {
    const v = header(headers, 'retry-after');
    if (v === null) return null;
    if (/^\d+$/.test(v)) {
        const ms = secondsToMs(Number(v));
        return ms > 0 ? ms : null;
    }
    if (IMF_FIXDATE.test(v)) {
        const ms = Date.parse(v) - now;
        return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    // Not strict delay-seconds, but a number beyond the cap (1e306): the
    // cap, never an early retry (F4).
    if (DECIMAL.test(v) && secondsToMs(Number(v)) > MAX_BACKOFF_MS) return Infinity;
    return null;
}

/**
 * x-ratelimit-reset as an instant (epoch ms): epoch milliseconds (grumpy #4),
 * epoch seconds (GitHub) or seconds until the reset (Reddit), told apart by
 * magnitude. Infinity when it overflows (F4); null when absent, negative or
 * unparseable.
 */
function parseReset(value, now = Date.now()) {
    if (value === undefined || value === null) return null;
    const s = String(value).trim();
    if (s === '' || !DECIMAL.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || !Number.isFinite(n * 1000)) return Infinity;
    if (n >= EPOCH_MS_MIN) return n;
    if (n >= EPOCH_SECONDS_MIN) return n * 1000;
    return now + n * 1000;
}

/** Whether a JSON error body's `message` is GitHub's rate-limit wording (never stored). */
function bodyNamesRateLimit(body) {
    if (typeof body !== 'string' || body.length === 0 || body.length > BODY_PARSE_MAX) return false;
    let data;
    try {
        data = JSON.parse(body);
    } catch {
        return false;
    }
    return !!data && typeof data === 'object' && typeof data.message === 'string' && BODY_RE.test(data.message);
}

/**
 * Whether a final response is a rate limit, on positive evidence only.
 * @param {{ status: number, headers?: object, body?: string }} res
 * @returns {{ signal: string, retryAt: number|null, weak: boolean }|null}
 *          retryAt: the source's own time (epoch ms; Infinity = beyond the
 *          cap) or null when it gave none
 */
function rateLimitSignal(res, now = Date.now()) {
    if (!res || (res.status !== 429 && res.status !== 403)) return null;
    // A bot-wall challenge is a refusal whatever else the response says (F6).
    if (isChallenge(res)) return null;
    const headers = res.headers || {};
    const remaining = header(headers, 'x-ratelimit-remaining');
    const spent = remaining !== null && DECIMAL.test(remaining.trim()) && Number(remaining) === 0;
    let signal = null;
    if (res.status === 429) signal = 'http_429';
    else if (spent) signal = 'ratelimit_remaining_zero';
    else if (bodyNamesRateLimit(res.body)) signal = 'body_rate_limit';
    if (!signal) return null;
    // Never earlier than any time the source named (Retry-After only
    // lengthens a classified hold — F2).
    const times = [];
    const retryAfter = parseRetryAfter(headers, now);
    if (retryAfter !== null) times.push(now + retryAfter);
    if (spent) {
        const reset = parseReset(header(headers, 'x-ratelimit-reset'), now);
        if (reset !== null) times.push(reset);
    }
    return { signal, retryAt: times.length ? Math.max(...times) : null, weak: WEAK_SIGNALS.includes(signal) };
}

/**
 * The end of a hold: the source's time, at least the floor for the host's
 * `count`-th consecutive rate limit (60 s × 2^(count-1)) and at most 24 h
 * from now. retryAt Infinity is the cap (F4); a non-number is "no time".
 */
function backoffUntil(retryAt, now = Date.now(), count = 1) {
    const n = Math.max(1, Math.min(Number.isInteger(count) ? count : 1, 40));
    const floor = now + Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** (n - 1));
    const t = retryAt === Infinity ? now + MAX_BACKOFF_MS : (Number.isFinite(retryAt) ? retryAt : now);
    return Math.min(now + MAX_BACKOFF_MS, Math.max(floor, t));
}

const validHost = h => typeof h === 'string' && h.length > 0 && h.length <= HOST_MAX && /^[a-z0-9.:[\]-]+$/i.test(h);
const streak = v => (Number.isInteger(v) && v >= 0 ? Math.min(v, STREAK_MAX) : 0);

/**
 * Stored holds, sanitised: { host: { until (ISO), http_status, signal, count,
 * weak } }. Expired holds are KEPT (their streak counts until a success
 * resets it) unless they ended more than STALE_MS ago; malformed entries
 * and invalid hosts are dropped.
 */
function sanitizeHolds(stored, now = Date.now()) {
    const out = {};
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return out;
    for (const [rawHost, h] of Object.entries(stored)) {
        const host = String(rawHost).toLowerCase();
        if (!validHost(host) || !h || typeof h !== 'object') continue;
        const until = Date.parse(h.until);
        if (!Number.isFinite(until) || until <= now - STALE_MS) continue;
        out[host] = {
            until: new Date(until).toISOString(),
            http_status: Number.isInteger(h.http_status) ? h.http_status : null,
            signal: SIGNALS.includes(h.signal) ? h.signal : null,
            count: Math.max(1, streak(h.count)),
            weak: streak(h.weak),
        };
    }
    return out;
}

/** The holds still in force (until > now), sanitised. */
function activeHolds(stored, now = Date.now()) {
    const all = sanitizeHolds(stored, now);
    return Object.fromEntries(Object.entries(all).filter(([, h]) => Date.parse(h.until) > now));
}

/**
 * The next hold of a host after a rate limit (security F1).
 * @param {object|null} prev  the host's current entry (active or expired)
 * @param {{ retryAt, status, signal, weak }} sig
 * @returns {{ entry: object, escalate: boolean }} escalate: this is the
 *          ESCALATE_AFTER-th consecutive weak rate limit — treat it as a refusal
 */
function nextHold(prev, { retryAt = null, status = null, signal = null, weak = false }, now = Date.now()) {
    const count = Math.min(STREAK_MAX, (prev ? streak(prev.count) : 0) + 1);
    const weakCount = weak ? Math.min(STREAK_MAX, (prev ? streak(prev.weak) : 0) + 1) : 0;
    let until = backoffUntil(retryAt, now, count);
    // A later hold already in force is never shortened.
    const prevUntil = prev ? Date.parse(prev.until) : NaN;
    if (Number.isFinite(prevUntil) && prevUntil > until) until = prevUntil;
    return {
        entry: { until: new Date(until).toISOString(), http_status: status, signal: SIGNALS.includes(signal) ? signal : null, count, weak: weakCount },
        escalate: weak && weakCount >= ESCALATE_AFTER,
    };
}

/** Merge `source` holds into `target` per host: the later until, the longer streaks. */
function mergeHolds(target, source, now = Date.now()) {
    for (const [host, h] of Object.entries(sanitizeHolds(source, now))) {
        const t = target[host];
        if (!t) { target[host] = h; continue; }
        const later = Date.parse(h.until) > Date.parse(t.until) ? h : t;
        target[host] = { ...later, count: Math.max(streak(t.count), h.count), weak: Math.max(streak(t.weak), h.weak) };
    }
    return target;
}

/** The active hold of a host (hostname), or null. @returns {{ until: number, http_status, signal }|null} */
function heldUntil(holds, host, now = Date.now()) {
    if (!holds || typeof host !== 'string') return null;
    const h = holds[host.toLowerCase()];
    const until = h ? Date.parse(h.until) : NaN;
    return Number.isFinite(until) && until > now ? { until, http_status: h.http_status, signal: h.signal } : null;
}

// The hosts a route's REQUESTS go to, when narrower than the hosts it may
// contact (grumpy #2): Reddit's www.reddit.com is only its token host, and
// Reuters Connect's auth host only issues tokens.
const REQUEST_HOSTS = Object.freeze({
    reddit: () => ['oauth.reddit.com'],
    'reuters-connect': (route, env, allowed) => {
        const { hostOf } = module.exports;
        const h = hostOf(env && env.REUTERS_CONNECT_API_URL);
        return h ? [h] : allowed.filter(x => x === 'api.reutersconnect.com');
    },
});

const hostOf = (u) => {
    try {
        return typeof u === 'string' && u.trim() ? new URL(u.trim()).hostname.toLowerCase() : null;
    } catch {
        return null;
    }
};

/** The hosts whose holds stop a route (all of them must be held). */
function routeRequestHosts(route, env) {
    const { routeAllowedHosts } = require('../config/source-registry');
    const allowed = routeAllowedHosts(route, env);
    const narrow = REQUEST_HOSTS[route.adapter];
    return narrow ? narrow(route, env, allowed) : allowed;
}

/** Every host any route of a source may contact (its holds are stored on the source). */
function sourceHosts(src, env) {
    const { routeAllowedHosts } = require('../config/source-registry');
    return [...new Set(src.routes.flatMap(r => routeAllowedHosts(r, env)))].sort();
}

/** The time a route is held until (ISO; the EARLIEST of its hosts' holds), or null. */
function routeHeldUntil(route, env, holds, now = Date.now()) {
    const hosts = routeRequestHosts(route, env);
    if (!hosts.length) return null;
    let min = Infinity;
    for (const h of hosts) {
        const hold = heldUntil(holds, h, now);
        if (!hold) return null;
        min = Math.min(min, hold.until);
    }
    return new Date(min).toISOString();
}

/** A route is held when it has request hosts and every one of them is held. */
function routeHeld(route, env, holds, now = Date.now()) {
    return routeHeldUntil(route, env, holds, now) !== null;
}

/** The public reason of a hold: routes and enums only, never a host (F3). */
function holdReason(state, routes, until) {
    const ids = Object.keys(routes);
    return `backing off after a rate limit until ${until}: routes held: ${ids.join(', ')}`
        + (state === 'partial' ? ' (the source\'s other routes keep collecting)' : '')
        + ' — honouring x-ratelimit-reset / Retry-After; not a refusal';
}

/**
 * The rate-limit gate of a source: which of its OPEN routes its active holds
 * stop (computed by the worker, which sees the real env).
 * @returns {{ state: 'none'|'partial'|'all', until: string|null, next: string|null,
 *             routes: { [routeId]: string }, reason: string|null }}
 *   until: when the LAST held route frees (ISO); next: the FIRST
 */
function holdGate(src, env, holds, now = Date.now()) {
    const { openRoutes } = require('../config/source-registry');
    const routes = openRoutes(src, env);
    const held = {};
    for (const r of routes) {
        const t = routeHeldUntil(r, env, holds, now);
        if (t) held[r.id] = t;
    }
    const times = Object.values(held).sort();
    if (!times.length) return { state: 'none', until: null, next: null, routes: {}, reason: null };
    const state = times.length === routes.length ? 'all' : 'partial';
    const until = times[times.length - 1];
    return { state, until, next: times[0], routes: held, reason: holdReason(state, held, until) };
}

/**
 * The hosts of a source's active holds as /api/sources may publish them
 * (security F3): a host the REGISTRY names (env-free) is served; any other
 * (from a contract feed URL in the env) is CONFIGURED_HOST.
 * @returns {Array<{ host, until, http_status, signal, count }>}
 */
function publicHosts(src, holds, now = Date.now()) {
    const { routeAllowedHosts } = require('../config/source-registry');
    const registry = new Set(src.routes.flatMap(r => routeAllowedHosts(r, {})));
    return Object.entries(activeHolds(holds, now))
        .map(([host, h]) => ({ host: registry.has(host) ? host : CONFIGURED_HOST, until: h.until, http_status: h.http_status, signal: h.signal, count: h.count }))
        .sort((a, b) => a.host.localeCompare(b.host) || a.until.localeCompare(b.until));
}

module.exports = {
    MIN_BACKOFF_MS, MAX_BACKOFF_MS, MAX_IN_RUN_WAIT_MS, ESCALATE_AFTER, WARN_AFTER, STALE_MS, RATE_LIMITED, SIGNALS,
    WEAK_SIGNALS, CONFIGURED_HOST, BODY_RE,
    parseRetryAfter, parseReset, bodyNamesRateLimit, rateLimitSignal, backoffUntil,
    sanitizeHolds, activeHolds, nextHold, mergeHolds, heldUntil, hostOf,
    routeRequestHosts, sourceHosts, routeHeldUntil, routeHeld, holdGate, holdReason, publicHosts,
};
