// src/collectors/adapters/academic.js
// Academic adapters: arXiv API (Atom), PubMed E-utilities, Springer Nature
// Meta API, ScienceDirect Search API, IEEE Xplore, JSTOR dataset loader and
// the Google Scholar alert-mailbox reader. Author names are never mapped.

'use strict';

const xml2js = require('xml2js');
const { Parser } = require('htmlparser2');
const { Collector, JsonApiCollector, BulkFileCollector, RssAtomCollector, rssItem, rejectDtdEntities } = require('../base');
const { findCity } = require('../../../public/js/config/cities.config.js');
const { htmlToText } = require('../normalize');
const { ParseError, HttpError } = require('../errors');
const { scrub } = require('../redact');

/** arXiv export API (Atom). One request per run; the API allows 1 per 3 s. */
class ArxivCollector extends RssAtomCollector {
    static get robotsGated() { return false; }

    async fetchItems() {
        const q = new URLSearchParams({
            search_query: this.params.searchQuery, sortBy: 'submittedDate', sortOrder: 'descending',
            max_results: String(this.params.maxResults || 50),
        });
        const res = await this.get(`https://export.arxiv.org/api/query?${q}`);
        const feed = await this.parse(res.body);
        return (feed.items || []).map(rssItem);
    }
}

const textOf = (node) => {
    if (node === undefined || node === null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(textOf).join(' ');
    if (typeof node === 'object') return textOf(node._ !== undefined ? node._ : Object.values(node).filter(v => typeof v !== 'object'));
    return String(node);
};

/** City from an institutional affiliation string ("Dept X, Univ Y, London, UK"). */
function affiliationCity(aff) {
    if (!aff) return null;
    for (const part of String(aff).split(',').map(s => s.replace(/\.$/, '').trim()).reverse()) {
        const c = findCity(part);
        if (c) return c.name;
    }
    return null;
}

/** PubMed E-utilities: esearch (last day, AI MeSH) → efetch XML in one batch. */
class PubmedCollector extends JsonApiCollector {
    common() {
        const p = new URLSearchParams({ tool: this.envValue('NCBI_TOOL') || 'pulse-of-ai' });
        if (this.envValue('NCBI_EMAIL')) p.set('email', this.envValue('NCBI_EMAIL'));
        if (this.envValue('NCBI_API_KEY')) p.set('api_key', this.envValue('NCBI_API_KEY'));
        return p;
    }

    async fetchItems() {
        const base = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
        const s = this.common();
        s.set('db', 'pubmed'); s.set('term', this.params.term); s.set('reldate', String(this.params.relDays || 1));
        s.set('datetype', 'edat'); s.set('retmax', String(this.params.retMax || 40)); s.set('retmode', 'json');
        s.set('sort', 'pub_date');
        const search = await this.getJson(`${base}/esearch.fcgi?${s}`);
        const ids = (search.data.esearchresult && search.data.esearchresult.idlist) || [];
        if (ids.length === 0) return [];
        const f = this.common();
        f.set('db', 'pubmed'); f.set('id', ids.join(',')); f.set('retmode', 'xml');
        const res = await this.get(`${base}/efetch.fcgi?${f}`);
        let doc;
        rejectDtdEntities(res.body);   // F10-15
        try {
            doc = await xml2js.parseStringPromise(res.body, { explicitArray: false });
        } catch (err) {
            throw new ParseError('PubMed efetch parse error (XML)', { detail: String(err && err.message).slice(0, 200) });
        }
        let articles = (doc.PubmedArticleSet && doc.PubmedArticleSet.PubmedArticle) || [];
        if (!Array.isArray(articles)) articles = [articles];
        return articles.map((a) => {
            const mc = a.MedlineCitation || {};
            const art = mc.Article || {};
            const pmid = textOf(mc.PMID);
            let authors = (art.AuthorList && art.AuthorList.Author) || [];
            if (!Array.isArray(authors)) authors = [authors];
            // Only the first author's INSTITUTIONAL affiliation is read, and
            // only to find a registry city in it; no name is ever read.
            const aff = authors[0] && authors[0].AffiliationInfo
                ? textOf([].concat(authors[0].AffiliationInfo)[0].Affiliation) : null;
            return {
                id: pmid,
                title: textOf(art.ArticleTitle),
                text: textOf(art.Abstract && art.Abstract.AbstractText),
                url: pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null,
                publishedAt: null,   // E-utilities entry date is within relDays by query
                city: affiliationCity(aff),
            };
        });
    }
}

class SpringerCollector extends JsonApiCollector {
    async fetchItems() {
        const q = new URLSearchParams({ q: this.params.query, p: String(this.params.pageSize || 25), api_key: this.envValue('SPRINGER_API_KEY') });
        const res = await this.getJson(`https://api.springernature.com/meta/v2/json?${q}`);
        return (res.data.records || []).map(r => ({
            id: r.doi || r.identifier,
            title: r.title,
            text: typeof r.abstract === 'string' ? r.abstract : textOf(r.abstract),
            url: Array.isArray(r.url) && r.url[0] ? r.url[0].value : null,
            publishedAt: r.publicationDate || r.onlineDate,
        }));
    }
}

class ElsevierCollector extends JsonApiCollector {
    async fetchItems() {
        const res = await this.http.json('https://api.elsevier.com/content/search/sciencedirect', this.requestOptions({
            method: 'PUT',
            headers: { 'X-ELS-APIKey': this.envValue('ELSEVIER_API_KEY'), 'Content-Type': 'application/json' },
            body: JSON.stringify({ qs: this.params.query, display: { show: this.params.show || 25, sortBy: 'date' } }),
        }));
        return (res.data.results || []).map(r => ({
            id: r.pii || r.doi, title: r.title, text: '', url: r.uri, publishedAt: r.publicationDate,
        }));
    }
}

class IeeeCollector extends JsonApiCollector {
    async fetchItems() {
        const q = new URLSearchParams({
            querytext: this.params.query, sort_field: 'publication_date', sort_order: 'desc',
            max_records: String(this.params.maxRecords || 25), apikey: this.envValue('IEEE_API_KEY'),
        });
        const res = await this.getJson(`https://ieeexploreapi.ieee.org/api/v1/search/articles?${q}`);
        return (res.data.articles || []).map(a => ({
            id: a.article_number || a.doi, title: a.title, text: a.abstract, url: a.html_url,
            publishedAt: a.insert_date ? `${a.insert_date.slice(0, 4)}-${a.insert_date.slice(4, 6)}-${a.insert_date.slice(6, 8)}` : null,
        }));
    }
}

/** JSTOR Text Analysis Support dataset (JSON lines delivered by JSTOR). */
class JstorDatasetCollector extends BulkFileCollector {
    get pathEnv() { return 'JSTOR_DATASET_PATH'; }

    mapRecord(r) {
        return {
            id: r.id || r.doi, title: r.title, text: r.abstract || r.text || '',
            url: r.url, publishedAt: r.publicationDate || r.published_date || r.datePublished,
        };
    }
}

// F10-3: the alert HTML is cut to this size before parsing (the message
// itself is capped at 2 MB by the IMAP reader, F10-4).
const SCHOLAR_HTML_CAP = 128 * 1024;

/**
 * Parse one Scholar alert email (HTML) into items. Each result is an <h3>
 * with the paper link followed by the author/venue line (never read) and a
 * snippet div (class gse_alrt_sni). Links are NOT followed or stored.
 * Tokenised with htmlparser2 in one linear pass (F10-3) — no regex over the
 * markup.
 */
function parseScholarAlert(html, date, messageId) {
    const blocks = [];
    let cur = null;
    let inA = 0;
    let inSnippet = 0;
    let divDepth = 0;
    const parser = new Parser({
        onopentag(name, attrs) {
            if (name === 'h3') {
                cur = { title: '', snippet: '', titleDone: false };
                blocks.push(cur);
            } else if (!cur) {
                return;
            } else if (name === 'a' && !cur.titleDone) {
                inA++;
            } else if (name === 'div') {
                if (inSnippet) divDepth++;
                else if (/(^|\s)gse_alrt_sni(\s|$)/.test(attrs.class || '')) { inSnippet = 1; divDepth = 0; }
            }
        },
        onclosetag(name) {
            if (!cur) return;
            if (name === 'a' && inA) { inA--; if (!inA) cur.titleDone = true; }
            else if (name === 'div' && inSnippet) {
                if (divDepth) divDepth--;
                else inSnippet = 0;
            }
        },
        ontext(t) {
            if (!cur) return;
            if (inA) cur.title += t;
            else if (inSnippet) cur.snippet += t;
        },
    }, { decodeEntities: true, lowerCaseTags: true });
    parser.write(String(html || '').slice(0, SCHOLAR_HTML_CAP));
    parser.end();
    const items = [];
    blocks.forEach((b, i) => {
        const title = b.title.replace(/\s+/g, ' ').trim();
        const snippet = b.snippet.replace(/\s+/g, ' ').trim();
        if (title) items.push({ id: `${messageId}#${i}`, title, text: snippet, url: null, publishedAt: date });
    });
    return items;
}

// F10-4 / F10-7: a Scholar alert is a few KB; a message over this size is
// skipped unread (its UID still advances the cursor).
const MAX_ALERT_BYTES = 2 * 1024 * 1024;
const SCHOLAR_SENDER = 'scholaralerts-noreply@google.com';
// The receiving server's verdict: DKIM passed for a google.com signature.
const DKIM_GOOGLE_RE = /(?:^|[;\s])dkim=pass\b[^;]{0,300}?\bheader\.(?:d=google\.com|i=[^;\s]{0,64}@google\.com)\b/i;

/**
 * F10-7: accept a message only when the TOPMOST Authentication-Results
 * header (the one the receiving server prepended — later ones can be
 * supplied by the sender) reports dkim=pass for google.com, and From is the
 * Scholar sender. A spoofed From: without Google's signature is dropped.
 * @param {object} mail  mailparser output
 */
function isAuthenticScholarAlert(mail) {
    const lines = Array.isArray(mail && mail.headerLines) ? mail.headerLines : [];
    const top = lines.find(h => h && h.key === 'authentication-results');
    if (!top || !DKIM_GOOGLE_RE.test(String(top.line || '').slice(0, 4096))) return false;
    const from = mail.from && Array.isArray(mail.from.value) ? mail.from.value : [];
    return from.length === 1 && String(from[0].address || '').toLowerCase() === SCHOLAR_SENDER;
}

/** An IMAP failure with no server text in its message (F10-7); detail is scrubbed. */
function imapError(stage, err, env) {
    const code = (err && (err.code || err.serverResponseCode || err.name)) || 'error';
    return new HttpError(`IMAP ${stage} failed (${String(code).replace(/[^\w.-]/g, '').slice(0, 40)})`, {
        kind: 'network', detail: scrub(String((err && err.message) || ''), env).slice(0, 500),
    });
}

/**
 * Google Scholar alert mailbox over IMAP (the only official automated
 * delivery). Reads messages from scholaralerts-noreply@google.com newer
 * than the last UID seen. `ctx.imapFactory` is injectable for tests.
 *
 * F10-7: TLS 1.2+ with certificate verification, messages over 2 MB skipped
 * before download, DKIM (google.com) required, logout always attempted
 * (G10-20), and IMAP errors reported without server text.
 */
class ScholarImapCollector extends Collector {
    constructor(ctx) {
        super(ctx);
        this.imapFactory = ctx.imapFactory || ((opts) => new (require('imapflow').ImapFlow)(opts));
    }

    async fetchItems() {
        const { simpleParser } = require('mailparser');
        const client = this.imapFactory({
            host: this.env.SCHOLAR_ALERTS_IMAP_HOST.trim(),
            port: Number(this.env.SCHOLAR_ALERTS_IMAP_PORT) || 993,
            secure: true,
            tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
            auth: { user: this.env.SCHOLAR_ALERTS_IMAP_USER.trim(), pass: this.env.SCHOLAR_ALERTS_IMAP_PASSWORD },
            logger: false,
        });
        const items = [];
        let lock = null;
        let stage = 'connect';
        try {
            await client.connect();
            stage = 'mailbox';
            lock = await client.getMailboxLock(this.env.SCHOLAR_ALERTS_MAILBOX || 'INBOX');
            stage = 'search';
            const since = new Date(this.now() - 7 * 86400000);
            const uids = await client.search({ from: SCHOLAR_SENDER, since }, { uid: true });
            const lastUid = this.cursor.lastUid || 0;
            const fresh = (uids || []).filter(u => u > lastUid).sort((a, b) => a - b);
            for (const uid of fresh) {
                stage = 'fetch';
                const meta = await client.fetchOne(uid, { size: true }, { uid: true });
                const size = meta && Number.isFinite(meta.size) ? meta.size : null;
                let msg = null;
                if (size !== null && size <= MAX_ALERT_BYTES) msg = await client.fetchOne(uid, { source: true }, { uid: true });
                const bytes = msg && msg.source ? msg.source.length : 0;
                if (!msg || !msg.source || bytes > MAX_ALERT_BYTES) {
                    this.warn(`message uid ${uid} skipped: ${size === null ? 'size unknown' : `over ${MAX_ALERT_BYTES} bytes`}`,
                        Object.assign(new Error('message too large'), { kind: 'too_large' }));
                } else {
                    const mail = await simpleParser(msg.source);
                    if (isAuthenticScholarAlert(mail)) {
                        items.push(...parseScholarAlert(mail.html || '', mail.date, mail.messageId || String(uid)));
                    } else {
                        this.warn(`message uid ${uid} dropped: no DKIM pass for google.com`,
                            new ParseError('unauthenticated alert message'));
                    }
                }
                this.cursor.lastUid = Math.max(this.cursor.lastUid || 0, uid);
            }
        } catch (err) {
            if (err instanceof ParseError) throw err;
            throw imapError(stage, err, this.env);
        } finally {
            if (lock) { try { lock.release(); } catch { /* released with the connection */ } }
            try {
                await client.logout();
            } catch {
                try { if (typeof client.close === 'function') client.close(); } catch { /* already closed */ }
            }
        }
        return items;
    }
}

module.exports = {
    ArxivCollector, PubmedCollector, SpringerCollector, ElsevierCollector, IeeeCollector,
    JstorDatasetCollector, ScholarImapCollector, parseScholarAlert, affiliationCity,
    isAuthenticScholarAlert, MAX_ALERT_BYTES,
};
