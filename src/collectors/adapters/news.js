// src/collectors/adapters/news.js
// Licensed / paid news adapters. The free feeds of ruling 4 use the generic
// RssAtomCollector; these run only when their key or licence env is set:
//   NYT Article Search (paid tier), Guardian Content API (commercial key),
//   AP Media API, Reuters Connect (OAuth + GraphQL), and the contract-feed
//   adapter used by CNN Wire Store and the Dow Jones feed.
// Byline / author fields are never mapped.

'use strict';

const { JsonApiCollector, RssAtomCollector, rssItem } = require('../base');

class NytArticleSearchCollector extends JsonApiCollector {
    async fetchItems() {
        const q = new URLSearchParams({
            fq: `subject:("${this.params.subject}")`, sort: 'newest', 'api-key': this.envValue('NYT_API_KEY'),
        });
        const res = await this.getJson(`https://api.nytimes.com/svc/search/v2/articlesearch.json?${q}`);
        const docs = (res.data.response && res.data.response.docs) || [];
        return docs.map(d => {
            const place = (d.keywords || []).find(k => k.name === 'glocations');
            return {
                id: d._id || d.uri,
                title: d.headline && d.headline.main,
                text: d.abstract || d.snippet || d.lead_paragraph,
                url: d.web_url,
                publishedAt: d.pub_date,
                // Content-level: the article's own geographic keyword, kept
                // only when it names a registry city.
                city: place ? String(place.value).split(/[(,]/)[0].trim() : null,
            };
        });
    }
}

class GuardianContentApiCollector extends JsonApiCollector {
    async fetchItems() {
        const q = new URLSearchParams({
            tag: this.params.tag, 'show-fields': 'trailText', 'order-by': 'newest', 'page-size': '30',
            'api-key': this.envValue('GUARDIAN_API_KEY'),
        });
        const res = await this.getJson(`https://content.guardianapis.com/search?${q}`);
        const results = (res.data.response && res.data.response.results) || [];
        return results.map(r => ({
            id: r.id, title: r.webTitle, text: r.fields && r.fields.trailText,
            url: r.webUrl, publishedAt: r.webPublicationDate,
        }));
    }
}

class ApMediaCollector extends JsonApiCollector {
    async fetchItems() {
        const q = new URLSearchParams({ q: this.params.query, page_size: String(this.params.pageSize || 50) });
        const res = await this.getJson(`https://api.ap.org/media/v/content/search?${q}`, {
            headers: { 'x-api-key': this.envValue('AP_API_KEY') },
        });
        const items = (res.data.data && res.data.data.items) || [];
        return items.map(({ item }) => ({
            id: (item.altids && item.altids.itemid) || item.uri,
            title: item.headline,
            text: item.headline_extended || item.description_summary || '',
            url: null,
            publishedAt: item.firstcreated,
        }));
    }
}

/**
 * Reuters Connect: OAuth client credentials, then a GraphQL search. Token
 * and API URLs default to the documented endpoints and can be overridden
 * from the contract (REUTERS_CONNECT_TOKEN_URL / _API_URL). Tested against
 * a fixture only — the schema is unverified without a contract.
 */
class ReutersConnectCollector extends JsonApiCollector {
    async fetchItems() {
        const tokenUrl = this.envValue('REUTERS_CONNECT_TOKEN_URL') || 'https://auth.thomsonreuters.com/oauth/token';
        const apiUrl = this.envValue('REUTERS_CONNECT_API_URL') || 'https://api.reutersconnect.com/content/graphql';
        const token = await this.http.json(tokenUrl, this.requestOptions({
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
                client_id: this.envValue('REUTERS_CONNECT_CLIENT_ID'),
                client_secret: this.envValue('REUTERS_CONNECT_CLIENT_SECRET'),
            }).toString(),
        }));
        const query = 'query Search($q: String!, $limit: Int) { search(query: $q, limit: $limit) '
            + '{ items { versionedGuid headLine fragment firstCreated } } }';
        const res = await this.http.json(apiUrl, this.requestOptions({
            method: 'POST',
            headers: { Authorization: `Bearer ${token.data.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables: { q: this.params.query, limit: this.params.limit || 50 } }),
        }));
        const items = (res.data.data && res.data.data.search && res.data.data.search.items) || [];
        return items.map(i => ({
            id: i.versionedGuid, title: i.headLine, text: i.fragment, url: null, publishedAt: i.firstCreated,
        }));
    }
}

/**
 * Contract delivery feed (CNN Wire Store, Dow Jones): the URL and credential
 * come from the contract via env. RSS/Atom or JSON ({ items | articles | data }
 * array) are both accepted. Env names come from the route's `requires`:
 * the *_FEED_URL is the endpoint; *_API_KEY (if set) is sent as a Bearer token.
 */
class LicensedFeedCollector extends RssAtomCollector {
    static get robotsGated() { return false; }

    get feedEnv() { return (this.route.requires || []).find(k => k.endsWith('_FEED_URL')); }

    get keyEnv() {
        return [...(this.route.requires || []), ...(this.route.optional || [])].find(k => k.endsWith('_API_KEY'));
    }

    async fetchItems() {
        const url = this.env[this.feedEnv].trim();
        const key = this.keyEnv && this.env[this.keyEnv] ? this.env[this.keyEnv].trim() : null;
        const res = await this.get(url, { cache: this.httpCache, headers: key ? { Authorization: `Bearer ${key}` } : {} });
        if (res.notModified) return [];
        if (res.body.trim().startsWith('<')) {
            const feed = await this.parse(res.body);
            return (feed.items || []).map(rssItem);
        }
        const data = JSON.parse(res.body);
        const list = Array.isArray(data) ? data : (data.items || data.articles || data.data || []);
        return list.map(a => ({
            id: a.id || a.guid || a.url || a.link,
            title: a.title || a.headline,
            text: a.summary || a.description || a.abstract || a.snippet || '',
            url: a.url || a.link,
            publishedAt: a.published || a.published_at || a.pubDate || a.date,
        }));
    }
}

module.exports = {
    NytArticleSearchCollector, GuardianContentApiCollector, ApMediaCollector,
    ReutersConnectCollector, LicensedFeedCollector,
};
