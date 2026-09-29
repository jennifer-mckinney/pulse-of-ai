// src/collectors/adapters/policy.js
// Policy adapters: GovInfo search API (the collection RSS uses the generic
// RSS collector), Congress.gov bill API and Pew's WordPress REST AI category.

'use strict';

const { JsonApiCollector } = require('../base');

/** GovInfo search (api.data.gov key in the X-Api-Key HEADER, never the URL — F10-1). */
class GovinfoSearchCollector extends JsonApiCollector {
    async fetchItems() {
        const res = await this.http.json('https://api.govinfo.gov/search', this.requestOptions({
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.envValue('GOVINFO_API_KEY') },
            body: JSON.stringify({
                query: this.params.query, pageSize: this.params.pageSize || 50, offsetMark: '*',
                sorts: [{ field: 'publishdate', sortOrder: 'DESC' }],
            }),
        }));
        return (res.data.results || []).map(r => ({
            id: r.granuleId || r.packageId,
            title: r.title,
            text: '',
            url: r.packageId ? `https://www.govinfo.gov/app/details/${r.packageId}${r.granuleId ? `/${r.granuleId}` : ''}` : null,
            publishedAt: r.dateIssued || r.lastModified,
        }));
    }
}

/**
 * Congress.gov: no keyword search exists — recent bills, AI-filtered locally.
 * The api.data.gov key travels in the X-Api-Key HEADER, never the URL (F10-1).
 */
class CongressCollector extends JsonApiCollector {
    async fetchItems() {
        const from = this.cursor.fromDateTime || new Date(this.now() - 3 * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const q = new URLSearchParams({
            format: 'json', sort: 'updateDate desc', limit: String(this.params.limit || 250), fromDateTime: from,
        });
        const res = await this.getJson(`https://api.congress.gov/v3/bill?${q}`, {
            headers: { 'X-Api-Key': this.envValue('CONGRESS_API_KEY') },
        });
        const bills = res.data.bills || [];
        this.cursor.fromDateTime = new Date(this.now() - 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        return bills.map(b => ({
            id: `${b.congress}-${String(b.type).toLowerCase()}-${b.number}-${b.updateDate || ''}`,
            title: b.title,
            text: b.latestAction ? `Latest action (${b.latestAction.actionDate}): ${b.latestAction.text}` : '',
            url: `https://www.congress.gov/bill/${b.congress}th-congress/${billPath(b.type)}/${b.number}`,
            publishedAt: b.updateDateIncludingText || b.updateDate,
        }));
    }
}

const BILL_PATHS = { HR: 'house-bill', S: 'senate-bill', HRES: 'house-resolution', SRES: 'senate-resolution',
    HJRES: 'house-joint-resolution', SJRES: 'senate-joint-resolution', HCONRES: 'house-concurrent-resolution',
    SCONRES: 'senate-concurrent-resolution' };
function billPath(type) {
    return BILL_PATHS[String(type).toUpperCase()] || String(type).toLowerCase();
}

/** Pew Research Center: WordPress REST, category 299 (Artificial Intelligence). */
class PewCollector extends JsonApiCollector {
    static get robotsGated() { return true; }   // served from the publisher's own site

    async fetchItems() {
        const q = new URLSearchParams({
            categories: String(this.params.category), per_page: String(this.params.perPage || 50),
            _fields: 'id,date_gmt,link,title,excerpt',
        });
        const res = await this.getJson(`https://www.pewresearch.org/wp-json/wp/v2/posts?${q}`, { cache: this.httpCache });
        if (res.notModified) return [];
        return (res.data || []).map(p => ({
            id: p.id,
            title: p.title && p.title.rendered,
            text: p.excerpt && p.excerpt.rendered,
            url: p.link,
            publishedAt: p.date_gmt ? `${p.date_gmt}Z` : null,
        }));
    }
}

module.exports = { GovinfoSearchCollector, CongressCollector, PewCollector, billPath };
