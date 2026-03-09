// src/pipeline/ingest.js
// Pipeline orchestrator: raw API payload → normalise → dedup → score → store.
//
// Entry points:
//   normalisePost(rawPayload, sourceType)          — pure: strips PII, hashes content
//   ingestPost(rawPayload, sourceId, jobId, mvIds) — orchestrates full pipeline for one post
//   ingestBatch(payloads, sourceId, jobId, mvIds)  — ingestPost over an array; returns counts
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

// ─── PII fields stripped from raw_payload before storage ─────────────────────
const PII_FIELDS = ['author', 'author_fullname', 'username', 'user', 'email'];

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
    // Fetch source_type to drive normalisation logic
    const source = await dbGet(
        'SELECT source_type FROM data_sources WHERE id = $1',
        [sourceId],
    );
    const sourceType = source?.source_type || 'reddit';

    // Step 1: Normalise (pure — no DB)
    const normalised = normalisePost(rawPayload, sourceType);

    // Step 2: Dedup — try to insert; return existing if already present
    const existing = await dbGet(
        'SELECT id FROM raw_posts WHERE source_id = $1 AND external_id = $2',
        [sourceId, normalised.externalId],
    );
    if (existing) {
        return { postId: existing.id, isNew: false };
    }

    // Step 3: Insert raw_posts row (immutable after insert)
    const post = await dbRun(
        `INSERT INTO raw_posts
            (source_id, external_id, content, content_hash, raw_payload)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
            sourceId,
            normalised.externalId,
            normalised.content,
            normalised.contentHash,
            JSON.stringify(normalised.rawPayload),
        ],
    );
    const postId = post.id;

    // Steps 4–6: Score in parallel — all three pipeline components are independent
    await Promise.all([
        saveSentiment(postId, jobId, mvIds.sentimentMvId),
        saveRelevance(postId, jobId, mvIds.relevanceMvId),
        saveDQI(postId, jobId, mvIds.discourseMvId),
    ]);

    return { postId, isNew: true };
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

module.exports = { normalisePost, ingestPost, ingestBatch };
