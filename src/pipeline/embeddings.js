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
//
// The Infinity service is checked via EMBEDDINGS_SERVICE_URL env var.
// In test environments, axios.post is mocked — no real HTTP call is made.

'use strict';

const axios = require('axios');
const { dbGet, dbRun } = require('../db/connection');
const { METHODOLOGY_VERSIONS } = require('../config/methodology-registry');

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

/**
 * Full embedding pipeline for a single post.
 * Fetches the post content, generates an embedding, and persists it.
 *
 * @param {string} postId  UUID of the raw_posts row to embed
 * @returns {Promise<{ postId: string, embeddingId: string, dimensions: number }>}
 */
async function embedPost(postId) {
    const post = await dbGet(
        'SELECT content FROM raw_posts WHERE id = $1',
        [postId],
    );
    if (!post) {
        throw new Error(`Post not found: ${postId}`);
    }

    const embedding   = await generateEmbedding(post.content);
    const embeddingId = await saveEmbedding(postId, embedding);

    return { postId, embeddingId, dimensions: embedding.length };
}

module.exports = {
    generateEmbedding,
    saveEmbedding,
    embedPost,
    EMBEDDING_DIMENSIONS,
    embeddingMethodologyVersion,
};
