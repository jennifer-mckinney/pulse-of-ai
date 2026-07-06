// tests/integration/helpers.js
// Shared test data helpers for all integration test suites.
// Uses direct DB inserts (bypasses API) for speed and isolation.
// All helpers are self-sufficient: tests can compose them freely.

'use strict';

const crypto = require('crypto');
const { dbRun } = require('../../src/db/connection');

// ─── Source ───────────────────────────────────────────────────────────────────

async function insertSource(name = 'test-src', category = 'social') {
    const row = await dbRun(
        `INSERT INTO data_sources (name, display_name, source_type, category)
         VALUES ($1, $1, 'reddit', $2)
         ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [name, category],
    );
    return row.id;
}

// ─── Job ──────────────────────────────────────────────────────────────────────

async function insertJob(status = 'completed', { postsProcessed = 3 } = {}) {
    const row = await dbRun(
        `INSERT INTO processing_jobs
            (triggered_by, status, posts_processed, completed_at)
         VALUES ('test', $1, $2, CASE WHEN $1 = 'completed' THEN NOW() ELSE NULL END)
         RETURNING id`,
        [status, postsProcessed],
    );
    return row.id;
}

// ─── Methodology versions ─────────────────────────────────────────────────────

async function insertMethodologyVersions() {
    const rows = await Promise.all([
        dbRun(`INSERT INTO methodology_versions
                   (component, version, model_name, config, justification)
               VALUES ('sentiment', '1.0.0', 'afinn-sentiment-v5',
                       '{"positive_threshold":0.05,"negative_threshold":-0.05}'::jsonb,
                       'AFINN word list sentiment scoring.')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component
               RETURNING id`),
        dbRun(`INSERT INTO methodology_versions
                   (component, version, model_name, config, justification)
               VALUES ('relevance', '1.0.0', 'keyword-relevance-v1',
                       '{"keywords":["ai","machine learning"]}'::jsonb,
                       'Keyword-based relevance scoring.')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component
               RETURNING id`),
        dbRun(`INSERT INTO methodology_versions
                   (component, version, model_name, config, justification)
               VALUES ('discourse', '1.0.0-DQI', 'dqi-heuristic-v1',
                       '{}'::jsonb,
                       'Deliberative Quality Index heuristic scoring.')
               ON CONFLICT (component, version) DO UPDATE SET component = EXCLUDED.component
               RETURNING id`),
    ]);
    return { sentimentMvId: rows[0].id, relevanceMvId: rows[1].id, discourseMvId: rows[2].id };
}

// ─── Full post + all three pipeline results ───────────────────────────────────

/**
 * Insert a raw_post with sentiment + relevance + discourse results.
 * Used by audit and query tests that need the full decision trail.
 *
 * @param {string} sourceId
 * @param {string} jobId
 * @param {{ sentimentMvId, relevanceMvId, discourseMvId }} mvIds
 * @param {{ location?, indicator?, comparative?, externalId?, collectedAt?, keywords? }} opts
 *        collectedAt: Date or ISO string; null lets the DB default to NOW().
 *        keywords: matched_keywords stored on the relevance result.
 * @returns {Promise<string>}  UUID of the inserted raw_post
 */
async function insertPostWithFullPipeline(sourceId, jobId, mvIds, {
    location    = 'London',
    indicator   = 'positive',
    comparative = 0.5,
    externalId  = null,
    collectedAt = null,
    keywords    = ['ai', 'machine learning'],
} = {}) {
    const content = `Test post ${externalId || Math.random()}`;
    const hash    = crypto.createHash('sha256').update(content).digest('hex');
    const extId   = externalId || hash.slice(0, 16);

    // raw_posts — COALESCE keeps the NOW() default when no explicit timestamp
    // is requested (a plain $6 = NULL would store NULL, not the column default)
    const post = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, collected_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
         ON CONFLICT (source_id, external_id) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [sourceId, extId, content, hash, location,
         collectedAt instanceof Date ? collectedAt.toISOString() : collectedAt],
    );

    // Sentiment: audit log + derived result
    const sentAudit = await dbRun(
        `INSERT INTO decision_audit_log
            (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output)
         VALUES ($1, $2, $3, 'sentiment', 'afinn-sentiment-v5', $4, $5::jsonb)
         RETURNING id`,
        [post.id, jobId, mvIds.sentimentMvId, hash, JSON.stringify({ indicator, comparative })],
    );
    await dbRun(
        `INSERT INTO sentiment_results
            (raw_post_id, audit_id, score, comparative, indicator, positive_words, negative_words, token_count)
         VALUES ($1, $2, $3, $4, $5, '{}', '{}', 5)`,
        [post.id, sentAudit.id, comparative * 10, comparative, indicator],
    );

    // Relevance: audit log + derived result
    const relAudit = await dbRun(
        `INSERT INTO decision_audit_log
            (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output)
         VALUES ($1, $2, $3, 'relevance', 'keyword-relevance-v1', $4, $5::jsonb)
         RETURNING id`,
        [post.id, jobId, mvIds.relevanceMvId, hash, JSON.stringify({ score: 0.6 })],
    );
    await dbRun(
        `INSERT INTO relevance_results
            (raw_post_id, audit_id, score, matched_keywords, is_relevant)
         VALUES ($1, $2, 0.6, $3::text[], true)`,
        [post.id, relAudit.id, keywords],
    );

    // Discourse: audit log + derived result
    const discAudit = await dbRun(
        `INSERT INTO decision_audit_log
            (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output, confidence)
         VALUES ($1, $2, $3, 'discourse', 'dqi-heuristic-v1', $4, $5::jsonb, 0.5)
         RETURNING id`,
        [post.id, jobId, mvIds.discourseMvId, hash, JSON.stringify({ total: 0.5, dimensions: {} })],
    );
    await dbRun(
        `INSERT INTO discourse_results
            (raw_post_id, audit_id, dqi_total, dimensions)
         VALUES ($1, $2, 0.5, $3::jsonb)`,
        [post.id, discAudit.id, JSON.stringify({
            participation: 0.5, justification: 0.5,
            respectfulness: 1.0, constructiveness: 0.5, evidence: 0.0,
        })],
    );

    return post.id;
}

// ─── Post with relevance only (no sentiment score) ────────────────────────────

/**
 * Insert a raw_post with ONLY a relevance result — no sentiment, no discourse.
 * Models the mid-pipeline state where a post has been keyword-tagged but not
 * yet (or never) sentiment-scored. Used by themes tests to prove unscored
 * posts cannot influence per-keyword aggregates.
 *
 * @returns {Promise<string>}  UUID of the inserted raw_post
 */
async function insertPostWithRelevanceOnly(sourceId, jobId, mvIds, {
    location    = 'London',
    externalId  = null,
    collectedAt = null,
    keywords    = ['ai', 'machine learning'],
} = {}) {
    const content = `Unscored post ${externalId || Math.random()}`;
    const hash    = crypto.createHash('sha256').update(content).digest('hex');
    const extId   = externalId || hash.slice(0, 16);

    const post = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, collected_at)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
         ON CONFLICT (source_id, external_id) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [sourceId, extId, content, hash, location,
         collectedAt instanceof Date ? collectedAt.toISOString() : collectedAt],
    );

    const relAudit = await dbRun(
        `INSERT INTO decision_audit_log
            (raw_post_id, job_id, methodology_version_id, decision_type, model_name, input_hash, output)
         VALUES ($1, $2, $3, 'relevance', 'keyword-relevance-v1', $4, $5::jsonb)
         RETURNING id`,
        [post.id, jobId, mvIds.relevanceMvId, hash, JSON.stringify({ score: 0.6 })],
    );
    await dbRun(
        `INSERT INTO relevance_results
            (raw_post_id, audit_id, score, matched_keywords, is_relevant)
         VALUES ($1, $2, 0.6, $3::text[], true)`,
        [post.id, relAudit.id, keywords],
    );

    return post.id;
}

// ─── Alert event ──────────────────────────────────────────────────────────────

async function insertAlert({ alertType = 'bias_violation', severity = 'warning' } = {}) {
    const row = await dbRun(
        `INSERT INTO alert_events (alert_type, severity, details)
         VALUES ($1, $2, '{}'::jsonb)
         RETURNING id`,
        [alertType, severity],
    );
    return row.id;
}

module.exports = {
    insertSource,
    insertJob,
    insertMethodologyVersions,
    insertPostWithFullPipeline,
    insertPostWithRelevanceOnly,
    insertAlert,
};
