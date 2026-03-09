// src/pipeline/bias.js
// Bias detection pipeline: runs three checks after every processing job.
//
// Checks:
//   checkLocationConcentration  — flags if one city dominates (> threshold share)
//   checkPlatformSentimentParity — flags if two source categories diverge in avg sentiment
//   checkNegativeDominance       — flags if negative posts exceed threshold share
//
// All thresholds are read from methodology_versions.config (DB-driven).
// This makes them auditable, versioned, and changeable without a code deploy (AI Act §13).
//
// Every check writes a row to bias_assessments (always — for audit completeness).
// Violations additionally write to alert_events to surface on the health dashboard.

'use strict';

const { dbGet, dbAll, dbRun } = require('../db/connection');

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Fetch the config JSONB from a methodology_versions row by ID.
 * Throws if the row does not exist (programming error — caller must ensure ID is valid).
 *
 * @param {string} biasMvId  UUID of the bias methodology_version row
 * @returns {Promise<object>} Parsed config object
 */
async function getBiasConfig(biasMvId) {
    const row = await dbGet(
        'SELECT config FROM methodology_versions WHERE id = $1',
        [biasMvId],
    );
    if (!row) throw new Error(`Bias methodology version not found: ${biasMvId}`);
    return row.config;
}

/**
 * Write a bias_assessments row for every check run (violation or not).
 * The bias_assessments table is the permanent audit record for compliance.
 *
 * @param {object} params
 */
async function writeBiasAssessment({
    jobId,
    assessmentType,
    groupField,
    groupValue,
    metricName,
    metricValue,
    threshold,
    isViolation,
    severity,
    evidence,
}) {
    await dbRun(
        `INSERT INTO bias_assessments
            (job_id, assessment_type, group_field, group_value,
             metric_name, metric_value, threshold, is_violation, severity, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`,
        [
            jobId,
            assessmentType,
            groupField,
            groupValue,
            metricName,
            metricValue,
            threshold,
            isViolation,
            severity,                              // null when not a violation
            JSON.stringify(evidence || {}),
        ],
    );
}

/**
 * Write an alert_events row. Only called when is_violation = true.
 * Links back to the bias_assessments table via source_table + source_id (soft FK).
 *
 * @param {object} params
 */
async function writeAlertEvent({ alertType, severity, details }) {
    await dbRun(
        `INSERT INTO alert_events (alert_type, severity, source_table, details)
         VALUES ($1, $2, 'bias_assessments', $3::jsonb)`,
        [alertType, severity, JSON.stringify(details || {})],
    );
}

// ─── checkLocationConcentration ───────────────────────────────────────────────

/**
 * Detect geographic concentration bias: flags when a single city accounts for
 * more than `location_concentration_max` of all located posts in the job.
 *
 * Query strategy: use IN-subquery to find posts for this job, then GROUP BY location.
 * Avoids JOIN fan-out from posts having multiple audit entries (sentiment + relevance + DQI).
 *
 * @param {string} jobId     UUID of the processing_jobs row
 * @param {string} biasMvId  UUID of the bias methodology_versions row
 * @returns {Promise<{ isViolation: boolean, metricValue: number, groupValue: string|null }>}
 */
async function checkLocationConcentration(jobId, biasMvId) {
    const config    = await getBiasConfig(biasMvId);
    const threshold = config.location_concentration_max;

    // Count distinct posts per non-null location for this job
    const rows = await dbAll(
        `SELECT rp.location, COUNT(*)::int AS post_count
         FROM raw_posts rp
         WHERE rp.id IN (
             SELECT DISTINCT raw_post_id
             FROM decision_audit_log
             WHERE job_id = $1 AND decision_type = 'sentiment'
         )
           AND rp.location IS NOT NULL
           AND rp.location != ''
         GROUP BY rp.location
         ORDER BY post_count DESC`,
        [jobId],
    );

    // No located posts — cannot compute concentration
    if (rows.length === 0) {
        await writeBiasAssessment({
            jobId,
            assessmentType: 'location_concentration',
            groupField:     'location',
            groupValue:     'none',
            metricName:     'share_of_total',
            metricValue:    0,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       { rows: [], total: 0 },
        });
        return { isViolation: false, metricValue: 0, groupValue: null };
    }

    const total      = rows.reduce((sum, r) => sum + r.post_count, 0);
    const dominant   = rows[0];                        // already sorted DESC
    const metricValue = dominant.post_count / total;
    const isViolation = metricValue > threshold;

    // Severity: critical above 80%, warning otherwise
    const severity = isViolation
        ? (metricValue > 0.80 ? 'critical' : 'warning')
        : null;

    await writeBiasAssessment({
        jobId,
        assessmentType: 'location_concentration',
        groupField:     'location',
        groupValue:     dominant.location,
        metricName:     'share_of_total',
        metricValue,
        threshold,
        isViolation,
        severity,
        evidence:       { rows, total, dominantLocation: dominant.location },
    });

    if (isViolation) {
        await writeAlertEvent({
            alertType: 'location_concentration',
            severity,
            details: {
                jobId,
                location:  dominant.location,
                share:     metricValue,
                threshold,
            },
        });
    }

    return { isViolation, metricValue, groupValue: dominant.location };
}

// ─── checkPlatformSentimentParity ─────────────────────────────────────────────

/**
 * Detect cross-platform sentiment bias: flags when the maximum difference in
 * average sentiment comparative between any two source categories exceeds
 * `platform_parity_max_diff`.
 *
 * Rationale: if Reddit shows consistently positive sentiment while academic sources
 * show consistently negative, that indicates platform selection bias rather than
 * genuine discourse differences.
 *
 * @param {string} jobId     UUID of the processing_jobs row
 * @param {string} biasMvId  UUID of the bias methodology_versions row
 * @returns {Promise<{ isViolation: boolean, metricValue: number, groupValue: string|null }>}
 */
async function checkPlatformSentimentParity(jobId, biasMvId) {
    const config    = await getBiasConfig(biasMvId);
    const threshold = config.platform_parity_max_diff;

    // Average comparative sentiment per source category for posts in this job
    const rows = await dbAll(
        `SELECT ds.category, AVG(sr.comparative) AS avg_comparative
         FROM sentiment_results sr
         JOIN raw_posts rp     ON rp.id      = sr.raw_post_id
         JOIN data_sources ds  ON ds.id      = rp.source_id
         WHERE sr.raw_post_id IN (
             SELECT DISTINCT raw_post_id
             FROM decision_audit_log
             WHERE job_id = $1 AND decision_type = 'sentiment'
         )
         GROUP BY ds.category`,
        [jobId],
    );

    // Parity requires at least two distinct platforms to compare
    if (rows.length < 2) {
        await writeBiasAssessment({
            jobId,
            assessmentType: 'platform_sentiment_parity',
            groupField:     'platform',
            groupValue:     rows.length === 1 ? rows[0].category : 'none',
            metricName:     'max_comparative_diff',
            metricValue:    0,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       { rows, note: 'fewer than 2 platforms' },
        });
        return { isViolation: false, metricValue: 0, groupValue: null };
    }

    // Find the maximum pairwise difference across all platform combinations
    let maxDiff  = 0;
    let worstPair = null;
    for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
            const diff = Math.abs(rows[i].avg_comparative - rows[j].avg_comparative);
            if (diff > maxDiff) {
                maxDiff   = diff;
                worstPair = `${rows[i].category} vs ${rows[j].category}`;
            }
        }
    }

    const isViolation = maxDiff > threshold;
    const severity    = isViolation ? 'warning' : null;

    await writeBiasAssessment({
        jobId,
        assessmentType: 'platform_sentiment_parity',
        groupField:     'platform',
        groupValue:     worstPair || 'unknown',
        metricName:     'max_comparative_diff',
        metricValue:    maxDiff,
        threshold,
        isViolation,
        severity,
        evidence:       { rows, maxDiff, worstPair },
    });

    if (isViolation) {
        await writeAlertEvent({
            alertType: 'platform_sentiment_parity',
            severity,
            details: {
                jobId,
                pair:      worstPair,
                diff:      maxDiff,
                threshold,
            },
        });
    }

    return { isViolation, metricValue: maxDiff, groupValue: worstPair };
}

// ─── checkNegativeDominance ───────────────────────────────────────────────────

/**
 * Detect negative sentiment dominance: flags when negative posts exceed
 * `negative_dominance_max` share of all posts in the job.
 *
 * Rationale: a feed that is overwhelmingly negative may reflect collection bias
 * (e.g., only controversy-driven posts being ingested) rather than true discourse.
 *
 * @param {string} jobId     UUID of the processing_jobs row
 * @param {string} biasMvId  UUID of the bias methodology_versions row
 * @returns {Promise<{ isViolation: boolean, metricValue: number }>}
 */
async function checkNegativeDominance(jobId, biasMvId) {
    const config    = await getBiasConfig(biasMvId);
    const threshold = config.negative_dominance_max;

    // Count posts per sentiment indicator for this job
    const rows = await dbAll(
        `SELECT sr.indicator, COUNT(DISTINCT sr.raw_post_id)::int AS count
         FROM sentiment_results sr
         WHERE sr.raw_post_id IN (
             SELECT DISTINCT raw_post_id
             FROM decision_audit_log
             WHERE job_id = $1 AND decision_type = 'sentiment'
         )
         GROUP BY sr.indicator`,
        [jobId],
    );

    if (rows.length === 0) {
        await writeBiasAssessment({
            jobId,
            assessmentType: 'negative_dominance',
            groupField:     'global',
            groupValue:     'all',
            metricName:     'negative_share',
            metricValue:    0,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       { rows: [], total: 0 },
        });
        return { isViolation: false, metricValue: 0 };
    }

    const total      = rows.reduce((sum, r) => sum + r.count, 0);
    const negRow     = rows.find(r => r.indicator === 'negative');
    const negCount   = negRow ? negRow.count : 0;
    const metricValue = negCount / total;
    const isViolation = metricValue > threshold;
    const severity    = isViolation ? 'warning' : null;

    await writeBiasAssessment({
        jobId,
        assessmentType: 'negative_dominance',
        groupField:     'global',
        groupValue:     'all',
        metricName:     'negative_share',
        metricValue,
        threshold,
        isViolation,
        severity,
        evidence:       { rows, total, negCount },
    });

    if (isViolation) {
        await writeAlertEvent({
            alertType: 'negative_dominance',
            severity,
            details: {
                jobId,
                negativeShare: metricValue,
                total,
                threshold,
            },
        });
    }

    return { isViolation, metricValue };
}

// ─── runBiasChecks ────────────────────────────────────────────────────────────

/**
 * Orchestrate all three bias checks for a completed processing job.
 * Runs checks sequentially (not parallel) so each check's audit row is committed
 * before the next begins — preserves audit log ordering.
 *
 * @param {string} jobId     UUID of the completed processing_jobs row
 * @param {string} biasMvId  UUID of the bias methodology_versions row
 * @returns {Promise<{
 *   jobId:           string,
 *   checksRun:       number,
 *   violationsFound: number,
 *   results:         Array<object>
 * }>}
 */
async function runBiasChecks(jobId, biasMvId) {
    const locationResult = await checkLocationConcentration(jobId, biasMvId);
    const parityResult   = await checkPlatformSentimentParity(jobId, biasMvId);
    const negDomResult   = await checkNegativeDominance(jobId, biasMvId);

    const results        = [locationResult, parityResult, negDomResult];
    const violationsFound = results.filter(r => r.isViolation).length;

    return {
        jobId,
        checksRun:       3,
        violationsFound,
        results,
    };
}

module.exports = {
    runBiasChecks,
    checkLocationConcentration,
    checkPlatformSentimentParity,
    checkNegativeDominance,
};
