// src/collectors/provenance.js
// Provenance identifier (decision D2: "we need an identifier to be able to
// prove the audit traceability back to the source"), ingest@1.3.0.
//
//   provenance fingerprint = HMAC-SHA256(key,
//       source_slug + ":" + raw upstream external id + ":" + canonical source URL)
//   key = PROVENANCE_KEY, else AUDIT_HASH_KEY (standup generates it)
//
// Every collected post stores it (raw_posts.provenance_fingerprint). Nothing
// about the upstream item needs to be stored to prove the link later: anyone
// holding the original URL (and, when it was fingerprinted, the original
// id) reproduces the fingerprint with `npm run verify-provenance`.
//
// External ids: the raw upstream id is stored only when it is not
// identity-bearing (numeric ids, arXiv / PMID / DOI, HN item ids, clean
// slugs). An id that is a profile link, carries a query string, fragment,
// '@', '%', '&' or '=', contains whitespace, or is over 200 characters is
// stored as its keyed fingerprint instead ("fp:<hmac>", F10-14). Without a
// key an unkeyed SHA-256 is used (ids stay unreadable; the provenance
// fingerprint is then absent and the receipt says so).

'use strict';

const crypto = require('crypto');
const { isIdentityUrl } = require('./identity');

const SAFE_ID_RE = /^[\w.:/~+-]{1,200}$/;

/** @returns {string|null} the provenance key, or null when none is configured */
function provenanceKey(env = process.env) {
    for (const k of ['PROVENANCE_KEY', 'AUDIT_HASH_KEY']) {
        const v = env[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
}

function hmac(key, text) {
    return crypto.createHmac('sha256', key).update(text).digest('hex');
}

/**
 * @param {string|null} key
 * @param {string} slug     registry source slug
 * @param {string} rawId    upstream external id, as received
 * @param {string} url      canonical source URL, as received ('' when none)
 * @returns {string|null}
 */
function provenanceFingerprint(key, slug, rawId, url) {
    if (!key) return null;
    return hmac(key, `${slug}:${rawId}:${url || ''}`);
}

/** Whether an upstream id could identify a person (or carries tokens). */
function isIdentityBearingId(raw) {
    return !SAFE_ID_RE.test(raw) || isIdentityUrl(raw);
}

/**
 * The stored external id: `<route>:<raw id>` when the raw id is safe, else
 * `<route>:fp:<keyed fingerprint>` (or an unkeyed SHA-256 without a key).
 */
function storedExternalId(routeId, rawId, key) {
    const raw = String(rawId === null || rawId === undefined ? '' : rawId).trim();
    if (!raw) return '';
    if (!isIdentityBearingId(raw)) return `${routeId}:${raw}`;
    return key ? `${routeId}:fp:${hmac(key, `id:${routeId}:${raw}`)}` : `${routeId}:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

/**
 * Verify a claimed original against a stored post.
 * @returns {{ match: boolean, fingerprint: string|null }}
 */
function verify({ key, slug, rawId, url, stored }) {
    const fp = provenanceFingerprint(key, slug, rawId, url);
    const a = Buffer.from(String(fp || ''));
    const b = Buffer.from(String(stored || ''));
    return { match: !!fp && a.length === b.length && crypto.timingSafeEqual(a, b), fingerprint: fp };
}

module.exports = { provenanceKey, provenanceFingerprint, isIdentityBearingId, storedExternalId, verify, hmac };
