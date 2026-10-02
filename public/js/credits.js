// PulseCredits — K1: the credits page (public/credits.html). Fills the page
// from GET /api/credits (src/routes/credits.js): the site notices, then every
// source that has stored real posts, grouped by category, with the credit its
// excerpts carry, its licence, its notice and its terms link.
//
// Elements are built with createElement + textContent ONLY (never innerHTML);
// links are set only after PulseAttribution.safeHttpUrl re-validates them.
// Dual export guard: CommonJS for jest; browser script tag sets
// window.PulseCredits (load js/config/design.config.js, js/attribution.js and
// js/utils.js BEFORE this file).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./attribution'), require('./utils'));   // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseCredits = factory(root.PulseAttribution, root.PulseUtils);   // browser global
    }
}(typeof self !== 'undefined' ? self : this, function (attribution, utils) {
    'use strict';

    const ENDPOINT = '/api/credits';
    // The same display label the main page uses ('nonprofit' -> 'Non-profit').
    const catLabel = utils.catLabel;

    function node(doc, tag, className, text) {
        const n = doc.createElement(tag);
        if (className) n.className = className;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    // link: an external link, or null when the URL is not safe to link to.
    function link(doc, text, url, label) {
        const safe = attribution.safeHttpUrl(url);
        if (!safe) return null;
        const a = node(doc, 'a', null, text);
        a.href = safe;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.setAttribute('aria-label', label);
        return a;
    }

    function clear(n) {
        while (n && n.firstChild) n.removeChild(n.firstChild);
    }

    // groupByCategory: the served sources (registry order) → [{ category, rows }]
    // in order of first appearance.
    function groupByCategory(sources) {
        const groups = [];
        const index = new Map();
        for (const s of Array.isArray(sources) ? sources : []) {
            if (!s || typeof s !== 'object' || typeof s.slug !== 'string') continue;
            const cat = typeof s.category === 'string' ? s.category : 'other';
            if (!index.has(cat)) { index.set(cat, { category: cat, rows: [] }); groups.push(index.get(cat)); }
            index.get(cat).rows.push(s);
        }
        return groups;
    }

    function sourceRow(doc, s) {
        const row = node(doc, 'div', 'credits-row');
        const name = String(s.name || s.slug);
        row.appendChild(node(doc, 'div', 'credits-name', name));
        const c = s.credit && typeof s.credit === 'object' ? s.credit : {};
        if (c.text) row.appendChild(node(doc, 'div', 'credits-credit mono', 'Excerpts are credited: via ' + c.text));
        const meta = node(doc, 'div', 'credits-meta mono');
        let any = false;
        if (c.license) {
            const a = link(doc, c.license, c.license_url, 'Licence: ' + c.license + ' (opens in a new tab)');
            meta.appendChild(node(doc, 'span', null, 'Licence: '));
            meta.appendChild(a || node(doc, 'span', null, c.license));
            any = true;
        }
        const terms = link(doc, 'terms', s.terms_url, 'Terms of ' + name + ' (opens in a new tab)');
        if (terms) {
            if (any) meta.appendChild(node(doc, 'span', null, ' · '));
            meta.appendChild(terms);
            any = true;
        }
        if (any) row.appendChild(meta);
        if (c.notice) {
            const n = node(doc, 'div', 'credits-notice', c.notice);
            const more = link(doc, 'details', c.notice_url, 'Notice details (opens in a new tab)');
            if (more) { n.appendChild(node(doc, 'span', null, ' ')); n.appendChild(more); }
            row.appendChild(n);
        }
        return row;
    }

    // render: the payload → the page. A malformed payload shows an honest
    // message, never a half-built list.
    function render(doc, payload, els) {
        clear(els.notices);
        clear(els.sources);
        const ok = payload && typeof payload === 'object' && Array.isArray(payload.sources);
        if (!ok) {
            els.sources.appendChild(node(doc, 'p', 'credits-status mono',
                'The list of sources could not be loaded. Please try again later.'));
            return false;
        }
        const notices = payload.notices && typeof payload.notices === 'object' ? payload.notices : {};
        for (const key of ['excerpts', 'links', 'demo']) {
            if (typeof notices[key] === 'string' && notices[key] !== '') {
                els.notices.appendChild(node(doc, 'li', null, notices[key]));
            }
        }
        if (payload.sources.length === 0) {
            els.sources.appendChild(node(doc, 'p', 'credits-status mono', 'No source has contributed posts yet.'));
            return true;
        }
        for (const g of groupByCategory(payload.sources)) {
            els.sources.appendChild(node(doc, 'div', 'credits-cat mono', catLabel(g.category)));
            for (const s of g.rows) els.sources.appendChild(sourceRow(doc, s));
        }
        return true;
    }

    /* istanbul ignore next -- Browser bootstrap; the render path is unit-tested */
    function init() {
        if (typeof document === 'undefined' || typeof fetch !== 'function') return;
        const els = {
            notices: document.getElementById('credits-notices'),
            sources: document.getElementById('credits-sources'),
        };
        if (!els.notices || !els.sources) return;
        fetch(ENDPOINT)
            .then((res) => { if (!res || !res.ok) throw new Error('credits ' + (res && res.status)); return res.json(); })
            .then((payload) => render(document, payload, els))
            .catch(() => render(document, null, els));
    }
    /* istanbul ignore next */
    if (typeof document !== 'undefined') init();

    return { render, groupByCategory, ENDPOINT };
}));
