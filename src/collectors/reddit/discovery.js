// src/collectors/reddit/discovery.js
// The daily subreddit discovery (selection rule steps a-d,
// ./selection.js): which subreddits mention AI, how often, and how many
// subscribers they have. Runs only once Reddit has approved the app and the
// credentials are set (src/collectors/reddit/maintenance.js).
//
//   (a) GET /search?q=<shared AI terms, OR-joined>&sort=new&t=week&type=link
//       &limit=100, paginated with `after` (at most MAX_PAGES_PER_QUERY pages
//       per query, stopping at the first page older than the window). Every
//       result must also pass the local AI filter (the same filter as every
//       site-wide feed) and be inside the rolling 7 days; each post counts
//       once for its subreddit. Only allowlisted fields are read
//       (./fields.js) — no author field is ever touched.
//       Reddit caps a listing at about 1,000 results, so a very busy
//       subreddit's count is a LOWER BOUND; it only has to clear the
//       qualifying threshold.
//   (c) GET /r/{sub}/about for the qualifying subreddits, highest AI-post
//       counts first, at most MAX_ABOUT_LOOKUPS; the rest are recorded as
//       exclusions ("not looked up").
// Every request takes a grant from the shared budget with a reserve, so the
// collection runs keep their share. When the budget runs out the discovery
// is INCOMPLETE: nothing is stored and it is retried on a later maintenance
// tick (a partial count must not decide the selection).

'use strict';

const { SEARCH_TERMS, isAiRelated } = require('../ai-filter');
const { pickAllowed, FULLNAME_RE, SUBREDDIT_RE } = require('./fields');
const { BudgetExhaustedError } = require('./budget');
const { RateLimitedError, AccessDeniedError } = require('../errors');
const { TOP_N, WINDOW_DAYS, DENY_LIST, minAiPosts, rankSubreddits } = require('./selection');

const MAX_PAGES_PER_QUERY = 10;
const MAX_ABOUT_LOOKUPS = 250;
// Consecutive plain 403s on /about (no lookup succeeding between) that are read as
// Reddit refusing us, not as private subreddits (Copilot review).
const ABOUT_REFUSAL_AFTER = 3;
const MAX_QUERY_CHARS = 400;

/** OR-join the shared AI terms into queries of at most MAX_QUERY_CHARS. */
function buildQueries(terms = SEARCH_TERMS, maxChars = MAX_QUERY_CHARS) {
    const out = [];
    let cur = [];
    for (const t of terms) {
        const next = [...cur, t].join(' OR ');
        if (cur.length && next.length > maxChars) {
            out.push(cur.join(' OR '));
            cur = [t];
        } else cur.push(t);
    }
    if (cur.length) out.push(cur.join(' OR '));
    return out;
}

const isDenied = (name) => DENY_LIST.some(d => d.subreddit.toLowerCase() === name.toLowerCase()) || /^u_/i.test(name);

/**
 * @param {object} o
 * @param {import('./api').RedditApi} o.api
 * @param {object} [o.env]
 * @param {Function} [o.now]
 * @returns {Promise<{ complete: boolean, windowStart, windowEnd, minPosts, top,
 *                     ranking, exclusions, selected, qualifying, stats }>}
 */
async function discoverSubreddits({ api, env = process.env, now = () => Date.now(),
    maxPagesPerQuery = MAX_PAGES_PER_QUERY, maxAboutLookups = MAX_ABOUT_LOOKUPS } = {}) {
    const windowEnd = now();
    const windowStart = windowEnd - WINDOW_DAYS * 86400000;
    const minPosts = minAiPosts(env);
    const queries = buildQueries();
    const stats = {
        queries: queries.length, search_requests: 0, posts_seen: 0, ai_posts: 0, about_lookups: 0,
        qualifying: 0, not_looked_up: 0,
    };
    const base = {
        windowStart: new Date(windowStart).toISOString(), windowEnd: new Date(windowEnd).toISOString(),
        minPosts, top: TOP_N, stats,
    };
    const seen = new Set();
    const counts = new Map();

    try {
        for (const q of queries) {
            let after = null;
            for (let page = 0; page < maxPagesPerQuery; page++) {
                const params = { q, sort: 'new', t: 'week', type: 'link', limit: '100' };
                if (after) params.after = after;
                const listing = await api.listing('/search', params);
                stats.search_requests++;
                let oldest = Infinity;
                for (const child of listing.children) {
                    if (!child || child.kind !== 't3') continue;
                    const d = pickAllowed(child.data);
                    if (typeof d.name !== 'string' || !FULLNAME_RE.test(d.name) || seen.has(d.name)) continue;
                    seen.add(d.name);
                    stats.posts_seen++;
                    const created = typeof d.created_utc === 'number' ? d.created_utc * 1000 : null;
                    if (created !== null) oldest = Math.min(oldest, created);
                    if (created === null || created < windowStart || created > windowEnd + 3600000) continue;
                    if (typeof d.subreddit !== 'string' || !SUBREDDIT_RE.test(d.subreddit)) continue;
                    if (!isAiRelated(`${d.title || ''}\n${d.selftext || ''}`)) continue;
                    stats.ai_posts++;
                    const key = d.subreddit.toLowerCase();
                    const c = counts.get(key) || { name: d.subreddit, count: 0 };
                    c.count++;
                    counts.set(key, c);
                }
                after = listing.after;
                if (!after || oldest < windowStart) break;
            }
        }

        const qualifying = [...counts.values()].filter(c => c.count >= minPosts)
            .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
        stats.qualifying = qualifying.length;
        const abouts = new Map();
        let looked = 0;
        // Copilot review: a private subreddit answers 403 on its own, so ONE plain
        // 403 is "unavailable" — but Reddit refusing us would answer every lookup
        // so. ABOUT_REFUSAL_AFTER 403s in a row (no lookup succeeding between)
        // are the source saying no: the AccessDeniedError is rethrown (the
        // refused state), never read as a ranking of unavailable subreddits.
        let refused403 = 0;
        for (const q of qualifying) {
            if (isDenied(q.name)) continue;   // excluded without a request
            if (looked >= maxAboutLookups) {
                abouts.set(q.name.toLowerCase(), { about: null, unavailable: `not looked up: beyond the ${maxAboutLookups} highest AI-post counts` });
                stats.not_looked_up++;
                continue;
            }
            looked++;
            try {
                const about = await api.about(q.name);
                stats.about_lookups++;
                refused403 = 0;
                abouts.set(q.name.toLowerCase(), about ? { about } : { about: null, unavailable: 'not a subreddit' });
            } catch (err) {
                if (err instanceof BudgetExhaustedError) throw err;
                // Grumpy #1: a rate limit (a 429, or a rate-limit 403) is not
                // the subreddit being unavailable — stop the discovery, never
                // ask for the next one.
                if (err instanceof RateLimitedError) throw err;
                // A private, banned or missing subreddit answers 403 / 404;
                // any other failure leaves it out of today's ranking.
                if (err && err.status === 403 && err instanceof AccessDeniedError && ++refused403 >= ABOUT_REFUSAL_AFTER) throw err;
                if (err && (err.status === 403 || err.status === 404)) {
                    abouts.set(q.name.toLowerCase(), { about: null, unavailable: `HTTP ${err.status}` });
                } else if (err && err.status === 401) {
                    throw err;
                } else {
                    abouts.set(q.name.toLowerCase(), { about: null, unavailable: 'lookup failed' });
                }
            }
        }
        return { complete: true, ...base, ...rankSubreddits({ counts, abouts, minPosts, top: TOP_N }) };
    } catch (err) {
        if (err instanceof BudgetExhaustedError || err instanceof RateLimitedError) {
            return { complete: false, ...base, ranking: [], exclusions: [], selected: [], qualifying: [], reason: err.message,
                ...(err instanceof RateLimitedError ? { rateLimited: true } : {}) };
        }
        throw err;
    }
}

module.exports = { discoverSubreddits, buildQueries, MAX_PAGES_PER_QUERY, MAX_ABOUT_LOOKUPS, ABOUT_REFUSAL_AFTER };
