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
//   getRefusal / recordRefusal / clearRefusal   the refused state (F10-5,
//       migration 018; src/collectors/refusal.js has the rules)

'use strict';

const { dbGet, dbAll, dbRun } = require('../db/connection');

// Scheduler jitter slack (G10-16): a run due every N s may start early by up
// to 20% of the collection window (a fixed 10 s was less than the jitter of
// a busy worker, so due runs were refused as "within the poll interval"),
// never more than 20% of the source's own interval.
const CLAIM_SLACK_FRACTION = 0.2;
const CLAIM_SLACK_SEC = 10;   // floor

/** Slack in seconds for a source polled every `intervalSec` under a window of `windowMs`. */
function claimSlackSec(intervalSec, windowMs) {
    const byWindow = CLAIM_SLACK_FRACTION * (windowMs || 0) / 1000;
    const byInterval = CLAIM_SLACK_FRACTION * (intervalSec || 0);
    return Math.max(Math.min(CLAIM_SLACK_SEC, byInterval), Math.min(byWindow, byInterval));
}

/** slug → data_sources.id for registry rows. */
async function sourceIdsBySlug(slugs) {
    const rows = await dbAll('SELECT id, name FROM data_sources WHERE name = ANY($1::text[])', [slugs]);
    return new Map(rows.map(r => [r.name, r.id]));
}

async function claim(sourceId, minIntervalSec, windowMs = require('../config/source-registry').collectWindowMs()) {
    await dbRun(
        'INSERT INTO source_collection_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING',
        [sourceId],
    );
    const interval = Math.max(0, (minIntervalSec || 0) - claimSlackSec(minIntervalSec, windowMs));
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

/** G10-12: count a run that changed nothing instead of inserting a row. */
async function countUnchangedRun(sourceId) {
    await dbRun(
        `UPDATE source_collection_state
         SET unchanged_runs = unchanged_runs + 1, last_unchanged_at = NOW()
         WHERE source_id = $1`,
        [sourceId],
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

/**
 * The database kill switch of a source (F10-10, migration 020).
 * @returns {Promise<{ disabled_at, reason, by }|null>} null when not disabled
 */
async function dbKillSwitch(sourceId) {
    const row = await dbGet(
        `SELECT collection_disabled_at AS disabled_at, collection_disabled_reason AS reason, collection_disabled_by AS by
         FROM data_sources WHERE id = $1`,
        [sourceId],
    );
    return row && row.disabled_at ? row : null;
}

/** Set (disabled=true) or clear the database kill switch. @returns {Promise<boolean>} whether a row changed */
async function setDbKillSwitch(sourceId, disabled, { reason = null, by = null } = {}) {
    const row = disabled
        ? await dbGet(
            `UPDATE data_sources SET collection_disabled_at = NOW(), collection_disabled_reason = $2, collection_disabled_by = $3
             WHERE id = $1 RETURNING id`, [sourceId, reason, by])
        : await dbGet(
            `UPDATE data_sources SET collection_disabled_at = NULL, collection_disabled_reason = NULL, collection_disabled_by = NULL
             WHERE id = $1 RETURNING id`, [sourceId]);
    return !!row;
}

/** The refusal columns of a source (null when it has no state row yet). */
async function getRefusal(sourceId) {
    return dbGet(
        `SELECT access_denied_at, access_denied_status, access_denied_kind, refused_until, refusal_count
         FROM source_collection_state WHERE source_id = $1`,
        [sourceId],
    );
}

/**
 * Enter (or extend) the refused state: the n-th consecutive refusal sets a
 * cooldown of min(1 h × 2^(n-1), 24 h), and one critical 'source_refused'
 * alert is opened unless one is already open for the source.
 * @returns {Promise<{ refusal_count: number, refused_until: Date }>}
 */
async function recordRefusal(sourceId, { kind, status = null }, slug) {
    const { COOLDOWN_BASE_MS, COOLDOWN_MAX_MS } = require('./refusal');
    const row = await dbGet(
        `UPDATE source_collection_state
         SET access_denied_at = NOW(),
             access_denied_status = $2::int,
             access_denied_kind = $3::text,
             refused_until = NOW() + make_interval(secs => LEAST($4::float8, $5::float8 * power(2, LEAST(refusal_count, 10)))),
             refusal_count = refusal_count + 1,
             updated_at = NOW()
         WHERE source_id = $1
         RETURNING refusal_count, refused_until`,
        [sourceId, status, kind, COOLDOWN_MAX_MS / 1000, COOLDOWN_BASE_MS / 1000],
    );
    await dbRun(
        `INSERT INTO alert_events (alert_type, severity, source_table, source_id, details)
         SELECT 'source_refused', 'critical', 'data_sources', $1::uuid, $2::jsonb
         WHERE NOT EXISTS (SELECT 1 FROM alert_events
                           WHERE alert_type = 'source_refused' AND source_id = $1::uuid AND resolved_at IS NULL)`,
        [sourceId, JSON.stringify({
            slug, error_kind: kind, http_status: status,
            refusal_count: row ? row.refusal_count : null,
            refused_until: row ? row.refused_until : null,
        })],
    );
    return row;
}

/** Leave the refused state and resolve its open alert, recording why. */
async function clearRefusal(sourceId, resolution) {
    await dbRun(
        `UPDATE source_collection_state
         SET access_denied_at = NULL, access_denied_status = NULL, access_denied_kind = NULL,
             refused_until = NULL, refusal_count = 0, updated_at = NOW()
         WHERE source_id = $1`,
        [sourceId],
    );
    await dbRun(
        `UPDATE alert_events
         SET resolved_at = NOW(), details = COALESCE(details, '{}'::jsonb) || jsonb_build_object('resolution', $2::text)
         WHERE alert_type = 'source_refused' AND source_id = $1::uuid AND resolved_at IS NULL`,
        [sourceId, resolution],
    );
}

module.exports = {
    sourceIdsBySlug, claim, saveOutcome, recordRun, countUnchangedRun, getRefusal, recordRefusal, clearRefusal,
    dbKillSwitch, setDbKillSwitch, CLAIM_SLACK_SEC, CLAIM_SLACK_FRACTION, claimSlackSec,
};
