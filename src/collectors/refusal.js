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
//   after the cooldown      ONE probe run is allowed; another refusal
//                           doubles the cooldown. A successful probe ends
//                           the refused state (the source collects again)
//                           but KEEPS the count: the source is on PROBATION
//                           for 24 h (PROBATION_MS)
//   during probation        a refusal is refusal n+1 (the cooldown keeps
//                           escalating up to 24 h)
//   24 h without a refusal  probation is over: the count decays to 0 (at the
//                           next successful run, or a later refusal counts
//                           as refusal 1 again)
//   manual reset            env SOURCE_<SLUG>_RESET=<ISO date> at or after
//                           the (last) refusal, with its named approval, or
//                           `npm run source:reset -- <slug>` — clears
//                           everything, count and probation too, in the
//                           refused state AND during probation
//
// Probation (diagnosis 2026-09-30, Jennifer: "Probation + log headers
// (Recommended)"; ADR 0001 dated note): one clean probe used to zero the
// count, so a publisher that lets a few requests through before refusing
// again (Pew: bursts of 1–9 runs, then 403) held us at a 1 h cooldown
// forever. The rule is TIME-based, not a run count: 24 h is the cap of the
// cooldown schedule, so any refusal pattern up to once a day escalates to the
// cap, and the rule does not depend on the cadence (a run count would be
// satisfied by a burst — Pew allowed 9 clean runs, 22 minutes, before its
// next 403 — or never be reached while the stack is idle).
//
// Each transition into the refused state writes one critical alert_events
// row (alert_type 'source_refused') unless one is already open — then the
// open alert's details are updated to the current refusal count (an
// escalation). Ending the refused state resolves it.

'use strict';

const HOUR_MS = 3600 * 1000;
const COOLDOWN_BASE_MS = HOUR_MS;
const COOLDOWN_MAX_MS = 24 * HOUR_MS;
const PROBATION_MS = COOLDOWN_MAX_MS;   // 24 h without a refusal decays the count
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
    if (!row) return { state: 'none' };
    if (!row.access_denied_at) {
        // Grumpy #3 (option b): an approved SOURCE_<SLUG>_RESET at or after
        // the last refusal also clears a PROBATION (the count), exactly as
        // it clears the refused state.
        const onProbation = (row.refusal_count || 0) > 0 && !probationOver(row, now);
        return onProbation && row.last_refused_at && envReset(slug, env, row.last_refused_at) ? { state: 'reset' } : { state: 'none' };
    }
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

const ms = v => (v ? new Date(v).getTime() : NaN);

/**
 * Whether the refusal count has decayed: the source is not refused and not
 * inside its probation window (24 h after its successful probe). A count
 * left with no probation time (a row written before migration 062) has
 * decayed too. The same rule is PRIOR_COUNT_SQL / decayRefusal in state.js;
 * tests/integration/collect.refusal.test.js pins the two together.
 * @param {object|null} row  source_collection_state
 */
function probationOver(row, now = Date.now()) {
    if (!row || row.access_denied_at) return false;
    if (!row.probation_until) return true;
    return now >= ms(row.probation_until);
}

/** From the run's classified route errors: the refusal, or null. */
function refusalOf(classified) {
    const hit = (classified || []).find(c => c && REFUSED_KINDS.includes(c.error_kind));
    return hit ? { kind: hit.error_kind, status: hit.http_status } : null;
}

module.exports = {
    BLOCKED_BY_SOURCE, REFUSED_KINDS, COOLDOWN_BASE_MS, COOLDOWN_MAX_MS, PROBATION_MS,
    resetEnv, cooldownMs, envReset, refusalGate, refusalOf, probationOver,
};
