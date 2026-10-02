// src/config/attribution.js
// K1 (launch blocker, Jennifer 2026-10-01 "Yes, required before launch"):
// the ONE mechanism that gives every excerpt and receipt a source credit and
// a link back to the original. Design: docs/research/k1-attribution-design.md.
//
//   creditFor(slug)        the credit a source's excerpts carry, derived from
//                          the registry at READ time (no schema change: a
//                          registry fix applies to every stored post), or null
//   safeSourceUrl(raw, slug) the stored permalink when it is safe to publish as a
//                          link AND belongs to the source (host on the source's
//                          link domains, not an identity link), else null
//   postAttribution(row)   the fields every post row of the public API adds:
//                          { data_origin, source_url, published_at,
//                            attribution, credit }
//   creditsCatalogue(slugs) the credit models for GET /api/credits
//
// Rules (decisions D1-D6 of the design):
//   - every real registry source is credited, not only those whose terms
//     require it (D1);
//   - demo posts (data_sources.source_type 'demo') are fictional: no credit,
//     no link, never a fake credit to a real source (D2);
//   - a slug with no registry entry (retired legacy rows) has no credit and no
//     link (D5); a link is only ever published for the source it belongs to.

'use strict';

const { getSource, allowedHosts, SOURCES } = require('./source-registry');
const { DEMO_SOURCE_TYPE } = require('./data-mode');
const { isIdentityUrl } = require('../collectors/identity');
// Layering note (as in routes/posts.js): the URL base check is the browser
// module's own function, so the server and the browser can never drift apart.
const { safeHttpUrl, ISO_DATE_RE } = require('../../public/js/attribution');

const MAX_DATE_LENGTH = 40;

// Site-wide statements the credits page and the receipts show.
const SITE_NOTICES = Object.freeze({
    excerpts: 'Excerpts are shortened to 120 characters and have identities redacted, so they may differ from the original. Follow the link to read the original.',
    links: 'Every excerpt links to the original item on its source; a link is absent when the source supplied none, when its address could not be verified as belonging to the source, or when the text has been removed under its retention rule.',
    demo: 'Posts labelled demo are fictional and are not from any real source.',
});

// Second-level labels under a two-letter country code (bbc.co.uk, gov.uk): the
// registrable domain keeps three labels there.
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

/** Approximate registrable domain (no public-suffix list in this repo). */
function registrable(host) {
    const l = host.split('.');
    if (l.length <= 2) return host;
    const tld = l[l.length - 1];
    const sld = l[l.length - 2];
    return tld.length === 2 && SECOND_LEVEL.has(sld) ? l.slice(-3).join('.') : l.slice(-2).join('.');
}

const linkDomainCache = new Map();

/**
 * The domains a source's links may point at: the registrable domain of every
 * host the source's routes use (src/config/source-registry.js allowedHosts:
 * api.github.com -> github.com) plus the registry's explicit `linkHosts` where
 * the permalink lives elsewhere (feeds.bbci.co.uk -> bbc.co.uk). Env-supplied
 * contract hosts are not consulted: a licensed feed lists its own `linkHosts`.
 * @param {object} src registry entry
 * @returns {Set<string>}
 */
function linkDomains(src) {
    let d = linkDomainCache.get(src.slug);
    if (!d) {
        d = new Set(allowedHosts(src, {}).map(h => registrable(h.replace(/^www\./, ''))));
        for (const h of src.linkHosts || []) d.add(String(h).toLowerCase());
        linkDomainCache.set(src.slug, d);
    }
    return d;
}

/**
 * The stored permalink when it is safe to publish as a link, else null. Always
 * the browser module's base rule (public/js/attribution.js safeHttpUrl: http(s),
 * real public DNS name, no credentials, no control/bidi characters, tracking
 * and credential query keys removed). With a slug it must also
 *   - belong to that source: the host is on (or under) one of the source's
 *     link domains, so a hostile feed item cannot make "via NPR" link to an
 *     unrelated site (open redirect, phishing); an unregistered slug has none;
 *   - not be an identity link (a legacy row from before ingest@1.3.0, or any
 *     other ingest path, never publishes a person's profile).
 * @param {unknown} raw
 * @param {string} [slug]  data_sources.name; omit for the base rule alone
 * @returns {string|null}
 */
function safeSourceUrl(raw, slug) {
    const url = safeHttpUrl(raw);
    if (!url) return null;
    if (slug === undefined) return url;
    const src = typeof slug === 'string' ? getSource(slug) : null;
    if (!src) return null;
    if (isIdentityUrl(url)) return null;
    const host = new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
    for (const d of linkDomains(src)) {
        if (host === d || host.endsWith('.' + d)) return url;
    }
    return null;
}

/**
 * A publication date as an ISO-8601 UTC string, or null when it is not a date.
 * @param {unknown} v
 * @returns {string|null}
 */
function safeIsoDate(v) {
    // Date.parse is lenient (it reads "<img src=x onerror=1>" as a date), so
    // only an ISO-8601 shape is accepted.
    if (typeof v !== 'string' || v.length > MAX_DATE_LENGTH || !ISO_DATE_RE.test(v)) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Credit text: the registry `creditText`, else its `attribution` with a
 * trailing "(LICENCE)" removed (the licence is rendered once, as a link),
 * else the source name without a trailing parenthetical.
 */
function creditText(src) {
    if (typeof src.creditText === 'string' && src.creditText.trim() !== '') return src.creditText.trim();
    if (typeof src.attribution === 'string' && src.attribution.trim() !== '') {
        let t = src.attribution.trim();
        if (src.license) {
            const suffix = `(${src.license})`;
            if (t.endsWith(suffix)) t = t.slice(0, -suffix.length).trim();
        }
        return t;
    }
    return String(src.name || src.slug).replace(/\s*\([^)]*\)\s*$/, '').trim() || String(src.slug);
}

/**
 * The credit a registry source's excerpts carry.
 * @param {unknown} slug  data_sources.name
 * @returns {null|{ text: string, required: boolean, license: string|null,
 *   license_url: string|null, modified: boolean, cite_date: boolean,
 *   notice: string|null, notice_url: string|null }}
 */
function creditFor(slug) {
    if (typeof slug !== 'string' || slug === '') return null;
    const src = getSource(slug);
    if (!src) return null;
    const license = typeof src.license === 'string' && src.license !== '' ? src.license : null;
    return {
        text: creditText(src),
        // true when the source's terms (the registry `attribution`) require it
        required: typeof src.attribution === 'string' && src.attribution !== '',
        license,
        license_url: license && typeof src.licenseUrl === 'string' ? src.licenseUrl : null,
        // Creative Commons "BY" licences require changes to be indicated.
        modified: !!license && /^CC BY/.test(license),
        cite_date: src.citeDate === true,
        notice: typeof src.notice === 'string' ? src.notice : null,
        notice_url: typeof src.noticeUrl === 'string' ? src.noticeUrl : null,
    };
}

/**
 * The attribution fields of one post row of the public API.
 * @param {{ sourceName?: string, sourceType: string, url?: unknown, publishedAt?: unknown }} row  sourceType is required
 * @returns {{ data_origin: 'live'|'demo', source_url: string|null,
 *   published_at: string|null, attribution: string|null, credit: object|null }}
 */
function postAttribution({ sourceName, sourceType, url, publishedAt } = {}) {
    // Fail loud, never open: without the source type a demo post could be
    // credited as a real source's (decision D2).
    if (typeof sourceType !== 'string' || sourceType === '') {
        throw new TypeError('postAttribution: sourceType is required (data_sources.source_type)');
    }
    const demo = sourceType === DEMO_SOURCE_TYPE;
    const src = demo ? null : getSource(sourceName);
    return {
        data_origin: demo ? 'demo' : 'live',
        // a fictional demo post links to nothing; a link must belong to its source
        source_url: demo ? null : safeSourceUrl(url, sourceName),
        published_at: demo ? null : safeIsoDate(publishedAt),
        // unchanged field: the credit text the registry says the terms require
        attribution: src && src.attribution ? src.attribution : null,
        credit: demo ? null : creditFor(sourceName),
    };
}

/**
 * Credit models for the credits page: the requested slugs that have a credit,
 * once each, in registry order, with the source's terms link.
 * @param {unknown} slugs
 * @returns {Array<{ slug: string, name: string, category: string, terms_url: string|null, credit: object }>}
 */
function creditsCatalogue(slugs) {
    if (!Array.isArray(slugs)) return [];
    const wanted = new Set(slugs.filter(s => typeof s === 'string'));
    const out = [];
    for (const src of SOURCES) {
        if (!wanted.has(src.slug)) continue;
        const credit = creditFor(src.slug);
        if (!credit) continue;
        out.push({
            slug: src.slug,
            name: src.name,
            category: src.category,
            terms_url: typeof src.termsUrl === 'string' ? src.termsUrl : null,
            credit,
        });
    }
    return out;
}

module.exports = {
    creditFor, safeSourceUrl, safeIsoDate, postAttribution, creditsCatalogue, linkDomains, registrable, SITE_NOTICES,
};
