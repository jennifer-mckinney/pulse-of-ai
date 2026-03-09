// src/pipeline/sentiment.js
// Sentiment analysis pipeline component.
//
// Responsibilities:
//   computeSentiment(text)            — pure scoring; no DB side-effects
//   saveSentiment(postId, jobId, mvId) — scores + persists to sentiment_results
//                                        and decision_audit_log (audit trail)
//
// Algorithm: AFINN lexicon via 'sentiment' npm (v5.x)
// Methodology version: see methodology_versions table, component='sentiment'
// Thresholds: comparative > 0.05 → positive, < -0.05 → negative, else neutral
// Justification: ±0.05 derived from empirical AI-discourse corpus distribution.
//   Stored in methodology_versions.justification for regulatory auditability.

'use strict';

const crypto    = require('crypto');
const Sentiment = require('sentiment');
const { dbGet, dbRun, dbTransaction } = require('../db/connection');

const analyzer = new Sentiment();

// Threshold constants — must match values stored in methodology_versions config
const POSITIVE_THRESHOLD =  0.05;
const NEGATIVE_THRESHOLD = -0.05;

// Model identifier written to decision_audit_log.model_name
const MODEL_NAME = 'afinn-sentiment-v5';

// ─── Pure scoring ─────────────────────────────────────────────────────────────

/**
 * Compute AFINN sentiment score for a piece of text.
 * Pure function — no database access, no side effects.
 *
 * @param {string} text  Raw post content to score
 * @returns {{
 *   score:         number,   // raw AFINN score (sum of word scores)
 *   comparative:   number,   // score normalised by token count
 *   indicator:     string,   // 'positive' | 'neutral' | 'negative'
 *   positiveWords: string[], // matched positive-valence words
 *   negativeWords: string[], // matched negative-valence words
 *   tokenCount:    number    // word count used for normalisation
 * }}
 */
function computeSentiment(text) {
    const safe = (text || '').trim();

    // AFINN analysis — returns { score, comparative, tokens, words, positive, negative }
    const result = analyzer.analyze(safe);

    // Derive indicator from comparative score using documented thresholds
    let indicator;
    if (result.comparative > POSITIVE_THRESHOLD) {
        indicator = 'positive';
    } else if (result.comparative < NEGATIVE_THRESHOLD) {
        indicator = 'negative';
    } else {
        indicator = 'neutral';
    }

    return {
        score:         result.score,
        comparative:   result.comparative,
        indicator,
        positiveWords: result.positive || [],
        negativeWords: result.negative || [],
        tokenCount:    result.tokens ? result.tokens.length : 0,
    };
}

// ─── DB persistence ───────────────────────────────────────────────────────────

/**
 * Score a raw post and persist the result with a full audit trail.
 * Idempotent: a second call for the same postId is a no-op (ON CONFLICT DO NOTHING).
 *
 * @param {string} postId  UUID of the raw_posts row
 * @param {string} jobId   UUID of the processing_jobs row
 * @param {string} mvId    UUID of the methodology_versions row (component='sentiment')
 * @returns {Promise<object>}  The saved sentiment_results row
 */
async function saveSentiment(postId, jobId, mvId) {
    // Fetch the post content to score
    const post = await dbGet(
        'SELECT content FROM raw_posts WHERE id = $1',
        [postId],
    );
    if (!post || !post.content) {
        throw new Error(`saveSentiment: post ${postId} not found or content already nulled`);
    }

    // Idempotency check — return existing row if already scored
    const existing = await dbGet(
        'SELECT * FROM sentiment_results WHERE raw_post_id = $1',
        [postId],
    );
    if (existing) return existing;

    // Compute sentiment (pure)
    const scored = computeSentiment(post.content);

    // input_hash: SHA-256 of the content — proves what was scored without storing PII
    const inputHash = crypto
        .createHash('sha256')
        .update(post.content)
        .digest('hex');

    return dbTransaction(async (client) => {
        // 1. Write decision_audit_log row (master audit trail — INSERT only)
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
                'sentiment',
                MODEL_NAME,
                inputHash,
                JSON.stringify({
                    score:         scored.score,
                    comparative:   scored.comparative,
                    indicator:     scored.indicator,
                    positiveWords: scored.positiveWords,
                    negativeWords: scored.negativeWords,
                }),
                null,   // confidence: AFINN lexicon does not produce a probability estimate
            ],
        );
        const auditId = auditResult.rows[0].id;

        // 2. Write derived sentiment_results row (queried by dashboard)
        const sentResult = await client.query(
            `INSERT INTO sentiment_results
                (raw_post_id, audit_id, score, comparative, indicator,
                 positive_words, negative_words, token_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [
                postId,
                auditId,
                scored.score,
                scored.comparative,
                scored.indicator,
                scored.positiveWords,
                scored.negativeWords,
                scored.tokenCount,
            ],
        );

        return sentResult.rows[0];
    });
}

module.exports = { computeSentiment, saveSentiment };
