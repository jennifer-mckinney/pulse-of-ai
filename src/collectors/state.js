// src/collectors/state.js
// Per-source collection state and run outcomes (migration 013).
//
//   claim(sourceId, minIntervalSec)  atomic cadence guard: sets
//       last_attempt_at = NOW() only when the previous attempt is older than
//       the source's poll interval, and returns the stored cursor + HTTP
//       validators; null when another process (the worker schedule or
//       POST /api/refresh) ran the source inside its interval.
//   saveOutcome(...)                 cursor, validators, last success /
//       error / counts, consecutive failures
//   recordRun(...)                   one source_runs row per run

'use strict';

const { dbGet, dbAll, dbRun } = require('../db/connection');

// Scheduler jitter slack: a run due every N s may start a few seconds early.
const CLAIM_SLACK_SEC = 10;

/** slug → data_sources.id for registry rows. */
async function sourceIdsBySlug(slugs) {
    const rows = await dbAll('SELECT id, name FROM data_sources WHERE name = ANY($1::text[])', [slugs]);
    return new Map(rows.map(r => [r.name, r.id]));
}

async function claim(sourceId, minIntervalSec) {
    await dbRun(
        'INSERT INTO source_collection_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING',
        [sourceId],
    );
    const interval = Math.max(0, (minIntervalSec || 0) - CLAIM_SLACK_SEC);
    return dbGet(
        `UPDATE source_collection_state
         SET last_attempt_at = NOW(), updated_at = NOW()
         WHERE source_id = $1
           AND (last_attempt_at IS NULL OR last_attempt_at <= NOW() - make_interval(secs => $2))
         RETURNING cursor, http_cache`,
        [sourceId, interval],
    );
}

/**
 * `error` must already be scrubbed (src/collectors/redact.js); `errorKind` /
 * `httpStatus` are its public classification (migration 016).
 */
async function saveOutcome(sourceId, { cursor, httpCache, ok, itemCount, newPosts, error, errorKind = null, httpStatus = null }) {
    await dbRun(
        `UPDATE source_collection_state
         SET cursor = $2::jsonb,
             http_cache = $3::jsonb,
             last_success_at = CASE WHEN $4::boolean THEN NOW() ELSE last_success_at END,
             last_item_count = CASE WHEN $4::boolean THEN $5::int ELSE last_item_count END,
             last_new_posts  = CASE WHEN $4::boolean THEN $6::int ELSE last_new_posts END,
             last_error      = $7::text,
             last_error_kind = $8::text,
             last_http_status = $9::int,
             last_error_at   = CASE WHEN $7::text IS NULL THEN last_error_at ELSE NOW() END,
             consecutive_failures = CASE WHEN $4::boolean THEN 0 ELSE consecutive_failures + 1 END,
             updated_at = NOW()
         WHERE source_id = $1`,
        [sourceId, JSON.stringify(cursor || {}), JSON.stringify(httpCache || {}), ok, itemCount, newPosts, error || null,
            error ? errorKind : null, error ? httpStatus : null],
    );
}

async function recordRun({
    sourceId, jobId, gateStatus, outcome, itemsFetched = 0, postsNew = 0, requests = 0,
    error = null, errorKind = null, httpStatus = null, startedAt,
}) {
    await dbRun(
        `INSERT INTO source_runs
            (source_id, job_id, gate_status, outcome, items_fetched, posts_new, requests, error, error_kind, http_status,
             started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())`,
        [sourceId, jobId, gateStatus, outcome, itemsFetched, postsNew, requests, error,
            error ? errorKind : null, error ? httpStatus : null, startedAt || new Date()],
    );
}

module.exports = { sourceIdsBySlug, claim, saveOutcome, recordRun, CLAIM_SLACK_SEC };
