// src/collectors/adapters/reddit.js
// Reddit (#52, Forums): the approved Reddit Data API only
// (src/collectors/reddit/api.js — client-credentials OAuth, oauth.reddit.com,
// Reddit's User-Agent, the shared request budget). No reddit.com page is
// ever fetched; the route is closed until Reddit approves the app and all
// four REDDIT_* variables are set (the registry gate, GateClosedError here).
//
// One run: the current selection (src/collectors/reddit/selection.js — the 7
// highest-subscriber subreddits mentioning AI, or the provisional list before
// the first API ranking), then /r/{sub}/new?limit=100 for each, newest first.
// The run's budget share is split evenly across the subreddits
// (budget.pagesPerSubreddit, at most params.maxPagesPerSubreddit pages each);
// a subreddit pages on only while every post is newer than its cursor. The
// collector framework then applies the same AI filter as every site-wide
// feed (route scope 'filter'), the 48 h age cap (params.maxAgeDays 2, the
// retention window) and the payload allowlist.
//
// Items come from ../reddit/fields.js mapSubmission: allowlisted fields only
// (no author, author_fullname or any user field), the username-free
// permalink as the canonical URL, t3_<id> as the upstream id. NSFW,
// non-public, user-profile and deleted or removed posts are dropped.
// Reddit has no post location: region 'global', homeCity null, so the
// stored location is empty and location_basis null (none).

'use strict';

const { JsonApiCollector } = require('../base');
const { RedditApi } = require('../reddit/api');
const { mapSubmission, SUBREDDIT_RE } = require('../reddit/fields');
const { DbBudget, BudgetExhaustedError, pagesPerSubreddit } = require('../reddit/budget');
const { loadSelection, TOP_N } = require('../reddit/selection');
const { collectWindowMs } = require('../../config/source-registry');

class RedditCollector extends JsonApiCollector {
    constructor(ctx) {
        super(ctx);
        // Injectable for tests; the defaults share state through the database.
        this.budget = ctx.redditBudget || new DbBudget();
        this.selectionLoader = ctx.redditSelection || (() => loadSelection());
        this.api = new RedditApi({
            http: this.http, env: this.env, budget: this.budget, now: this.now,
            requestOptions: extra => this.requestOptions(extra),
        });
        this.drops = {};
        this.budgetExhausted = false;
    }

    async fetchItems() {
        const selection = await this.selectionLoader();
        const subs = (selection.subreddits || []).filter(s => SUBREDDIT_RE.test(s)).slice(0, TOP_N);
        this.selectionBasis = selection.basis;
        const pages = pagesPerSubreddit(subs.length, {
            cadenceMs: collectWindowMs(this.env), maxPages: this.params.maxPagesPerSubreddit || 3,
        });
        const since = this.cursor.since && typeof this.cursor.since === 'object' ? this.cursor.since : {};
        const items = [];
        for (const sub of subs) {
            let after = null;
            let newest = since[sub] || 0;
            try {
                for (let page = 0; page < pages; page++) {
                    const params = { limit: String(this.params.limit || 100) };
                    if (after) params.after = after;
                    const listing = await this.api.listing(`/r/${sub}/new`, params);
                    let reachedCursor = false;
                    for (const child of listing.children) {
                        const { item, drop } = mapSubmission(child);
                        if (!item) {
                            this.drops[drop] = (this.drops[drop] || 0) + 1;
                            continue;
                        }
                        if (item.publishedAt && item.publishedAt <= (since[sub] || 0)) reachedCursor = true;
                        newest = Math.max(newest, item.publishedAt || 0);
                        items.push(item);
                    }
                    after = listing.after;
                    if (!after || reachedCursor) break;
                }
            } catch (err) {
                // The budget said stop: keep what was read, resume next run.
                if (err instanceof BudgetExhaustedError) { this.budgetExhausted = true; break; }
                throw err;
            }
            if (newest) since[sub] = newest;
        }
        // Only the current selection's cursors are kept.
        this.cursor.since = Object.fromEntries(subs.filter(s => since[s]).map(s => [s, since[s]]));
        return items;
    }
}

module.exports = { RedditCollector };
