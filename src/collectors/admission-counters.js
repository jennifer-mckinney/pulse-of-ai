// src/collectors/admission-counters.js
// Relevance-accuracy Stage 0, P1 — rejection counters (R1). Decision
// (Jennifer McKinney 2026-09-30, verbatim "Counters only (Recommended)"):
// the collector keeps COUNTS of why fetched items were admitted or rejected,
// never their text and never their ids. A future recall measurement and a
// gold-corrected prevalence estimate need the rejected counts per source;
// rejected items themselves are not retained (policy unchanged).
//
// Two stores, both counts only:
//   source_runs.dropped_*     per run: the collector's in-memory
//                             dropped.{invalid, old, outOfScope, duplicate},
//                             summed over the source's routes (migration 068);
//                             rolled up with the run into source_run_daily
//                             (src/collectors/run-retention.js, spec §19
//                             Tier 3, kept permanently).
//   admission_rule_hits       per UTC day, source, route, admission_filter
//                             version and rule: admitted_count and
//                             rejected_count, upserted by the collector after
//                             each route (src/collectors/runner.js). Kept
//                             ADMISSION_RULE_HITS_DAYS (default 400) days
//                             (expireRuleHits, the worker's daily maintenance).
//
// Rule ids are a CLOSED vocabulary (RULE_ID_RE; the same expression is the
// table's CHECK, so no free text can be stored):
//   invalid      rejected: the item had no usable id or text
//   old          rejected: published before the route's age window
//   no_pattern   no admission pattern matched it: REJECTED on a 'filter'
//                route (out of scope), ADMITTED on an 'ai' route (AI-specific
//                feeds are stored whole; this counts how many of them the
//                patterns would not have recognised)
//   duplicate    rejected: the same id earlier in the same fetch
//   any_pattern  admitted, at least one pattern matched (one per item)
//   pattern:NN   admitted, pattern NN matched (NN = index into the
//                admission_filter version's registered patterns; one item can
//                count on several patterns, so pattern rows are not summed)
// Per item exactly one of invalid / old / no_pattern / duplicate /
// any_pattern is counted, so their sum is the number of items evaluated.
// Under admission_filter@1.0.0 (any pattern admits) pattern rows only ever
// count admissions; rejected_count on them stays 0 until a cascade can
// override a pattern hit.
//
// Counts are EVALUATIONS: an item a feed serves again on a later fetch (no
// ETag / 304 and no cursor) is evaluated, and counted, again; the counts
// cannot be de-duplicated without keeping ids, which this design rules out.
// A route is counted only when all of its items stored: a route whose store
// failed is fetched again by the next run, and counting both would count the
// same items twice (source_runs.dropped_* stays per run, so it is not
// affected: it describes that run).

'use strict';

const { retentionWindowDays } = require('../config/source-registry');

const RULE_ID_RE = /^(invalid|old|duplicate|no_pattern|any_pattern|pattern:[0-9]{2})$/;
// Registry route ids (src/config/source-registry.js): lower-case words and
// hyphens. The table's CHECK uses the same expression.
const ROUTE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULT_RULE_HITS_DAYS = 400;   // a year plus a month: same-month year-on-year comparison
const MIN_RULE_HITS_DAYS = 35;
const BATCH = 5000;

/** 'pattern:NN' for a PATTERNS index (0..99). */
function patternRuleId(index) {
    if (!Number.isInteger(index) || index < 0 || index > 99) throw new Error(`not a pattern index: ${index}`);
    return `pattern:${String(index).padStart(2, '0')}`;
}

/** An empty tally: { [ruleId]: { admitted, rejected } }. */
function newTally() {
    return {};
}

/** Count one item on one rule. */
function count(tally, ruleId, admitted) {
    if (!RULE_ID_RE.test(ruleId)) throw new Error(`not an admission rule id: ${JSON.stringify(ruleId)}`);
    const c = tally[ruleId] || (tally[ruleId] = { admitted: 0, rejected: 0 });
    if (admitted) c.admitted++;
    else c.rejected++;
}

/** { evaluated, admitted, rejected } from the per-item outcome rules (pattern rows excluded). */
function totals(tally) {
    const get = (id, k) => (tally[id] ? tally[id][k] : 0);
    const admitted = get('any_pattern', 'admitted') + get('no_pattern', 'admitted');
    const rejected = get('invalid', 'rejected') + get('old', 'rejected') + get('no_pattern', 'rejected') + get('duplicate', 'rejected');
    return { evaluated: admitted + rejected, admitted, rejected };
}

/** Upsert rows of a tally (rows with no count are skipped). */
function rows(tally) {
    return Object.entries(tally || {})
        .filter(([, c]) => c.admitted > 0 || c.rejected > 0)
        .map(([ruleId, c]) => ({ rule_id: ruleId, admitted_count: c.admitted, rejected_count: c.rejected }));
}

/** Sum the per-route dropped counters of one source run. */
function mergeDropped(list) {
    const out = { invalid: 0, old: 0, outOfScope: 0, duplicate: 0 };
    for (const d of list) {
        if (!d) continue;
        for (const k of Object.keys(out)) out[k] += Number(d[k]) || 0;
    }
    return out;
}

/** ADMISSION_RULE_HITS_DAYS (default 400, at least 35): strict, a bad value throws. */
function ruleHitsRetentionDays(env = process.env) {
    return retentionWindowDays(env, { name: 'ADMISSION_RULE_HITS_DAYS', def: DEFAULT_RULE_HITS_DAYS, min: MIN_RULE_HITS_DAYS });
}

// ─── Database ────────────────────────────────────────────────────────────────
// Required lazily, so the pure helpers above load without a database.
const db = () => require('../db/connection');

/**
 * Add one route's tally to today's (UTC) admission_rule_hits rows.
 * @returns {Promise<number>} rows written
 */
async function recordRuleHits({ sourceId, route, admissionMvId, tally }) {
    if (!ROUTE_ID_RE.test(String(route))) throw new Error(`not a registry route id: ${JSON.stringify(route)}`);
    const list = rows(tally);
    if (!list.length) return 0;
    await db().dbRun(
        `INSERT INTO admission_rule_hits AS h
             (day, source_id, route, admission_mv_id, rule_id, admitted_count, rejected_count)
         SELECT (NOW() AT TIME ZONE 'UTC')::date, $1, $2, $3, r.rule_id, r.admitted_count, r.rejected_count
         FROM unnest($4::text[], $5::bigint[], $6::bigint[]) AS r(rule_id, admitted_count, rejected_count)
         ON CONFLICT (day, source_id, route, admission_mv_id, rule_id) DO UPDATE SET
             admitted_count = h.admitted_count + EXCLUDED.admitted_count,
             rejected_count = h.rejected_count + EXCLUDED.rejected_count,
             updated_at = NOW()`,
        [sourceId, route, admissionMvId, list.map(r => r.rule_id), list.map(r => r.admitted_count), list.map(r => r.rejected_count)],
    );
    return list.length;
}

/**
 * Retention: remove admission_rule_hits rows older than the window, in
 * bounded batches, each with one data_retention_log summary row.
 * @returns {Promise<{ removed: number, batches: number, keepDays: number }>}
 */
async function expireRuleHits({ env = process.env, batch = BATCH } = {}) {
    // Strict: a bad ADMISSION_RULE_HITS_DAYS throws and nothing is removed.
    const keep = ruleHitsRetentionDays(env);
    let removed = 0; let batches = 0;
    for (;;) {
        const n = await db().dbTransaction(async (client) => {
            const r = await client.query(
                `DELETE FROM admission_rule_hits WHERE ctid = ANY(ARRAY(
                     SELECT ctid FROM admission_rule_hits
                     WHERE day < (NOW() AT TIME ZONE 'UTC')::date - $1::int
                     ORDER BY day LIMIT $2 FOR UPDATE SKIP LOCKED))`,
                [keep, batch]);
            if (!r.rowCount) return 0;
            await client.query(
                `INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
                 VALUES (NULL, 'expired_admission_rule_hits', $1, $2, 'src/collectors/admission-counters.js')`,
                [JSON.stringify({ summary: `${r.rowCount} admission_rule_hits row(s) older than ${keep} days removed.`,
                    rows: r.rowCount, keep_days: keep }),
                'Aggregate admission counts (no text, no ids, no personal data); kept ADMISSION_RULE_HITS_DAYS days '
                    + '(default 400); per-source daily rejection totals stay in source_run_daily (spec §19 Tier 3).'],
            );
            return r.rowCount;
        });
        removed += n;
        if (n) batches++;
        if (n < batch) break;
    }
    return { removed, batches, keepDays: keep };
}

// The API window: the last `days` UTC days, today included.
const WINDOW_SQL = `day > (NOW() AT TIME ZONE 'UTC')::date - $1::int`;
const API_WINDOW_DAYS = 7;

/** Outcome summary of { [ruleId]: { admitted, rejected } } (counts only). */
function summary(byRule) {
    const get = (id, k) => (byRule[id] ? byRule[id][k] : 0);
    const t = totals(byRule);
    return {
        evaluated: t.evaluated,
        admitted: t.admitted,
        admitted_without_pattern: get('no_pattern', 'admitted'),
        rejected: {
            total: t.rejected,
            out_of_scope: get('no_pattern', 'rejected'),
            old: get('old', 'rejected'),
            invalid: get('invalid', 'rejected'),
            duplicate: get('duplicate', 'rejected'),
        },
    };
}

/**
 * Per source, over the last `days` UTC days: Map(source_id → summary).
 * Sources with no counts in the window are absent.
 */
async function admissionBySource({ days = API_WINDOW_DAYS } = {}) {
    const list = await db().dbAll(
        `SELECT source_id, rule_id, SUM(admitted_count)::bigint AS admitted, SUM(rejected_count)::bigint AS rejected
         FROM admission_rule_hits WHERE ${WINDOW_SQL} AND rule_id NOT LIKE 'pattern:%'
         GROUP BY source_id, rule_id`, [days]);
    const bySource = new Map();
    for (const r of list) {
        const m = bySource.get(r.source_id) || {};
        m[r.rule_id] = { admitted: Number(r.admitted), rejected: Number(r.rejected) };
        bySource.set(r.source_id, m);
    }
    return new Map([...bySource].map(([id, byRule]) => [id, { window_days: days, ...summary(byRule) }]));
}

/**
 * All sources together, over the last `days` UTC days, with the pattern
 * counts per admission_filter version (GET /api/health).
 */
async function admissionTotals({ days = API_WINDOW_DAYS, env = process.env } = {}) {
    // One statement, so the rule totals and the source count come from the
    // same snapshot.
    const list = await db().dbAll(
        `WITH w AS (SELECT * FROM admission_rule_hits WHERE ${WINDOW_SQL})
         SELECT mv.version, w.rule_id, SUM(w.admitted_count)::bigint AS admitted, SUM(w.rejected_count)::bigint AS rejected,
                (SELECT COUNT(DISTINCT source_id)::int FROM w) AS sources
         FROM w JOIN methodology_versions mv ON mv.id = w.admission_mv_id
         GROUP BY mv.version, w.rule_id`, [days]);
    // Version order is numeric (1.10.0 after 1.9.0), which SQL's text sort is not.
    const ver = (v) => String(v).split('.').map(n => parseInt(n, 10) || 0);
    const byVersion = (a, b) => {
        const x = ver(a), y = ver(b);
        for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
        return 0;
    };
    list.sort((a, b) => byVersion(a.version, b.version) || (a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0));
    const sourcesReporting = list.length ? list[0].sources : 0;
    const outcome = {};
    const patterns = [];
    for (const r of list) {
        const c = { admitted: Number(r.admitted), rejected: Number(r.rejected) };
        if (r.rule_id.startsWith('pattern:')) {
            patterns.push({ admission_filter: r.version, rule_id: r.rule_id, ...c });
            continue;
        }
        const o = outcome[r.rule_id] || (outcome[r.rule_id] = { admitted: 0, rejected: 0 });
        o.admitted += c.admitted;
        o.rejected += c.rejected;
    }
    // A malformed ADMISSION_RULE_HITS_DAYS makes the daily retention step
    // fail (nothing is removed); say so here instead of only a null window.
    let retentionDays; let retentionInvalid = false;
    try { retentionDays = ruleHitsRetentionDays(env); } catch { retentionDays = null; retentionInvalid = true; }
    return {
        window_days: days,
        day_basis: 'UTC',
        counted_as: 'evaluations: an item a feed serves again on a later fetch is counted again; '
            + 'a route whose store failed is counted only by the run that completes it',
        sources_reporting: sourcesReporting,
        ...summary(outcome),
        patterns,
        retention_days: retentionDays,
        retention_invalid: retentionInvalid,
    };
}

module.exports = {
    RULE_ID_RE, ROUTE_ID_RE, DEFAULT_RULE_HITS_DAYS, MIN_RULE_HITS_DAYS, API_WINDOW_DAYS,
    patternRuleId, newTally, count, totals, rows, mergeDropped, ruleHitsRetentionDays, summary,
    recordRuleHits, expireRuleHits, admissionBySource, admissionTotals,
};
