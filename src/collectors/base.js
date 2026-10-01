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
const { GateClosedError, ParseError } = require('./errors');
const { routeAllowedHosts } = require('../config/source-registry');
const { ResponseTooLargeError } = require('./transport');
const { checkUrl } = require('./netguard');
const { provenanceKey } = require('./provenance');

const DEFAULT_MAX_AGE_DAYS = 7;

/**
 * F10-15: feeds never need a DTD. A body that declares one WITH entity
 * declarations (external entities, "billion laughs") is refused before any
 * XML parser sees it. The parsers in use (sax via rss-parser and xml2js)
 * do not expand them today; this keeps it that way whatever they become.
 * @throws {ParseError}
 */
function rejectDtdEntities(xml) {
    const head = String(xml || '');
    if (/<!DOCTYPE/i.test(head) && /<!ENTITY/i.test(head)) {
        throw new ParseError('refused: the document declares a DTD with entities');
    }
    return xml;
}
// F10-4: one dataset file is read whole, so it is capped (route
// params.maxFileBytes overrides). A larger delivery must be split.
const BULK_MAX_FILE_BYTES = 50 * 1024 * 1024;
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
        // G10-6: per-feed / per-item problems that did not stop the route.
        // Each is { text, err } (err classifies it); the runner surfaces
        // them into the run's errors, last_error and status, and a refusal
        // among them puts the source in the refused state (F10-5).
        this.warnings = [];
        // Every required env var must be present — defense in depth behind
        // the registry gate (sourceStatus); the blocked-4 rely on this.
        const missing = (this.route.requires || []).filter(k => !nonEmpty(this.env[k]));
        if (missing.length) {
            throw new GateClosedError(`${this.source.slug}/${this.route.id}: refusing to run without ${missing.join(', ')}`,
                { missing });
        }
    }

    /**
     * An endpoint URL taken from env (a contract feed, a token endpoint):
     * it must be https on a public host (F10-11), else the collector refuses
     * to run — GateClosedError, before any network call.
     * @param {string} name  env var
     * @returns {string|null} the trimmed URL, or null when unset
     */
    envUrl(name) {
        const v = nonEmpty(this.env[name]) ? this.env[name].trim() : null;
        if (v === null) return null;
        try {
            checkUrl(v);
        } catch (err) {
            throw new GateClosedError(`${this.source.slug}/${this.route.id}: ${name} must be an https URL on a public host (${err.message})`);
        }
        return v;
    }

    /**
     * Request options shared by every call of this collector: politeness,
     * robots, the route's allowed hosts (F10-2: every hop must stay on them)
     * and the route's response-size cap (F10-4; default in transport.js).
     */
    requestOptions(extra = {}) {
        const robotsLiteral = this.source.robots && nonEmpty(this.env[this.source.robots.literalWhenEnv]);
        return {
            minIntervalMs: this.source.rateLimit ? this.source.rateLimit.minIntervalMs : 1000,
            robots: this.constructor.robotsGated,
            robotsConservative: !robotsLiteral,
            allowedHosts: routeAllowedHosts(this.route, this.env),
            ...(this.route.maxResponseBytes ? { maxBytes: this.route.maxResponseBytes } : {}),
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

    /** Record a problem that did not stop the route (G10-6). */
    warn(text, err = null) {
        this.warnings.push({ text: String(text), err });
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
        const key = provenanceKey(this.env);   // D2 provenance / F10-14 id fingerprints
        for (const item of items) {
            const p = toPayload(item, this.source, this.route, { key });
            if (!p) { dropped.invalid++; continue; }
            if (p.published_at && Date.parse(p.published_at) < cutoff) { dropped.old++; continue; }
            if (this.route.scope === 'filter' && !isAiRelated(p.text)) { dropped.outOfScope++; continue; }
            if (seen.has(p.id)) { dropped.duplicate++; continue; }
            seen.add(p.id);
            payloads.push(p);
        }
        return { payloads, fetched: items.length, dropped, warnings: this.warnings.slice() };
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

    /**
     * Parse an RSS / Atom body. A failure is a ParseError whose message never
     * quotes the body (F10-13); the parser's own message goes to `detail`,
     * which the runner writes only to the (scrubbed) server log.
     */
    async parse(xml) {
        rejectDtdEntities(xml);
        try {
            return await parser.parseString(xml);
        } catch (err) {
            throw new ParseError('feed parse error (RSS/Atom)', { detail: String(err && err.message).slice(0, 200) });
        }
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
                    errors.push({ text: `${url}: feed generator is not ${this.params.requireGenerator} — skipped`,
                        err: new ParseError('unexpected feed generator') });
                    continue;
                }
                for (const it of feed.items || []) {
                    const item = rssItem(it);
                    if (!this.params.geo) item.geo = null;
                    out.push(item);
                }
            } catch (err) {
                // One broken feed of a multi-feed source must not hide the
                // others; the only feed's failure is the run's error.
                if (this.feedUrls().length === 1) throw err;
                errors.push({ text: `${url}: ${err.message}`, err });
            }
        }
        if (errors.length && out.length === 0 && errors.length === this.feedUrls().length) {
            // Every feed failed: throw the MOST SIGNIFICANT error (a refusal
            // first) with every feed's text, so the classification survives
            // (G10-6: a joined plain Error used to classify as 'internal').
            const { classifyError } = require('./errors');
            // Grumpy #6: a feed NOT requested (its host backing off) never
            // hides a real failure of another feed.
            const lead = errors.find(e => ['access_denied', 'robots'].includes(classifyError(e.err).error_kind))
                || errors.find(e => !(e.err && e.err.held === true)) || errors[0];
            const cls = classifyError(lead.err);
            const le = lead.err || {};
            throw Object.assign(new Error(errors.map(e => e.text).join('; ')), {
                kind: cls.error_kind, status: cls.http_status, detail: le.detail,
                // A rate limit's details survive (its host, time, signal and
                // allow-listed headers) for the run row and the hold.
                ...(cls.error_kind === 'rate_limited'
                    ? { host: le.host, retryAt: le.retryAt, signal: le.signal, ...(le.headers ? { headers: le.headers } : {}) } : {}),
                // Diagnosis 2026-10-01: every feed's host was still backing
                // off — nothing was requested, so this is a skip, not a failure.
                ...(errors.every(e => e.err && e.err.held === true) ? { held: true } : {}),
            });
        }
        for (const e of errors) this.warn(e.text, e.err);
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
        const cap = this.params.maxFileBytes || BULK_MAX_FILE_BYTES;
        for (const file of this.listFiles()) {
            const stat = fs.statSync(file);
            const mtime = stat.mtimeMs;
            if (seenFiles[file] === mtime) continue;   // unchanged since the last run
            if (stat.size > cap) {
                throw new ResponseTooLargeError(`dataset file ${path.basename(file)} is ${stat.size} bytes, over the ${cap}-byte cap — split the delivery`);
            }
            const text = fs.readFileSync(file, 'utf8');
            let records;
            try {
                records = /\.json$/i.test(file) && text.trim().startsWith('[')
                    ? JSON.parse(text)
                    : text.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
            } catch (err) {
                // The file path is an operator setting and the parser quotes
                // the record: neither goes into the stored error (F10-13).
                throw new ParseError('dataset parse error (JSON lines)', { detail: String(err && err.message).slice(0, 200) });
            }
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
    rejectDtdEntities,
    DEFAULT_MAX_AGE_DAYS,
    BULK_MAX_FILE_BYTES,
};
