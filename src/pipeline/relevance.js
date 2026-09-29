// src/pipeline/relevance.js
// AI-relevance scoring pipeline component.
//
// Responsibilities:
//   computeRelevance(text, version?)    — pure: text → { score, matchedKeywords }
//   saveRelevance(postId, jobId, mvId)  — persist to relevance_results + decision_audit_log
//
// Versions (src/config/methodology-registry.js; the scorer of every
// registered version is kept, so `npm run replay` re-runs a decision with
// the rule it was scored under):
//   relevance@1.1.0  20-term lexicon, case-insensitive SUBSTRING match
//                    (so "Robert" matched "bert"; also what 1.0.0's code ran,
//                    see the erratum row). Model keyword-relevance-v1.
//   relevance@1.2.0  (current, P10-13) 21 terms — the 20 plus "AI" — matched
//                    by the rules in src/config/ai-lexicon.js: case-sensitive
//                    whole-word "AI" (the collection filter's own rule),
//                    whole-word acronyms, word boundaries for every term.
//                    Model keyword-relevance-v2.
//   score = |unique matched terms| / lexicon size, capped at 1.0.
//
// Embedding gate: EMBED_GATE_MIN_SCORE = 1 / (current lexicon size) — a post
//   is embedded when at least one term matches.
//
// Phase D upgrade: replace keyword scoring with cosine similarity against AI-topic centroid
//   embedding (all-MiniLM-L6-v2). Justification stored in methodology_versions config.

'use strict';

const crypto = require('crypto');
const { dbGet, dbRun, dbTransaction } = require('../db/connection');

const { RELEVANCE_TERMS_1_2_0 } = require('../config/ai-lexicon');

// ─── relevance@1.1.0 lexicon (substring) ─────────────────────────────────────
// Kept exactly for replay of 1.0.0 / 1.1.0 decisions; never edited.
const KEYWORD_LIST_1_1_0 = Object.freeze([
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
]);

function substringScorer(list) {
    return (text) => {
        const lower = (text || '').toLowerCase();
        if (!lower) return { score: 0, matchedKeywords: [] };
        const matched = [...new Set(list.filter(kw => lower.includes(kw)))];
        return { score: Math.min(matched.length / list.length, 1.0), matchedKeywords: matched };
    };
}

function patternScorer(terms) {
    return (text) => {
        const t = typeof text === 'string' ? text : '';
        if (!t) return { score: 0, matchedKeywords: [] };
        const matched = terms.filter(x => x.pattern.test(t)).map(x => x.term);
        return { score: Math.min(matched.length / terms.length, 1.0), matchedKeywords: matched };
    };
}

// version → { model, lexicon, run }. The CURRENT version is the registry's
// last relevance row (CURRENT_VERSIONS); tests hold the two in step.
const VERSIONS = Object.freeze({
    '1.0.0': { model: 'keyword-relevance-v1', lexicon: KEYWORD_LIST_1_1_0, run: substringScorer(KEYWORD_LIST_1_1_0) },
    '1.1.0': { model: 'keyword-relevance-v1', lexicon: KEYWORD_LIST_1_1_0, run: substringScorer(KEYWORD_LIST_1_1_0) },
    '1.2.0': {
        model: 'keyword-relevance-v2',
        lexicon: Object.freeze(RELEVANCE_TERMS_1_2_0.map(x => x.term)),
        run: patternScorer(RELEVANCE_TERMS_1_2_0),
    },
});
const CURRENT_VERSION = '1.2.0';
const MODEL_NAME = VERSIONS[CURRENT_VERSION].model;
// The CURRENT lexicon (relevance@1.2.0).
const KEYWORD_LIST = VERSIONS[CURRENT_VERSION].lexicon;

/** The scorer of a registered version (unknown or missing → current). */
function scorerFor(version) {
    return VERSIONS[version] || VERSIONS[CURRENT_VERSION];
}

// ─── Pure scoring ─────────────────────────────────────────────────────────────

/**
 * Compute AI-relevance score for a piece of text.
 * Pure function — no database access, no side effects.
 *
 * @param {string} text     Raw post content to score
 * @param {string} [version] registered relevance version (default: current)
 * @returns {{ score: number, matchedKeywords: string[] }}
 */
function computeRelevance(text, version = CURRENT_VERSION) {
    return scorerFor(version).run(text);
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

    // Score with the rule of the version this decision is recorded under
    // (P10-13): the audit row's methodology_version_id and its output then
    // always agree, and `npm run replay` reproduces it. An unregistered id
    // (or a version with no kept scorer) falls back to the current rule.
    const mv = await dbGet('SELECT version FROM methodology_versions WHERE id = $1', [mvId]);
    const scorer    = scorerFor(mv && mv.version);
    const scored    = scorer.run(post.content);
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
                scorer.model,
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

// ─── Embedding gate ───────────────────────────────────────────────────────────

/** Minimum relevance score for a post to be embedded: one lexicon match. */
const EMBED_GATE_MIN_SCORE = 1 / KEYWORD_LIST.length;

/**
 * Whether a relevance score passes the embedding gate.
 * @param {number|string|null} score  relevance_results.score (pg NUMERIC may arrive as a string)
 * @returns {boolean}
 */
function passesEmbedGate(score) {
    const n = Number(score);
    // Tolerance absorbs NUMERIC round-trips of exactly 1/20.
    return Number.isFinite(n) && n >= EMBED_GATE_MIN_SCORE - 1e-9;
}

// MODEL_NAME exported for scripts/replay.js (code identity of a replay).
module.exports = {
    computeRelevance,
    scorerFor,
    VERSIONS,
    CURRENT_VERSION,
    KEYWORD_LIST_1_1_0,
    saveRelevance,
    passesEmbedGate,
    EMBED_GATE_MIN_SCORE,
    KEYWORD_LIST,
    MODEL_NAME,
};
