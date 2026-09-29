// src/collectors/run-retention.js
// Retention for the operational run tables (P10-9, G10-12), run by the
// worker's repeatable maintenance job (src/workers/maintenance.worker.js).
//
//   source_runs      raw rows are kept SOURCE_RUNS_RAW_DAYS (30) days; older
//                    rows are first added to source_run_daily (one row per
//                    day and source: runs, outcomes, items, new posts,
//                    requests, error kinds — migration 034) and then removed,
//                    in bounded batches, each batch in one transaction.
//   processing_jobs  a job older than PROCESSING_JOBS_KEEP_DAYS (30) that is
//                    finished (not running / closing / awaiting retries) and
//                    that NOTHING references — no decision_audit_log,
//                    bias_assessments or source_runs row — is removed: it is
//                    an empty job. Every job that scored a post or ran a
//                    bias check is kept permanently (spec §19 Tier 3).
//
// Each removing batch writes one data_retention_log summary row
// (raw_post_id NULL) with the true counts.

'use strict';

const { dbTransaction } = require('../db/connection');

const DEFAULT_RAW_DAYS = 30;
const DEFAULT_JOB_DAYS = 30;
const BATCH = 5000;

const days = (v, d) => { const n = parseInt(v || '', 10); return Number.isFinite(n) && n > 0 ? n : d; };

/** @returns {Promise<{ rolledUp: number, batches: number }>} */
async function rollupSourceRuns({ env = process.env, batch = BATCH } = {}) {
    const keep = days(env.SOURCE_RUNS_RAW_DAYS, DEFAULT_RAW_DAYS);
    let rolledUp = 0; let batches = 0;
    for (;;) {
        const n = await dbTransaction(async (client) => {
            const picked = (await client.query(
                `SELECT id FROM source_runs WHERE started_at < NOW() - make_interval(days => $1)
                 ORDER BY started_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [keep, batch])).rows.map(r => r.id);
            if (!picked.length) return 0;
            await client.query(
                `INSERT INTO source_run_daily AS d
                     (day, source_id, runs, ok_runs, error_runs, skipped_runs, items_fetched, posts_new, requests, error_kinds)
                 SELECT g.day, g.source_id, g.runs, g.ok_runs, g.error_runs, g.skipped_runs, g.items_fetched, g.posts_new, g.requests,
                        COALESCE((SELECT jsonb_object_agg(k.error_kind, k.n)
                                  FROM (SELECT error_kind, COUNT(*) AS n FROM source_runs
                                        WHERE id = ANY($1::uuid[]) AND error_kind IS NOT NULL
                                          AND started_at::date = g.day AND source_id = g.source_id
                                        GROUP BY error_kind) k), '{}'::jsonb)
                 FROM (SELECT started_at::date AS day, source_id, COUNT(*)::int AS runs,
                              COUNT(*) FILTER (WHERE outcome = 'ok')::int AS ok_runs,
                              COUNT(*) FILTER (WHERE outcome = 'error')::int AS error_runs,
                              COUNT(*) FILTER (WHERE outcome = 'skipped')::int AS skipped_runs,
                              SUM(items_fetched) AS items_fetched, SUM(posts_new) AS posts_new, SUM(requests) AS requests
                       FROM source_runs WHERE id = ANY($1::uuid[])
                       GROUP BY started_at::date, source_id) g
                 ON CONFLICT (day, source_id) DO UPDATE SET
                     runs = d.runs + EXCLUDED.runs, ok_runs = d.ok_runs + EXCLUDED.ok_runs,
                     error_runs = d.error_runs + EXCLUDED.error_runs, skipped_runs = d.skipped_runs + EXCLUDED.skipped_runs,
                     items_fetched = d.items_fetched + EXCLUDED.items_fetched, posts_new = d.posts_new + EXCLUDED.posts_new,
                     requests = d.requests + EXCLUDED.requests,
                     error_kinds = (SELECT COALESCE(jsonb_object_agg(k, to_jsonb(COALESCE((d.error_kinds->>k)::int, 0)
                                                                     + COALESCE((EXCLUDED.error_kinds->>k)::int, 0))), '{}'::jsonb)
                                    FROM (SELECT jsonb_object_keys(d.error_kinds) AS k
                                          UNION SELECT jsonb_object_keys(EXCLUDED.error_kinds)) keys),
                     rolled_up_at = NOW()`,
                [picked],
            );
            const removed = (await client.query('DELETE FROM source_runs WHERE id = ANY($1::uuid[])', [picked])).rowCount;
            await client.query(
                `INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
                 VALUES (NULL, 'rolled_up_source_runs', $1, $2, 'src/collectors/run-retention.js')`,
                [JSON.stringify({ summary: `${removed} source_runs row(s) older than ${keep} days rolled up into source_run_daily and removed.`, rows: removed, keep_days: keep }),
                    'Operational run records (no personal data); raw rows kept 30 days, daily rollups kept (PR #10 review P10-9).'],
            );
            return removed;
        });
        rolledUp += n;
        if (n) batches++;
        if (n < batch) break;
    }
    return { rolledUp, batches };
}

/** @returns {Promise<{ removed: number }>} */
async function purgeEmptyJobs({ env = process.env, batch = BATCH } = {}) {
    const keep = days(env.PROCESSING_JOBS_KEEP_DAYS, DEFAULT_JOB_DAYS);
    let removed = 0;
    for (;;) {
        const n = await dbTransaction(async (client) => {
            const r = await client.query(
                `DELETE FROM processing_jobs p
                 WHERE p.id IN (
                     SELECT j.id FROM processing_jobs j
                     WHERE j.status IN ('completed', 'failed')
                       AND j.started_at < NOW() - make_interval(days => $1)
                       AND NOT EXISTS (SELECT 1 FROM decision_audit_log d WHERE d.job_id = j.id)
                       AND NOT EXISTS (SELECT 1 FROM bias_assessments b WHERE b.job_id = j.id)
                       AND NOT EXISTS (SELECT 1 FROM source_runs s WHERE s.job_id = j.id)
                     ORDER BY j.started_at LIMIT $2
                     FOR UPDATE SKIP LOCKED)`,
                [keep, batch],
            );
            if (r.rowCount) {
                await client.query(
                    `INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
                     VALUES (NULL, 'purged_empty_jobs', $1, $2, 'src/collectors/run-retention.js')`,
                    [JSON.stringify({ summary: `${r.rowCount} empty processing_jobs row(s) older than ${keep} days removed.`, rows: r.rowCount, keep_days: keep }),
                        'Operational records with no scored post, bias check or run attached (no personal data; PR #10 review P10-9). '
                        + 'Jobs that scored posts or ran bias checks are kept permanently (spec §19 Tier 3).'],
                );
            }
            return r.rowCount;
        });
        removed += n;
        if (n < batch) break;
    }
    return { removed };
}

module.exports = { rollupSourceRuns, purgeEmptyJobs, DEFAULT_RAW_DAYS, DEFAULT_JOB_DAYS };
