// src/routes/bias.js
// GET /api/bias/latest
//
// Returns the most recent bias assessment results.
// Scoped to the most recently completed processing job.
//
// Returns:
//   200 {
//     job_id: uuid | null,
//     assessed_at: ISO8601 | null,
//     violations: [ { assessment_type, group_field, group_value,
//                     metric_name, metric_value, threshold, severity } ],
//     all_assessments: [ ... same shape ... ],
//     insufficient_sample: { per_cycle: { last_24h, last_7d }, rolling_window:
//                            { latest_run, last_7d } } — per check
//                            { assessments, insufficient, share } (PR #22
//                            principal #11; src/pipeline/bias-window.js)
//   }
//
// GET /api/bias/history
//
// Trailing-window alert history for the health drawer ("ALERT HISTORY · LAST
// 12H"), mapped to the frontend severity vocabulary (alert | watch | pass —
// see src/config/bias-vocabulary.js) with layer display names and literature
// citations from the bias methodology version that PRODUCED each row
// (lineage — src/config/bias-lineage.js).
//
// Whole-window coverage (PR #8 review): at the 2–3 min processing cadence a
// 12h window holds ~720–1,080 assessments, so a flat row cap silently showed
// only the newest fraction. Instead:
//   alerts       — EVERY flagged (alert|watch) row in the window, newest
//                  first. Flagged rows are rare; a hard safety cap
//                  (HISTORY_ALERT_CAP) still bounds the payload, and when it
//                  bites `truncated` is true and `alert_count` is the total.
//   pass_summary — pass rows collapsed to ONE summary per layer (count,
//                  first/last time, latest value + threshold), so every
//                  passing check in the window is accounted for.
// Every query shares ONE database timestamp (src/db/clock.js): the window is
// [anchor − hours, anchor] and generated_at is that anchor.
//
// Query params:
//   ?hours=12    window size in hours (integer, default 12, clamped to 1..48)
//
// Returns:
//   200 { window_hours, window_start, generated_at,
//         total_count, alert_count, pass_count, insufficient_count, truncated, alert_cap,
//         alerts: [ { id, time, severity, layer, assessment_type, group_value,
//                     metric_name, value, threshold, detail, citation,
//                     model_name, version, lineage } ],
//         pass_summary: [ { severity: 'pass', layer, assessment_type, count, insufficient,
//                           first_time, last_time, metric_name, latest_value,
//                           threshold, detail, citation,
//                           model_name, version, lineage } ] }
//   400 when hours is not an integer

'use strict';

const { logRouteError } = require('../middleware/log-error');

const { Router }       = require('express');
const { dbGet, dbAll } = require('../db/connection');
const clock            = require('../db/clock');
const {
    severityLabel, layerName, citationFor, alertDetail, canonicalAssessmentType,
} = require('../config/bias-vocabulary');
const { resolveBiasLineage, loadBiasVersions } = require('../config/bias-lineage');
const { insufficientSampleReport } = require('../pipeline/bias-window');

const router = Router();

// Safety cap on FLAGGED rows per response. Flagged rows are rare (pass rows
// are summarized, never listed), so this only bites in a pathological window;
// when it does, the response says so (truncated + alert_count).
const HISTORY_ALERT_CAP = 500;

// group_value of a check below its minimum sample (src/pipeline/bias.js).
const { INSUFFICIENT_SAMPLE } = require('../pipeline/bias');

/** Lineage-resolved methodology fields for one stored row. */
function lineageFields(row, versions) {
    const { mv, lineage } = resolveBiasLineage(row, versions);
    return {
        config:     mv ? mv.config : null,
        model_name: mv ? mv.model_name : null,
        version:    mv ? mv.version : null,
        lineage,
    };
}

/**
 * Fold per-stored-type pass aggregates into one summary per CANONICAL layer
 * (a synonym-typed row joins its canonical twin — read-time synonym mapping,
 * never a rewrite). The latest row supplies value/threshold/lineage.
 */
function foldPassSummaries(rows, versions) {
    const byType = new Map();
    for (const r of rows) {
        const type = canonicalAssessmentType(r.assessment_type);
        const prev = byType.get(type);
        if (!prev) {
            byType.set(type, { ...r, assessment_type: type, n: Number(r.n), insufficient: Number(r.insufficient) || 0 });
            continue;
        }
        const newer = new Date(r.last_time) > new Date(prev.last_time) ? r : prev;
        byType.set(type, {
            ...newer,
            assessment_type: type,
            n:          prev.n + Number(r.n),
            insufficient: prev.insufficient + (Number(r.insufficient) || 0),
            first_time: new Date(r.first_time) < new Date(prev.first_time)
                ? r.first_time : prev.first_time,
        });
    }
    return [...byType.values()]
        .sort((a, b) => new Date(b.last_time) - new Date(a.last_time))
        .map((r) => {
            const lin = lineageFields({
                methodology_version_id: r.methodology_version_id,
                created_at:             r.last_time,
            }, versions);
            const value = Number(r.metric_value);
            return {
                severity:        'pass',
                layer:           layerName(r.assessment_type, lin.config),
                assessment_type: r.assessment_type,
                count:           r.n,
                insufficient:    r.insufficient,
                first_time:      r.first_time,
                last_time:       r.last_time,
                metric_name:     r.metric_name,
                latest_value:    r.metric_value,
                threshold:       r.threshold,
                // Deterministic, built only from stored fields.
                // PR #22 principal #11: rows below the minimum sample are
                // not passes; the detail says how many there were.
                detail: (r.insufficient > 0
                    ? `${r.n - r.insufficient} passing check${r.n - r.insufficient === 1 ? '' : 's'} and `
                        + `${r.insufficient} with an insufficient sample in the window · `
                    : `${r.n} passing check${r.n === 1 ? '' : 's'} in the window · `)
                    + `latest ${r.metric_name} `
                    + `${Number.isFinite(value) ? value.toFixed(3) : 'n/a'} `
                    + `(τ = ${r.threshold}).`,
                citation:        citationFor(r.assessment_type, lin.config),
                model_name:      lin.model_name,
                version:         lin.version,
                lineage:         lin.lineage,
            };
        });
}

router.get('/bias/history', async (req, res) => {
    try {
        // Same validate-then-clamp pattern as /api/sources/timeseries: strict
        // integer check first (parseInt would silently accept '1.5'), then
        // clamp — window size is a display preference, not a correctness input.
        // F5: digits only — a negative window is meaningless, so '-5' is a
        // 400 like any other malformed value instead of clamping to 1.
        let hours = 12;
        if (req.query.hours !== undefined) {
            if (!/^\d+$/.test(req.query.hours)) {
                return res.status(400).json({ error: 'hours must be an integer' });
            }
            hours = parseInt(req.query.hours, 10);
        }
        hours = Math.min(48, Math.max(1, hours));

        // ONE anchor for every query below (and for generated_at).
        const anchor = await clock.dbNow();
        const WINDOW = `created_at >= $1::timestamptz - ($2::int * INTERVAL '1 hour')
                        AND created_at <= $1::timestamptz`;
        const params = [anchor, hours];

        const counts = await dbGet(
            `SELECT COUNT(*)::int                                  AS total_count,
                    COUNT(*) FILTER (WHERE is_violation)::int      AS alert_count,
                    COUNT(*) FILTER (WHERE NOT is_violation)::int  AS pass_count,
                    COUNT(*) FILTER (WHERE NOT is_violation AND group_value = $3)::int AS insufficient_count
             FROM bias_assessments
             WHERE ${WINDOW}`,
            [...params, INSUFFICIENT_SAMPLE],
        );

        const flagged = await dbAll(
            `SELECT id, assessment_type, group_field, group_value,
                    metric_name, metric_value, threshold, is_violation, severity,
                    created_at, methodology_version_id
             FROM bias_assessments
             WHERE is_violation AND ${WINDOW}
             ORDER BY created_at DESC, id DESC
             LIMIT ${HISTORY_ALERT_CAP}`,
            params,
        );

        // One row per stored assessment_type: count + first/last time over
        // the window, plus the latest row's value/threshold/lineage (window
        // functions run before DISTINCT ON picks the newest row).
        const passRows = await dbAll(
            `SELECT DISTINCT ON (assessment_type)
                    assessment_type, metric_name, metric_value, threshold,
                    methodology_version_id,
                    created_at                                         AS last_time,
                    COUNT(*)        OVER (PARTITION BY assessment_type) AS n,
                    COUNT(*) FILTER (WHERE group_value = $3) OVER (PARTITION BY assessment_type) AS insufficient,
                    MIN(created_at) OVER (PARTITION BY assessment_type) AS first_time
             FROM bias_assessments
             WHERE NOT is_violation AND ${WINDOW}
             ORDER BY assessment_type, created_at DESC, id DESC`,
            [...params, INSUFFICIENT_SAMPLE],
        );

        const versions = await loadBiasVersions(dbAll);

        const alerts = flagged.map((row) => {
            const lin = lineageFields(row, versions);
            return {
                id:              row.id,
                time:            row.created_at,
                severity:        severityLabel(row),
                layer:           layerName(row.assessment_type, lin.config),
                assessment_type: row.assessment_type,
                group_value:     row.group_value,
                metric_name:     row.metric_name,
                value:           row.metric_value,
                threshold:       row.threshold,
                detail:          alertDetail(row, lin.config),
                citation:        citationFor(row.assessment_type, lin.config),
                model_name:      lin.model_name,
                version:         lin.version,
                lineage:         lin.lineage,
            };
        });

        const windowStart = new Date(new Date(anchor).getTime() - hours * 3600 * 1000);
        return res.json({
            window_hours: hours,
            window_start: windowStart.toISOString(),
            generated_at: new Date(anchor).toISOString(),
            total_count:  counts.total_count,
            alert_count:  counts.alert_count,
            pass_count:   counts.pass_count,
            // Of the non-alerting rows, those below their check's minimum
            // sample (PR #22 principal #11): not evidence of "no bias".
            insufficient_count: counts.insufficient_count,
            truncated:    alerts.length < counts.alert_count,
            alert_cap:    HISTORY_ALERT_CAP,
            alerts,
            pass_summary: foldPassSummaries(passRows, versions),
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('bias history', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

router.get('/bias/latest', async (req, res) => {
    try {
        // Find the most recently completed job (regardless of whether it has assessments).
        // Using INNER JOIN here would exclude jobs with no assessments, incorrectly reporting
        // a stale job as "latest" when a newer job exists but produced no bias findings.
        const latestJob = await dbGet(
            // The latest completed job that PROCESSED posts: a job that scored
            // nothing (a refresh that found no new items) has no fairness
            // assessment to show.
            `SELECT id
             FROM processing_jobs
             WHERE status = 'completed' AND posts_processed > 0
             ORDER BY started_at DESC
             LIMIT 1`,
        );

        // PR #22 principal #11 / G2: how often each check could not reach
        // its minimum sample (per cycle and in the rolling window), so a
        // monitor that is always "insufficient sample" is visible.
        const insufficientSample = await insufficientSampleReport();

        if (!latestJob) {
            return res.json({
                job_id:          null,
                assessed_at:     null,
                violations:      [],
                all_assessments: [],
                insufficient_sample: insufficientSample,
            });
        }

        const all = await dbAll(
            `SELECT
                id, assessment_type, group_field, group_value,
                metric_name, metric_value, threshold, is_violation, severity,
                evidence, created_at, methodology_version_id
             FROM bias_assessments
             WHERE job_id = $1
             ORDER BY created_at ASC`,
            [latestJob.id],
        );

        const violations   = all.filter(a => a.is_violation);
        const assessed_at  = all.length > 0 ? all[all.length - 1].created_at : null;

        return res.json({
            job_id:          latestJob.id,
            assessed_at,
            violations,
            all_assessments: all,
            insufficient_sample: insufficientSample,
        });
    /* istanbul ignore start -- Database failure; requires error injection testing infrastructure */
    } catch (err) {
        logRouteError('bias', err);
        return res.status(500).json({ error: 'Internal server error' });
    }
    /* istanbul ignore end */
});

module.exports = router;
module.exports.HISTORY_ALERT_CAP = HISTORY_ALERT_CAP;
