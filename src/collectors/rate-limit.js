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
//   403 from api.github.com whose JSON body      'body_rate_limit'           WEAK
//       `message` STARTS WITH GitHub's own wording ("API rate limit
//       exceeded", "You have exceeded a secondary rate limit", "You have
//       triggered an abuse detection mechanism"). From any other host the
//       wording is no evidence (BODY_HOSTS). The body is matched, NEVER
//       stored or quoted (F10-13).
//   the same WITH a strictly parsed Retry-After  'body_rate_limit_retry_after' strong
//       (GitHub's documented secondary-limit response — two independent
//       signals; grumpy re-review N1, agreed by the security review)
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
// when the source's wait is at most MAX_IN_RUN_WAIT_MS (10 s), and never
// before it; a longer (or unparseable-overflow) wait ends the request and
// becomes the hold instead of a sleep.
//
// TLDR (diagnosis 2026-10-01, PR #44, unified here in the PR #45 merge):
// tldr.tech answered the poll with HTTP 429 and a Retry-After of a minute or
// more; a 60 s in-run wait slept twice overran the scheduled run's deadline
// (half the collection window), hiding the 429 as 'deadline'. That is now a
// case of this classifier: 429 → 'http_429' → a host hold until the
// source's time, persisted in source_collection_state.rate_limited_hosts
// (never in the rolled-back HTTP cache), so a restarted worker or another
// replica honours it. A 429 that names NO time holds at least
// NO_TIME_429_HOLD_MS (PR #44's default: two cadence ticks). PR #44 kept its
// holds as `retry-after:<host>` keys in http_cache; legacyHolds() folds any
// such key into this store (migration 077 moved the stored ones).

'use strict';

const { isChallenge } = require('./challenge');

const MIN_BACKOFF_MS = 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
// PR #44 (TLDR): the longest wait slept INSIDE a run. Two waits plus three
// requests stay well inside the scheduled run's deadline (half the
// collection window); a longer wait is a hold, never a sleep.
const MAX_IN_RUN_WAIT_MS = 10 * 1000;
// PR #44: a 429 that names no time (no Retry-After, no x-ratelimit-reset)
// holds the host at least this long — two cadence ticks (2 × 150 s).
const NO_TIME_429_HOLD_MS = 5 * 60 * 1000;
// PR #44's persisted hold keys in source_collection_state.http_cache
// ({ until: ISO, status: 429 | 503 }), folded into this store (legacyHolds).
const LEGACY_HOLD_PREFIX = 'retry-after:';
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
const SIGNALS = Object.freeze(['http_429', 'ratelimit_remaining_zero', 'body_rate_limit', 'body_rate_limit_retry_after', 'retry_after_5xx']);
const WEAK_SIGNALS = Object.freeze(['body_rate_limit']);
// GitHub's rate-limit wording is evidence only from GitHub's API host
// (security re-review of N1): from any other host it is not a rate limit.
const BODY_HOSTS = Object.freeze(['api.github.com']);
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
        // Copilot review: the shape is not enough — Date.parse rolls 31 Feb
        // into March and ignores a wrong weekday. Only a date that formats
        // back to exactly the same string is a real one.
        const t = Date.parse(v);
        if (!Number.isFinite(t) || new Date(t).toUTCString() !== v) return null;
        const ms = t - now;
        return ms > 0 ? ms : null;
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
 * @param {number} [now]
 * @param {string} [host]  the FINAL response's hostname: GitHub's wording
 *        counts only from api.github.com (BODY_HOSTS); without a host the
 *        body is no evidence at all (fail closed)
 * @returns {{ signal: string, retryAt: number|null, weak: boolean }|null}
 *          retryAt: the source's own time (epoch ms; Infinity = beyond the
 *          cap) or null when it gave none
 */
function rateLimitSignal(res, now = Date.now(), host = null) {
    if (!res || (res.status !== 429 && res.status !== 403)) return null;
    // A bot-wall challenge is a refusal whatever else the response says (F6).
    if (isChallenge(res)) return null;
    const headers = res.headers || {};
    const remaining = header(headers, 'x-ratelimit-remaining');
    const spent = remaining !== null && DECIMAL.test(remaining.trim()) && Number(remaining) === 0;
    const retryAfter = parseRetryAfter(headers, now);
    const bodyHost = typeof host === 'string' && BODY_HOSTS.includes(host.toLowerCase());
    let signal = null;
    if (res.status === 429) signal = 'http_429';
    else if (spent) signal = 'ratelimit_remaining_zero';
    else if (bodyHost && bodyNamesRateLimit(res.body)) {
        // N1 (grumpy re-review; security agreed): GitHub's documented
        // secondary-limit response — its wording AND a strictly parsed
        // Retry-After — is two independent signals: strong, never escalated
        // (the doubling floor still bounds it). The wording alone is weak.
        signal = retryAfter !== null ? 'body_rate_limit_retry_after' : 'body_rate_limit';
    }
    if (!signal) return null;
    // Never earlier than any time the source named (Retry-After only
    // lengthens a classified hold — F2).
    const times = [];
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
        // `at`: when the hold was recorded — the NEWEST record of a host wins
        // a merge (Copilot review: never a fieldwise maximum, which would
        // resurrect a weak streak a later strong limit reset). Legacy
        // entries without it read as recorded a minute before their until.
        const at = Date.parse(h.at);
        out[host] = {
            until: new Date(until).toISOString(),
            http_status: Number.isInteger(h.http_status) ? h.http_status : null,
            signal: SIGNALS.includes(h.signal) ? h.signal : null,
            // 0 only for a hold that was never a rate limit (a 5xx's
            // Retry-After — grumpy N4); a legacy entry without one is 1.
            count: h.count === undefined ? 1 : streak(h.count),
            weak: streak(h.weak),
            at: new Date(Number.isFinite(at) && at <= until ? at : until - MIN_BACKOFF_MS).toISOString(),
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
    // Grumpy N4 / Copilot: a 5xx's Retry-After holds the host but is not a
    // rate limit — it leaves both streaks as they were (no warning, no
    // doubling, no escalation from server errors).
    const notLimit = signal === 'retry_after_5xx';
    const prevCount = prev ? streak(prev.count) : 0;
    const prevWeak = prev ? streak(prev.weak) : 0;
    const count = notLimit ? prevCount : Math.min(STREAK_MAX, prevCount + 1);
    const weakCount = notLimit ? prevWeak : (weak ? Math.min(STREAK_MAX, prevWeak + 1) : 0);
    let until = backoffUntil(retryAt, now, notLimit ? 1 : count);
    // PR #44: a 429 without any time of the source's holds at least
    // NO_TIME_429_HOLD_MS (the doubling floor may already be longer).
    if (signal === 'http_429' && (retryAt === null || retryAt === undefined)) {
        until = Math.max(until, now + NO_TIME_429_HOLD_MS);
    }
    // A later hold already in force is never shortened.
    const prevUntil = prev ? Date.parse(prev.until) : NaN;
    if (Number.isFinite(prevUntil) && prevUntil > until) until = prevUntil;
    return {
        entry: { until: new Date(until).toISOString(), http_status: status, signal: SIGNALS.includes(signal) ? signal : null,
            count, weak: weakCount, at: new Date(now).toISOString() },
        escalate: !notLimit && weak && weakCount >= ESCALATE_AFTER,
    };
}

/**
 * Merge `source` holds into `target` per host: the NEWEST record (`at`)
 * gives the streaks and signal (Copilot review: a fieldwise maximum
 * resurrected a weak streak that a later strong limit had reset), but the
 * hold lasts until the LATEST until among the copies (security N6: a newer,
 * shorter record never frees a host before another copy's stated time).
 */
function mergeHolds(target, source, now = Date.now()) {
    for (const [host, h] of Object.entries(sanitizeHolds(source, now))) target[host] = combineHold(target[host], h);
    return target;
}

/**
 * Two records of one host's hold → one (the ONE rule for merging loads and
 * saves): the newest record (`at`) gives the streaks and signal; the hold
 * lasts until the latest until of the two (security N6).
 * @param {object|null} a  may lack `at` (then b is the newer)
 * @param {object} b       a sanitised record
 */
function combineHold(a, b) {
    if (!a) return b;
    const ta = Date.parse(a.at);
    const newest = !Number.isFinite(ta) || Date.parse(b.at) > ta ? b : a;
    const ua = Date.parse(a.until);
    const until = Math.max(Date.parse(b.until), Number.isFinite(ua) ? ua : -Infinity);
    return { ...newest, until: new Date(until).toISOString() };
}

/** The active hold of a host (hostname), or null. @returns {{ until: number, http_status, signal }|null} */
function heldUntil(holds, host, now = Date.now()) {
    if (!holds || typeof host !== 'string') return null;
    const h = holds[host.toLowerCase()];
    const until = h ? Date.parse(h.until) : NaN;
    return Number.isFinite(until) && until > now ? { until, http_status: h.http_status, signal: h.signal } : null;
}

// How a route's hosts combine (grumpy #2, Copilot review):
//   'all'  ALTERNATIVES (a multi-feed RSS route's feeds): the route is held
//          only when every host is, and frees when the FIRST frees.
//   'any'  PREREQUISITES (a token host + an API host): every host is needed,
//          so a hold on ANY of them holds the route, until the LAST frees.
const ROUTE_HOST_MODE = Object.freeze({
    reddit: 'any',              // www.reddit.com (token) + oauth.reddit.com (API)
    'reuters-connect': 'any',   // auth host (token) + API host
});

const hostOf = (u) => {
    try {
        return typeof u === 'string' && u.trim() ? new URL(u.trim()).hostname.toLowerCase() : null;
    } catch {
        return null;
    }
};

/** The hosts whose holds stop a route, and how they combine ('all' | 'any'). */
function routeRequestHosts(route, env) {
    const { routeAllowedHosts } = require('../config/source-registry');
    return { hosts: routeAllowedHosts(route, env), mode: ROUTE_HOST_MODE[route.adapter] || 'all' };
}

/** Every host any route of a source may contact (its holds are stored on the source). */
function sourceHosts(src, env) {
    const { routeAllowedHosts } = require('../config/source-registry');
    return [...new Set(src.routes.flatMap(r => routeAllowedHosts(r, env)))].sort();
}

/**
 * The time a route is held until (ISO), or null when it is not held:
 * 'all' — every host held, until the EARLIEST frees; 'any' — any host held,
 * until the LATEST frees.
 */
function routeHeldUntil(route, env, holds, now = Date.now()) {
    const { hosts, mode } = routeRequestHosts(route, env);
    if (!hosts.length) return null;
    const times = hosts.map(h => heldUntil(holds, h, now)).map(h => (h ? h.until : null));
    if (mode === 'any') {
        const held = times.filter(t => t !== null);
        return held.length ? new Date(Math.max(...held)).toISOString() : null;
    }
    return times.every(t => t !== null) ? new Date(Math.min(...times)).toISOString() : null;
}

/** Whether a route's hosts' holds stop it (routeHeldUntil). */
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
 * A source's stored holds WITHOUT its terms-page host (unless a route also
 * uses it): a throttled terms page (the governance snapshot) is held so it
 * is not asked early, but it is not the source being rate-limited — it never
 * shows on /api/sources, in rate_limited_until or in the warning (grumpy
 * re-review).
 */
function collectionHolds(src, holds) {
    const { routeAllowedHosts } = require('../config/source-registry');
    const terms = hostOf(src && src.termsUrl);
    if (!holds || typeof holds !== 'object' || !terms) return holds;
    const routeHosts = new Set(src.routes.flatMap(r => routeAllowedHosts(r, {})));
    if (routeHosts.has(terms)) return holds;
    return Object.fromEntries(Object.entries(holds).filter(([h]) => String(h).toLowerCase() !== terms));
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
    return Object.entries(activeHolds(collectionHolds(src, holds), now))
        .map(([host, h]) => ({ host: registry.has(host) ? host : CONFIGURED_HOST, until: h.until, http_status: h.http_status, signal: h.signal, count: h.count }))
        .sort((a, b) => a.host.localeCompare(b.host) || a.until.localeCompare(b.until));
}

/**
 * PR #44's holds, stored as `retry-after:<host>` keys ({ until, status }) in
 * a source's HTTP cache, as holds of this store — and the cache without
 * them. One hold store: the runner folds them in on claim (a worker of the
 * previous release may still write one during a rolling deploy; migration
 * 077 moved the stored ones). A key's host may carry a port (PR #44 keyed by
 * URL host): the hold is the hostname's. 429 → 'http_429' (count 1), 503 →
 * 'retry_after_5xx' (count 0 — not a rate limit, nextHold), recorded `at`
 * now. Expired keys are dropped from the cache and not kept.
 * @returns {{ holds: object, cache: object }} holds: sanitised; cache: a new object
 */
function legacyHolds(httpCache, now = Date.now()) {
    const holds = {};
    const cache = {};
    for (const [k, e] of Object.entries(httpCache && typeof httpCache === 'object' ? httpCache : {})) {
        if (!k.startsWith(LEGACY_HOLD_PREFIX)) { cache[k] = e; continue; }
        const host = hostOf(`https://${k.slice(LEGACY_HOLD_PREFIX.length)}/`);
        const until = Date.parse(e && e.until);
        if (!host || !Number.isFinite(until) || until <= now) continue;
        const status = e.status === 503 ? 503 : 429;
        const rec = sanitizeHolds({ [host]: {
            until: new Date(Math.min(until, now + MAX_BACKOFF_MS)).toISOString(), http_status: status,
            signal: status === 503 ? 'retry_after_5xx' : 'http_429', count: status === 503 ? 0 : 1, weak: 0,
            at: new Date(now).toISOString(),
        } }, now)[host];
        if (rec) holds[host] = combineHold(holds[host], rec);
    }
    return { holds, cache };
}

module.exports = {
    MIN_BACKOFF_MS, MAX_BACKOFF_MS, MAX_IN_RUN_WAIT_MS, NO_TIME_429_HOLD_MS, LEGACY_HOLD_PREFIX, ESCALATE_AFTER, WARN_AFTER, STALE_MS, RATE_LIMITED, SIGNALS,
    WEAK_SIGNALS, BODY_HOSTS, CONFIGURED_HOST, BODY_RE,
    parseRetryAfter, parseReset, bodyNamesRateLimit, rateLimitSignal, backoffUntil,
    sanitizeHolds, activeHolds, nextHold, mergeHolds, combineHold, collectionHolds, heldUntil, hostOf,
    routeRequestHosts, sourceHosts, routeHeldUntil, routeHeld, holdGate, holdReason, publicHosts, legacyHolds,
};
