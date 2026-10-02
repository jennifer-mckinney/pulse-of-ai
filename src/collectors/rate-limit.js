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
// Security review L3: a 403 with `x-ratelimit-remaining: 0` is a strong signal
// from ANY host (GitHub's body wording, by contrast, counts only from
// api.github.com and never escalates — N1), so a host that really refuses could add the header and never
// be treated as refusing (ADR 0001 ruling 5). A 403 counts as a spent limit
// only with a reset instant of the source's own that lies in the future and
// within 24 h (security review F1: the bare header proves nothing), and
// consecutive STRONG 403s (not 429s) of one host escalate too: by the 5th the
// doubling floor is far past any real window reset, and a success resets the
// streak.
const ESCALATE_STRONG_403_AFTER = 5;
// Security review F3: a refusing host may answer 429 for ever. Consecutive
// rate limits of one host of ANY kind with no success in between (by the 14th
// the doubling floor has sat at the 24 h cap for days) are a refusal too.
const ESCALATE_ANY_AFTER = 14;
// Grumpy #5: consecutive rate limits of one host before the source_rate_limited
// warning opens (a run whose other routes succeed never fails, so
// consecutive_failures cannot see this).
const WARN_AFTER = 3;
// Security review L4: a hold from a 5xx's Retry-After (not a rate limit) is
// capped lower than a rate limit's 24 h: any host that answers 5xx with a huge
// Retry-After would otherwise park every source on that host for a day.
const MAX_5XX_HOLD_MS = 60 * 60 * 1000;
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
// Security review F5: unambiguous alternatives (no backtracking), and a value
// longer than HEADER_NUMBER_MAX characters is never run through it.
const DECIMAL = /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+]?\d+)?$/i;
const HEADER_NUMBER_MAX = 512;

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
    if (v.length <= HEADER_NUMBER_MAX && DECIMAL.test(v) && secondsToMs(Number(v)) > MAX_BACKOFF_MS) return Infinity;
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
    if (s === '' || s.length > HEADER_NUMBER_MAX || !DECIMAL.test(s)) return null;
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
    const spent = remaining !== null && remaining.length <= HEADER_NUMBER_MAX && DECIMAL.test(remaining.trim()) && Number(remaining) === 0;
    const retryAfter = parseRetryAfter(headers, now);
    const bodyHost = typeof host === 'string' && BODY_HOSTS.includes(host.toLowerCase());
    // Security review F1: a 403 is a spent limit only with the source's own
    // reset instant, in the future and within the 24 h cap. The bare header
    // (any host can send it) proves nothing: without a reset the 403 is
    // judged on its body (GitHub's wording) or stays a refusal.
    const reset = spent ? parseReset(header(headers, 'x-ratelimit-reset'), now) : null;
    const resetPlausible = reset !== null && Number.isFinite(reset) && reset > now && reset <= now + MAX_BACKOFF_MS;
    let signal = null;
    if (res.status === 429) signal = 'http_429';
    else if (spent && resetPlausible) signal = 'ratelimit_remaining_zero';
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
    if (spent && reset !== null) times.push(reset);
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

/**
 * A hostname as a hold key (security review F4): lower case, no trailing dot
 * (`api.github.com.` is the same host to DNS and TLS).
 */
const normHost = h => String(h).trim().toLowerCase().replace(/\.+$/, '');

/**
 * Every key a host's hold may be stored under: the host itself and its
 * `www.` / bare twin — the source allow-list (netguard hostAllowed) ignores a
 * leading "www." both ways, so a hold on one is a hold on the other.
 */
function hostKeys(h) {
    const n = normHost(h);
    const bare = n.replace(/^www\./, '');
    return [...new Set([n, bare, `www.${bare}`])];
}

// A host has at least one dot (netguard refuses single-label names): that also
// keeps `constructor` / `toString` out of a plain-object map (security F6).
const validHost = h => typeof h === 'string' && h.length > 0 && h.length <= HOST_MAX && h.includes('.') && /^[a-z0-9.:[\]-]+$/i.test(h);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
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
        const host = normHost(rawHost);
        if (!validHost(host) || !h || typeof h !== 'object') continue;
        // Security review L5: a stored `until` is never read beyond the
        // 24 h cap (a poisoned or legacy row could hold a host for years) —
        // and a 5xx's Retry-After hold never beyond its own 1 h cap (grumpy 11).
        const rawUntil = Date.parse(h.until);
        if (!Number.isFinite(rawUntil) || rawUntil <= now - STALE_MS) continue;
        const signal = SIGNALS.includes(h.signal) ? h.signal : null;
        const until = Math.min(rawUntil, now + (signal === 'retry_after_5xx' ? MAX_5XX_HOLD_MS : MAX_BACKOFF_MS));
        // `at`: when the hold was recorded. Legacy entries without it read as
        // recorded a minute before their until.
        const at = Date.parse(h.at);
        const atMs = Number.isFinite(at) && at <= until ? at : until - MIN_BACKOFF_MS;
        // `limit_at`: when the host's streaks were last written by a RATE LIMIT
        // (a 5xx hold carries them forward without writing them) — what makes
        // combineHold order-independent.
        const lim = Date.parse(h.limit_at);
        const rec = {
            until: new Date(until).toISOString(),
            http_status: Number.isInteger(h.http_status) ? h.http_status : null,
            signal,
            // 0 only for a hold that was never a rate limit (a 5xx's
            // Retry-After — grumpy N4); a legacy entry without one is 1.
            count: h.count === undefined ? 1 : streak(h.count),
            weak: streak(h.weak),
            ...(streak(h.strong403) ? { strong403: streak(h.strong403) } : {}),
            // Set by the WORKER when it stores a source's row: whether this
            // host is that source's terms-page host ONLY (no route of the
            // source, under the worker's env, requests it) — markTermsOnly /
            // collectionHolds. Unset on every host that is not the terms host.
            ...(typeof h.terms_only === 'boolean' ? { terms_only: h.terms_only } : {}),
            at: new Date(atMs).toISOString(),
        };
        if (Number.isFinite(lim)) rec.limit_at = new Date(Math.min(lim, atMs)).toISOString();
        out[host] = out[host] ? combineHold(out[host], rec) : rec;
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
    // L3: consecutive strong 403s of the host (a 429 or a weak limit ends it).
    const prevStrong = prev ? streak(prev.strong403) : 0;
    const strong403 = notLimit ? prevStrong : (status === 403 && signal === 'ratelimit_remaining_zero' ? Math.min(STREAK_MAX, prevStrong + 1) : 0);
    let until = backoffUntil(retryAt, now, notLimit ? 1 : count);
    // PR #44: a 429 without any time of the source's holds at least
    // NO_TIME_429_HOLD_MS (the doubling floor may already be longer).
    if (signal === 'http_429' && (retryAt === null || retryAt === undefined)) {
        until = Math.max(until, now + NO_TIME_429_HOLD_MS);
    }
    if (notLimit) until = Math.min(until, now + MAX_5XX_HOLD_MS);
    // A later hold already in force is never shortened.
    const prevUntil = prev ? Date.parse(prev.until) : NaN;
    let outStatus = status;
    let outSignal = SIGNALS.includes(signal) ? signal : null;
    if (Number.isFinite(prevUntil) && prevUntil >= until) {
        // The expiry keeps its CAUSE (the same rule as combineHold: the record
        // that supplies the latest until, a tie going to the rate limit): a 5xx's
        // (short) hold never takes over the cause of a longer rate-limit hold
        // already in force, and a rate limit never takes over a longer server
        // backoff's — its streak (count / weak) still advances.
        if (notLimit && prev.signal !== 'retry_after_5xx') { outSignal = prev.signal; outStatus = prev.http_status; }
        if (!notLimit && prevUntil > until && prev.signal === 'retry_after_5xx') { outSignal = 'retry_after_5xx'; outStatus = prev.http_status; }
        until = Math.max(until, prevUntil);
    }
    // limit_at: a rate limit writes the streaks now; a 5xx carries the previous writer's forward.
    const limitAt = notLimit ? limitAtOf(prev) : now;
    return {
        entry: { until: new Date(until).toISOString(), http_status: outStatus, signal: outSignal,
            count, weak: weakCount, ...(strong403 ? { strong403 } : {}),
            ...(limitAt !== null ? { limit_at: new Date(limitAt).toISOString() } : {}), at: new Date(now).toISOString() },
        escalate: !notLimit && ((weak && weakCount >= ESCALATE_AFTER) || strong403 >= ESCALATE_STRONG_403_AFTER || count >= ESCALATE_ANY_AFTER),
    };
}

/**
 * When a record's streaks were last WRITTEN by a rate limit (epoch ms), or
 * null when none was (a 5xx hold that never carried a streak). A record
 * without `limit_at` (stored before it existed) reads as written at its `at`
 * unless it is a 5xx hold with no streak.
 */
function limitAtOf(r) {
    if (!r) return null;
    const lim = Date.parse(r.limit_at);
    if (Number.isFinite(lim)) return lim;
    if (r.signal === 'retry_after_5xx' && streak(r.count) === 0) return null;
    const at = Date.parse(r.at);
    return Number.isFinite(at) ? at : null;
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
    // A join of three INDEPENDENT fields, each the maximum of a total order, so
    // the result is the same in either argument order and for any fold order of
    // three or more records (concurrent savers, rows merged in any order —
    // grumpy review 4):
    //   until   the latest (security N6: a newer, shorter record never frees a
    //           host before another copy's stated time);
    //   cause   (signal, http_status) of the record that supplies the latest
    //           until, a tie going to the rate-limit cause, then the text of the
    //           signal — a concurrent 1 h 5xx hold never relabels a 24 h rate limit;
    //   streaks (count, weak, strong403) of the record whose RATE LIMIT wrote
    //           them last (limit_at), then the larger — a 5xx record carries the
    //           streaks it saw but never wins them from a newer rate limit, and a
    //           later strong limit's reset weak streak is never resurrected.
    const is5xx = r => r.signal === 'retry_after_5xx';
    const num = v => (Number.isFinite(v) ? v : -Infinity);
    const cmp = (x, y) => { for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1; } return 0; };
    const causeKey = r => [num(Date.parse(r.until)), is5xx(r) ? 0 : 1, `${r.signal || ''}|${r.http_status || ''}`];
    const streakKey = r => [num(limitAtOf(r)), streak(r.count), streak(r.weak), streak(r.strong403)];
    const cause = cmp(causeKey(b), causeKey(a)) > 0 ? b : a;
    const streaks = cmp(streakKey(b), streakKey(a)) > 0 ? b : a;
    const until = Math.max(num(Date.parse(a.until)), num(Date.parse(b.until)));
    const at = Math.max(num(Date.parse(a.at)), num(Date.parse(b.at)));
    const limitAt = limitAtOf(streaks);
    const merged = {
        until: new Date(until).toISOString(), http_status: cause.http_status, signal: cause.signal,
        count: streaks.count, weak: streaks.weak,
        ...(streaks.strong403 ? { strong403: streaks.strong403 } : {}),
        ...(limitAt !== null ? { limit_at: new Date(limitAt).toISOString() } : {}),
        at: new Date(Number.isFinite(at) ? at : until).toISOString(),
    };
    // A host is a terms-page-only host only when BOTH records say so (the worker
    // recomputes the flag whenever it stores a row — state.saveHolds).
    if (a.terms_only === true && b.terms_only === true) merged.terms_only = true;
    return merged;
}

/** The active hold of a host (hostname), or null. @returns {{ until: number, http_status, signal }|null} */
function heldUntil(holds, host, now = Date.now()) {
    if (!holds || typeof host !== 'string') return null;
    // Security review F4: a trailing dot or a www. twin is the same host (hostKeys).
    let best = null;
    for (const key of hostKeys(host)) {
        if (!hasOwn(holds, key)) continue;
        const h = holds[key];
        const until = h ? Date.parse(h.until) : NaN;
        if (Number.isFinite(until) && until > now && (!best || until > best.until)) best = { until, http_status: h.http_status, signal: h.signal };
    }
    return best;
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
        return typeof u === 'string' && u.trim() ? normHost(new URL(u.trim()).hostname) : null;
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
function holdReason(state, routes, until, kind = 'rate_limit') {
    const ids = Object.keys(routes);
    // Copilot review: a server error's Retry-After (retry_after_5xx) is honoured
    // but is not a rate limit, and is never described as one.
    const what = kind === 'server' ? 'a server error (HTTP 5xx with Retry-After)' : 'a rate limit';
    return `backing off after ${what} until ${until}: routes held: ${ids.join(', ')}`
        + (state === 'partial' ? ' (the source\'s other routes keep collecting)' : '')
        + (kind === 'server' ? ' — honouring Retry-After; not a rate limit, not a refusal' : ' — honouring x-ratelimit-reset / Retry-After; not a refusal');
}

/**
 * When the last active 5xx hold (retry_after_5xx) of a source's collection
 * hosts passes (ISO), or null — a server error's Retry-After, honoured but
 * never reported as a rate limit (Copilot review).
 */
function serverBackoffUntil(src, holds, now = Date.now(), env = {}) {
    const only = Object.fromEntries(Object.entries(collectionHolds(src, holds, env) || {})
        .filter(([, h]) => h && h.signal === 'retry_after_5xx'));
    const times = Object.values(activeHolds(only, now)).map(h => h.until).sort();
    return times.length ? times[times.length - 1] : null;
}

/** The stored key of a route held by a 5xx's Retry-After (the same JSON map as rate-limited routes). */
const SERVER_ROUTE_PREFIX = 'server:';

/**
 * The map the worker stores in source_collection_state.rate_limited_routes:
 * the rate-limited routes as { id: until } and the routes held only by a 5xx's
 * Retry-After as { 'server:<id>': until } — so the web process can keep both
 * out of open_routes while only the first is a rate limit (Copilot review).
 */
function storedRouteMap(gate) {
    return {
        ...gate.limitedRoutes,
        ...Object.fromEntries(Object.entries(gate.serverRoutes || {}).map(([id, t]) => [SERVER_ROUTE_PREFIX + id, t])),
    };
}

/**
 * The holds that are RATE LIMITS: a hold from a 5xx's Retry-After
 * (retry_after_5xx) is enforced but is not one, so it never reads as
 * "rate limited" in a status, a reason, a time or a host list (Copilot review).
 */
function rateLimitHolds(holds) {
    if (!holds || typeof holds !== 'object') return holds;
    return Object.fromEntries(Object.entries(holds).filter(([, h]) => !(h && h.signal === 'retry_after_5xx')));
}

/**
 * The rate-limit gate of a source: which of its OPEN routes its active holds
 * stop (computed by the worker, which sees the real env).
 * @returns {{ state: 'none'|'partial'|'all', kind: 'rate_limit'|'server'|null, until: string|null,
 *             next: string|null, routes: { [routeId]: string },
 *             limitedRoutes: { [routeId]: string }, serverRoutes: { [routeId]: string },
 *             reason: string|null }}
 *   routes: every held route (enforcement); limitedRoutes: those held by a real
 *   rate limit (what /api/sources reports — a 5xx hold is `kind: 'server'`)
 *   until: when the LAST held route frees (ISO); next: the FIRST
 */
function holdGate(src, env, holds, now = Date.now(), { routeKills = [] } = {}) {
    const { openRoutes } = require('../config/source-registry');
    // Copilot review: a route the database kill switch disabled never runs, so it
    // is never held (nor stored as rate-limited) — `routeKills` are the source's
    // state.routeKillSwitches rows.
    const routes = openRoutes(src, env, { routeKills });
    const held = {};
    const limited = {};
    const limitedHolds = rateLimitHolds(holds);
    for (const r of routes) {
        const t = routeHeldUntil(r, env, holds, now);
        if (!t) continue;
        held[r.id] = t;
        const tl = routeHeldUntil(r, env, limitedHolds, now);
        if (tl) limited[r.id] = tl;
    }
    const times = Object.values(held).sort();
    if (!times.length) return { state: 'none', kind: null, until: null, next: null, routes: {}, limitedRoutes: {}, serverRoutes: {}, reason: null };
    const state = times.length === routes.length ? 'all' : 'partial';
    const until = times[times.length - 1];
    // 'rate_limit' when any held route is held by a real rate limit, else 'server'.
    const kind = Object.keys(limited).length ? 'rate_limit' : 'server';
    const server = Object.fromEntries(Object.entries(held).filter(([id]) => !limited[id]));
    return { state, kind, until, next: times[0], routes: held, limitedRoutes: limited, serverRoutes: server, reason: holdReason(state, held, until, kind) };
}

/**
 * A source's stored holds WITHOUT its terms-page host (unless a route also
 * uses it): a throttled terms page (the governance snapshot) is held so it
 * is not asked early, but it is not the source being rate-limited — it never
 * shows on /api/sources, in rate_limited_until or in the warning (grumpy
 * re-review).
 */
function collectionHolds(src, holds, env = {}) {
    const { routeAllowedHosts } = require('../config/source-registry');
    const terms = hostOf(src && src.termsUrl);
    if (!holds || typeof holds !== 'object' || !terms) return holds;
    // Copilot review: the hosts of the routes are those of the ACTIVE env (a
    // contract feed URL may share the terms page's host). The web process cannot
    // see that env, so the worker writes the verdict into the hold itself
    // (`terms_only`, markTermsOnly); only an unmarked entry is judged here.
    let routeHosts = null;
    return Object.fromEntries(Object.entries(holds).filter(([h, e]) => {
        if (normHost(h) !== terms) return true;
        if (e && typeof e.terms_only === 'boolean') return !e.terms_only;
        routeHosts = routeHosts || new Set(src.routes.flatMap(r => routeAllowedHosts(r, env || {})));
        return routeHosts.has(terms);
    }));
}

/**
 * A source's stored holds with the terms-page verdict written in (the worker
 * calls this when it stores the row, with the REAL env): the terms host's hold
 * is `terms_only` unless a route of the source — under that env — requests the
 * host too; every other host carries no mark.
 */
function markTermsOnly(src, holds, env = {}) {
    const { routeAllowedHosts } = require('../config/source-registry');
    const terms = hostOf(src && src.termsUrl);
    const routeHosts = new Set(src.routes.flatMap(r => routeAllowedHosts(r, env || {})));
    const out = {};
    for (const [h, e] of Object.entries(holds || {})) {
        const { terms_only: _drop, ...rest } = e || {};
        out[h] = terms && normHost(h) === terms ? { ...rest, terms_only: !routeHosts.has(terms) } : rest;
    }
    return out;
}

let registryHostSet = null;
/**
 * Security review L6: a hostname as an error message (stored in last_error and
 * mailed by the watchdog) may name: a host the REGISTRY lists (env-free) is
 * named; any other (from a contract feed URL in the env) is CONFIGURED_HOST.
 */
function publicHostName(host) {
    if (!registryHostSet) {
        const { SOURCES, routeAllowedHosts } = require('../config/source-registry');
        registryHostSet = new Set(SOURCES.flatMap(src => src.routes.flatMap(r => routeAllowedHosts(r, {}))));
    }
    return registryHostSet.has(String(host).toLowerCase()) ? host : CONFIGURED_HOST;
}

/**
 * The hosts of a source's active holds as /api/sources may publish them
 * (security F3): a host the REGISTRY names (env-free) is served; any other
 * (from a contract feed URL in the env) is CONFIGURED_HOST.
 * @returns {Array<{ host, until, http_status, signal, count }>}
 */
function publicHosts(src, holds, now = Date.now(), env = {}, { kind = 'rate_limit' } = {}) {
    const { routeAllowedHosts } = require('../config/source-registry');
    const registry = new Set(src.routes.flatMap(r => routeAllowedHosts(r, {})));
    // A 5xx's Retry-After hold is not a rate limit: `rate_limited_hosts` lists
    // rate limits only, `server_backoff_hosts` (kind 'server') the others.
    const wanted = kind === 'server'
        ? Object.fromEntries(Object.entries(collectionHolds(src, holds, env) || {}).filter(([, h]) => h && h.signal === 'retry_after_5xx'))
        : rateLimitHolds(collectionHolds(src, holds, env));
    // The streak counter is internal (never published); the signal is an enum.
    return Object.entries(activeHolds(wanted, now))
        .map(([host, h]) => ({ host: registry.has(host) ? host : CONFIGURED_HOST, until: h.until, http_status: h.http_status, signal: h.signal }))
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
            until: new Date(Math.min(until, now + (status === 503 ? MAX_5XX_HOLD_MS : MAX_BACKOFF_MS))).toISOString(), http_status: status,
            signal: status === 503 ? 'retry_after_5xx' : 'http_429', count: status === 503 ? 0 : 1, weak: 0,
            at: new Date(now).toISOString(),
            // The legacy key is not a newer rate limit than an existing streak
            // (migration 077 keeps the existing streaks too): it joins its
            // time and cause only.
            ...(status === 503 ? {} : { limit_at: new Date(0).toISOString() }),
        } }, now)[host];
        if (rec) holds[host] = combineHold(holds[host], rec);
    }
    return { holds, cache };
}

module.exports = {
    MIN_BACKOFF_MS, MAX_BACKOFF_MS, MAX_5XX_HOLD_MS, publicHostName, rateLimitHolds, serverBackoffUntil, storedRouteMap, SERVER_ROUTE_PREFIX, MAX_IN_RUN_WAIT_MS, NO_TIME_429_HOLD_MS, LEGACY_HOLD_PREFIX, ESCALATE_AFTER, ESCALATE_STRONG_403_AFTER, WARN_AFTER, STALE_MS, RATE_LIMITED, SIGNALS,
    WEAK_SIGNALS, BODY_HOSTS, CONFIGURED_HOST, BODY_RE,
    parseRetryAfter, parseReset, bodyNamesRateLimit, rateLimitSignal, backoffUntil,
    sanitizeHolds, activeHolds, nextHold, mergeHolds, combineHold, collectionHolds, markTermsOnly, heldUntil, hostOf, normHost, hostKeys, limitAtOf, ESCALATE_ANY_AFTER,
    routeRequestHosts, sourceHosts, routeHeldUntil, routeHeld, holdGate, holdReason, publicHosts, legacyHolds,
};
