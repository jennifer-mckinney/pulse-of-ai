// src/collectors/source-health.js
// Source-health evaluator (PR #10 review P10-8). Run by the worker on
// every 30 s tick of src/workers/start.js closeDueCycles, after
// closeCycles, whether or not a cycle closed on that tick (a tick still
// running makes the next one skip). For every registry source that is
// COLLECTING (gate open, no database kill switch) and has a
// collection-state row:
//
//   source_stale    warning   no NEW post for longer than the registry's
//                             expectedNewWithinHours (reference:
//                             last_new_post_at, else the row's FIXED
//                             freshness_anchor_at — migration 037, PR #22
//                             P0-2; never last_success_at, which every
//                             successful run refreshes, so a feed answering
//                             200 with nothing new goes stale)
//   source_failing  warning   FAILING_AFTER (3) or more consecutive failed
//                             runs
//   source_rate_limited  warning  a host of the source rate-limited it
//                             RATE_LIMITED_WARN_AFTER (3) times in a row
//                             (rate_limited_hosts streak, migration 075;
//                             diagnosis 2026-10-01 — never critical, never
//                             a refusal); resolved by the host's next success
//   source_refused  critical  the source refused access (F10-5); normally
//                             opened by state.recordRefusal — the evaluator
//                             only makes sure it exists
//
// One OPEN alert per (type, source) at most, enforced by a unique partial
// index (migration 038; src/collectors/source-alerts.js); each is RESOLVED
// (resolved_at, details.resolution, and an alert_resolutions record) as soon
// as its condition clears, or when the source
// stops collecting (killed or closed: not a health problem of the source).
// Nothing is deleted.

'use strict';

const { dbAll } = require('../db/connection');
const { openSourceAlert, resolveSourceAlert } = require('./source-alerts');
const { getSource, sourceStatus } = require('../config/source-registry');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');

const FAILING_AFTER = 3;
// Grumpy #5 (diagnosis 2026-10-01): a host of the source rate-limited this
// many times in a row (rate-limit.js WARN_AFTER; the streak resets on its
// first success). A run whose OTHER routes succeed is 'ok', so
// consecutive_failures never sees persistent throttling of one host.
const { WARN_AFTER: RATE_LIMITED_WARN_AFTER, sanitizeHolds, collectionHolds, CONFIGURED_HOST } = require('./rate-limit');
const TYPES = Object.freeze(['source_stale', 'source_failing', 'source_refused', 'source_rate_limited']);

/**
 * The hosts whose streak reached the warning threshold, as they may be
 * published (security F3: a host the registry names, else "configured host").
 */
function throttledHosts(row, src, now, { env = null, routeKills = [] } = {}) {
    const { routeAllowedHosts, openRoutes } = require('../config/source-registry');
    const registry = new Set(src.routes.flatMap(r => routeAllowedHosts(r, {})));
    // Copilot review: only hosts of the routes that are open NOW (env, missing
    // configuration, database route kills): a closed route's host can never
    // answer successfully to resolve the warning.
    const live = env ? new Set(openRoutes(src, env, { routeKills }).flatMap(r => routeAllowedHosts(r, env))) : null;
    // A throttled terms page is not the source being rate-limited.
    const hit = Object.entries(sanitizeHolds(collectionHolds(src, row.rate_limited_hosts), now))
        .filter(([host, h]) => h.count >= RATE_LIMITED_WARN_AFTER && (!live || live.has(host)));
    return {
        hosts: [...new Set(hit.map(([host]) => (registry.has(host) ? host : CONFIGURED_HOST)))].sort(),
        max_count: hit.reduce((m, [, h]) => Math.max(m, h.count), 0),
    };
}

/**
 * Why an open alert of `type` is being resolved (the audited resolution text).
 * Copilot review: a source_rate_limited alert whose throttled route simply
 * CLOSED (disabled, unconfigured) was not cleared by a host answering — say so.
 */
function resolutionWhy(type, collecting, row, src, now = Date.now()) {
    if (!collecting) return 'the source is no longer collecting (closed or switched off)';
    if (type === 'source_stale') return 'a new post was stored';
    if (type === 'source_failing') return 'a run succeeded';
    if (type === 'source_rate_limited') {
        return throttledHosts(row, src, now).hosts.length
            ? 'the throttled host\'s route is no longer open (disabled or unconfigured); no host answered — the streak is unchanged'
            : 'the rate-limited host answered successfully';
    }
    return 'the refusal cleared';
}

/**
 * Pure: which conditions hold for one source row.
 * @param {{ env?: object, routeKills?: object[] }} [live]  the env and database route kills
 *   (the open routes decide which throttled hosts count)
 */
function conditionsFor(row, src, now = Date.now(), live = {}) {
    const out = {};
    const hours = src.expectedNewWithinHours;
    // P0-2: a fixed anchor, never a time that moves with each run.
    const ref = row.last_new_post_at || row.freshness_anchor_at;
    if (hours > 0 && ref && row.last_attempt_at) {
        const ageH = (now - new Date(ref).getTime()) / 3600000;
        if (ageH > hours) {
            out.source_stale = { severity: 'warning', hours_without_new_posts: Math.round(ageH * 10) / 10, expected_within_hours: hours,
                last_new_post_at: row.last_new_post_at || null };
        }
    }
    if ((row.consecutive_failures || 0) >= FAILING_AFTER) {
        out.source_failing = { severity: 'warning', consecutive_failures: row.consecutive_failures,
            last_error_kind: row.last_error_kind || null, last_http_status: row.last_http_status || null };
    }
    const throttled = throttledHosts(row, src, now, live);
    if (throttled.hosts.length) {
        out.source_rate_limited = { severity: 'warning', hosts: throttled.hosts, max_count: throttled.max_count };
    }
    if (row.access_denied_at) {
        out.source_refused = { severity: 'critical', error_kind: row.access_denied_kind || null,
            http_status: row.access_denied_status || null, refused_until: row.refused_until || null,
            refusal_count: row.refusal_count || null };
    }
    return out;
}

/**
 * @param {{ env?: object, now?: number }} [o]
 * @returns {Promise<{ opened: Array<{slug,type}>, resolved: Array<{slug,type}> }>}
 */
async function evaluateSourceHealth({ env = process.env, now = Date.now() } = {}) {
    const rows = await dbAll(
        `SELECT ds.id, ds.name, ds.collection_disabled_at,
                s.last_attempt_at, s.last_success_at, s.last_new_post_at, s.freshness_anchor_at, s.consecutive_failures,
                s.last_error_kind, s.last_http_status, s.access_denied_at, s.access_denied_kind,
                s.access_denied_status, s.refused_until, s.refusal_count, s.rate_limited_hosts
         FROM data_sources ds
         JOIN source_collection_state s ON s.source_id = ds.id
         WHERE ds.source_type <> $1`,
        [DEMO_SOURCE_TYPE],
    );
    const open = await dbAll(
        `SELECT id, alert_type, source_id FROM alert_events
         WHERE resolved_at IS NULL AND alert_type = ANY($1::text[]) AND source_table = 'data_sources'`,
        [TYPES],
    );
    const openBy = new Map(open.map(a => [`${a.alert_type}:${a.source_id}`, a]));
    const routeKills = await require('./state').allRouteKillSwitches();
    const opened = [];
    const resolved = [];
    for (const row of rows) {
        const src = getSource(row.name);
        if (!src) continue;
        // Migration 073: a source whose every runnable route is switched off
        // by the database route kill switch is not collecting either.
        const collecting = sourceStatus(src, env, { routeKills: routeKills.get(row.id) || [] }).status === 'collecting'
            && !row.collection_disabled_at;
        const cond = collecting ? conditionsFor(row, src, now, { env, routeKills: routeKills.get(row.id) || [] }) : {};
        for (const type of TYPES) {
            const existing = openBy.get(`${type}:${row.id}`);
            if (cond[type] && !existing) {
                const { severity, ...details } = cond[type];
                // P1-6: atomic — the unique partial index (migration 038)
                // makes a concurrent second insert a no-op.
                if (await openSourceAlert(type, severity, row.id, { slug: src.slug, ...details })) opened.push({ slug: src.slug, type });
            } else if (!cond[type] && existing) {
                const why = resolutionWhy(type, collecting, row, src, now);
                // P1-6: the resolution is an audited alert_resolutions record.
                await resolveSourceAlert(type, row.id, {
                    resolvedBy: 'source-health evaluator (src/collectors/source-health.js)',
                    resolution: `resolved by the source-health evaluator: ${why}`,
                    basis: { slug: src.slug, collecting, last_new_post_at: row.last_new_post_at || null,
                        consecutive_failures: row.consecutive_failures || 0, access_denied_at: row.access_denied_at || null },
                });
                resolved.push({ slug: src.slug, type });
            }
        }
    }
    return { opened, resolved };
}

module.exports = { evaluateSourceHealth, conditionsFor, resolutionWhy, FAILING_AFTER, RATE_LIMITED_WARN_AFTER, TYPES };
