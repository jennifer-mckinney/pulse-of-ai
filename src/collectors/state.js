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
//   getRefusal / recordRefusal / endCooldown / decayRefusal / clearRefusal
//       the refused state and its probation (F10-5, migrations 018 and
//       062; src/collectors/refusal.js has the rules)
//   routeKillSwitches / allRouteKillSwitches / setRouteKillSwitch
//       the per-route database kill switch (migration 073)

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
             -- P10-8 (migration 033): when a NEW post was last stored.
             last_new_post_at = CASE WHEN COALESCE($6::int, 0) > 0 THEN NOW() ELSE last_new_post_at END,
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

/**
 * `responseHeaders`: the allow-listed, scrubbed headers of a refusal
 * (migration 062); null on every other run.
 * `dropped`: the collector's dropped counters summed over the run's routes,
 * { invalid, old, outOfScope, duplicate } (migration 068, relevance-accuracy
 * R1); counts only. `dropped: null` (a run that evaluated no item: gate
 * closed, skipped, refused, failed, or every route returned nothing) stores NULL,
 * never a fake 0; so does every row from before the migration. Within an
 * object, a missing key is 0.
 */
async function recordRun({
    sourceId, jobId, gateStatus, outcome, itemsFetched = 0, postsNew = 0, requests = 0,
    error = null, errorKind = null, httpStatus = null, startedAt, responseHeaders = null, dropped = null,
}) {
    const headers = responseHeaders && Object.keys(responseHeaders).length ? JSON.stringify(responseHeaders) : null;
    const d = (k) => (dropped == null ? null : (Number.isInteger(dropped[k]) && dropped[k] >= 0 ? dropped[k] : 0));
    await dbRun(
        `INSERT INTO source_runs
            (source_id, job_id, gate_status, outcome, items_fetched, posts_new, requests, error, error_kind, http_status,
             started_at, finished_at, response_headers,
             dropped_invalid, dropped_old, dropped_out_of_scope, dropped_duplicate)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12::jsonb, $13, $14, $15, $16)`,
        [sourceId, jobId, gateStatus, outcome, itemsFetched, postsNew, requests, error,
            error ? errorKind : null, error ? httpStatus : null, startedAt || new Date(), headers,
            d('invalid'), d('old'), d('outOfScope'), d('duplicate')],
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

/**
 * Set (disabled=true) or clear the database kill switch.
 * PR #22 L6 / L16: pass `client` to write it in the caller's transaction,
 * together with its source_gate_events row (scripts/source-admin.js).
 * @returns {Promise<boolean>} whether a row changed
 */
async function setDbKillSwitch(sourceId, disabled, { reason = null, by = null, client = null } = {}) {
    const [sql, params] = disabled
        ? [`UPDATE data_sources SET collection_disabled_at = NOW(), collection_disabled_reason = $2, collection_disabled_by = $3
             WHERE id = $1 RETURNING id`, [sourceId, reason, by]]
        : [`UPDATE data_sources SET collection_disabled_at = NULL, collection_disabled_reason = NULL, collection_disabled_by = NULL
             WHERE id = $1 RETURNING id`, [sourceId]];
    const row = client ? (await client.query(sql, params)).rows[0] : await dbGet(sql, params);
    return !!row;
}

// ─── Per-route kill switch (migration 073) ──────────────────────────────────
// The database switch of ONE route of a source (source_route_state). The
// route id is validated against the registry by the caller
// (scripts/source-admin.js); the table's CHECK is a second line.

const ROUTE_KILL_COLUMNS = `route_id, collection_disabled_at AS disabled_at, collection_disabled_reason AS reason,
                collection_disabled_by AS by`;

/**
 * The disabled routes of a source.
 * @returns {Promise<Array<{ route_id, disabled_at, reason, by }>>} [] when none
 */
async function routeKillSwitches(sourceId) {
    return (await dbAll(
        `SELECT ${ROUTE_KILL_COLUMNS} FROM source_route_state
         WHERE source_id = $1 AND collection_disabled_at IS NOT NULL ORDER BY route_id`,
        [sourceId],
    )) || [];
}

/**
 * Every disabled route, by source id (status, governance and health read
 * all sources at once).
 * @returns {Promise<Map<string, Array<{ route_id, disabled_at, reason, by }>>>}
 */
async function allRouteKillSwitches() {
    const rows = (await dbAll(
        `SELECT source_id, ${ROUTE_KILL_COLUMNS} FROM source_route_state
         WHERE collection_disabled_at IS NOT NULL ORDER BY source_id, route_id`,
    )) || [];
    const out = new Map();
    for (const { source_id: id, ...k } of rows) {
        if (!out.has(id)) out.set(id, []);
        out.get(id).push(k);
    }
    return out;
}

/**
 * Set (disabled=true) or clear the database kill switch of one route.
 * Pass `client` to write it in the caller's transaction, together with its
 * source_gate_events row (scripts/source-admin.js; PR #22 L6 / L16).
 * @returns {Promise<boolean>} whether a row changed (clearing a route that
 *   was never disabled changes nothing)
 */
async function setRouteKillSwitch(sourceId, routeId, disabled, { reason = null, by = null, client = null } = {}) {
    // Copilot round 2: the database CHECK of migration 073 accepts a NULL
    // approver (a NULL regex result passes a CHECK). Until a follow-up
    // migration closes that, the write path refuses it here: a takedown
    // always records why and the named approval behind it.
    if (disabled) {
        const { namedApproval } = require('../config/source-registry');
        if (typeof reason !== 'string' || !reason.trim()) throw new Error('a route takedown needs a reason');
        if (!namedApproval({ GATE_APPROVED_BY: by }).ok) throw new Error('a route takedown needs a named approval ("Name YYYY-MM-DD") as `by`');
    }
    const [sql, params] = disabled
        ? [`INSERT INTO source_route_state (source_id, route_id, collection_disabled_at, collection_disabled_reason, collection_disabled_by, updated_at)
            VALUES ($1, $2, NOW(), $3, $4, NOW())
            ON CONFLICT (source_id, route_id) DO UPDATE
            SET collection_disabled_at = NOW(), collection_disabled_reason = EXCLUDED.collection_disabled_reason,
                collection_disabled_by = EXCLUDED.collection_disabled_by, updated_at = NOW()
            RETURNING route_id`, [sourceId, routeId, reason, by]]
        : [`UPDATE source_route_state
            SET collection_disabled_at = NULL, collection_disabled_reason = NULL, collection_disabled_by = NULL, updated_at = NOW()
            WHERE source_id = $1 AND route_id = $2 AND collection_disabled_at IS NOT NULL
            RETURNING route_id`, [sourceId, routeId]];
    const row = client ? (await client.query(sql, params)).rows[0] : await dbGet(sql, params);
    return !!row;
}

/** The refusal columns of a source (null when it has no state row yet). */
async function getRefusal(sourceId) {
    return dbGet(
        `SELECT access_denied_at, access_denied_status, access_denied_kind, refused_until, refusal_count, probation_until,
                last_refused_at
         FROM source_collection_state WHERE source_id = $1`,
        [sourceId],
    );
}

// The count a new refusal continues from: the stored count while the source
// is refused or on probation, else 0 (probation over — 24 h without a
// refusal; refusal.js probationOver is the same rule in JS). In an UPDATE
// every expression reads the row as it was before the update.
const PRIOR_COUNT_SQL = `(CASE WHEN access_denied_at IS NULL AND (probation_until IS NULL OR probation_until <= NOW())
                               THEN 0 ELSE refusal_count END)`;

/**
 * Enter (or extend) the refused state: the n-th refusal of an episode (the
 * count continues through probation, refusal.js) sets a cooldown of
 * min(1 h × 2^(n-1), 24 h). One critical 'source_refused' alert is opened
 * unless one is already open for the source; an open one is updated to the
 * current count (an escalation), so it never understates the refusal.
 * @param {{ kind: string, status?: number|null, headers?: object|null }} refusal
 *        headers: the allow-listed, scrubbed response headers (http.js refusalHeaders)
 * @returns {Promise<{ refusal_count: number, refused_until: Date, alert: 'opened'|'escalated'|null }>}
 */
async function recordRefusal(sourceId, { kind, status = null, headers = null }, slug) {
    const { COOLDOWN_BASE_MS, COOLDOWN_MAX_MS } = require('./refusal');
    const saved = headers && Object.keys(headers).length ? headers : null;
    const row = await dbGet(
        `UPDATE source_collection_state
         SET access_denied_at = NOW(),
             access_denied_status = $2::int,
             access_denied_kind = $3::text,
             refused_until = NOW() + make_interval(secs => LEAST($4::float8, $5::float8 * power(2, LEAST(${PRIOR_COUNT_SQL}, 10)))),
             refusal_count = ${PRIOR_COUNT_SQL} + 1,
             probation_until = NULL,
             last_refused_at = NOW(),
             access_denied_headers = $6::jsonb,
             updated_at = NOW()
         WHERE source_id = $1
         RETURNING refusal_count, refused_until, access_denied_at`,
        [sourceId, status, kind, COOLDOWN_MAX_MS / 1000, COOLDOWN_BASE_MS / 1000, saved ? JSON.stringify(saved) : null],
    );
    // Security L1 / grumpy #7: response_headers is ALWAYS set (null when
    // this refusal has none, e.g. robots), so an escalated alert never
    // shows the headers of an earlier refusal as if they were this one's.
    const details = {
        slug, error_kind: kind, http_status: status,
        refusal_count: row ? row.refusal_count : null,
        refused_until: row ? row.refused_until : null,
        response_headers: saved,
    };
    // P1-6: atomic one-open-alert rule (migration 038).
    const alerts = require('./source-alerts');
    let alert = null;
    if (await alerts.openSourceAlert('source_refused', 'critical', sourceId, { ...details, opened_refusal_count: details.refusal_count })) {
        alert = 'opened';
    } else if (row && await alerts.escalateSourceAlert('source_refused', sourceId, { ...details, last_refused_at: row.access_denied_at })) {
        alert = 'escalated';
    }
    return row ? { refusal_count: row.refusal_count, refused_until: row.refused_until, alert } : row;
}

/**
 * A probe after the cooldown succeeded: leave the refused state (the source
 * collects again, its alert is resolved) but KEEP the refusal count — the
 * source is on probation until NOW() + PROBATION_MS (refusal.js). A refusal
 * during probation continues the count.
 *
 * Security M1 / grumpy #2: guarded on the refusal the probe was run for
 * (`probedDeniedAt`, the access_denied_at read before the run). If another
 * run recorded a NEWER refusal meanwhile, nothing is changed and no alert is
 * resolved — a stale success never clears a fresh refusal.
 * @returns {Promise<{ refusal_count: number, probation_until: Date }|null>} null when the guard did not match
 */
async function endCooldown(sourceId, probedDeniedAt) {
    const { PROBATION_MS } = require('./refusal');
    const row = await dbGet(
        `UPDATE source_collection_state
         SET access_denied_at = NULL, access_denied_status = NULL, access_denied_kind = NULL,
             refused_until = NULL, access_denied_headers = NULL,
             probation_until = NOW() + make_interval(secs => $2::float8), updated_at = NOW(),
             -- Grumpy final #4: a row refused before migration 062 has no
             -- last_refused_at (062 adds it without a backfill, rewriting no
             -- row). Carry the refusal time over (the right-hand side reads
             -- the PRE-update access_denied_at), so an approved
             -- SOURCE_<SLUG>_RESET can clear this probation like any other.
             last_refused_at = COALESCE(last_refused_at, access_denied_at)
         -- JS Dates hold milliseconds, timestamptz microseconds: match the
         -- probed refusal within 1 ms (a newer refusal is a later run,
         -- whole seconds apart).
         WHERE source_id = $1 AND access_denied_at IS NOT NULL
           AND abs(extract(epoch FROM access_denied_at - $3::timestamptz)) < 0.001
         RETURNING refusal_count, probation_until`,
        [sourceId, PROBATION_MS / 1000, probedDeniedAt],
    );
    // Grumpy #9: resolve only when this call actually ended the cooldown.
    if (!row) return null;
    const n = row.refusal_count;
    const until = new Date(row.probation_until).toISOString();
    await require('./source-alerts').resolveSourceAlert('source_refused', sourceId, {
        resolvedBy: 'refusal state (src/collectors/state.js endCooldown)',
        resolution: `a probe run after the cooldown succeeded; on probation until ${until}`
            + ` (refusal count ${n} kept: a refusal before then continues it, 24 h without one decays it)`,
        basis: { cleared: true, probation: true, refusal_count: n, probation_until: until },
    });
    return row;
}

/**
 * Probation over (24 h without a refusal): the refusal count decays to 0.
 * A no-op unless the source is not refused, has a count and its probation
 * has ended.
 * @returns {Promise<boolean>} whether the count was reset
 */
async function decayRefusal(sourceId) {
    const row = await dbGet(
        `UPDATE source_collection_state
         SET refusal_count = 0, probation_until = NULL, last_refused_at = NULL, updated_at = NOW()
         WHERE source_id = $1 AND access_denied_at IS NULL AND refusal_count > 0
           AND (probation_until IS NULL OR probation_until <= NOW())
         RETURNING source_id`,
        [sourceId],
    );
    return !!row;
}

/**
 * Leave the refused state completely (a manual reset: env or
 * npm run source:reset) — count and probation too — and resolve its open
 * alert, recording why.
 */
async function clearRefusal(sourceId, resolution, { client = null } = {}) {
    const sql = `UPDATE source_collection_state
         SET access_denied_at = NULL, access_denied_status = NULL, access_denied_kind = NULL,
             refused_until = NULL, refusal_count = 0, probation_until = NULL, access_denied_headers = NULL,
             last_refused_at = NULL,
             updated_at = NOW()
         WHERE source_id = $1`;
    if (client) await client.query(sql, [sourceId]);
    else await dbRun(sql, [sourceId]);
    // P1-6: resolved with an audited alert_resolutions record (in the
    // caller's transaction when one is given — PR #22 L16).
    await require('./source-alerts').resolveSourceAlert('source_refused', sourceId, {
        resolvedBy: 'refusal state (src/collectors/state.js clearRefusal)', resolution, basis: { cleared: true },
    }, client);
}

module.exports = {
    sourceIdsBySlug, claim, saveOutcome, recordRun, countUnchangedRun, getRefusal, recordRefusal, clearRefusal,
    endCooldown, decayRefusal,
    dbKillSwitch, setDbKillSwitch, routeKillSwitches, allRouteKillSwitches, setRouteKillSwitch, CLAIM_SLACK_SEC, CLAIM_SLACK_FRACTION, claimSlackSec,
};
