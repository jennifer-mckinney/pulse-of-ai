// tests/integration/helpers.js
// Shared test data helpers for all integration test suites.
// Uses direct DB inserts (bypasses API) for speed and isolation.
// All helpers are self-sufficient: tests can compose them freely.

'use strict';

const crypto = require('crypto');
const { dbRun } = require('../../src/db/connection');
const { METHODOLOGY_VERSIONS } = require('../../src/config/methodology-registry');

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

/**
 * Register a methodology row exactly as the shared registry defines it
 * (src/config/methodology-registry.js — the source seed.js and migration 009
 * both use), so integration tests exercise the REAL registered config
 * instead of a hand-mirrored copy that can drift.
 * @returns {Promise<string>}  methodology_versions.id
 */
async function insertRegisteredMethodology(component) {
    const m = METHODOLOGY_VERSIONS.find(r => r.component === component);
    const row = await dbRun(
        `INSERT INTO methodology_versions (component, version, model_name, config, justification)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (component, version) DO UPDATE SET config = EXCLUDED.config
         RETURNING id`,
        [m.component, m.version, m.model_name, JSON.stringify(m.config), m.justification],
    );
    return row.id;
}

/**
 * Register the versioned 'bias' methodology row (thresholds, layer names,
 * layer notes, citations, planned layers, layer order) that the audit
 * fairness layers and the bias history endpoint read.
 * @returns {Promise<string>}  methodology_versions.id
 */
async function insertBiasMethodology() {
    return insertRegisteredMethodology('bias');
}

/**
 * Register the versioned 'ingest' methodology row (PII fields, granularity,
 * legal basis) that the audit route renders as the synthetic Ingestion step.
 * @returns {Promise<string>}  methodology_versions.id
 */
async function insertIngestMethodology() {
    return insertRegisteredMethodology('ingest');
}

// ─── Bias assessment ──────────────────────────────────────────────────────────

/**
 * Insert a bias_assessments row directly (bypasses the pipeline).
 * @param {string} jobId
 * @param {{ assessmentType?, groupValue?, metricName?, metricValue?, threshold?,
 *           isViolation?, severity?, createdAt?, methodologyVersionId? }} opts
 *        severity: stored severity ('warning'|'critical') — only meaningful
 *        when isViolation is true. createdAt: Date/ISO for history-window tests.
 *        methodologyVersionId: the recorded bias methodology lineage
 *        (migration 010). Defaults to NULL, a pre-lineage row that the
 *        routes resolve as lineage 'inferred'. Tests that need recorded
 *        lineage pass a specific methodology_versions.id, so the recorded
 *        path is never assumed by accident.
 */
async function insertBiasAssessment(jobId, {
    assessmentType = 'location_concentration',
    groupField     = 'location',
    groupValue     = 'San Francisco',
    metricName     = 'share_of_total',
    metricValue    = 0.40,
    threshold      = 0.35,
    isViolation    = false,
    severity       = null,
    createdAt      = null,
    methodologyVersionId = null,
} = {}) {
    const row = await dbRun(
        `INSERT INTO bias_assessments
            (job_id, assessment_type, group_field, group_value,
             metric_name, metric_value, threshold, is_violation, severity, created_at,
             methodology_version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, NOW()), $11)
         RETURNING id`,
        [jobId, assessmentType, groupField, groupValue, metricName, metricValue,
         threshold, isViolation, severity,
         createdAt instanceof Date ? createdAt.toISOString() : createdAt,
         methodologyVersionId],
    );
    return row.id;
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
    rawPayload  = null,   // K1: raw_payload metadata (url, published_at) as ingest stores it
} = {}) {
    const content = `Test post ${externalId || Math.random()}`;
    const hash    = crypto.createHash('sha256').update(content).digest('hex');
    const extId   = externalId || hash.slice(0, 16);

    // raw_posts — COALESCE keeps the NOW() default when no explicit timestamp
    // is requested (a plain $6 = NULL would store NULL, not the column default)
    const post = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, collected_at, raw_payload)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7::jsonb)
         ON CONFLICT (source_id, external_id) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [sourceId, extId, content, hash, location,
         collectedAt instanceof Date ? collectedAt.toISOString() : collectedAt,
         rawPayload === null ? null : JSON.stringify(rawPayload)],
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
    rawPayload  = null,   // K1: raw_payload metadata (url, published_at)
} = {}) {
    const content = `Unscored post ${externalId || Math.random()}`;
    const hash    = crypto.createHash('sha256').update(content).digest('hex');
    const extId   = externalId || hash.slice(0, 16);

    const post = await dbRun(
        `INSERT INTO raw_posts (source_id, external_id, content, content_hash, location, collected_at, raw_payload)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()), $7::jsonb)
         ON CONFLICT (source_id, external_id) DO UPDATE SET content = EXCLUDED.content
         RETURNING id`,
        [sourceId, extId, content, hash, location,
         collectedAt instanceof Date ? collectedAt.toISOString() : collectedAt,
         rawPayload === null ? null : JSON.stringify(rawPayload)],
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
    insertRegisteredMethodology,
    insertBiasMethodology,
    insertIngestMethodology,
    insertBiasAssessment,
    insertPostWithFullPipeline,
    insertPostWithRelevanceOnly,
    insertAlert,
};
