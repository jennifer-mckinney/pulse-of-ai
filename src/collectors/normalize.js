// src/collectors/normalize.js
// Collector item → the pipeline's raw post payload (src/pipeline/ingest.js).
//
// The payload is built from an ALLOWLIST of content fields — title, text,
// link, timestamp, language, licence/attribution, route — so identity fields
// (authors, usernames, profile locations, avatars) can never reach storage,
// whatever an upstream API returned. Location is capped at city level:
//   1. content-level: an item geotag (lat/lng) is rounded to the nearest
//      city-registry entry within 50 km, or an item-level city name that the
//      registry resolves;
//   2. else the publisher's home city (route.homeCity ?? source.homeCity) for
//      editorial sources — recorded as location_basis 'publisher';
//   3. else none.

'use strict';

const crypto = require('crypto');
const { Parser } = require('htmlparser2');
const { CITY_REGISTRY, findCity } = require('../../public/js/config/cities.config.js');

// Links whose path names a person (profile / user namespace) are not stored:
// e.g. OpenStreetMap diary links /user/<name>/diary/<id>.
const IDENTITY_URL_RE = /\/(?:user|users|u|profile|people|member|members)\/[^/?#]+|\/@[^/?#]+/i;

const MAX_TEXT = 4000;
const MAX_TITLE = 300;
const NEAREST_CITY_KM = 50;

// F10-3: every text step here is LINEAR in the input. Upstream text is cut
// to RAW_TEXT_CAP / RAW_TITLE_CAP characters BEFORE any parsing or
// redaction (then truncated again to MAX_TEXT / MAX_TITLE after), HTML is
// tokenised by htmlparser2 (no backtracking regex over markup), and the
// e-mail pattern is bounded and anchored so it cannot restart at every
// offset of a long run.
const RAW_TEXT_CAP = 4 * MAX_TEXT;     // 16 000 chars
const RAW_TITLE_CAP = 4 * MAX_TITLE;   //  1 200 chars
// htmlToText's own bound, for callers other than toPayload.
const HTML_PARSE_CAP = 64 * 1024;

const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template']);
const BLOCK_TAGS = new Set(['br', 'p', 'li', 'div', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'hr', 'ul', 'ol', 'section', 'article']);

/**
 * Strip HTML to plain text with a streaming tokenizer: drop script/style,
 * separate block elements with a space, decode entities, collapse
 * whitespace. Linear time.
 */
function htmlToText(html) {
    if (html === null || html === undefined) return '';
    const parts = [];
    let skip = 0;
    const parser = new Parser({
        onopentagname(name) {
            if (SKIP_TAGS.has(name)) skip++;
            else if (BLOCK_TAGS.has(name)) parts.push(' ');
        },
        onclosetag(name) {
            if (SKIP_TAGS.has(name)) skip = Math.max(0, skip - 1);
            else if (BLOCK_TAGS.has(name)) parts.push(' ');
        },
        ontext(t) {
            if (!skip) parts.push(t);
        },
    }, { decodeEntities: true, lowerCaseTags: true });
    parser.write(String(html).slice(0, HTML_PARSE_CAP));
    parser.end();
    return parts.join('').replace(/\s+/g, ' ').trim();
}

// In-text identities: e-mail addresses and @handles (mentions, pings) are
// replaced before storage — the text keeps its meaning, not the person.
// Bounded quantifiers plus a lookbehind: a match can only START at the
// beginning of a local part, so a long run of word characters is scanned
// once (F10-3 measured the old unbounded pattern quadratic).
const EMAIL_RE = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![A-Za-z])/g;
const HANDLE_RE = /(^|[^A-Za-z0-9_.])@[A-Za-z0-9_][A-Za-z0-9_.-]{1,38}/g;
function redactIdentities(text) {
    return String(text || '').replace(EMAIL_RE, '[email]').replace(HANDLE_RE, '$1@[user]');
}

/** Cut raw upstream text before any processing (F10-3). */
function capRaw(v, n) {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return s.length > n ? s.slice(0, n) : s;
}

function truncate(s, n) {
    return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

function haversineKm(a, b) {
    const R = 6371;
    const rad = d => d * Math.PI / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest registry city to a geotag, within NEAREST_CITY_KM; else null. */
function nearestCity(lat, lng) {
    const p = { lat: Number(lat), lng: Number(lng) };
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) return null;
    let best = null;
    for (const c of CITY_REGISTRY) {
        const d = haversineKm(p, c);
        if (d <= NEAREST_CITY_KM && (!best || d < best.d)) best = { name: c.name, d };
    }
    return best ? best.name : null;
}

function isoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Stable, identity-free external id: the upstream id when short and clean, else a hash. */
function externalId(routeId, id) {
    const raw = String(id === null || id === undefined ? '' : id).trim();
    if (!raw) return '';
    const safe = raw.length <= 200 && /^[\w.:/?=&%#~+-]+$/.test(raw) ? raw : crypto.createHash('sha256').update(raw).digest('hex');
    return `${routeId}:${safe}`;
}

/**
 * @param {object} item   adapter output { id, title, text, url, publishedAt,
 *                        geo?: {lat,lng}, city?, language? }
 * @param {object} source registry entry
 * @param {object} route  registry route
 * @returns {object|null} payload for storeRawPost, or null when unusable
 */
function toPayload(item, source, route) {
    if (!item) return null;
    const title = truncate(redactIdentities(htmlToText(capRaw(item.title, RAW_TITLE_CAP))), MAX_TITLE);
    const body = truncate(redactIdentities(htmlToText(capRaw(item.text, RAW_TEXT_CAP))), MAX_TEXT);
    const joined = body && body !== title && !title.includes(body) ? (title ? `${title}\n\n${body}` : body) : title;
    const text = truncate(joined, MAX_TEXT);
    const id = externalId(route.id, item.id || item.url);
    if (!id || !text) return null;

    let location = '';
    let basis = null;
    const geoCity = item.geo ? nearestCity(item.geo.lat, item.geo.lng) : null;
    const namedCity = item.city ? findCity(item.city) : null;
    if (geoCity) { location = geoCity; basis = 'content'; }
    else if (namedCity) { location = namedCity.name; basis = 'content'; }
    else {
        const home = route.homeCity !== undefined ? route.homeCity : source.homeCity;
        if (home && findCity(home)) { location = findCity(home).name; basis = 'publisher'; }
    }

    const url = typeof item.url === 'string' && /^https?:\/\//.test(item.url) && !IDENTITY_URL_RE.test(item.url)
        ? item.url : null;
    return {
        id,
        text,
        title: title || null,
        url,
        published_at: isoDate(item.publishedAt),
        language: typeof item.language === 'string' && /^[a-z]{2}$/i.test(item.language) ? item.language.toLowerCase() : 'en',
        location,
        location_basis: basis,
        source_slug: source.slug,
        route: route.id,
        license: source.license || null,
        attribution: source.attribution || null,
    };
}

module.exports = { IDENTITY_URL_RE, EMAIL_RE, RAW_TEXT_CAP, RAW_TITLE_CAP, HTML_PARSE_CAP, capRaw, redactIdentities, toPayload, htmlToText, nearestCity, externalId, isoDate, truncate, MAX_TEXT };
