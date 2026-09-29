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
const { CITY_REGISTRY, findCity } = require('../../public/js/config/cities.config.js');

// Links whose path names a person (profile / user namespace) are not stored:
// e.g. OpenStreetMap diary links /user/<name>/diary/<id>.
const IDENTITY_URL_RE = /\/(?:user|users|u|profile|people|member|members)\/[^/?#]+|\/@[^/?#]+/i;

const MAX_TEXT = 4000;
const MAX_TITLE = 300;
const NEAREST_CITY_KM = 50;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** Strip HTML to plain text: drop script/style, tags, decode entities, collapse whitespace. */
function htmlToText(html) {
    if (html === null || html === undefined) return '';
    return String(html)
        .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
            if (e[0] === '#') {
                const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
                return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : ' ';
            }
            return ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m;
        })
        .replace(/\s+/g, ' ')
        .trim();
}

// In-text identities: e-mail addresses and @handles (mentions, pings) are
// replaced before storage — the text keeps its meaning, not the person.
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HANDLE_RE = /(^|[^A-Za-z0-9_.])@[A-Za-z0-9_][A-Za-z0-9_.-]{1,38}/g;
function redactIdentities(text) {
    return String(text || '').replace(EMAIL_RE, '[email]').replace(HANDLE_RE, '$1@[user]');
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
    const title = truncate(redactIdentities(htmlToText(item.title)), MAX_TITLE);
    const body = redactIdentities(htmlToText(item.text));
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

module.exports = { IDENTITY_URL_RE, redactIdentities, toPayload, htmlToText, nearestCity, externalId, isoDate, truncate, MAX_TEXT };
