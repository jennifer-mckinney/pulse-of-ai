// src/collectors/robots.js
// robots.txt policy for publisher-site routes (RFC 9309 matching, plus the
// CONSERVATIVE trailing-slash reading of ADR 0001).
//
// Matching: the group for our product token (User-agent line containing
// "pulseofai", case-insensitive) wins over "*"; within a group the longest
// matching rule wins and Allow wins a tie. `*` matches any run of
// characters and a trailing `$` anchors the end.
//
// Conservative mode (default): a `Disallow: /x/` rule ALSO disallows the path
// `/x` exactly. This is how CFR's `Disallow: /feed/` is read against its feed
// at `/feed`. A source whose registry entry names `robots.literalWhenEnv`
// switches to literal RFC 9309 matching once that env var records the
// site's confirmation.
//
// Fetch outcome → policy (cached per origin for 24 h), per RFC 9309 §2.3.1:
//   2xx                  parse the file
//   4xx (not 429)        "unavailable" → no robots rules apply (§2.3.1.3).
//                        Seen live: the Dow Jones feed host (S3) and rand.org
//                        (CloudFront) answer 403 for /robots.txt while their
//                        feeds answer 200. This never works around a wall: a
//                        401/403 on the resource itself still stops the run
//                        (AccessDeniedError in http.js).
//   429 / 5xx / error    "unreachable" → complete disallow (§2.3.1.4)

'use strict';

const PRODUCT_TOKEN = 'pulseofai';
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Parse robots.txt into groups.
 * @param {string} text
 * @returns {Array<{ agents: string[], rules: Array<{ allow: boolean, path: string }> }>}
 */
function parseRobots(text) {
    const groups = [];
    let current = null;
    let lastWasAgent = false;
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        if (!line) continue;
        const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const value = m[2].trim();
        if (key === 'user-agent') {
            if (!current || !lastWasAgent) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
        } else if (key === 'allow' || key === 'disallow') {
            lastWasAgent = false;
            if (!current) continue;
            if (key === 'disallow' && value === '') continue;   // empty Disallow allows all
            current.rules.push({ allow: key === 'allow', path: value });
        } else {
            lastWasAgent = false;
        }
    }
    return groups;
}

function patternToRegex(pattern) {
    const anchored = pattern.endsWith('$');
    const body = (anchored ? pattern.slice(0, -1) : pattern)
        .split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp('^' + body + (anchored ? '$' : ''));
}

/**
 * Whether `path` (path + query) is allowed under the parsed groups.
 * @param {ReturnType<typeof parseRobots>} groups
 * @param {string} path
 * @param {{ conservative?: boolean }} [opts]
 */
function isAllowed(groups, path, { conservative = true } = {}) {
    const ours = groups.filter(g => g.agents.some(a => a !== '*' && a.includes(PRODUCT_TOKEN)));
    const group = ours.length ? ours : groups.filter(g => g.agents.includes('*'));
    const rules = group.flatMap(g => g.rules);
    let best = null;
    for (const rule of rules) {
        let matched = patternToRegex(rule.path).test(path);
        // Conservative: "Disallow: /x/" also covers "/x" itself.
        if (!matched && conservative && !rule.allow && rule.path.length > 1 && rule.path.endsWith('/')) {
            const bare = rule.path.slice(0, -1);
            matched = path === bare || path.startsWith(bare + '?');
        }
        if (!matched) continue;
        const len = rule.path.replace(/\*/g, '').length;
        if (!best || len > best.len || (len === best.len && rule.allow && !best.allow)) {
            best = { allow: rule.allow, len };
        }
    }
    return best ? best.allow : true;
}

/**
 * Per-origin robots cache. `fetchRobots(url)` must fetch WITHOUT robots
 * gating and resolve { status, body }.
 */
// F10-9: ONE robots cache per process, shared by every HttpClient (a
// client is created per collection run, so a per-client cache refetched
// robots.txt on every run). Keyed by origin; entries live TTL_MS (24 h).
// An UNREACHABLE robots.txt (5xx, 429, network) is a complete disallow for
// this run but is cached only UNREACHABLE_TTL_MS, so a transient outage is
// re-checked soon instead of blocking the origin for a day.
const UNREACHABLE_TTL_MS = 10 * 60 * 1000;
const SHARED_CACHE = new Map();

class RobotsPolicy {
    /**
     * @param {object} o
     * @param {Function} o.fetchRobots
     * @param {Map} [o.cache]  defaults to the process-level cache
     */
    constructor({ fetchRobots, now = () => Date.now(), ttlMs = TTL_MS, cache = SHARED_CACHE }) {
        this.fetchRobots = fetchRobots;
        this.now = now;
        this.ttlMs = ttlMs;
        this.cache = cache;   // origin → { groups | null, allowAll, denyAll, unreachable, at }
    }

    async policyFor(origin) {
        const hit = this.cache.get(origin);
        if (hit && this.now() - hit.at < (hit.unreachable ? Math.min(UNREACHABLE_TTL_MS, this.ttlMs) : this.ttlMs)) return hit;
        let entry;
        try {
            const res = await this.fetchRobots(`${origin}/robots.txt`);
            if (res.status >= 200 && res.status < 300) entry = { groups: parseRobots(res.body) };
            else if (res.status >= 400 && res.status < 500 && res.status !== 429) entry = { allowAll: true };
            else entry = { denyAll: true, unreachable: true, reason: `robots.txt unreachable (HTTP ${res.status}) — complete disallow` };
        } catch (err) {
            // The run's deadline is not an answer from the origin: nothing
            // is cached (G10-9).
            if (err && err.kind === 'deadline') throw err;
            // Nor is a request we did not send because its host is backing
            // off after a rate limit (diagnosis 2026-10-01, security F5): the
            // route is held, and nothing is cached as "unreachable".
            if (err && err.held === true) throw err;
            entry = { denyAll: true, unreachable: true, reason: `robots.txt unreachable: ${err.message}` };
        }
        entry.at = this.now();
        this.cache.set(origin, entry);
        return entry;
    }

    /**
     * @param {string} url
     * @param {{ conservative?: boolean }} [opts]
     * @returns {Promise<{ allowed: boolean, reason: string|null }>}
     */
    async check(url, opts = {}) {
        const u = new URL(url);
        if (u.pathname === '/robots.txt') return { allowed: true, reason: null };
        const p = await this.policyFor(u.origin);
        if (p.allowAll) return { allowed: true, reason: null };
        if (p.denyAll) return { allowed: false, reason: p.reason, unreachable: !!p.unreachable };
        const allowed = isAllowed(p.groups, u.pathname + u.search, opts);
        return { allowed, reason: allowed ? null : `robots.txt disallows ${u.pathname}${opts.conservative === false ? '' : ' (conservative reading)'}` };
    }
}

/** Empty the process-level cache (tests). */
function clearSharedRobotsCache() { SHARED_CACHE.clear(); }

module.exports = { parseRobots, isAllowed, RobotsPolicy, PRODUCT_TOKEN, SHARED_CACHE, UNREACHABLE_TTL_MS, clearSharedRobotsCache };
