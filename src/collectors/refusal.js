// src/collectors/refusal.js
// The refused state (F10-5, ADR 0001 ruling 5: a refusal is "NEVER retried
// and never worked around" — per SOURCE, across runs, not only per request).
//
// A run whose routes were refused (AccessDeniedError: 401 / 403 / 451 or a
// bot challenge; RobotsDisallowedError) puts the source in the refused state
// (source_collection_state, migration 018):
//
//   refusal n (1, 2, 3, …)  cooldown = min(1 h × 2^(n-1), 24 h)
//   during the cooldown     the runner skips the source: status
//                           'blocked_by_source', no request is made
//   after the cooldown      ONE probe run is allowed; success clears the
//                           state, another refusal doubles the cooldown
//   manual reset            env SOURCE_<SLUG>_RESET=<ISO date> newer than
//                           the refusal, or `npm run source:reset -- <slug>`
//
// Each transition into the refused state writes one critical alert_events
// row (alert_type 'source_refused') unless one is already open; clearing the
// state resolves it.

'use strict';

const HOUR_MS = 3600 * 1000;
const COOLDOWN_BASE_MS = HOUR_MS;
const COOLDOWN_MAX_MS = 24 * HOUR_MS;
const REFUSED_KINDS = Object.freeze(['access_denied', 'robots']);
const BLOCKED_BY_SOURCE = 'blocked_by_source';

/** Env name of the manual reset: SOURCE_<SLUG>_RESET. */
function resetEnv(slug) {
    return `SOURCE_${slug.toUpperCase()}_RESET`;
}

/** Cooldown after the n-th consecutive refusal (n >= 1). */
function cooldownMs(n) {
    const k = Math.max(1, Math.floor(n || 1));
    return Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** Math.min(k - 1, 10));
}

/** Whether the env holds a reset date at or after a refusal recorded at deniedAt. */
function envResetDate(slug, env, deniedAt) {
    const v = env && env[resetEnv(slug)];
    if (typeof v !== 'string' || !v.trim()) return false;
    const t = Date.parse(v.trim());
    return Number.isFinite(t) && !!deniedAt && t >= new Date(deniedAt).getTime();
}

/**
 * Whether an env reset date clears a refusal recorded at deniedAt. PR #22
 * decision G5 / security L6: a reset re-opens a refused source, so it also
 * needs a named approval (GATE_APPROVED_BY), the recorded actor of its
 * 'refusal_reset' gate event. Without one the refusal stands.
 */
function envReset(slug, env, deniedAt) {
    const { namedApproval } = require('../config/source-registry');
    return envResetDate(slug, env, deniedAt) && namedApproval(env || {}).ok;
}

/**
 * The refusal gate for one source.
 * @param {object|null} row  source_collection_state (access_denied_at, refused_until, access_denied_status, refusal_count)
 * @returns {{ state: 'none'|'reset'|'cooldown'|'probe', reason?: string, until?: string }}
 */
function refusalGate(row, slug, env = process.env, now = Date.now()) {
    if (!row || !row.access_denied_at) return { state: 'none' };
    if (envReset(slug, env, row.access_denied_at)) return { state: 'reset' };
    const until = row.refused_until ? new Date(row.refused_until).getTime() : 0;
    const status = row.access_denied_status ? `HTTP ${row.access_denied_status}` : (row.access_denied_kind === 'robots' ? 'robots.txt' : 'access denied');
    const held = envResetDate(slug, env, row.access_denied_at)
        ? `; ${resetEnv(slug)} is set but awaiting named approval (GATE_APPROVED_BY "Name YYYY-MM-DD")` : '';
    const reason = `the source refused access (${status}) at ${new Date(row.access_denied_at).toISOString()}`
        + ` — refusal ${row.refusal_count || 1}; reset with ${resetEnv(slug)}=<date> or npm run source:reset -- ${slug}${held}`;
    if (now < until) return { state: 'cooldown', reason: `${reason}; cooldown until ${new Date(until).toISOString()}`, until: new Date(until).toISOString() };
    return { state: 'probe', reason };
}

/** From the run's classified route errors: the refusal, or null. */
function refusalOf(classified) {
    const hit = (classified || []).find(c => c && REFUSED_KINDS.includes(c.error_kind));
    return hit ? { kind: hit.error_kind, status: hit.http_status } : null;
}

module.exports = {
    BLOCKED_BY_SOURCE, REFUSED_KINDS, COOLDOWN_BASE_MS, COOLDOWN_MAX_MS,
    resetEnv, cooldownMs, envReset, refusalGate, refusalOf,
};
