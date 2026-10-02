// src/collectors/run-retention.js
// Retention for the operational run table source_runs (P10-9, G10-12), run by the
// worker's repeatable maintenance job (src/workers/maintenance.worker.js).
//
//   source_runs      raw rows are kept SOURCE_RUNS_RAW_DAYS (30) days; older
//                    rows are first added to source_run_daily (one row per
//                    day and source: runs, outcomes, items, new posts,
//                    requests, error kinds — migration 034; the admission
//                    dropped counts — migration 068) and then removed,
//                    in bounded batches, each batch in one transaction.
//   processing_jobs  NEVER removed: every job, failed ones included, is kept
//                    permanently (spec §19 Tier 3; PR #22 decision G4,
//                    Jennifer 2026-09-29). Only source_runs is rolled up.
//
// Each removing batch writes one data_retention_log summary row
// (raw_post_id NULL) with the true counts.

'use strict';

const { dbTransaction } = require('../db/connection');
const { retentionWindowDays } = require('../config/source-registry');

const DEFAULT_RAW_DAYS = 30;
const BATCH = 5000;


/** @returns {Promise<{ rolledUp: number, batches: number }>} */
async function rollupSourceRuns({ env = process.env, batch = BATCH } = {}) {
    // M1: strict — a bad SOURCE_RUNS_RAW_DAYS throws, nothing is removed.
    const keep = retentionWindowDays(env, { name: 'SOURCE_RUNS_RAW_DAYS', def: DEFAULT_RAW_DAYS, min: 7 });
    let rolledUp = 0; let batches = 0;
    for (;;) {
        const n = await dbTransaction(async (client) => {
            const picked = (await client.query(
                `SELECT id FROM source_runs WHERE started_at < NOW() - make_interval(days => $1)
                 ORDER BY started_at LIMIT $2 FOR UPDATE SKIP LOCKED`, [keep, batch])).rows.map(r => r.id);
            if (!picked.length) return 0;
            await client.query(
                `INSERT INTO source_run_daily AS d
                     (day, source_id, runs, ok_runs, error_runs, skipped_runs, items_fetched, posts_new, requests,
                      dropped_invalid, dropped_old, dropped_out_of_scope, dropped_duplicate, error_kinds)
                 SELECT g.day, g.source_id, g.runs, g.ok_runs, g.error_runs, g.skipped_runs, g.items_fetched, g.posts_new, g.requests,
                        g.dropped_invalid, g.dropped_old, g.dropped_out_of_scope, g.dropped_duplicate,
                        COALESCE((SELECT jsonb_object_agg(k.error_kind, k.n)
                                  FROM (SELECT error_kind, COUNT(*) AS n FROM source_runs
                                        WHERE id = ANY($1::uuid[]) AND error_kind IS NOT NULL
                                          AND started_at::date = g.day AND source_id = g.source_id
                                        GROUP BY error_kind) k), '{}'::jsonb)
                 FROM (SELECT started_at::date AS day, source_id, COUNT(*)::int AS runs,
                              COUNT(*) FILTER (WHERE outcome = 'ok')::int AS ok_runs,
                              COUNT(*) FILTER (WHERE outcome = 'error')::int AS error_runs,
                              COUNT(*) FILTER (WHERE outcome = 'skipped')::int AS skipped_runs,
                              SUM(items_fetched) AS items_fetched, SUM(posts_new) AS posts_new, SUM(requests) AS requests,
                              -- Migration 068: NULL when no run of the day recorded them.
                              SUM(dropped_invalid) AS dropped_invalid, SUM(dropped_old) AS dropped_old,
                              SUM(dropped_out_of_scope) AS dropped_out_of_scope, SUM(dropped_duplicate) AS dropped_duplicate
                       FROM source_runs WHERE id = ANY($1::uuid[])
                       GROUP BY started_at::date, source_id) g
                 ON CONFLICT (day, source_id) DO UPDATE SET
                     runs = d.runs + EXCLUDED.runs, ok_runs = d.ok_runs + EXCLUDED.ok_runs,
                     error_runs = d.error_runs + EXCLUDED.error_runs, skipped_runs = d.skipped_runs + EXCLUDED.skipped_runs,
                     items_fetched = d.items_fetched + EXCLUDED.items_fetched, posts_new = d.posts_new + EXCLUDED.posts_new,
                     requests = d.requests + EXCLUDED.requests,
                     -- NULL + NULL stays NULL (not recorded); otherwise a NULL side counts 0.
                     dropped_invalid = CASE WHEN d.dropped_invalid IS NULL AND EXCLUDED.dropped_invalid IS NULL THEN NULL
                         ELSE COALESCE(d.dropped_invalid, 0) + COALESCE(EXCLUDED.dropped_invalid, 0) END,
                     dropped_old = CASE WHEN d.dropped_old IS NULL AND EXCLUDED.dropped_old IS NULL THEN NULL
                         ELSE COALESCE(d.dropped_old, 0) + COALESCE(EXCLUDED.dropped_old, 0) END,
                     dropped_out_of_scope = CASE WHEN d.dropped_out_of_scope IS NULL AND EXCLUDED.dropped_out_of_scope IS NULL THEN NULL
                         ELSE COALESCE(d.dropped_out_of_scope, 0) + COALESCE(EXCLUDED.dropped_out_of_scope, 0) END,
                     dropped_duplicate = CASE WHEN d.dropped_duplicate IS NULL AND EXCLUDED.dropped_duplicate IS NULL THEN NULL
                         ELSE COALESCE(d.dropped_duplicate, 0) + COALESCE(EXCLUDED.dropped_duplicate, 0) END,
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

module.exports = { rollupSourceRuns, DEFAULT_RAW_DAYS };
