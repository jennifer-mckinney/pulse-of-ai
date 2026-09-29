// src/collectors/adapters/academic.js
// Academic adapters: arXiv API (Atom), PubMed E-utilities, Springer Nature
// Meta API, ScienceDirect Search API, IEEE Xplore, JSTOR dataset loader and
// the Google Scholar alert-mailbox reader. Author names are never mapped.

'use strict';

const xml2js = require('xml2js');
const { Collector, JsonApiCollector, BulkFileCollector, RssAtomCollector, rssItem } = require('../base');
const { findCity } = require('../../../public/js/config/cities.config.js');
const { htmlToText } = require('../normalize');
const { ParseError } = require('../errors');

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

/**
 * Parse one Scholar alert email (HTML) into items. Each result is an <h3>
 * with the paper link followed by the author/venue line (never read) and a
 * snippet div (class gse_alrt_sni). Links are NOT followed or stored.
 */
function parseScholarAlert(html, date, messageId) {
    const items = [];
    const blocks = String(html || '').split(/<h3\b/i).slice(1);
    blocks.forEach((block, i) => {
        const title = htmlToText((block.match(/<a\b[^>]*>([\s\S]*?)<\/a>/i) || [])[1]);
        const snippet = htmlToText((block.match(/<div[^>]*class="gse_alrt_sni"[^>]*>([\s\S]*?)<\/div>/i) || [])[1]);
        if (title) items.push({ id: `${messageId}#${i}`, title, text: snippet, url: null, publishedAt: date });
    });
    return items;
}

/**
 * Google Scholar alert mailbox over IMAP (the only official automated
 * delivery). Reads messages from scholaralerts-noreply@google.com newer
 * than the last UID seen. `ctx.imapFactory` is injectable for tests.
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
            auth: { user: this.env.SCHOLAR_ALERTS_IMAP_USER.trim(), pass: this.env.SCHOLAR_ALERTS_IMAP_PASSWORD },
            logger: false,
        });
        await client.connect();
        const items = [];
        const lock = await client.getMailboxLock(this.env.SCHOLAR_ALERTS_MAILBOX || 'INBOX');
        try {
            const since = new Date(this.now() - 7 * 86400000);
            const uids = await client.search({ from: 'scholaralerts-noreply@google.com', since }, { uid: true });
            const lastUid = this.cursor.lastUid || 0;
            const fresh = (uids || []).filter(u => u > lastUid);
            for (const uid of fresh) {
                const msg = await client.fetchOne(uid, { source: true }, { uid: true });
                const mail = await simpleParser(msg.source);
                items.push(...parseScholarAlert(mail.html || '', mail.date, mail.messageId || String(uid)));
                this.cursor.lastUid = Math.max(this.cursor.lastUid || 0, uid);
            }
        } finally {
            lock.release();
            await client.logout();
        }
        return items;
    }
}

module.exports = {
    ArxivCollector, PubmedCollector, SpringerCollector, ElsevierCollector, IeeeCollector,
    JstorDatasetCollector, ScholarImapCollector, parseScholarAlert, affiliationCity,
};
