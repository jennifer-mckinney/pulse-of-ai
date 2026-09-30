// src/pipeline/embeddings.js
// Text embedding pipeline: generate → store in post_embeddings.
//
// External dependency: Infinity embedding service (OpenAI-compatible API).
//   POST /embeddings  { input: [text], model: "..." }
//   Returns: { data: [{ index: 0, embedding: float[] }] }
//
// Entry points:
//   generateEmbedding(text)        — calls Infinity; returns float array
//   saveEmbedding(postId, vec)     — upserts post_embeddings row; returns row UUID
//   embedPost(postId)              — full pipeline: fetch content → generate → save
//                                    (a no-op with a reason for a post purged or
//                                    blanked by retention — never its notice)
//
// The Infinity service is checked via EMBEDDINGS_SERVICE_URL env var.
// In test environments, axios.post is mocked — no real HTTP call is made.

'use strict';

const axios = require('axios');
const { dbGet, dbRun } = require('../db/connection');
const { METHODOLOGY_VERSIONS } = require('../config/methodology-registry');
const { DEMO_PURGE_ACTION } = require('../config/data-mode');

const EMBEDDINGS_SERVICE_URL = process.env.EMBEDDINGS_SERVICE_URL || 'http://localhost:8000';
const MODEL_NAME             = process.env.EMBED_MODEL || 'sentence-transformers/all-MiniLM-L6-v2';

// P9-5: the registered embedding methodology (model + pinned revision) —
// the LAST 'embedding' entry of the registry, as for every component.
const EMBEDDING_METHODOLOGY = METHODOLOGY_VERSIONS.filter(m => m.component === 'embedding').pop();

/**
 * The embedding methodology version to record on a stored vector: the
 * registered version when the configured model AND revision are the
 * registered ones (the defaults), else null — a vector produced under an
 * override must not claim a methodology it may not match.
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
function embeddingMethodologyVersion(env) {
    const model = env.EMBED_MODEL || EMBEDDING_METHODOLOGY.model_name;
    const revision = env.EMBED_MODEL_REVISION || EMBEDDING_METHODOLOGY.config.revision;
    return model === EMBEDDING_METHODOLOGY.model_name && revision === EMBEDDING_METHODOLOGY.config.revision
        ? EMBEDDING_METHODOLOGY.version : null;
}
const METHODOLOGY_VERSION = embeddingMethodologyVersion(process.env);

// all-MiniLM-L6-v2 produces 384-dimensional embeddings
const EMBEDDING_DIMENSIONS = 384;

// ─── generateEmbedding ────────────────────────────────────────────────────────

/**
 * Send text to the Infinity embedding service and return the float array.
 * Uses the OpenAI-compatible POST /embeddings endpoint.
 *
 * @param {string} text  Content to embed
 * @returns {Promise<number[]>}  Array of EMBEDDING_DIMENSIONS floats
 */
async function generateEmbedding(text) {
    const response = await axios.post(
        `${EMBEDDINGS_SERVICE_URL}/embeddings`,
        { input: [text], model: MODEL_NAME },
    );
    // OpenAI-compatible response: { data: [{ index, embedding }] }
    return response.data.data[0].embedding;
}

// ─── saveEmbedding ────────────────────────────────────────────────────────────

/**
 * Upsert an embedding vector into post_embeddings.
 * ON CONFLICT replaces the vector — re-embedding a post replaces the old row.
 *
 * @param {string}   postId     UUID of raw_posts row
 * @param {number[]} embedding  Float array from generateEmbedding
 * @param {string}   [modelName] Model that produced the embedding
 * @returns {Promise<string>}  UUID of the inserted/updated post_embeddings row
 */
async function saveEmbedding(postId, embedding, modelName = MODEL_NAME) {
    // pgvector expects vector in '[f1,f2,...,fn]' string format
    const vectorStr = `[${embedding.join(',')}]`;

    // methodology_version (P9-5): which registered embedding methodology
    // (model + pinned revision, migration 012) produced this vector.
    const row = await dbRun(
        `INSERT INTO post_embeddings (raw_post_id, embedding, model_name, methodology_version)
         VALUES ($1, $2::vector, $3, $4)
         ON CONFLICT (raw_post_id) DO UPDATE
            SET embedding           = EXCLUDED.embedding,
                model_name          = EXCLUDED.model_name,
                methodology_version = EXCLUDED.methodology_version
         RETURNING id`,
        [postId, vectorStr, modelName, METHODOLOGY_VERSION],
    );
    return row.id;
}

// ─── embedPost ────────────────────────────────────────────────────────────────

// Why an embed job completes WITHOUT embedding (a no-op with a recorded
// reason, never a failed job):
//   purged_demo   the post was a fictional demo post deleted at the retention
//                 boundary (scripts/compact.js purgeDemoBatch) after its job
//                 was queued — the purge's data_retention_log row lists it;
//   text_removed  the post's text was removed by retention (blanked to a
//                 notice, src/collectors/retention.js) — the notice is never
//                 embedded.
// A post that is missing WITHOUT a purge record is a real error and still
// throws "Post not found".
const SKIP_REASONS = Object.freeze({ PURGED_DEMO: 'purged_demo', TEXT_REMOVED: 'text_removed' });

/**
 * The demo-purge record that deleted this post, or null. The purge writes
 * one data_retention_log row per batch whose reason JSON lists post_ids; the
 * CASE keeps the jsonb cast off every other action's (free-text) reason.
 * @param {string} postId
 * @returns {Promise<{ performed_at: Date } | null>}
 */
async function findDemoPurgeRecord(postId) {
    const row = await dbGet(
        `SELECT performed_at FROM data_retention_log
         WHERE action = $1
           AND CASE WHEN action = $1 AND reason LIKE '{%'
                    THEN COALESCE((reason::jsonb -> 'post_ids') ? $2, FALSE)
                    ELSE FALSE END
         ORDER BY performed_at DESC
         LIMIT 1`,
        [DEMO_PURGE_ACTION, String(postId)],
    );
    return row || null;
}

/** A skipped job's result: the post id, the reason and when it happened. */
function skipped(postId, reason, at) {
    return { postId, skipped: true, reason, at: at ? new Date(at).toISOString() : null };
}

/**
 * The post is not in raw_posts: a no-op when a demo purge removed it, else
 * the loud "Post not found" error (a real bug: BullMQ retries, then fails).
 */
async function missingPost(postId) {
    const purge = await findDemoPurgeRecord(postId);
    if (purge) return skipped(postId, SKIP_REASONS.PURGED_DEMO, purge.performed_at);
    throw new Error(`Post not found: ${postId}`);
}

/**
 * Store the vector only while the post still exists WITH its text: the
 * INSERT selects from raw_posts, so a post blanked or purged between the
 * read and this write gets no vector (null is returned). A purge that
 * commits during the insert surfaces as a foreign-key violation (23503),
 * also returned as null — the caller re-reads the post's state.
 * @returns {Promise<string|null>} post_embeddings.id, or null
 */
async function saveEmbeddingIfTextStored(postId, embedding, modelName = MODEL_NAME) {
    const vectorStr = `[${embedding.join(',')}]`;
    try {
        const row = await dbRun(
            `INSERT INTO post_embeddings (raw_post_id, embedding, model_name, methodology_version)
             SELECT rp.id, $2::vector, $3, $4
             FROM raw_posts rp
             WHERE rp.id = $1 AND rp.text_removed_at IS NULL
             ON CONFLICT (raw_post_id) DO UPDATE
                SET embedding           = EXCLUDED.embedding,
                    model_name          = EXCLUDED.model_name,
                    methodology_version = EXCLUDED.methodology_version
             RETURNING id`,
            [postId, vectorStr, modelName, METHODOLOGY_VERSION],
        );
        return row ? row.id : null;
    } catch (err) {
        if (err && err.code === '23503') return null;   // post deleted mid-insert
        throw err;
    }
}

/**
 * Full embedding pipeline for a single post.
 * Fetches the post content, generates an embedding, and persists it.
 * A post purged or blanked by retention is skipped (see SKIP_REASONS).
 *
 * @param {string} postId  UUID of the raw_posts row to embed
 * @returns {Promise<{ postId: string, embeddingId: string, dimensions: number }
 *                  | { postId: string, skipped: true, reason: string, at: string|null }>}
 */
async function embedPost(postId) {
    const post = await dbGet(
        'SELECT content, text_removed_at FROM raw_posts WHERE id = $1',
        [postId],
    );
    if (!post) return missingPost(postId);
    if (post.text_removed_at) return skipped(postId, SKIP_REASONS.TEXT_REMOVED, post.text_removed_at);

    const embedding   = await generateEmbedding(post.content);
    const embeddingId = await saveEmbeddingIfTextStored(postId, embedding);
    if (!embeddingId) {
        // Purged or blanked while the vector was being computed: re-read.
        const now = await dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [postId]);
        if (!now) return missingPost(postId);
        if (now.text_removed_at) return skipped(postId, SKIP_REASONS.TEXT_REMOVED, now.text_removed_at);
        throw new Error(`embedding for post ${postId} was not stored`);
    }

    return { postId, embeddingId, dimensions: embedding.length };
}

module.exports = {
    generateEmbedding,
    saveEmbedding,
    embedPost,
    findDemoPurgeRecord,
    SKIP_REASONS,
    EMBEDDING_DIMENSIONS,
    embeddingMethodologyVersion,
};
