// src/pipeline/embeddings.js
// Text embedding pipeline: generate → store in post_embeddings.
//
// External dependency: the embeddings service (python/embeddings_service.py,
// FastAPI + sentence-transformers; compose service `embeddings`), which
// speaks an OpenAI-compatible API — so an Infinity server, the planned
// Phase-2 alternative (python/requirements.txt), could replace it unchanged.
//   POST /embeddings  { input: [text], model: "..." }
//   Returns: { data: [{ index: 0, embedding: float[] }] }
//
// Entry points:
//   generateEmbedding(text)        — calls the service; returns float array
//   saveEmbedding(postId, vec)     — upserts post_embeddings row; returns row UUID
//   embedPost(postId)              — full pipeline: fetch content → generate →
//                                    verify the service (GET /health) → save
//                                    (a no-op with a reason for a post purged or
//                                    blanked by retention — never its notice)
//
// The service is reached at the EMBEDDINGS_SERVICE_URL env var.
//   GET /health  { model, revision, library, ... } — compared with the
//                registered embedding methodology before a vector is stamped
// In test environments, axios.post and axios.get are mocked — no real HTTP
// call is made.

'use strict';

const axios = require('axios');
const { dbGet, dbRun } = require('../db/connection');
const { METHODOLOGY_VERSIONS } = require('../config/methodology-registry');
const { DEMO_PURGE_ACTION } = require('../config/data-mode');

const EMBEDDINGS_SERVICE_URL = process.env.EMBEDDINGS_SERVICE_URL || 'http://localhost:8000';
const MODEL_NAME             = process.env.EMBED_MODEL || 'sentence-transformers/all-MiniLM-L6-v2';

// P9-5: the registered embedding methodology (model + pinned revision +
// library) — the LAST 'embedding' entry of the registry, as for every
// component (= CURRENT_VERSIONS.embedding; embedding@1.1.0 since migration
// 065, sentence-transformers 6.1.0).
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

// ─── The running service must be the registered one (grumpy final #3) ────────
//
// The worker's env names the model and revision it ASKS for; it says nothing
// about the library the service actually runs, and the library is part of
// the methodology (embedding@1.1.0: sentence-transformers==6.1.0, migration
// 065). A host .venv built before the bump, or one resolved with other
// versions, would get its vectors labelled 1.1.0. So before a vector is
// stamped, the service's GET /health (python/embeddings_service.py) must
// report the registered model, revision AND library.
//
// Mismatch behaviour (decision): the vector is STORED, with
// methodology_version NULL, and the mismatch is logged once per process.
//   - NULL is the existing convention for a vector that may not match the
//     registered methodology (migration 012: model/revision overrides store
//     NULL) — the claim is withheld, the data is not thrown away. A later
//     re-embedding under a verified service restamps the row (the upsert).
//   - Failing the job instead would stop semantic search for every new post
//     over a provenance gap whose vectors are probably identical (the 1.1.0
//     equivalence evidence), and BullMQ would retry it for nothing.
//   - A /health that cannot be READ (network error, timeout, HTTP 5xx) is
//     not a mismatch: the job fails and is retried, so no vector is stored
//     with a verdict that was never reached. A /health that answers without
//     the registered fields (HTTP 404, another server) cannot verify: NULL.
// The check runs for every vector, right after the service produced it (one
// local GET per embed job), so a service replaced while the worker runs is
// noticed at once — a cached verdict would keep stamping the old one.
const HEALTH_TIMEOUT_MS = 5000;
const loggedMismatches = new Set();

/** What GET /health reports that differs from the registered methodology ([] = the registered one). */
function healthMismatches(health) {
    const h = health && typeof health === 'object' ? health : {};
    const registered = {
        model:    EMBEDDING_METHODOLOGY.model_name,
        revision: EMBEDDING_METHODOLOGY.config.revision,
        library:  EMBEDDING_METHODOLOGY.config.library,
    };
    return Object.keys(registered)
        .filter(k => h[k] !== registered[k])
        // The served value is capped: it goes into a log line.
        .map(k => `${k} ${String(JSON.stringify(h[k] === undefined ? null : h[k])).slice(0, 200)} (registered ${JSON.stringify(registered[k])})`);
}

/**
 * The embedding methodology version to stamp on a vector the service just
 * produced: the registered version when the worker's model/revision are the
 * registered ones (embeddingMethodologyVersion), the vector is stored under
 * the registered model name, AND the service's GET /health reports the
 * registered model, revision and library; null otherwise.
 * Throws when /health cannot be read (the job is retried).
 * @param {string} [modelName]  the model_name the vector is stored under
 * @returns {Promise<string|null>}
 */
async function verifiedMethodologyVersion(modelName = MODEL_NAME) {
    if (METHODOLOGY_VERSION === null) return null;     // an override claims nothing
    // Copilot review on PR #43: a vector stored under another model name
    // never carries the registered methodology, whatever the service runs.
    if (modelName !== EMBEDDING_METHODOLOGY.model_name) return null;
    let res;
    try {
        res = await axios.get(`${EMBEDDINGS_SERVICE_URL}/health`, {
            timeout: HEALTH_TIMEOUT_MS,
            validateStatus: status => status < 500,
        });
    } catch (err) {
        throw new Error(`embeddings service /health unavailable (${err && err.message}): `
            + `the vector's embedding methodology cannot be verified, so it is not stored`);
    }
    const ok = res.status >= 200 && res.status < 300;
    const problems = ok ? healthMismatches(res.data) : [`GET /health answered HTTP ${res.status}`];
    if (problems.length === 0) return METHODOLOGY_VERSION;
    const key = problems.join('; ');
    if (!loggedMismatches.has(key)) {
        loggedMismatches.add(key);
        require('../workers/logging').logError(
            `[embed] the embeddings service at ${EMBEDDINGS_SERVICE_URL} does not match the registered `
            + `embedding@${METHODOLOGY_VERSION}: ${key}. New vectors are stored with methodology_version NULL `
            + 'until it does (logged once per mismatch per process).');
    }
    return null;
}

// all-MiniLM-L6-v2 produces 384-dimensional embeddings
const EMBEDDING_DIMENSIONS = 384;

// ─── generateEmbedding ────────────────────────────────────────────────────────

/**
 * Send text to the embeddings service and return the float array.
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
    // (model + pinned revision + library) produced this vector — only once
    // the running service is verified to be it (grumpy final #3).
    const methodologyVersion = await verifiedMethodologyVersion(modelName);
    const row = await dbRun(
        `INSERT INTO post_embeddings (raw_post_id, embedding, model_name, methodology_version)
         VALUES ($1, $2::vector, $3, $4)
         ON CONFLICT (raw_post_id) DO UPDATE
            SET embedding           = EXCLUDED.embedding,
                model_name          = EXCLUDED.model_name,
                methodology_version = EXCLUDED.methodology_version
         RETURNING id`,
        [postId, vectorStr, modelName, methodologyVersion],
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
 * FOR SHARE (PR #22 G3): a concurrent blanking either waits for this insert
 * and then deletes the new vector in its own transaction, or commits first
 * and this re-checked WHERE excludes the blanked post — never a vector left
 * behind for removed text.
 * @returns {Promise<string|null>} post_embeddings.id, or null
 */
async function saveEmbeddingIfTextStored(postId, embedding, methodologyVersion, modelName = MODEL_NAME) {
    const vectorStr = `[${embedding.join(',')}]`;
    try {
        const row = await dbRun(
            `INSERT INTO post_embeddings (raw_post_id, embedding, model_name, methodology_version)
             SELECT rp.id, $2::vector, $3, $4
             FROM raw_posts rp
             WHERE rp.id = $1 AND rp.text_removed_at IS NULL
             FOR SHARE OF rp
             ON CONFLICT (raw_post_id) DO UPDATE
                SET embedding           = EXCLUDED.embedding,
                    model_name          = EXCLUDED.model_name,
                    methodology_version = EXCLUDED.methodology_version
             RETURNING id`,
            [postId, vectorStr, modelName, methodologyVersion],
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
 * @returns {Promise<{ postId: string, embeddingId: string, dimensions: number, methodologyVersion: string|null }
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
    // Grumpy final #3: the stamp is verified against the service that just
    // produced the vector (NULL on a mismatch; throws if /health is down).
    const methodologyVersion = await verifiedMethodologyVersion(MODEL_NAME);
    const embeddingId = await saveEmbeddingIfTextStored(postId, embedding, methodologyVersion);
    if (!embeddingId) {
        // Purged or blanked while the vector was being computed: re-read.
        const now = await dbGet('SELECT text_removed_at FROM raw_posts WHERE id = $1', [postId]);
        if (!now) return missingPost(postId);
        if (now.text_removed_at) return skipped(postId, SKIP_REASONS.TEXT_REMOVED, now.text_removed_at);
        throw new Error(`embedding for post ${postId} was not stored`);
    }

    return { postId, embeddingId, dimensions: embedding.length, methodologyVersion };
}

module.exports = {
    generateEmbedding,
    saveEmbedding,
    embedPost,
    findDemoPurgeRecord,
    SKIP_REASONS,
    EMBEDDING_DIMENSIONS,
    embeddingMethodologyVersion,
    verifiedMethodologyVersion,
};
