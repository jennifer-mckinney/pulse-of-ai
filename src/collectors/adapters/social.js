// src/collectors/adapters/social.js
// Social-platform adapters: YouTube Data API, TikTok Research API, X API v2
// and the Meta Content Library bulk loader (WhatsApp, Instagram, Facebook).
// Author, channel and account fields are never mapped into items.

'use strict';

const path = require('path');
const { JsonApiCollector, BulkFileCollector } = require('../base');

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

/** YouTube: search.list (100/day quota → 15-min cadence) + videos.list for full descriptions. */
class YouTubeCollector extends JsonApiCollector {
    async fetchItems() {
        const key = this.envValue('YOUTUBE_API_KEY');
        const after = this.cursor.publishedAfter || new Date(this.now() - 86400000).toISOString();
        const q = new URLSearchParams({
            part: 'snippet', type: 'video', order: 'date', q: this.params.query,
            maxResults: String(this.params.maxResults || 25), publishedAfter: after, key,
        });
        const search = await this.getJson(`https://www.googleapis.com/youtube/v3/search?${q}`);
        const ids = (search.data.items || []).map(i => i.id && i.id.videoId).filter(Boolean);
        if (ids.length === 0) return [];
        const v = new URLSearchParams({ part: 'snippet', id: ids.join(','), key });
        const videos = await this.getJson(`https://www.googleapis.com/youtube/v3/videos?${v}`);
        const items = (videos.data.items || []).map(vid => ({
            id: vid.id,
            title: vid.snippet.title,
            text: vid.snippet.description,
            url: `https://www.youtube.com/watch?v=${vid.id}`,
            publishedAt: vid.snippet.publishedAt,
            language: (vid.snippet.defaultAudioLanguage || vid.snippet.defaultLanguage || 'en').slice(0, 2),
        }));
        const newest = items.map(i => i.publishedAt).filter(Boolean).sort().pop();
        if (newest) this.cursor.publishedAfter = newest;
        return items;
    }
}

/** TikTok Research API: client-credentials token, then video query. */
class TikTokResearchCollector extends JsonApiCollector {
    async fetchItems() {
        const token = await this.http.json('https://open.tiktokapis.com/v2/oauth/token/', this.requestOptions({
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_key: this.envValue('TIKTOK_RESEARCH_CLIENT_KEY'),
                client_secret: this.envValue('TIKTOK_RESEARCH_CLIENT_SECRET'),
                grant_type: 'client_credentials',
            }).toString(),
        }));
        const fields = 'id,video_description,voice_to_text,create_time,region_code';
        const res = await this.http.json(`https://open.tiktokapis.com/v2/research/video/query/?fields=${fields}`, this.requestOptions({
            method: 'POST',
            headers: { Authorization: `Bearer ${token.data.access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: { and: [{ operation: 'IN', field_name: 'keyword', field_values: this.params.keywords }] },
                start_date: ymd(this.now() - 86400000),
                end_date: ymd(this.now()),
                max_count: this.params.maxCount || 50,
            }),
        }));
        const videos = (res.data && res.data.data && res.data.data.videos) || [];
        // username is never requested; region_code is country-level only, so
        // no city is derived from it.
        return videos.map(v => ({
            id: v.id,
            title: '',
            text: [v.video_description, v.voice_to_text].filter(Boolean).join('\n\n'),
            url: null,
            publishedAt: v.create_time,
        }));
    }
}

/** X API v2 recent search (pay-per-use): since_id keeps each post read once. */
class XRecentSearchCollector extends JsonApiCollector {
    async fetchItems() {
        const q = new URLSearchParams({
            query: this.params.query,
            max_results: String(Math.max(10, this.params.maxResults || 20)),
            'tweet.fields': 'created_at,lang',
        });
        if (this.cursor.sinceId) q.set('since_id', this.cursor.sinceId);
        const res = await this.getJson(`https://api.x.com/2/tweets/search/recent?${q}`, {
            headers: { Authorization: `Bearer ${this.envValue('X_BEARER_TOKEN')}` },
        });
        const data = res.data.data || [];
        if (res.data.meta && res.data.meta.newest_id) this.cursor.sinceId = res.data.meta.newest_id;
        // author_id is never requested; the link uses the handle-free /i/web form.
        return data.map(t => ({
            id: t.id, title: '', text: t.text, url: `https://x.com/i/web/status/${t.id}`,
            publishedAt: t.created_at, language: t.lang,
        }));
    }
}

/**
 * Meta Content Library: loads exports produced inside Meta's approved
 * research environment (JSON lines). One export directory can hold all
 * three products; each source keeps only its own (record.product or a file
 * name starting with the product).
 */
class MetaContentLibraryCollector extends BulkFileCollector {
    get pathEnv() { return 'META_CONTENT_LIBRARY_EXPORT_DIR'; }

    listFiles() {
        // Files named for another product are skipped; unnamed files are
        // filtered record by record (accepts()).
        const product = this.params.product;
        return super.listFiles().filter((f) => {
            const base = path.basename(f);
            return base.startsWith(product) || !/^(whatsapp|instagram|facebook)/.test(base);
        });
    }

    accepts(rec) {
        return !rec.product || rec.product === this.params.product;
    }

    mapRecord(rec) {
        return {
            id: rec.id,
            title: '',
            text: rec.text || rec.caption || rec.message || '',
            url: null,
            publishedAt: rec.creation_time || rec.timestamp,
            language: rec.lang,
        };
    }
}

module.exports = { YouTubeCollector, TikTokResearchCollector, XRecentSearchCollector, MetaContentLibraryCollector };
