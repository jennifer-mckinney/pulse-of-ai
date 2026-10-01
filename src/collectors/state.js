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
//   loadHolds / saveHolds
//       per-host rate-limit holds — a backoff, never a refusal (diagnosis
//       2026-10-01, migration 075; src/collectors/rate-limit.js has the rules)

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
 */
async function recordRun({
    sourceId, jobId, gateStatus, outcome, itemsFetched = 0, postsNew = 0, requests = 0,
    error = null, errorKind = null, httpStatus = null, startedAt, responseHeaders = null,
}) {
    const headers = responseHeaders && Object.keys(responseHeaders).length ? JSON.stringify(responseHeaders) : null;
    await dbRun(
        `INSERT INTO source_runs
            (source_id, job_id, gate_status, outcome, items_fetched, posts_new, requests, error, error_kind, http_status,
             started_at, finished_at, response_headers)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW(), $12::jsonb)`,
        [sourceId, jobId, gateStatus, outcome, itemsFetched, postsNew, requests, error,
            error ? errorKind : null, error ? httpStatus : null, startedAt || new Date(), headers],
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

/**
 * Diagnosis 2026-10-01 / security F5: every stored rate-limit hold, merged
 * per host across sources (the later until, the longer streak), so a host
 * held for one source is held for every source — and the governance terms
 * fetch — that contacts it.
 * @returns {Promise<object>} { hostname: hold } (rate-limit.js sanitizeHolds)
 */
async function loadHolds() {
    const { mergeHolds } = require('./rate-limit');
    const rows = await dbAll(
        `SELECT rate_limited_hosts FROM source_collection_state WHERE rate_limited_hosts <> '{}'::jsonb`);
    const out = {};
    for (const r of rows) mergeHolds(out, r.rate_limited_hosts);
    return out;
}

/**
 * Store a source's rate-limit holds (src/collectors/rate-limit.js), per host
 * (grumpy #10: never a blind overwrite of the whole map). Under a row lock:
 *   - a host this run CHANGED takes the run's entry — unless the stored one
 *     holds longer (a concurrent run's newer limit wins) — or is removed
 *     when the run's success cleared it (null);
 *   - a host of the source that this run did not change takes the shared
 *     client view (`view`) when that holds longer (another source on the
 *     same host was limited), else keeps what is stored;
 *   - stale streaks are dropped (sanitizeHolds).
 * rate_limited_until = when the LAST active hold passes (NULL when none);
 * rate_limited_routes = the routes the worker found held ({ id: until },
 * grumpy #2 — /api/sources reads it, never recomputing hosts from the web
 * process's env). When this run hit a NEW rate limit (`limited`), its
 * allow-listed, scrubbed response headers and the time are recorded too.
 * Never touches the refused state (refusal count, probation,
 * access_denied_*) and opens no alert: a rate limit is a backoff.
 * @param {string} sourceId
 * @param {{ hosts: string[], changes?: Map, view?: object, routes?: object,
 *           limited?: boolean, headers?: object|null }} o
 */
async function saveHolds(sourceId, { hosts, changes = new Map(), view = {}, routes = {}, limited = false, headers = null }) {
    const rl = require('./rate-limit');
    const { dbTransaction } = require('../db/connection');
    const now = Date.now();
    await dbTransaction(async (client) => {
        // A source skipped before its first claim has no state row yet.
        await client.query('INSERT INTO source_collection_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [sourceId]);
        const cur = await client.query(
            'SELECT rate_limited_hosts FROM source_collection_state WHERE source_id = $1 FOR UPDATE', [sourceId]);
        if (!cur.rows.length) return;
        const stored = rl.sanitizeHolds(cur.rows[0].rate_limited_hosts, now);
        const viewClean = rl.sanitizeHolds(view, now);
        const later = (a, b) => (a && (!b || Date.parse(a.until) > Date.parse(b.until)) ? a : b);
        const cleared = [];
        for (const host of hosts) {
            if (changes.has(host)) {
                const next = changes.get(host);
                if (next === null) {
                    // Grumpy N5: a success clears the host — but never a newer
                    // hold another process stored meanwhile (still in force).
                    if (!stored[host] || Date.parse(stored[host].until) <= now) {
                        delete stored[host];
                        cleared.push(host);
                    }
                } else {
                    stored[host] = later(stored[host], rl.sanitizeHolds({ [host]: next }, now)[host]) || stored[host];
                }
            } else if (viewClean[host]) {
                stored[host] = later(viewClean[host], stored[host]);
            }
        }
        // Copilot review: a host's streak is ONE streak — a success clears its
        // expired copies on every other source's row too, or the next run's
        // merge would bring the old streak back (an active hold is kept).
        for (const host of cleared) {
            const others = await client.query(
                `SELECT source_id, rate_limited_hosts -> $2::text AS hold FROM source_collection_state
                 WHERE source_id <> $1 AND rate_limited_hosts ? $2::text`,
                [sourceId, host],
            );
            for (const o of others.rows) {
                const until = Date.parse(o.hold && o.hold.until);
                if (Number.isFinite(until) && until > now) continue;
                // Optimistic: only if that copy is still the one read here.
                await client.query(
                    `UPDATE source_collection_state SET rate_limited_hosts = rate_limited_hosts - $2::text, updated_at = NOW()
                     WHERE source_id = $1 AND rate_limited_hosts -> $2::text = $3::jsonb`,
                    [o.source_id, host, JSON.stringify(o.hold)],
                );
            }
        }
        const active = Object.values(rl.activeHolds(stored, now)).map(h => h.until).sort();
        const saved = headers && Object.keys(headers).length ? JSON.stringify(headers) : null;
        await client.query(
            `UPDATE source_collection_state
             SET rate_limited_hosts  = $2::jsonb,
                 rate_limited_until  = $3::timestamptz,
                 rate_limited_routes = $4::jsonb,
                 rate_limited_at     = CASE WHEN $5::boolean THEN NOW() ELSE rate_limited_at END,
                 rate_limit_headers  = CASE WHEN $5::boolean THEN $6::jsonb ELSE rate_limit_headers END,
                 updated_at = NOW()
             WHERE source_id = $1`,
            [sourceId, JSON.stringify(stored), active.length ? active[active.length - 1] : null, JSON.stringify(routes || {}),
                limited, saved],
        );
    });
}

/**
 * Grumpy N2: persist the hold changes of an HTTP client used OUTSIDE the
 * runner (the governance terms fetch, Reddit maintenance) on every source
 * whose hosts — its routes' hosts and its terms page's host — include a
 * changed host, so the next run honours them (and a success clears them).
 * @param {Map} changes  http.drainHoldChanges()
 * @param {object} view  the client's holds map
 */
async function saveHoldChanges(changes, view, { env = process.env } = {}) {
    if (!changes || !changes.size) return;
    const rl = require('./rate-limit');
    const { SOURCES } = require('../config/source-registry');
    const ids = await sourceIdsBySlug(SOURCES.map(s => s.slug));
    for (const src of SOURCES) {
        const hosts = new Set(rl.sourceHosts(src, env));
        const terms = rl.hostOf(src.termsUrl);
        if (terms) hosts.add(terms);
        const mine = [...changes.keys()].filter(h => hosts.has(h));
        const id = ids.get(src.slug);
        if (!mine.length || !id) continue;
        await saveHolds(id, { hosts: mine, changes, view, routes: rl.holdGate(src, env, view, Date.now()).routes });
    }
}

module.exports = {
    sourceIdsBySlug, claim, saveOutcome, recordRun, countUnchangedRun, getRefusal, recordRefusal, clearRefusal,
    endCooldown, decayRefusal, loadHolds, saveHolds, saveHoldChanges,
    dbKillSwitch, setDbKillSwitch, CLAIM_SLACK_SEC, CLAIM_SLACK_FRACTION, claimSlackSec,
};
