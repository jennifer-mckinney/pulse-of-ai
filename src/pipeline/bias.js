// src/pipeline/bias.js
// Bias detection pipeline: runs three checks after every processing job.
//
// Checks:
//   checkLocationConcentration  — flags if one city dominates (> threshold share)
//   checkPlatformSentimentParity — flags if two source categories diverge in avg sentiment
//   checkNegativeDominance       — flags if negative posts exceed threshold share
//
// All thresholds are read from methodology_versions.config (DB-driven), which
// makes them auditable and versioned (AI Act §13). A released row is never
// edited: a threshold change is a NEW bias version in
// src/config/methodology-registry.js plus a matching migration, i.e. a code
// deploy.
//
// Every check writes a row to bias_assessments (always — for audit completeness),
// recording the biasMvId it ran with in methodology_version_id (migration 010)
// so receipts and history resolve the exact version that produced each row.
// Violations additionally write to alert_events to surface on the health dashboard.
//
// bias@1.5.0 (PR #22 decision G2): the same checks also run over a rolling
// 24 h window (src/pipeline/bias-window.js); a check's TARGET is then a
// window scope and its rows go to bias_window_assessments (see scopeOf).
//
// bias@1.6.0 (audit drift D-2): an "insufficient sample" parity row states
// its computed gap (config parity_insufficient_value), like the other two
// checks already did; earlier versions are reproduced as they ran (0).

'use strict';

const { dbGet, dbAll, dbRun } = require('../db/connection');

// group_value of a location-concentration assessment whose located sample is
// below the version's location_min_sample (bias@1.3.0): no violation.
const INSUFFICIENT_SAMPLE = 'insufficient sample';

// ─── Scope: one processing job, or a rolling window (since bias@1.5.0, G2) ───
//
// Every check takes a TARGET: a processing_jobs id (the per-cycle checks —
// the posts whose sentiment decision was recorded under that job) or a
// window scope { windowRunId, start, end } (src/pipeline/bias-window.js — the
// posts whose sentiment decision was recorded in [start, end)). The rules
// are identical; only the post set and the table the assessment is written
// to differ (bias_assessments vs bias_window_assessments).

/**
 * @param {string|{ windowRunId: string, start: Date|string, end: Date|string }} target
 * @returns {{ kind: 'job'|'window', posts: string, params: Array, next: number, id: string }}
 *   posts: SQL selecting the scope's raw_post ids, using $1..$(next-1)
 */
function scopeOf(target) {
    if (typeof target === 'string') {
        return {
            kind: 'job',
            id: target,
            posts: `SELECT DISTINCT raw_post_id FROM decision_audit_log
                    WHERE job_id = $1 AND decision_type = 'sentiment'`,
            params: [target],
            next: 2,
        };
    }
    if (!target || !target.windowRunId || !target.start || !target.end) {
        throw new Error('bias check target must be a job id or { windowRunId, start, end }');
    }
    return {
        kind: 'window',
        id: target.windowRunId,
        posts: `SELECT DISTINCT raw_post_id FROM decision_audit_log
                WHERE decision_type = 'sentiment'
                  AND created_at >= $1::timestamptz AND created_at < $2::timestamptz`,
        params: [target.start, target.end],
        next: 3,
    };
}

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
    scope,
    assessmentType,
    groupField,
    groupValue,
    metricName,
    metricValue,
    threshold,
    isViolation,
    severity,
    evidence,
    biasMvId,                  // lineage: the methodology row this run used (migration 010)
}) {
    // bias_assessments (job_id) for a cycle; bias_window_assessments
    // (window_run_id, migration 060) for a rolling window run.
    const [table, idColumn] = scope.kind === 'window'
        ? ['bias_window_assessments', 'window_run_id'] : ['bias_assessments', 'job_id'];
    await dbRun(
        `INSERT INTO ${table}
            (${idColumn}, assessment_type, group_field, group_value,
             metric_name, metric_value, threshold, is_violation, severity, evidence,
             methodology_version_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)`,
        [
            scope.id,
            assessmentType,
            groupField,
            groupValue,
            metricName,
            metricValue,
            threshold,
            isViolation,
            severity,                              // null when not a violation
            JSON.stringify(evidence || {}),
            biasMvId,
        ],
    );
}

/**
 * Write an alert_events row. Only called when is_violation = true.
 * Links back to the bias_assessments table via source_table + source_id (soft FK).
 *
 * @param {object} params
 */
async function writeAlertEvent({ scope, alertType, severity, details }) {
    // A cycle alert names its job (details.jobId, as before); a window alert
    // names its window run instead (details.windowRunId + the window), and
    // points at bias_window_assessments.
    const table = scope.kind === 'window' ? 'bias_window_assessments' : 'bias_assessments';
    const ref = scope.kind === 'window'
        ? { windowRunId: scope.id, scope: 'rolling_window', windowStart: scope.params[0], windowEnd: scope.params[1] }
        : { jobId: scope.id };
    await dbRun(
        `INSERT INTO alert_events (alert_type, severity, source_table, details)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [alertType, severity, table, JSON.stringify({ ...ref, ...(details || {}) })],
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
 * @param {string|object} target  a processing_jobs id, or a window scope (see scopeOf)
 * @param {string} biasMvId  UUID of the bias methodology_versions row
 * @returns {Promise<{ isViolation: boolean, metricValue: number, groupValue: string|null }>}
 */
async function checkLocationConcentration(target, biasMvId) {
    const scope     = scopeOf(target);
    const config    = await getBiasConfig(biasMvId);
    const threshold = config.location_concentration_max;
    // D3 (ADR 0001, Jennifer 2026-09-29: "Separate layer, excluded from
    // bias."): from bias@1.2.0 the config lists location bases excluded from
    // this check. A post placed at its PUBLISHER's home city
    // (raw_payload.location_basis = 'publisher') says where the outlet is,
    // not where the discussion happened, so it is not evidence of
    // geographic concentration. Older versions carry no list, so replaying
    // their jobs keeps their original behaviour. A post with no recorded
    // basis (demo feeds, pre-collector rows) counts as content-located.
    const excludedBases = Array.isArray(config.location_basis_excluded)
        ? config.location_basis_excluded.filter(b => typeof b === 'string') : [];

    // Count distinct posts per non-null location for this job. rows[0] is
    // the dominant location; grumpy final #5 (same family): ties on the top
    // count go to the location name, so the named location never depends
    // on the query plan.
    const rows = await dbAll(
        `SELECT rp.location, COUNT(*)::int AS post_count
         FROM raw_posts rp
         WHERE rp.id IN (${scope.posts})
           AND rp.location IS NOT NULL
           AND rp.location != ''
           AND NOT (COALESCE(rp.raw_payload->>'location_basis', 'content') = ANY($${scope.next}::text[]))
         GROUP BY rp.location
         ORDER BY post_count DESC, rp.location`,
        [...scope.params, excludedBases],
    );
    // How many located posts the exclusion removed (evidence, never hidden).
    const excluded = excludedBases.length === 0 ? 0 : (await dbGet(
        `SELECT COUNT(*)::int AS n
         FROM raw_posts rp
         WHERE rp.id IN (${scope.posts})
           AND rp.location IS NOT NULL
           AND rp.location != ''
           AND COALESCE(rp.raw_payload->>'location_basis', 'content') = ANY($${scope.next}::text[])`,
        [...scope.params, excludedBases],
    )).n;
    const exclusion = excludedBases.length === 0 ? {} : { excluded_location_bases: excludedBases, excluded_posts: excluded };

    const minSample = Number.isInteger(config.location_min_sample) && config.location_min_sample > 0
        ? config.location_min_sample : 0;

    // No located posts — cannot compute concentration. PR #22 grumpy M5:
    // under a version with a minimum (bias@1.3.0+) zero content-located
    // posts is below that minimum, so it is recorded as "insufficient
    // sample" like any other small sample (never a "pass"). Older versions
    // keep their 'none' row, so their replays are unchanged.
    if (rows.length === 0) {
        const insufficient = minSample > 0;
        await writeBiasAssessment({
            scope,
            assessmentType: 'location_concentration',
            groupField:     'location',
            groupValue:     insufficient ? INSUFFICIENT_SAMPLE : 'none',
            metricName:     'share_of_total',
            metricValue:    0,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       {
                rows: [], total: 0, ...exclusion,
                ...(insufficient ? { insufficient_sample: true, min_sample: minSample } : {}),
            },
            biasMvId,
        });
        return insufficient
            ? { isViolation: false, metricValue: 0, groupValue: INSUFFICIENT_SAMPLE, insufficientSample: true }
            : { isViolation: false, metricValue: 0, groupValue: null };
    }

    const total      = rows.reduce((sum, r) => sum + r.post_count, 0);
    const dominant   = rows[0];                        // already sorted DESC
    const metricValue = dominant.post_count / total;

    // P10-5 (bias@1.3.0): a share computed over a handful of located posts
    // measures the job's shape, not the discourse (one BBC run is 100 %
    // London). Below config.location_min_sample content-located posts the
    // check records an "insufficient sample" assessment — the share is still
    // stated — and raises NO violation and NO alert. Older versions carry no
    // minimum, so their replays are unchanged.
    if (total < minSample) {
        await writeBiasAssessment({
            scope,
            assessmentType: 'location_concentration',
            groupField:     'location',
            groupValue:     INSUFFICIENT_SAMPLE,
            metricName:     'share_of_total',
            metricValue,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       {
                rows, total, dominantLocation: dominant.location, ...exclusion,
                insufficient_sample: true, min_sample: minSample,
            },
            biasMvId,
        });
        return { isViolation: false, metricValue, groupValue: INSUFFICIENT_SAMPLE, insufficientSample: true };
    }

    const isViolation = metricValue > threshold;

    // Severity: critical above 80%, warning otherwise
    const severity = isViolation
        ? (metricValue > 0.80 ? 'critical' : 'warning')
        : null;

    await writeBiasAssessment({
        scope,
        assessmentType: 'location_concentration',
        groupField:     'location',
        groupValue:     dominant.location,
        metricName:     'share_of_total',
        metricValue,
        threshold,
        isViolation,
        severity,
        evidence:       { rows, total, dominantLocation: dominant.location, ...exclusion },
        biasMvId,
    });

    if (isViolation) {
        await writeAlertEvent({
            scope,
            alertType: 'location_concentration',
            severity,
            details: {
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
 * The largest absolute difference in average comparative sentiment between
 * any two categories, and that pair ("a vs b"); 0 / null with fewer than two.
 * @param {Array<{ category: string, avg_comparative: number|string }>} rows
 * @returns {{ maxDiff: number, worstPair: string|null }}
 */
function maxPairwiseGap(rows) {
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
    return { maxDiff, worstPair };
}

/**
 * Detect cross-platform sentiment bias: flags when the maximum difference in
 * average sentiment comparative between any two source categories exceeds
 * `platform_parity_max_diff`.
 *
 * Rationale: if Reddit shows consistently positive sentiment while academic sources
 * show consistently negative, that indicates platform selection bias rather than
 * genuine discourse differences.
 *
 * @param {string|object} target  a processing_jobs id, or a window scope (see scopeOf)
 * @param {string} biasMvId  UUID of the bias methodology_versions row
 * @returns {Promise<{ isViolation: boolean, metricValue: number, groupValue: string|null }>}
 */
async function checkPlatformSentimentParity(target, biasMvId) {
    const scope     = scopeOf(target);
    const config    = await getBiasConfig(biasMvId);
    const threshold = config.platform_parity_max_diff;

    // Average comparative sentiment per source category for posts in this job.
    // Grumpy final #5: ORDER BY ds.category — PostgreSQL does not guarantee
    // GROUP BY output order, and the row order decides the stored
    // evidence.rows, the pair maxPairwiseGap names (worst_pair / the
    // violation's group_value) and which pair is kept on an exact tie.
    const allRows = await dbAll(
        `SELECT ds.category, AVG(sr.comparative) AS avg_comparative, COUNT(DISTINCT sr.raw_post_id)::int AS n
         FROM sentiment_results sr
         JOIN raw_posts rp     ON rp.id      = sr.raw_post_id
         JOIN data_sources ds  ON ds.id      = rp.source_id
         WHERE sr.raw_post_id IN (${scope.posts})
         GROUP BY ds.category
         ORDER BY ds.category`,
        scope.params,
    );
    // bias@1.4.0: only categories with at least parity_min_per_category
    // posts are compared (an average over three posts is noise); with fewer
    // than two such categories the check records "insufficient sample" and
    // raises no alert. Older versions compare every category. PR #22
    // grumpy M5: that includes a job with ONE category (the most common
    // cycle shape) or none — below the registered rule, so "insufficient
    // sample", never a "pass".
    const minPer = Number.isInteger(config.parity_min_per_category) && config.parity_min_per_category > 0
        ? config.parity_min_per_category : 0;
    const rows = allRows.filter(r => r.n >= minPer);
    if (minPer > 0 && rows.length < 2) {
        // bias@1.6.0 (audit drift D-2): "insufficient sample" states its
        // computed value, as sample_rules.below_minimum registers — the
        // largest pairwise gap across ALL the job's categories, small ones
        // included (0 with fewer than two). bias@1.4.0 / 1.5.0 recorded 0
        // (no parity_insufficient_value key); they are reproduced as they
        // ran, and an erratum on each says so.
        const stated = config.parity_insufficient_value === 'max_diff_all_categories' ? maxPairwiseGap(allRows) : null;
        const metricValue = stated ? stated.maxDiff : 0;
        await writeBiasAssessment({
            scope,
            assessmentType: 'platform_sentiment_parity',
            groupField:     'platform',
            groupValue:     INSUFFICIENT_SAMPLE,
            metricName:     'max_comparative_diff',
            metricValue,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       {
                rows: allRows, insufficient_sample: true, min_per_category: minPer, compared: rows.map(r => r.category),
                ...(stated ? { value_basis: 'all_categories', maxDiff: stated.maxDiff, worst_pair: stated.worstPair } : {}),
            },
            biasMvId,
        });
        return { isViolation: false, metricValue, groupValue: INSUFFICIENT_SAMPLE, insufficientSample: true };
    }

    // Parity requires at least two distinct platforms to compare
    if (rows.length < 2) {
        await writeBiasAssessment({
            scope,
            assessmentType: 'platform_sentiment_parity',
            groupField:     'platform',
            groupValue:     rows.length === 1 ? rows[0].category : 'none',
            metricName:     'max_comparative_diff',
            metricValue:    0,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       { rows, note: 'fewer than 2 platforms' },
            biasMvId,
        });
        return { isViolation: false, metricValue: 0, groupValue: null };
    }

    // Find the maximum pairwise difference across all platform combinations
    const { maxDiff, worstPair } = maxPairwiseGap(rows);

    const isViolation = maxDiff > threshold;
    const severity    = isViolation ? 'warning' : null;

    await writeBiasAssessment({
        scope,
        assessmentType: 'platform_sentiment_parity',
        groupField:     'platform',
        groupValue:     worstPair || 'unknown',
        metricName:     'max_comparative_diff',
        metricValue:    maxDiff,
        threshold,
        isViolation,
        severity,
        evidence:       { rows, maxDiff, worstPair, ...(minPer > 0 ? { min_per_category: minPer, excluded_small: allRows.filter(r => r.n < minPer) } : {}) },
        biasMvId,
    });

    if (isViolation) {
        await writeAlertEvent({
            scope,
            alertType: 'platform_sentiment_parity',
            severity,
            details: {
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
 * @param {string|object} target  a processing_jobs id, or a window scope (see scopeOf)
 * @param {string} biasMvId  UUID of the bias methodology_versions row
 * @returns {Promise<{ isViolation: boolean, metricValue: number }>}
 */
async function checkNegativeDominance(target, biasMvId) {
    const scope     = scopeOf(target);
    const config    = await getBiasConfig(biasMvId);
    const threshold = config.negative_dominance_max;

    // Count posts per sentiment indicator for this job (ordered, grumpy
    // final #5: the stored evidence.rows must not follow the query plan).
    const rows = await dbAll(
        `SELECT sr.indicator, COUNT(DISTINCT sr.raw_post_id)::int AS count
         FROM sentiment_results sr
         WHERE sr.raw_post_id IN (${scope.posts})
         GROUP BY sr.indicator
         ORDER BY sr.indicator`,
        scope.params,
    );

    // bias@1.4.0: a negative share over a handful of posts is noise —
    // below negative_min_sample the check records "insufficient sample".
    const minNeg = Number.isInteger(config.negative_min_sample) && config.negative_min_sample > 0 ? config.negative_min_sample : 0;

    // PR #22 grumpy M5: zero posts is below any minimum — "insufficient
    // sample" under bias@1.4.0+, the old 'all' row for older versions.
    if (rows.length === 0) {
        const insufficient = minNeg > 0;
        await writeBiasAssessment({
            scope,
            assessmentType: 'negative_dominance',
            groupField:     'global',
            groupValue:     insufficient ? INSUFFICIENT_SAMPLE : 'all',
            metricName:     'negative_share',
            metricValue:    0,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       { rows: [], total: 0, ...(insufficient ? { insufficient_sample: true, min_sample: minNeg } : {}) },
            biasMvId,
        });
        return insufficient ? { isViolation: false, metricValue: 0, insufficientSample: true } : { isViolation: false, metricValue: 0 };
    }

    const total      = rows.reduce((sum, r) => sum + r.count, 0);
    const negRow     = rows.find(r => r.indicator === 'negative');
    const negCount   = negRow ? negRow.count : 0;
    const metricValue = negCount / total;
    if (total < minNeg) {
        await writeBiasAssessment({
            scope,
            assessmentType: 'negative_dominance',
            groupField:     'global',
            groupValue:     INSUFFICIENT_SAMPLE,
            metricName:     'negative_share',
            metricValue,
            threshold,
            isViolation:    false,
            severity:       null,
            evidence:       { rows, total, negCount, insufficient_sample: true, min_sample: minNeg },
            biasMvId,
        });
        return { isViolation: false, metricValue, insufficientSample: true };
    }
    const isViolation = metricValue > threshold;
    const severity    = isViolation ? 'warning' : null;

    await writeBiasAssessment({
        scope,
        assessmentType: 'negative_dominance',
        groupField:     'global',
        groupValue:     'all',
        metricName:     'negative_share',
        metricValue,
        threshold,
        isViolation,
        severity,
        evidence:       { rows, total, negCount },
        biasMvId,
    });

    if (isViolation) {
        await writeAlertEvent({
            scope,
            alertType: 'negative_dominance',
            severity,
            details: {
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
    INSUFFICIENT_SAMPLE,
    scopeOf,
    runBiasChecks,
    checkLocationConcentration,
    checkPlatformSentimentParity,
    checkNegativeDominance,
};
