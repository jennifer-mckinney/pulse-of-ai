// src/collectors/adapters/forums.js
// Forum adapters: Stack Exchange API 2.3 (Stack Overflow + AI Stack
// Exchange) and Hacker News via Algolia search. Owners / authors are never
// mapped; /users and /user endpoints are never called.

'use strict';

const { JsonApiCollector } = require('../base');

class StackExchangeCollector extends JsonApiCollector {
    async fetchItems() {
        // Honour the API's `backoff` (seconds) from the previous run.
        if (this.cursor.backoffUntil && this.now() < this.cursor.backoffUntil) return [];
        const items = [];
        for (const s of this.params.sites) {
            const q = new URLSearchParams({
                order: 'desc', sort: 'creation', site: s.site, pagesize: String(this.params.pageSize || 30), filter: 'withbody',
            });
            if (s.tagged) q.set('tagged', s.tagged);
            if (this.envValue('STACKEXCHANGE_KEY')) q.set('key', this.envValue('STACKEXCHANGE_KEY'));
            const res = await this.getJson(`https://api.stackexchange.com/2.3/questions?${q}`);
            if (res.data.backoff) this.cursor.backoffUntil = this.now() + res.data.backoff * 1000;
            for (const it of res.data.items || []) {
                items.push({
                    id: `${s.site}-${it.question_id}`, title: it.title, text: it.body || '',
                    url: it.link, publishedAt: it.creation_date,
                });
            }
            if (res.data.backoff) break;
        }
        return items;
    }
}

class HnAlgoliaCollector extends JsonApiCollector {
    async fetchItems() {
        const q = new URLSearchParams({
            query: this.params.query, tags: this.params.tags, hitsPerPage: String(this.params.hitsPerPage || 50),
        });
        if (this.cursor.since) q.set('numericFilters', `created_at_i>${this.cursor.since}`);
        const res = await this.getJson(`https://hn.algolia.com/api/v1/search_by_date?${q}`);
        const hits = res.data.hits || [];
        const newest = Math.max(this.cursor.since || 0, ...hits.map(h => h.created_at_i || 0));
        if (newest) this.cursor.since = newest;
        return hits.map(h => ({
            id: h.objectID,
            title: h.title,
            text: h.story_text || '',
            url: `https://news.ycombinator.com/item?id=${h.objectID}`,
            publishedAt: h.created_at_i,
        }));
    }
}

module.exports = { StackExchangeCollector, HnAlgoliaCollector };
