// src/collectors/reddit/selection.js
// WHICH subreddits Reddit is collected from — Jennifer's selection rule
// (2026-09-29, ADR 0001 ruling 8):
//   "the top 7 subreddits with the most subscribers/followers."
//   "to be clear. the top 7 subreddits mentioning AI"
//   "Most subscribers, among those mentioning AI"
// So the selection is NOT limited to AI-focused communities: it is the 7
// highest-subscriber subreddits among those that regularly mention AI, and
// can include large general subreddits (r/technology, r/Futurology).
//
// The rule, as implemented (the daily discovery job, ./discovery.js):
//   (a) a site-wide /search for the shared AI filter terms
//       (src/collectors/ai-filter.js SEARCH_TERMS) over a rolling 7-day
//       window (t=week, sort=new, paginated within the request budget);
//       each result must also pass the local AI filter; results are counted
//       per subreddit (one count per distinct post);
//   (b) QUALIFYING = at least REDDIT_MIN_AI_POSTS_7D AI-mentioning posts in
//       that window (default 20);
//   (c) for qualifying subreddits, /r/{sub}/about gives subscribers, over18
//       and subreddit_type; EXCLUDED are NSFW, non-public (private,
//       restricted, …), quarantined and user-profile subreddits, any whose
//       /about is unavailable or returns no subscriber count, and the deny
//       list of activist communities below;
//   (d) the rest are ranked by subscribers (ties: more AI posts, then name)
//       and the top 7 are selected;
//   (e) every snapshot is stored (reddit_subreddit_rankings, migration 025)
//       with its window, counts, subscribers and exclusions with reasons, and
//       served by GET /api/sources (the reddit row's `selection`).
// A snapshot that selects at least one subreddit replaces the selection
// (applied); one that selects none (for example because Reddit no longer
// returns subscriber counts — research §7) is stored but leaves the previous
// selection in place.
//
// BEFORE APPROVAL there is no API access and so no live ranking. The
// PROVISIONAL list below is used until the first applied snapshot, which
// replaces it automatically. It is built from third-party tracker data
// (research §7): the largest general subreddits known to discuss AI and the
// largest AI subreddits. ALL COUNTS ARE UNVERIFIED — Reddit stopped showing
// member counts publicly in Sept 2025, and the trackers disagree.

'use strict';

const { SUBREDDIT_RE } = require('./fields');

const TOP_N = 7;
const DEFAULT_MIN_AI_POSTS_7D = 20;
const WINDOW_DAYS = 7;

/**
 * Provisional until the first API ranking. Member counts: third-party,
 * unverified (docs/research/2026-09-29-reddit-access.md §7); null where the
 * research has no tracker figure.
 */
const PROVISIONAL_SUBREDDITS = Object.freeze([
    { subreddit: 'technology', membersUnverified: null, basis: 'one of the largest general subreddits known to discuss AI (no tracker figure in the research)' },
    { subreddit: 'Futurology', membersUnverified: null, basis: 'one of the largest general subreddits known to discuss AI (no tracker figure in the research)' },
    { subreddit: 'ChatGPT', membersUnverified: '11.5M (usefulai.com, 12 Jul 2026) vs "5M+" (deadsubs.com, 26 Aug 2026) — trackers conflict', basis: 'largest AI subreddit' },
    { subreddit: 'singularity', membersUnverified: '3,998,116 (freesubstats.com, Sept 2026); 3.91M (usefulai.com, 12 Jul 2026)', basis: 'AI subreddit' },
    { subreddit: 'MachineLearning', membersUnverified: '3.05M (usefulai.com, 12 Jul 2026)', basis: 'AI subreddit' },
    { subreddit: 'OpenAI', membersUnverified: '2.76M (usefulai.com, 12 Jul 2026)', basis: 'AI subreddit' },
    { subreddit: 'ArtificialInteligence', membersUnverified: '1.9M (third-party list, date not stated)', basis: 'AI subreddit (spelled with one "l")' },
]);

/** The research's other candidates (§7), for the record; not collected until ranked. */
const RESEARCH_CANDIDATES = Object.freeze([
    { subreddit: 'artificial', membersUnverified: '1,344,846 (freesubstats.com, Sept 2026); 1.28M (usefulai.com, 12 Jul 2026)' },
    { subreddit: 'ClaudeAI', membersUnverified: '881K (usefulai.com, 12 Jul 2026)' },
    { subreddit: 'LocalLLaMA', membersUnverified: '733K (usefulai.com, 12 Jul 2026) vs "400K+" (deadsubs.com)' },
    { subreddit: 'AIethics', membersUnverified: null, note: 'not found in any tracker searched; hold until measured' },
]);

// Activist communities are never selected. The Developer Terms (§4.2) bring
// in the Public Content Policy's licensee restrictions, which the research
// (§2) summarises as: no profiling on sensitive attributes, and "no tracking
// or monitoring of sensitive events or groups such as protests, unions or
// activist groups". Names are compared case-insensitively.
const DENY_LIST = Object.freeze([
    { subreddit: 'antiai', reason: 'activist community (Public Content Policy: no monitoring of activist groups)' },
]);

const denied = (name) => DENY_LIST.find(d => d.subreddit.toLowerCase() === String(name).toLowerCase()) || null;

/** REDDIT_MIN_AI_POSTS_7D, or the default 20 (non-integers and < 1 fall back). */
function minAiPosts(env = process.env) {
    const n = parseInt(String(env.REDDIT_MIN_AI_POSTS_7D || '').trim(), 10);
    return Number.isInteger(n) && n >= 1 && String(n) === String(env.REDDIT_MIN_AI_POSTS_7D).trim() ? n : DEFAULT_MIN_AI_POSTS_7D;
}

/**
 * Why a subreddit's /about excludes it, or null when it may be ranked.
 * @param {string} name
 * @param {object|null} about   /r/{sub}/about data, or null when unavailable
 * @param {string} [unavailable] why /about could not be read
 */
function exclusionReason(name, about, unavailable = null) {
    const deny = denied(name);
    if (deny) return `deny list: ${deny.reason}`;
    if (/^u_/i.test(name)) return 'user profile, not a community';
    if (!about) return `about unavailable${unavailable ? ` (${unavailable})` : ''}`;
    if (about.over18 === true) return 'NSFW (over18)';
    if (about.quarantine === true) return 'quarantined';
    if (about.subreddit_type !== 'public') return `not public (subreddit_type ${String(about.subreddit_type || 'missing').slice(0, 20)})`;
    if (!Number.isFinite(about.subscribers) || about.subscribers < 0) return 'no subscriber count returned';
    return null;
}

/**
 * Steps (b)-(d): qualify, exclude, rank, select. Pure.
 * @param {object} o
 * @param {Map<string, {name: string, count: number}>|Array} o.counts  AI posts per subreddit (7 days)
 * @param {Map<string, {about: object|null, unavailable?: string}>} o.abouts  keyed by lower-case name
 * @param {number} o.minPosts
 * @param {number} [o.top]
 * @returns {{ ranking: object[], exclusions: object[], selected: string[], qualifying: string[] }}
 */
function rankSubreddits({ counts, abouts, minPosts, top = TOP_N }) {
    const list = [...(counts instanceof Map ? counts.values() : counts)];
    const qualifying = list.filter(c => c.count >= minPosts)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const eligible = [];
    const exclusions = [];
    for (const q of qualifying) {
        const a = abouts.get(q.name.toLowerCase()) || { about: null, unavailable: 'not looked up' };
        const reason = exclusionReason(q.name, a.about, a.unavailable);
        if (reason) exclusions.push({ subreddit: q.name, ai_posts_7d: q.count, reason });
        else {
            const name = typeof a.about.display_name === 'string' && SUBREDDIT_RE.test(a.about.display_name) ? a.about.display_name : q.name;
            eligible.push({ subreddit: name, ai_posts_7d: q.count, subscribers: a.about.subscribers });
        }
    }
    eligible.sort((x, y) => y.subscribers - x.subscribers || y.ai_posts_7d - x.ai_posts_7d
        || x.subreddit.localeCompare(y.subreddit));
    const ranking = eligible.map((e, i) => ({ ...e, rank: i + 1, selected: i < top }));
    return {
        ranking,
        exclusions,
        selected: ranking.filter(r => r.selected).map(r => r.subreddit),
        qualifying: qualifying.map(q => q.name),
    };
}

/** Store one snapshot (step e). @returns {Promise<object>} the stored row */
async function saveSnapshot(snap, db = require('../../db/connection')) {
    return db.dbGet(
        `INSERT INTO reddit_subreddit_rankings
            (window_start, window_end, min_ai_posts, top_n, applied, selected, ranking, exclusions, stats)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7::jsonb, $8::jsonb, $9::jsonb)
         RETURNING id, ranked_at, applied, selected`,
        [snap.windowStart, snap.windowEnd, snap.minPosts, snap.top || TOP_N, snap.selected.length > 0, snap.selected,
            JSON.stringify(snap.ranking), JSON.stringify(snap.exclusions), JSON.stringify(snap.stats || {})],
    );
}

/**
 * The current selection: the latest applied snapshot, else the provisional
 * list. @returns {Promise<{ basis: 'ranking'|'provisional', subreddits: string[], ... }>}
 */
async function loadSelection(db = require('../../db/connection')) {
    const row = await db.dbGet(
        `SELECT id, ranked_at, window_start, window_end, min_ai_posts, top_n, selected, ranking, exclusions, stats
         FROM reddit_subreddit_rankings WHERE applied ORDER BY ranked_at DESC LIMIT 1`,
    );
    if (!row) return provisionalSelection();
    return {
        basis: 'ranking',
        subreddits: row.selected.slice(0, TOP_N),
        ranked_at: row.ranked_at,
        window: { start: row.window_start, end: row.window_end, days: WINDOW_DAYS },
        min_ai_posts_7d: row.min_ai_posts,
        ranking: row.ranking,
        exclusions: row.exclusions,
        stats: row.stats,
    };
}

function provisionalSelection() {
    return {
        basis: 'provisional',
        note: 'provisional until the first API ranking; member counts are third-party and unverified',
        subreddits: PROVISIONAL_SUBREDDITS.map(p => p.subreddit),
        provisional: PROVISIONAL_SUBREDDITS,
        candidates: RESEARCH_CANDIDATES,
    };
}

/** The latest snapshot of any kind (applied or not), for the status surface. */
async function latestSnapshot(db = require('../../db/connection')) {
    return db.dbGet(
        `SELECT ranked_at, applied, selected, min_ai_posts, stats FROM reddit_subreddit_rankings
         ORDER BY ranked_at DESC LIMIT 1`,
    );
}

/** What GET /api/sources serves for Reddit (selection rule + current selection). */
async function selectionStatus(db = require('../../db/connection')) {
    const current = await loadSelection(db);
    const latest = await latestSnapshot(db);
    return {
        rule: `the ${TOP_N} subreddits with the most subscribers among those with at least the minimum number of `
            + `AI-mentioning posts in the last ${WINDOW_DAYS} days (REDDIT_MIN_AI_POSTS_7D, default ${DEFAULT_MIN_AI_POSTS_7D}); `
            + 'NSFW, non-public, quarantined, user-profile and deny-listed activist subreddits excluded',
        deny_list: DENY_LIST.map(d => d.subreddit),
        ...current,
        latest_snapshot: latest ? { ranked_at: latest.ranked_at, applied: latest.applied, selected: latest.selected } : null,
    };
}

module.exports = {
    TOP_N, DEFAULT_MIN_AI_POSTS_7D, WINDOW_DAYS, PROVISIONAL_SUBREDDITS, RESEARCH_CANDIDATES, DENY_LIST,
    minAiPosts, exclusionReason, rankSubreddits, saveSnapshot, loadSelection, provisionalSelection, latestSnapshot,
    selectionStatus,
};
