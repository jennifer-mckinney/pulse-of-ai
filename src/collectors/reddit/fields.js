// src/collectors/reddit/fields.js
// Which Reddit fields may be read, and what a submission becomes.
//
// ALLOWLIST, not denylist (docs/research/2026-09-29-reddit-access.md §4):
// Reddit adds fields over time, so only the keys below are ever copied out of
// an API object. Author fields (author, author_fullname, author_flair_*,
// author_premium, …), moderator fields, awardings, crosspost parents, media
// oEmbed blocks (they carry author_name / author_url) and previews are never
// read — an unknown `author*` key can therefore never reach storage (it fails
// closed by construction).
//
// A submission (fullname prefix t3_) is DROPPED when:
//   - it was posted to a user profile (subreddit "u_<name>" names the user);
//   - its subreddit is not public (subreddit_type other than 'public');
//   - it is NSFW (over_18: the Public Content Policy excludes sexually
//     explicit content);
//   - it shows a deletion or removal signal (deletionSignal below).
//
// Deletion signals (research §5, MEDIUM confidence: Reddit documents none of
// these meanings on the pages read; confirm on the first authenticated call).
// Ambiguous states are treated conservatively, as deleted:
//   - title or selftext is "[deleted]" or "[removed]";
//   - removed_by_category is set (any non-empty value);
//   - subreddit_type is not 'public' (or missing);
//   - over_18 turned true;
//   - the object is not a t3 submission with an object body.
// `edited` and `locked` are read but are NOT deletion signals: an edited or
// locked post is still public content.

'use strict';

/** The only keys ever read from a Reddit submission. */
const ALLOWED_FIELDS = Object.freeze([
    'name', 'id', 'subreddit', 'subreddit_id', 'subreddit_type', 'title', 'selftext', 'created_utc',
    'permalink', 'is_self', 'domain', 'url', 'over_18', 'link_flair_text', 'num_comments', 'score',
    'upvote_ratio', 'removed_by_category', 'edited', 'locked',
]);

const DELETED_MARKERS = Object.freeze(['[deleted]', '[removed]']);

const FULLNAME_RE = /^t3_[a-z0-9]{1,16}$/;
const SUBREDDIT_RE = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;
// A permalink path: /r/<sub>/comments/<id36>/<slug>/ — never a user path.
const PERMALINK_RE = /^\/r\/[A-Za-z0-9_]{2,21}\/comments\/[a-z0-9]{1,16}(?:\/[^\s?#]*)?$/;
const EXTERNAL_ID_RE = /^[a-z0-9-]+:(t3_[a-z0-9]{1,16})$/;

/**
 * Copy only the allowlisted keys of a Reddit API object.
 * @param {object} data
 * @returns {object}
 */
function pickAllowed(data) {
    const out = {};
    if (!data || typeof data !== 'object') return out;
    for (const k of ALLOWED_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(data, k)) out[k] = data[k];
    }
    return out;
}

const isUserSubreddit = (name) => typeof name === 'string' && /^u_/i.test(name);

/**
 * Why a stored or listed submission must be treated as deleted, or null.
 * @param {{ kind?: string, data?: object }|null} thing  a Reddit "thing"
 * @returns {string|null}
 */
function deletionSignal(thing) {
    if (!thing || typeof thing !== 'object' || thing.kind !== 't3' || !thing.data || typeof thing.data !== 'object') {
        return 'not a readable t3 submission (treated as deleted)';
    }
    const d = pickAllowed(thing.data);
    for (const k of ['title', 'selftext']) {
        if (typeof d[k] === 'string' && DELETED_MARKERS.includes(d[k].trim())) return `${k} is ${d[k].trim()}`;
    }
    if (d.removed_by_category !== undefined && d.removed_by_category !== null && d.removed_by_category !== '') {
        return 'removed_by_category is set';
    }
    if (d.subreddit_type !== 'public') {
        return `subreddit_type is ${d.subreddit_type === undefined ? 'missing' : `'${String(d.subreddit_type).slice(0, 20)}'`}`;
    }
    if (d.over_18 === true) return 'marked over_18';
    return null;
}

/**
 * One listing child → collector item, or a drop reason.
 * @param {{ kind: string, data: object }} thing
 * @returns {{ item: object|null, drop: string|null }}
 */
function mapSubmission(thing) {
    const gone = deletionSignal(thing);
    if (gone) return { item: null, drop: gone };
    const d = pickAllowed(thing.data);
    if (typeof d.name !== 'string' || !FULLNAME_RE.test(d.name)) return { item: null, drop: 'no t3 fullname' };
    if (isUserSubreddit(d.subreddit)) return { item: null, drop: 'posted to a user profile' };
    if (typeof d.subreddit !== 'string' || !SUBREDDIT_RE.test(d.subreddit)) return { item: null, drop: 'no subreddit' };
    // The permalink is the canonical URL: it names the subreddit, the post id
    // and a title slug, never a user (research §4).
    const url = typeof d.permalink === 'string' && PERMALINK_RE.test(d.permalink)
        ? `https://www.reddit.com${d.permalink}`
        : `https://www.reddit.com/r/${d.subreddit}/comments/${d.name.slice(3)}/`;
    return {
        item: {
            id: d.name,
            title: typeof d.title === 'string' ? d.title : '',
            text: typeof d.selftext === 'string' ? d.selftext : '',
            url,
            publishedAt: typeof d.created_utc === 'number' ? d.created_utc : null,
            subreddit: d.subreddit,
        },
        drop: null,
    };
}

/** The Reddit fullname stored in an external id ("<route>:t3_abc"), or null. */
function fullnameOf(externalId) {
    const m = String(externalId || '').match(EXTERNAL_ID_RE);
    return m ? m[1] : null;
}

module.exports = {
    ALLOWED_FIELDS, DELETED_MARKERS, FULLNAME_RE, SUBREDDIT_RE, pickAllowed, deletionSignal, mapSubmission,
    fullnameOf, isUserSubreddit,
};
