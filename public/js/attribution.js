// PulseAttribution — K1: the source credit and the link back to the original
// that every excerpt and receipt shows (docs/research/k1-attribution-design.md).
//
// The server decides what the credit is (src/config/attribution.js: registry,
// licences, notices) and serves it on every post row as `credit`, `source_url`,
// `published_at` and `data_origin`; this module only turns that into DOM.
// Re-exported through utils.js (PulseUtils.buildCredit), so story.js and ui.js
// share ONE mechanism.
//
// Pure: no global DOM access — buildCredit receives the document. Elements are
// built with createElement + textContent ONLY (never innerHTML): the Write
// hook blocks it and the CSP is strict. A link's href is set only after
// safeHttpUrl re-validates it here (defence in depth: the server already
// validated it), and always with rel="noopener noreferrer".
//
// Dual export guard: CommonJS for jest; browser script tag sets
// window.PulseAttribution (load BEFORE utils.js).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();                        // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseAttribution = factory();                 // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_URL_LENGTH = 2048;
    // ISO-8601: a date, or a date and time with an optional zone.
    const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
    // whitespace, C0/C1 controls, and invisible / bidirectional-control characters
    const UNSAFE_CHAR_RE = /[\s\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
    const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
    // A DNS label (after punycode): letters, digits, inner hyphens; at most 63.
    const LABEL_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
    // The top-level label: letters (2+) or a punycode IDN TLD.
    const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;
    // Names that only resolve on a private network.
    const PRIVATE_SUFFIX_RE = /\.(?:local|localhost|localdomain|internal|intranet|corp|home|lan|private|invalid|home\.arpa)$/;
    // Keys (of the query, or of a key=value fragment) that track a reader or carry a
    // credential: never kept in a link we publish (a signed or session URL from an
    // upstream API must not be echoed).
    const DROP_QUERY_KEY_RE = /^(?:utm_[a-z0-9_]*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|_hsenc|_hsmi|token|access_token|id_token|refresh_token|api_?key|key|sig|signature|auth|authorization|session|session_?id|sid|password|passwd|secret)$/i;

    // What a demo post shows instead of a credit: it is fictional, so it
    // names no real source and links to nothing.
    const DEMO_LABEL = 'fictional demo post · no real source';
    const MODIFIED_LABEL = 'excerpt shortened and redacted';

    // keepParams: the "k=v" parts of a query or fragment without the tracking /
    // credential keys (";" separates like "&"), joined with "&".
    function keepParams(raw) {
        const kept = raw.split(/[&;]/).filter((p) => {
            if (p === '') return false;
            let k = p.split('=')[0];
            try { k = decodeURIComponent(k); } catch (e) { /* keep the raw key */ }
            return !DROP_QUERY_KEY_RE.test(k);
        });
        return kept.join('&');
    }

    // safeHttpUrl: the normalized URL when it is an absolute http(s) URL a link
    // may point at, else null. The SERVER uses this same function as the base of
    // its own check (src/config/attribution.js), so the two cannot drift.
    //   - http(s) only, at most 2048 characters, no whitespace / control /
    //     invisible / bidi characters, no embedded credentials;
    //   - a real public DNS name: a trailing dot is stripped, every label is
    //     letters / digits / inner hyphens, the last label is alphabetic (or an
    //     IDN), there are at least two labels, and it is not an IP literal,
    //     localhost or a private-network suffix (.local, .internal, .corp, ...);
    //   - tracking and credential query keys (utm_*, fbclid, token, key, sig, ...)
    //     are removed from the query (and from a key=value fragment); only a
    //     default port is accepted; the result is the WHATWG-normalized href.
    function safeHttpUrl(raw) {
        if (typeof raw !== 'string') return null;
        const s = raw.trim();
        if (s === '' || s.length > MAX_URL_LENGTH || UNSAFE_CHAR_RE.test(s)) return null;
        if (!/^https?:\/\//i.test(s)) return null;
        let u;
        try { u = new URL(s); } catch (e) { return null; }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
        if (u.username || u.password || u.port) return null;
        const host = u.hostname.toLowerCase().replace(/\.+$/, '');
        if (host === '' || host.includes(':') || host.startsWith('[') || IPV4_RE.test(host)) return null;
        if (host === 'localhost' || PRIVATE_SUFFIX_RE.test(host)) return null;
        const labels = host.split('.');
        if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
        if (!TLD_RE.test(labels[labels.length - 1])) return null;
        if (u.search !== '') u.search = keepParams(u.search.slice(1));
        // a fragment is kept (Wikipedia comment anchors), unless it is a key=value
        // list: then its credential keys go too
        if (u.hash.length > 1 && u.hash.includes('=')) u.hash = keepParams(u.hash.slice(1));
        if (u.hostname !== host) u.hostname = host;     // serve the dotless host
        return u.href;
    }

    // hostOf: the destination host a link's text shows ("npr.org"), so a
    // reader sees where the link goes before clicking.
    function hostOf(url) {
        try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch (e) { return ''; }
    }

    // parseIsoDate: an ISO-8601 date or date-time as an ISO UTC string, or null.
    // Date.parse is lenient (it reads "<img src=x onerror=1>" as a date and rolls
    // 2026-02-31 over to March), so the shape and the calendar day are checked
    // first; a time without a zone is UTC (never the machine's timezone).
    function parseIsoDate(v) {
        if (typeof v !== 'string' || v.length > 40) return null;
        const m = v.match(ISO_DATE_RE);
        if (!m) return null;
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const probe = new Date(Date.UTC(y, mo - 1, d));
        if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
        const t = Date.parse(m[4] || v.length <= 10 ? v : v + 'Z');
        return Number.isFinite(t) ? new Date(t).toISOString() : null;
    }

    // isoDay: 'YYYY-MM-DD' of a date string, or null when it is not a date.
    // An ISO string keeps its own calendar day (no timezone shift).
    function isoDay(v) {
        return parseIsoDate(v) ? v.slice(0, 10) : null;
    }

    const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

    // creditModel: a post row → what to show, or null when there is nothing to
    // credit (no credit text and no link, e.g. a legacy row of a retired slug).
    //   { demo: true, label }
    //   { demo: false, text, url, host, license, licenseUrl, modified, date,
    //     notice, noticeUrl }
    // A row from an older server (no `credit`) falls back to its `attribution`
    // string; a bundled-fallback demo post (isDemo) is demo.
    function creditModel(post) {
        if (!post || typeof post !== 'object') return null;
        if (post.isDemo === true || post.data_origin === 'demo') {
            return { demo: true, label: DEMO_LABEL };
        }
        const c = post.credit && typeof post.credit === 'object' ? post.credit : null;
        const text = (c && str(c.text)) || str(post.attribution);
        const url = safeHttpUrl(post.source_url);
        if (!text && !url) return null;
        const licenseUrl = c ? safeHttpUrl(c.license_url) : null;
        const license = c ? str(c.license) : null;
        return {
            demo: false,
            text,
            url,
            host: url ? hostOf(url) : '',
            license,
            licenseUrl: license ? licenseUrl : null,
            modified: !!(c && c.modified === true),
            date: c && c.cite_date === true ? isoDay(post.published_at) : null,
            notice: c ? str(c.notice) : null,
            noticeUrl: c ? safeHttpUrl(c.notice_url) : null,
        };
    }

    function node(doc, tag, className, text) {
        const n = doc.createElement(tag);
        if (className) n.className = className;
        if (text !== undefined && text !== null) n.textContent = text;
        return n;
    }

    // sep: the " · " between parts; hidden from screen readers (they would
    // read it aloud as "middle dot").
    function sep(doc) {
        const n = node(doc, 'span', 'credit-sep', ' · ');
        n.setAttribute('aria-hidden', 'true');
        return n;
    }

    function externalLink(doc, className, text, href, label) {
        const a = node(doc, 'a', className, text);
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        if (label) a.setAttribute('aria-label', label);
        return a;
    }

    // buildCredit: the credit line for one excerpt, or null.
    //   <div class="credit mono">
    //     <span class="credit-via">via NPR (2026-09-29)</span>
    //     <span class="credit-sep"> · </span><a class="credit-link" …>npr.org ↗</a>
    //     <span class="credit-sep"> · </span><a class="credit-license" …>CC BY-SA 4.0</a>
    //     <span class="credit-sep"> · </span><span class="credit-note">excerpt shortened and redacted</span>
    //     <div class="credit-notice">arXiv acknowledgement …</div>
    //   </div>
    function buildCredit(doc, post, className) {
        const m = creditModel(post);
        if (!m || !doc) return null;
        const line = node(doc, 'div', (className || 'credit mono') + (m.demo ? ' credit-demo' : ''));
        if (m.demo) {
            line.appendChild(node(doc, 'span', 'credit-via', m.label));
            return line;
        }
        const parts = [];
        if (m.text) parts.push(node(doc, 'span', 'credit-via', 'via ' + m.text + (m.date ? ' (' + m.date + ')' : '')));
        if (m.url) {
            parts.push(externalLink(doc, 'credit-link', m.host + ' ↗', m.url,
                'Read the original at ' + m.host
                + (m.url.startsWith('http:') ? ' (not encrypted)' : '') + ' (opens in a new tab)'));
        }
        if (m.license) {
            parts.push(m.licenseUrl
                ? externalLink(doc, 'credit-license', m.license, m.licenseUrl,
                    'Licence: ' + m.license + ' (opens in a new tab)')
                : node(doc, 'span', 'credit-license-text', m.license));
        }
        if (m.modified) parts.push(node(doc, 'span', 'credit-note', MODIFIED_LABEL));
        parts.forEach((p, i) => {
            if (i > 0) line.appendChild(sep(doc));
            line.appendChild(p);
        });
        if (m.notice) {
            const n = node(doc, 'div', 'credit-notice', m.notice);
            if (m.noticeUrl) {
                n.appendChild(node(doc, 'span', 'credit-sep', ' '));
                n.appendChild(externalLink(doc, 'credit-link', 'details ↗', m.noticeUrl,
                    'Notice details (opens in a new tab)'));
            }
            line.appendChild(n);
        }
        return line;
    }

    return { safeHttpUrl, parseIsoDate, hostOf, creditModel, buildCredit, DEMO_LABEL, MODIFIED_LABEL };
}));
