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
//   manual reset            env SOURCE_<SLUG>_RESET=<date> at or after
//                           the (last) refusal AND not in the future (both
//                           bounds inclusive), with its named approval, or
//                           `npm run source:reset -- <slug>` — clears
//                           everything, count and probation too, in the
//                           refused state AND during probation. <date> is
//                           YYYY-MM-DD (00:00 UTC of that day, never the
//                           host's local time) or an ISO 8601 date-time
//                           with Z or an offset; see resetDate below
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

// The accepted SOURCE_<SLUG>_RESET forms (grumpy final #1). Date.parse alone
// is host-dependent: it reads a zone-less date-time in the host's LOCAL time
// zone, so the same value would mean different instants on different hosts.
//   YYYY-MM-DD                         00:00 UTC of that day (never local time)
//   YYYY-MM-DDThh:mm[:ss[.sss]]Z       an ISO 8601 date-time in UTC, or
//   YYYY-MM-DDThh:mm[:ss[.sss]]±hh:mm  with an explicit offset
// Anything else (a zone-less date-time, an impossible date such as
// 2026-02-30, free text) is not a reset date and is ignored, with a reason.
const RESET_DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const RESET_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i;
const RESET_FORMS = 'YYYY-MM-DD, read as 00:00 UTC, or an ISO 8601 date-time with Z or an offset';

/**
 * The instant (epoch ms) a SOURCE_<SLUG>_RESET value names, or null when it
 * is not one of the accepted forms above.
 * @param {string} value
 * @returns {number|null}
 */
function resetDate(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    const dateOnly = v.match(RESET_DATE_ONLY);
    const m = dateOnly || v.match(RESET_DATE_TIME);
    if (!m) return null;
    // Reject impossible calendar dates (Date.UTC would roll 02-30 into March).
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const day = new Date(Date.UTC(y, mo - 1, d));
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) return null;
    const t = dateOnly ? day.getTime() : Date.parse(v.toUpperCase());
    return Number.isFinite(t) ? t : null;
}

/**
 * The env reset for a refusal recorded at deniedAt, judged at `now`:
 *   'unset'   no value
 *   'invalid' not an accepted reset date
 *   'before'  older than the refusal (it was set for an earlier refusal)
 *   'future'  later than now: ignored until then (grumpy final #1 — a
 *             future date would otherwise also "reset" every refusal
 *             recorded before it, so the source was re-requested on every
 *             poll right after refusing, against ADR 0001 ruling 5)
 *   'valid'   at or after the refusal and not after now (both inclusive)
 * @returns {{ status: string, at?: number }}
 */
function envResetStatus(slug, env, deniedAt, now = Date.now()) {
    const v = env && env[resetEnv(slug)];
    if (typeof v !== 'string' || !v.trim()) return { status: 'unset' };
    const t = resetDate(v);
    if (t === null) return { status: 'invalid' };
    if (!deniedAt || t < new Date(deniedAt).getTime()) return { status: 'before', at: t };
    if (t > now) return { status: 'future', at: t };
    return { status: 'valid', at: t };
}

/**
 * Whether an env reset date clears a refusal recorded at deniedAt. PR #22
 * decision G5 / security L6: a reset re-opens a refused source, so it also
 * needs a named approval (GATE_APPROVED_BY), the recorded actor of its
 * 'refusal_reset' gate event. Without one the refusal stands.
 */
function envReset(slug, env, deniedAt, now = Date.now()) {
    const { namedApproval } = require('../config/source-registry');
    return envResetStatus(slug, env, deniedAt, now).status === 'valid' && namedApproval(env || {}).ok;
}

/** Why an env reset that is set did not clear the refusal ('' when nothing to say). */
function envResetNote(slug, reset) {
    const name = resetEnv(slug);
    if (reset.status === 'invalid') return `; ${name} is not a valid reset date (${RESET_FORMS}) and is ignored`;
    if (reset.status === 'future') return `; ${name} (${new Date(reset.at).toISOString()}) is in the future and is ignored until then`;
    if (reset.status === 'valid') return `; ${name} is set but awaiting named approval (GATE_APPROVED_BY "Name YYYY-MM-DD")`;
    return '';
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
        // the last refusal (and not in the future) also clears a PROBATION
        // (the count), exactly as it clears the refused state.
        const onProbation = (row.refusal_count || 0) > 0 && !probationOver(row, now);
        return onProbation && row.last_refused_at && envReset(slug, env, row.last_refused_at, now) ? { state: 'reset' } : { state: 'none' };
    }
    if (envReset(slug, env, row.access_denied_at, now)) return { state: 'reset' };
    const until = row.refused_until ? new Date(row.refused_until).getTime() : 0;
    const status = row.access_denied_status ? `HTTP ${row.access_denied_status}` : (row.access_denied_kind === 'robots' ? 'robots.txt' : 'access denied');
    // Why a set SOURCE_<SLUG>_RESET did not apply: not a valid date, in the
    // future, or valid but awaiting its named approval.
    const held = envResetNote(slug, envResetStatus(slug, env, row.access_denied_at, now));
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
    resetEnv, resetDate, cooldownMs, envReset, refusalGate, refusalOf, probationOver,
};
