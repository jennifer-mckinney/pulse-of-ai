// src/pipeline/ingest.js
// Pipeline orchestrator: raw API payload → normalise → dedup → score → store.
//
// Entry points:
//   normalisePost(rawPayload, sourceType)          — pure: strips PII, hashes content
//   storeRawPost(rawPayload, sourceId)             — normalise → dedup → insert (no scoring)
//   scorePost(postId, jobId, mvIds)                — sentiment + relevance + DQI (idempotent)
//   ingestPost(rawPayload, sourceId, jobId, mvIds) — storeRawPost + scorePost for one post
//   ingestBatch(payloads, sourceId, jobId, mvIds)  — ingestPost over an array; returns counts
//
// Collector payloads (src/collectors/normalize.js) arrive as
//   { id, text, title?, url?, published_at?, location?, location_basis?, language?, ... }
// built from an allowlist of content fields; `location` is kept only when it
// resolves to a city-registry entry (city granularity, never finer).
//
// Pipeline per post:
//   1. normalisePost — strip author/PII, build content string, compute content_hash
//   2. Dedup check — UNIQUE(source_id, external_id) prevents double-ingestion
//   3. saveSentiment   (src/pipeline/sentiment.js)
//   4. saveRelevance   (src/pipeline/relevance.js)
//   5. saveDQI         (src/pipeline/discourse.js)
//
// GDPR compliance:
//   - Author fields and usernames are removed in normalisePost before any DB write
//   - content_hash enables dedup without storing duplicate content
//   - raw_payload stores source metadata with PII fields stripped

'use strict';

const crypto    = require('crypto');
const { dbGet, dbRun } = require('../db/connection');
const { saveSentiment } = require('./sentiment');
const { saveRelevance  } = require('./relevance');
const { saveDQI        } = require('./discourse');
const { findCity       } = require('../../public/js/config/cities.config.js');
const { getSource, retentionHours } = require('../config/source-registry');

// ─── PII fields stripped from raw_payload before storage ─────────────────────
// Registered as ingest@1.1.0 pii_fields_removed (methodology-registry.js).
// Collectors never request these; this is the backstop.
// P10-2: payload keys that duplicate the post text; not stored (ingest@1.6.0).
const PAYLOAD_TEXT_KEYS = Object.freeze(['text', 'title', 'body', 'content', 'selftext']);
// Spec §8: every collected post gets a 'collected' data_retention_log row.
const COLLECTED_LEGAL_BASIS = 'GDPR Article 6(1)(f) - Legitimate Interest';

const PII_FIELDS = [
    'author', 'author_fullname', 'author_id', 'authors', 'username', 'user',
    'user_id', 'screen_name', 'creator', 'uploader', 'owner', 'email',
];

/**
 * G10-5: PostgreSQL TEXT and JSONB reject the NUL character (U+0000), so one
 * upstream item carrying it failed its whole store. Removed from every
 * string of the payload before normalising.
 * @param {unknown} v
 * @returns {unknown}
 */
function stripNul(v) {
    if (typeof v === 'string') return v.includes('\u0000') ? v.replace(/\u0000/g, '') : v;
    if (Array.isArray(v)) return v.map(stripNul);
    if (v && typeof v === 'object') {
        const out = {};
        for (const [k, x] of Object.entries(v)) out[stripNul(k)] = stripNul(x);
        return out;
    }
    return v;
}

/**
 * City-level location of a payload: the registry's canonical city name when
 * the payload's location resolves to a registry city, else ''.
 * @param {unknown} location
 * @returns {string}
 */
function cityLocation(location) {
    const entry = typeof location === 'string' ? findCity(location) : null;
    return entry ? entry.name : '';
}

// ─── Normalisation ────────────────────────────────────────────────────────────

/**
 * Normalise a raw API payload into storable fields.
 * Pure function — no database access, no side effects.
 *
 * Handles Reddit-format payloads (title + selftext).
 * Extend with additional sourceType branches as new collectors are added.
 *
 * @param {object} rawPayload   Raw object from the collector (Reddit, RSS, etc.)
 * @param {string} sourceType   'reddit' | 'rss' | 'arxiv' | 'scraper'
 * @returns {{
 *   externalId:  string,
 *   content:     string,   // PII-stripped, normalised text
 *   contentHash: string,   // SHA-256(content) for deduplication
 *   rawPayload:  object    // PII fields removed
 * }}
 */
function normalisePost(rawPayload, sourceType) {
    let content    = '';
    let externalId = rawPayload.id || rawPayload.external_id || '';

    if (sourceType === 'reddit') {
        // Concatenate title + selftext for the full document; trim whitespace
        const title    = (rawPayload.title    || '').trim();
        const selftext = (rawPayload.selftext || '').trim();
        content = [title, selftext].filter(Boolean).join('\n\n');
    } else {
        // Generic fallback: use 'text', 'body', 'content', or 'title' fields
        content = (
            rawPayload.text    ||
            rawPayload.body    ||
            rawPayload.content ||
            rawPayload.title   ||
            ''
        ).toString().trim();
    }

    // Normalise whitespace for consistent hashing
    const normalised = content.replace(/\s+/g, ' ').trim();

    // SHA-256 of normalised content — used for deduplication across sources
    const contentHash = crypto.createHash('sha256').update(normalised).digest('hex');

    // Strip PII from raw_payload before storage — GDPR data minimisation
    const safePayload = { ...rawPayload };
    for (const field of PII_FIELDS) {
        delete safePayload[field];
    }

    return {
        externalId,
        content:    normalised,
        contentHash,
        rawPayload: safePayload,
    };
}

// ─── Store / score ────────────────────────────────────────────────────────────

/**
 * Normalise → dedup → insert one raw post. No scoring.
 * Idempotent: an existing (source_id, external_id) returns the stored row.
 *
 * @param {object} rawPayload  Raw collector payload
 * @param {string} sourceId    UUID of data_sources row
 * @param {{ ingestMvId?: string, admissionMvId?: string }} [o]  methodology_versions.id of the ingest
 *        version (G10-11) and of the admission filter the post passed (PR #22 G6)
 * @returns {Promise<{ postId: string, isNew: boolean }>}
 */
async function storeRawPost(rawPayloadIn, sourceId, { ingestMvId = null, admissionMvId = null } = {}) {
    const rawPayload = stripNul(rawPayloadIn);
    // Fetch source_type to drive normalisation logic
    const source = await dbGet(
        'SELECT source_type, name FROM data_sources WHERE id = $1',
        [sourceId],
    );
    const sourceType = source?.source_type || 'reddit';

    // Step 1: Normalise (pure — no DB)
    const normalised = normalisePost(rawPayload, sourceType);
    if (!normalised.externalId || !normalised.content) {
        throw new Error('storeRawPost: payload has no external id or no text');
    }

    // Step 2: Dedup — try to insert; return existing if already present
    const existing = await dbGet(
        'SELECT id FROM raw_posts WHERE source_id = $1 AND external_id = $2',
        [sourceId, normalised.externalId],
    );
    if (existing) {
        return { postId: existing.id, isNew: false };
    }

    // Step 3: Insert raw_posts row (immutable after insert). ON CONFLICT
    // covers a concurrent insert of the same post by another process.
    const language = typeof rawPayload.language === 'string'
        && /^[a-z]{2}$/.test(rawPayload.language) ? rawPayload.language : 'en';
    // D2 provenance fingerprint (ingest@1.3.0, migration 017): a column of
    // its own, not duplicated in raw_payload. Only a well-formed HMAC-SHA256
    // hex digest is accepted.
    const fp = rawPayload.provenance_fingerprint;
    const provenanceFingerprint = typeof fp === 'string' && /^[0-9a-f]{64}$/.test(fp) ? fp : null;
    const storedPayload = { ...normalised.rawPayload };
    delete storedPayload.provenance_fingerprint;
    // P10-2 (ingest@1.6.0): the text lives ONLY in raw_posts.content, so
    // removing it (src/collectors/retention.js) genuinely removes it. The
    // payload keeps metadata (url, published_at, location_basis, route,
    // licence), never a second copy of the text or title.
    for (const k of PAYLOAD_TEXT_KEYS) delete storedPayload[k];
    // One statement: the post and its spec §8 'collected' retention row
    // are written together or not at all.
    const src = source ? getSource(source.name) : null;
    const post = await dbRun(
        `WITH ins AS (
             INSERT INTO raw_posts
                 (source_id, external_id, content, content_hash, raw_payload, location, language,
                  provenance_fingerprint, ingest_mv_id, admission_mv_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $12)
             ON CONFLICT (source_id, external_id) DO NOTHING
             RETURNING id
         ), logged AS (
             INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
             SELECT id, 'collected', $10, $11, 'src/pipeline/ingest.js' FROM ins
         )
         SELECT id FROM ins`,
        [
            sourceId,
            normalised.externalId,
            normalised.content,
            normalised.contentHash,
            JSON.stringify(storedPayload),
            cityLocation(rawPayload.location),
            language,
            provenanceFingerprint,
            // G10-11: the ingest methodology version this post was stored
            // under (the receipt shows it); null when the caller has none.
            ingestMvId,
            JSON.stringify({
                source: source ? source.name : null,
                text_retention_hours: safeRetentionHours(src),
                text_retention_basis: src && src.retention ? 'platform terms' : 'detail window (spec §19)',
            }),
            COLLECTED_LEGAL_BASIS,
            admissionMvId,
        ],
    );
    if (!post) {
        const raced = await dbGet(
            'SELECT id FROM raw_posts WHERE source_id = $1 AND external_id = $2',
            [sourceId, normalised.externalId],
        );
        return { postId: raced.id, isNew: false };
    }
    return { postId: post.id, isNew: true };
}

/**
 * Run the three per-post scorers (each writes its decision_audit_log row).
 * Idempotent: each save* is a no-op when its result already exists, so a
 * retry after a partial failure completes the missing stages only.
 *
 * @param {string} postId
 * @param {string} jobId
 * @param {{ sentimentMvId, relevanceMvId, discourseMvId }} mvIds
 * @returns {Promise<{ sentiment: object, relevance: object, discourse: object }>}
 */
/** The window stated on the collected row; null (never a guess) when the configured window is invalid (M1). */
function safeRetentionHours(src) {
    try { return retentionHours(src); } catch { return null; }
}

async function scorePost(postId, jobId, mvIds) {
    const [sentiment, relevance, discourse] = await Promise.all([
        saveSentiment(postId, jobId, mvIds.sentimentMvId),
        saveRelevance(postId, jobId, mvIds.relevanceMvId),
        saveDQI(postId, jobId, mvIds.discourseMvId),
    ]);
    return { sentiment, relevance, discourse };
}

// ─── Single post ingestion ────────────────────────────────────────────────────

/**
 * Full pipeline for a single raw post: normalise → dedup → score → store.
 * Idempotent: if the post already exists (same source_id + external_id), the
 * raw_posts INSERT is skipped and scoring is also skipped (scores already exist).
 *
 * @param {object} rawPayload  Raw collector payload
 * @param {string} sourceId    UUID of data_sources row
 * @param {string} jobId       UUID of processing_jobs row
 * @param {{
 *   sentimentMvId: string,
 *   relevanceMvId: string,
 *   discourseMvId: string
 * }} mvIds                    Methodology version UUIDs for each pipeline component
 * @returns {Promise<{ postId: string, isNew: boolean }>}
 */
async function ingestPost(rawPayload, sourceId, jobId, mvIds) {
    const stored = await storeRawPost(rawPayload, sourceId);
    if (!stored.isNew) return stored;
    await scorePost(stored.postId, jobId, mvIds);
    return stored;
}

// ─── Batch ingestion ──────────────────────────────────────────────────────────

/**
 * Ingest an array of raw payloads from a single source.
 * Posts are processed sequentially to avoid DB connection pool exhaustion.
 *
 * @param {object[]} payloads   Array of raw collector payloads
 * @param {string}   sourceId   UUID of data_sources row
 * @param {string}   jobId      UUID of processing_jobs row
 * @param {object}   mvIds      { sentimentMvId, relevanceMvId, discourseMvId }
 * @returns {Promise<{ total: number, newPosts: number, skipped: number }>}
 */
async function ingestBatch(payloads, sourceId, jobId, mvIds) {
    let newPosts = 0;
    let skipped  = 0;

    for (const payload of payloads) {
        const result = await ingestPost(payload, sourceId, jobId, mvIds);
        if (result.isNew) {
            newPosts++;
        } else {
            skipped++;
        }
    }

    return { total: payloads.length, newPosts, skipped };
}

module.exports = {
    normalisePost,
    storeRawPost,
    stripNul,
    scorePost,
    ingestPost,
    ingestBatch,
    cityLocation,
    PII_FIELDS,
    PAYLOAD_TEXT_KEYS,
    COLLECTED_LEGAL_BASIS,
};
