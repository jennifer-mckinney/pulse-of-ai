// src/collectors/base.js
// Collector interface and the generic base classes (strategy / adapter
// pattern). One collector instance = one registry ROUTE of one source.
//
//   collect() = fetchItems() → normalise (allowlisted payload, city-level
//               location — src/collectors/normalize.js) → drop items older
//               than maxAgeDays → AI scope filter (routes with scope
//               'filter') → dedupe within the batch
//
// Subclasses implement fetchItems() only:
//   RssAtomCollector   RSS 2.0 / Atom via rss-parser, conditional GET,
//                      robots.txt-gated (publisher sites), optional
//                      <generator> requirement (Substack), geotags
//   JsonApiCollector   documented JSON APIs (not robots-gated: their terms
//                      and rate limits govern); adapters in ./adapters
//   BulkFileCollector  approved datasets delivered as JSON-lines files
//
// Every request goes through ctx.http (src/collectors/http.js): the
// User-Agent, per-host spacing from the registry's rateLimit, retries,
// timeouts and robots are enforced there.

'use strict';

const fs = require('fs');
const path = require('path');
const Parser = require('rss-parser');
const { toPayload } = require('./normalize');
const { isAiRelated } = require('./ai-filter');
const { GateClosedError } = require('./errors');

const DEFAULT_MAX_AGE_DAYS = 7;
const nonEmpty = v => typeof v === 'string' && v.trim() !== '';

class Collector {
    /** Publisher-site routes check robots.txt before every request. */
    static get robotsGated() { return false; }

    /**
     * @param {object} ctx
     * @param {object} ctx.source  registry entry
     * @param {object} ctx.route   registry route
     * @param {object} ctx.env
     * @param {import('./http').HttpClient} ctx.http
     * @param {object} [ctx.cursor]     this route's persisted cursor (mutable)
     * @param {object} [ctx.httpCache]  url → validators (mutable)
     * @param {Function} [ctx.now]
     */
    constructor(ctx) {
        this.source = ctx.source;
        this.route = ctx.route;
        this.env = ctx.env || process.env;
        this.http = ctx.http;
        this.cursor = ctx.cursor || {};
        this.httpCache = ctx.httpCache || {};
        this.now = ctx.now || (() => Date.now());
        this.params = this.route.params || {};
        // Every required env var must be present — defense in depth behind
        // the registry gate (sourceStatus); the blocked-4 rely on this.
        const missing = (this.route.requires || []).filter(k => !nonEmpty(this.env[k]));
        if (missing.length) {
            throw new GateClosedError(`${this.source.slug}/${this.route.id}: refusing to run without ${missing.join(', ')}`,
                { missing });
        }
    }

    /** Request options shared by every call of this collector. */
    requestOptions(extra = {}) {
        const robotsLiteral = this.source.robots && nonEmpty(this.env[this.source.robots.literalWhenEnv]);
        return {
            minIntervalMs: this.source.rateLimit ? this.source.rateLimit.minIntervalMs : 1000,
            robots: this.constructor.robotsGated,
            robotsConservative: !robotsLiteral,
            ...extra,
        };
    }

    get(url, extra) {
        return this.http.request(url, this.requestOptions(extra));
    }

    getJson(url, extra) {
        return this.http.json(url, this.requestOptions(extra));
    }

    /** @abstract @returns {Promise<object[]>} adapter items */
    async fetchItems() {
        throw new Error(`${this.constructor.name}.fetchItems is not implemented`);
    }

    /**
     * @returns {Promise<{ payloads: object[], fetched: number, dropped: object }>}
     */
    async collect() {
        const items = await this.fetchItems();
        const maxAgeDays = this.params.maxAgeDays || DEFAULT_MAX_AGE_DAYS;
        const cutoff = this.now() - maxAgeDays * 86400000;
        const dropped = { invalid: 0, old: 0, outOfScope: 0, duplicate: 0 };
        const seen = new Set();
        const payloads = [];
        for (const item of items) {
            const p = toPayload(item, this.source, this.route);
            if (!p) { dropped.invalid++; continue; }
            if (p.published_at && Date.parse(p.published_at) < cutoff) { dropped.old++; continue; }
            if (this.route.scope === 'filter' && !isAiRelated(p.text)) { dropped.outOfScope++; continue; }
            if (seen.has(p.id)) { dropped.duplicate++; continue; }
            seen.add(p.id);
            payloads.push(p);
        }
        return { payloads, fetched: items.length, dropped };
    }
}

// ─── RSS / Atom ──────────────────────────────────────────────────────────────

const parser = new Parser({
    customFields: {
        feed: ['generator'],
        item: [['geo:lat', 'geoLat'], ['geo:long', 'geoLong'], ['georss:point', 'geoPoint']],
    },
});

/** Map one rss-parser item to an adapter item. */
function rssItem(it) {
    let geo = null;
    if (it.geoLat && it.geoLong) geo = { lat: it.geoLat, lng: it.geoLong };
    else if (typeof it.geoPoint === 'string') {
        const [lat, lng] = it.geoPoint.trim().split(/\s+/);
        geo = { lat, lng };
    }
    return {
        id: it.guid || it.id || it.link,
        title: it.title,
        text: it.contentSnippet || it.summary || it.content || '',
        url: it.link,
        publishedAt: it.isoDate || it.pubDate || it.published,
        geo,
    };
}

class RssAtomCollector extends Collector {
    static get robotsGated() { return true; }

    /** Feed URLs this collector reads. */
    feedUrls() {
        return this.params.urls || [];
    }

    async parse(xml) {
        return parser.parseString(xml);
    }

    async fetchItems() {
        const out = [];
        const errors = [];
        for (const url of this.feedUrls()) {
            try {
                const res = await this.get(url, { cache: this.httpCache, headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' } });
                if (res.notModified) continue;
                const feed = await this.parse(res.body);
                if (this.params.requireGenerator
                    && !String(feed.generator || '').toLowerCase().includes(this.params.requireGenerator.toLowerCase())) {
                    errors.push(`${url}: feed generator is not ${this.params.requireGenerator} — skipped`);
                    continue;
                }
                for (const it of feed.items || []) {
                    const item = rssItem(it);
                    if (!this.params.geo) item.geo = null;
                    out.push(item);
                }
            } catch (err) {
                // One broken feed of a multi-feed source must not hide the
                // others; a refusal (robots, 401/403) of the only feed still
                // surfaces as the run's error.
                if (this.feedUrls().length === 1) throw err;
                errors.push(`${url}: ${err.message}`);
            }
        }
        if (errors.length && out.length === 0 && errors.length === this.feedUrls().length) {
            throw new Error(errors.join('; '));
        }
        this.warnings = errors;
        return out;
    }
}

// ─── JSON APIs ────────────────────────────────────────────────────────────────

class JsonApiCollector extends Collector {
    /** @returns {string} env value (only called for required/optional env) */
    envValue(name) {
        return nonEmpty(this.env[name]) ? this.env[name].trim() : null;
    }
}

// ─── Bulk files (approved datasets) ──────────────────────────────────────────

class BulkFileCollector extends Collector {
    /** Env var naming the file or directory of JSON-lines files. */
    get pathEnv() {
        throw new Error(`${this.constructor.name}.pathEnv is not implemented`);
    }

    /** Map one JSON record to an adapter item (subclasses narrow it). */
    mapRecord(rec) {
        return {
            id: rec.id,
            title: rec.title,
            text: rec.text || rec.abstract || rec.description || '',
            url: rec.url,
            publishedAt: rec.published_at || rec.creation_time || rec.date,
        };
    }

    /** Filter hook for records (e.g. one Meta product of a shared export). */
    accepts() {
        return true;
    }

    listFiles() {
        const p = this.env[this.pathEnv].trim();
        const stat = fs.statSync(p);
        if (stat.isFile()) return [p];
        return fs.readdirSync(p).filter(f => /\.(jsonl|ndjson|json)$/i.test(f)).sort().map(f => path.join(p, f));
    }

    async fetchItems() {
        const out = [];
        const seenFiles = this.cursor.files || {};
        for (const file of this.listFiles()) {
            const mtime = fs.statSync(file).mtimeMs;
            if (seenFiles[file] === mtime) continue;   // unchanged since the last run
            const text = fs.readFileSync(file, 'utf8');
            const records = /\.json$/i.test(file) && text.trim().startsWith('[')
                ? JSON.parse(text)
                : text.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
            for (const rec of records) if (this.accepts(rec)) out.push(this.mapRecord(rec));
            seenFiles[file] = mtime;
        }
        this.cursor.files = seenFiles;
        return out;
    }
}

module.exports = {
    Collector,
    RssAtomCollector,
    JsonApiCollector,
    BulkFileCollector,
    rssItem,
    DEFAULT_MAX_AGE_DAYS,
};
