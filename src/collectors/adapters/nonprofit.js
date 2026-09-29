// src/collectors/adapters/nonprofit.js
// Non-profit adapters: Wikipedia talk-page comments on AI articles
// (MediaWiki Action API + DiscussionTools) and the Internet Archive
// advanced search. Editor names, signatures and IPs are never kept.

'use strict';

const crypto = require('crypto');
const { Parser } = require('htmlparser2');
const { JsonApiCollector } = require('../base');

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const SET_TTL_MS = 24 * 3600 * 1000;

// F10-3: comment HTML is cut to this size before parsing.
const COMMENT_HTML_CAP = 64 * 1024;
const SIGNATURE_HREF_RE = /(?:User(?:_talk)?:|Special:Contributions\/)/i;
const escapeHtml = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Remove signatures from DiscussionTools comment HTML: links to User:,
 * User talk: and Special:Contributions pages (with their text), the
 * "12:34, 5 May 2026 (UTC)" timestamp that closes every signature, and
 * leftover "(talk)" / "(contribs)" markers. Tokenised with htmlparser2
 * (linear, F10-3); the result is HTML-escaped text, so the normaliser's own
 * htmlToText decodes it exactly once.
 */
function stripSignatures(html) {
    const parts = [];
    let inSig = 0;
    const parser = new Parser({
        onopentag(name, attrs) {
            if (name === 'a' && (inSig || SIGNATURE_HREF_RE.test(attrs.href || ''))) inSig++;
            else if (['p', 'br', 'li', 'div', 'dd', 'dl'].includes(name)) parts.push(' ');
        },
        onclosetag(name) {
            if (name === 'a' && inSig) inSig--;
        },
        ontext(t) {
            if (!inSig) parts.push(t);
        },
    }, { decodeEntities: true, lowerCaseTags: true });
    parser.write(String(html || '').slice(0, COMMENT_HTML_CAP));
    parser.end();
    const text = parts.join('')
        .replace(/\d{1,2}:\d{2},\s{1,4}\d{1,2}\s{1,4}[A-Z][a-z]{2,9}\s{1,4}\d{4}\s{1,4}\(UTC\)/g, ' ')
        .replace(/\(\s{0,4}(?:(?:talk|contribs)\s{0,4})?\)/gi, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\s?[\u2013\u2014-]\s?$/, '')
        .trim();
    return escapeHtml(text);
}

/** Plain text of a heading's HTML (linear). */
function headingText(html) {
    const parts = [];
    const parser = new Parser({ ontext(t) { parts.push(t); } }, { decodeEntities: true });
    parser.write(String(html || '').slice(0, 4096));
    parser.end();
    return parts.join('').replace(/\s+/g, ' ').trim();
}

/** Flatten DiscussionTools thread items into comments (with their heading). */
function flattenThreads(items, heading = '') {
    const out = [];
    for (const it of items || []) {
        if (it.type === 'heading') {
            out.push(...flattenThreads(it.replies, headingText(it.html)));
        } else if (it.type === 'comment') {
            out.push({ id: it.id, html: it.html, timestamp: it.timestamp, heading });
            out.push(...flattenThreads(it.replies, heading));
        }
    }
    return out;
}

class WikipediaTalkCollector extends JsonApiCollector {
    api(params) {
        const q = new URLSearchParams({ format: 'json', formatversion: '2', ...params });
        return this.getJson(`${WIKI_API}?${q}`);
    }

    /** The AI article set (category members), refreshed daily in the cursor. */
    async articleSet() {
        if (this.cursor.set && this.now() - (this.cursor.setAt || 0) < SET_TTL_MS) return this.cursor.set;
        const res = await this.api({ action: 'query', list: 'categorymembers', cmtitle: this.params.category, cmnamespace: '0', cmlimit: '500' });
        const titles = ((res.data.query && res.data.query.categorymembers) || []).map(m => m.title);
        this.cursor.set = titles;
        this.cursor.setAt = this.now();
        return titles;
    }

    async fetchItems() {
        const set = await this.articleSet();
        const talk = new Set(set.map(t => `Talk:${t}`));
        // Recently edited talk pages (titles + timestamps only; no user field requested).
        const rc = await this.api({ action: 'query', list: 'recentchanges', rcnamespace: '1', rctype: 'edit|new', rcprop: 'title|timestamp', rclimit: '500' });
        const changed = [...new Set(((rc.data.query && rc.data.query.recentchanges) || []).map(c => c.title).filter(t => talk.has(t)))];
        const n = this.params.pagesPerRun || 6;
        let pages = changed.slice(0, n);
        if (pages.length < n && set.length) {
            // Rotate through the set so every AI article's talk page is read over time.
            let i = this.cursor.rotation || 0;
            while (pages.length < n && pages.length < set.length) {
                const t = `Talk:${set[i % set.length]}`;
                if (!pages.includes(t)) pages.push(t);
                i++;
            }
            this.cursor.rotation = i % set.length;
        }
        const items = [];
        for (const page of pages) {
            const res = await this.api({ action: 'discussiontoolspageinfo', page, prop: 'threaditemshtml' });
            const threads = res.data.discussiontoolspageinfo && res.data.discussiontoolspageinfo.threaditemshtml;
            for (const c of flattenThreads(threads)) {
                items.push({
                    // The DiscussionTools id embeds the signer's name: hash it.
                    id: crypto.createHash('sha256').update(`${page}#${c.id}`).digest('hex'),
                    title: `${page}${c.heading ? ` — ${c.heading}` : ''}`,
                    text: stripSignatures(c.html),
                    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.replace(/ /g, '_'))}`,
                    publishedAt: c.timestamp,
                });
            }
        }
        return items;
    }
}

class InternetArchiveCollector extends JsonApiCollector {
    async fetchItems() {
        const to = new Date(this.now()).toISOString().slice(0, 10);
        const from = new Date(this.now() - (this.params.days || 3) * 86400000).toISOString().slice(0, 10);
        const q = new URLSearchParams({
            q: `subject:("${this.params.subject}") AND publicdate:[${from} TO ${to}]`,
            rows: String(this.params.rows || 50), output: 'json', 'sort[]': 'publicdate desc',
        });
        for (const f of ['identifier', 'title', 'description', 'publicdate']) q.append('fl[]', f);
        const res = await this.getJson(`https://archive.org/advancedsearch.php?${q}`);
        const docs = (res.data.response && res.data.response.docs) || [];
        return docs.map(d => ({
            id: d.identifier,
            title: Array.isArray(d.title) ? d.title[0] : d.title,
            text: Array.isArray(d.description) ? d.description.join(' ') : d.description,
            url: `https://archive.org/details/${encodeURIComponent(d.identifier)}`,
            publishedAt: d.publicdate,
        }));
    }
}

module.exports = { WikipediaTalkCollector, InternetArchiveCollector, stripSignatures, flattenThreads };
