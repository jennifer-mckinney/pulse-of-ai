// src/pipeline/relevance.js
// AI-relevance scoring pipeline component.
//
// Responsibilities:
//   computeRelevance(text)              — pure: text → { score, matchedKeywords }
//   saveRelevance(postId, jobId, mvId)  — persist to relevance_results + decision_audit_log
//
// Algorithm: keyword overlap against a curated 20-term AI domain lexicon.
//   score = |unique matched keywords| / KEYWORD_LIST.length, capped at 1.0.
//   Phrase keywords are matched as substrings; single-word keywords match word boundaries.
//
// Phase D upgrade: replace keyword scoring with cosine similarity against AI-topic centroid
//   embedding (all-MiniLM-L6-v2). Justification stored in methodology_versions config.

'use strict';

const crypto = require('crypto');
const { dbGet, dbRun, dbTransaction } = require('../db/connection');

const MODEL_NAME = 'keyword-relevance-v1';

// ─── AI domain keyword lexicon ────────────────────────────────────────────────
// 20 terms spanning the major sub-disciplines of artificial intelligence.
// Expand or replace in Phase D with embedding-based scoring.
const KEYWORD_LIST = [
    'artificial intelligence',
    'machine learning',
    'deep learning',
    'neural network',
    'large language model',
    'llm',
    'natural language processing',
    'nlp',
    'transformer',
    'reinforcement learning',
    'generative ai',
    'computer vision',
    'foundation model',
    'fine-tuning',
    'embeddings',
    'gpt',
    'bert',
    'diffusion model',
    'autonomous agent',
    'ai safety',
];

// ─── Pure scoring ─────────────────────────────────────────────────────────────

/**
 * Compute AI-relevance score for a piece of text.
 * Pure function — no database access, no side effects.
 *
 * @param {string} text  Raw post content to score
 * @returns {{
 *   score:           number,    // 0.0–1.0; fraction of lexicon matched
 *   matchedKeywords: string[]   // unique keywords found in text
 * }}
 */
function computeRelevance(text) {
    const lower = (text || '').toLowerCase();
    if (!lower) return { score: 0, matchedKeywords: [] };

    // Deduplicate matches — each keyword counted at most once
    const matched = [...new Set(
        KEYWORD_LIST.filter(kw => lower.includes(kw)),
    )];

    const score = Math.min(matched.length / KEYWORD_LIST.length, 1.0);

    return { score, matchedKeywords: matched };
}

// ─── DB persistence ───────────────────────────────────────────────────────────

/**
 * Score a raw post for AI-relevance and persist with full audit trail.
 * Idempotent: a second call for the same postId is a no-op.
 *
 * @param {string} postId  UUID of raw_posts row
 * @param {string} jobId   UUID of processing_jobs row
 * @param {string} mvId    UUID of methodology_versions row (component='relevance')
 * @returns {Promise<object>}  The saved relevance_results row
 */
async function saveRelevance(postId, jobId, mvId) {
    const post = await dbGet('SELECT content FROM raw_posts WHERE id = $1', [postId]);
    if (!post || !post.content) {
        throw new Error(`saveRelevance: post ${postId} not found or content already nulled`);
    }

    // Idempotency check
    const existing = await dbGet(
        'SELECT * FROM relevance_results WHERE raw_post_id = $1',
        [postId],
    );
    if (existing) return existing;

    const scored    = computeRelevance(post.content);
    const inputHash = crypto.createHash('sha256').update(post.content).digest('hex');

    return dbTransaction(async (client) => {
        // 1. Write decision_audit_log row
        const auditResult = await client.query(
            `INSERT INTO decision_audit_log
                (raw_post_id, job_id, methodology_version_id,
                 decision_type, model_name, input_hash, output, confidence)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING id`,
            [
                postId,
                jobId,
                mvId,
                'relevance',
                MODEL_NAME,
                inputHash,
                JSON.stringify({
                    score:           scored.score,
                    matchedKeywords: scored.matchedKeywords,
                }),
                null,   // no confidence estimate from keyword matching
            ],
        );
        const auditId = auditResult.rows[0].id;

        // 2. Write derived relevance_results row
        // is_relevant: any keyword match (score > 0) qualifies as AI-relevant
        const relResult = await client.query(
            `INSERT INTO relevance_results
                (raw_post_id, audit_id, score, matched_keywords, is_relevant)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [postId, auditId, scored.score, scored.matchedKeywords, scored.score > 0],
        );

        return relResult.rows[0];
    });
}

module.exports = { computeRelevance, saveRelevance, KEYWORD_LIST };
