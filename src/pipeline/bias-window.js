// src/pipeline/bias-window.js
// The rolling-window fairness checks (introduced by bias@1.5.0, run under
// CURRENT_VERSIONS.bias; PR #22 decision G2,
// approved by Jennifer McKinney on 2026-09-29; ADR 0001) and the
// insufficient-sample report (PR #22 principal #11).
//
// Why: the per-cycle checks (src/pipeline/bias.js) run over the posts of one
// 2–3 minute collection cycle, which rarely reaches the minimum samples of
// bias@1.4.0 (30 content-located posts, 10 posts per category, 30 posts). A
// monitor that always answers "insufficient sample" looks exactly like one
// that finds no bias. So:
//
//   runBiasWindow()  runs the SAME three checks, with the same thresholds
//                    and minimums, over every post whose sentiment decision
//                    was recorded in the last rolling_window.hours (24) —
//                    daily from the maintenance `daily` task
//                    (src/workers/maintenance.worker.js) and on demand
//                    (`npm run bias:window`, scripts/bias-window.js). Each
//                    run is a bias_window_runs row; its assessments are
//                    bias_window_assessments rows (migration 060), linked
//                    to the bias version that ran. Per-cycle checks stay.
//
//   insufficientSampleReport()  the share of "insufficient sample"
//                    assessments per check: per cycle over the last 24 h and
//                    7 days, and for the rolling window (the latest run and
//                    the last 7 days). Served by GET /api/bias/latest and
//                    GET /api/health, so a silenced monitor is visible.

'use strict';

const { dbGet, dbAll, dbRun } = require('../db/connection');
const clock = require('../db/clock');
const { CURRENT_VERSIONS } = require('../config/methodology-registry');
const { canonicalAssessmentType } = require('../config/bias-vocabulary');
const {
    INSUFFICIENT_SAMPLE, scopeOf, checkLocationConcentration, checkPlatformSentimentParity, checkNegativeDominance,
} = require('./bias');

/** The three checks, in the order they run (and are reported). */
const CHECKS = Object.freeze(['location_concentration', 'platform_sentiment_parity', 'negative_dominance']);

/** The bias version the code implements, with its rolling-window config. */
async function currentBiasVersion() {
    const version = CURRENT_VERSIONS.bias;
    const row = await dbGet(
        `SELECT id, version, config FROM methodology_versions WHERE component = 'bias' AND version = $1`,
        [version],
    );
    if (!row) throw new Error(`bias@${version} is not registered — run \`npm run migrate\``);
    const hours = row.config && row.config.rolling_window && row.config.rolling_window.hours;
    if (!Number.isInteger(hours) || hours <= 0) {
        throw new Error(`bias@${version} has no rolling_window.hours: the rolling window needs bias@1.5.0 or later`);
    }
    return { id: row.id, version: row.version, hours };
}

/**
 * Run the three fairness checks over the rolling window ending now.
 * The run row is written first (status 'running') and moved to 'completed'
 * or 'failed' exactly once (guarded on status = 'running'); a failed run
 * keeps the assessments it wrote and rethrows, so the caller (the
 * maintenance step, the CLI) reports the failure.
 *
 * @param {{ triggeredBy?: 'schedule'|'on_demand' }} [o]
 * @returns {Promise<{ runId, version, windowStart, windowEnd, windowHours, postsAssessed,
 *                     violationsFound, results: Array<object> }>}
 */
async function runBiasWindow({ triggeredBy = 'schedule' } = {}) {
    if (!['schedule', 'on_demand'].includes(triggeredBy)) throw new Error(`unknown bias window trigger: ${triggeredBy}`);
    const mv = await currentBiasVersion();
    const end = await clock.dbNow();
    const start = new Date(new Date(end).getTime() - mv.hours * 3600 * 1000);
    const run = await dbRun(
        `INSERT INTO bias_window_runs (window_hours, window_start, window_end, triggered_by, methodology_version_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [mv.hours, start, end, triggeredBy, mv.id],
    );
    const target = { windowRunId: run.id, start, end };
    try {
        const scope = scopeOf(target);
        const posts = await dbGet(`SELECT COUNT(*)::int AS n FROM (${scope.posts}) p`, scope.params);
        const results = [
            await checkLocationConcentration(target, mv.id),
            await checkPlatformSentimentParity(target, mv.id),
            await checkNegativeDominance(target, mv.id),
        ];
        const violationsFound = results.filter(r => r.isViolation).length;
        await dbRun(
            `UPDATE bias_window_runs
             SET status = 'completed', completed_at = NOW(), posts_assessed = $2, violations_found = $3
             WHERE id = $1 AND status = 'running'`,
            [run.id, posts.n, violationsFound],
        );
        return {
            runId: run.id, version: mv.version, windowStart: start, windowEnd: end, windowHours: mv.hours,
            postsAssessed: posts.n, violationsFound, results,
        };
    } catch (err) {
        await dbRun(
            `UPDATE bias_window_runs SET status = 'failed', completed_at = NOW(), error_details = $2
             WHERE id = $1 AND status = 'running'`,
            [run.id, String(err && err.message).slice(0, 1000)],
        );
        throw err;
    }
}

/** { total, insufficient, share } — share null when nothing was assessed. */
function shareOf(total, insufficient) {
    return { assessments: total, insufficient, share: total > 0 ? insufficient / total : null };
}

/** Fold rows { assessment_type, n, k } into one entry per canonical check. */
function perCheck(rows, nKey, kKey) {
    const out = Object.fromEntries(CHECKS.map(c => [c, { n: 0, k: 0 }]));
    for (const r of rows) {
        const type = canonicalAssessmentType(r.assessment_type);
        if (!out[type]) continue;
        out[type].n += Number(r[nKey]) || 0;
        out[type].k += Number(r[kKey]) || 0;
    }
    return Object.fromEntries(CHECKS.map(c => [c, shareOf(out[c].n, out[c].k)]));
}

/**
 * The share of "insufficient sample" assessments per check (principal #11).
 * ONE database anchor for every window.
 * @param {{ anchor?: Date }} [o]
 */
async function insufficientSampleReport({ anchor } = {}) {
    const at = anchor || await clock.dbNow();
    const WINDOWS = `COUNT(*) FILTER (WHERE created_at > $1::timestamptz - INTERVAL '24 hours')::int      AS n_24h,
                     COUNT(*) FILTER (WHERE created_at > $1::timestamptz - INTERVAL '24 hours'
                                        AND group_value = $2)::int                                        AS k_24h,
                     COUNT(*)::int                                                                         AS n_7d,
                     COUNT(*) FILTER (WHERE group_value = $2)::int                                         AS k_7d`;
    const WHERE = `created_at > $1::timestamptz - INTERVAL '7 days' AND created_at <= $1::timestamptz`;
    const cycleRows = await dbAll(
        `SELECT assessment_type, ${WINDOWS} FROM bias_assessments WHERE ${WHERE} GROUP BY assessment_type`,
        [at, INSUFFICIENT_SAMPLE],
    );
    const windowRows = await dbAll(
        `SELECT assessment_type, ${WINDOWS} FROM bias_window_assessments WHERE ${WHERE} GROUP BY assessment_type`,
        [at, INSUFFICIENT_SAMPLE],
    );
    const latest = await dbGet(
        `SELECT r.id, r.status, r.triggered_by, r.window_hours, r.window_start, r.window_end, r.started_at,
                r.completed_at, r.posts_assessed, r.violations_found, mv.version
         FROM bias_window_runs r JOIN methodology_versions mv ON mv.id = r.methodology_version_id
         WHERE r.started_at <= $1::timestamptz
         ORDER BY r.started_at DESC, r.id DESC
         LIMIT 1`,
        [at],
    );
    let latestChecks = null;
    if (latest) {
        const rows = await dbAll(
            `SELECT assessment_type, group_value, metric_value, threshold, is_violation
             FROM bias_window_assessments WHERE window_run_id = $1`,
            [latest.id],
        );
        latestChecks = Object.fromEntries(CHECKS.map((c) => {
            const r = rows.find(x => canonicalAssessmentType(x.assessment_type) === c);
            return [c, r ? {
                outcome: r.is_violation ? 'violation' : (r.group_value === INSUFFICIENT_SAMPLE ? 'insufficient_sample' : 'within_threshold'),
                group_value: r.group_value, metric_value: r.metric_value, threshold: r.threshold,
            } : null];
        }));
    }
    return {
        generated_at: new Date(at).toISOString(),
        per_cycle: {
            last_24h: perCheck(cycleRows, 'n_24h', 'k_24h'),
            last_7d: perCheck(cycleRows, 'n_7d', 'k_7d'),
        },
        rolling_window: {
            latest_run: latest ? {
                id: latest.id, status: latest.status, triggered_by: latest.triggered_by, version: latest.version,
                window_hours: latest.window_hours, window_start: latest.window_start, window_end: latest.window_end,
                started_at: latest.started_at, completed_at: latest.completed_at,
                posts_assessed: latest.posts_assessed, violations_found: latest.violations_found,
                checks: latestChecks,
            } : null,
            last_7d: perCheck(windowRows, 'n_7d', 'k_7d'),
        },
    };
}

module.exports = { runBiasWindow, insufficientSampleReport, currentBiasVersion, CHECKS };
