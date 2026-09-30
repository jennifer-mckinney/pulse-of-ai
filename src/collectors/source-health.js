// src/collectors/source-health.js
// Source-health evaluator (PR #10 review P10-8). Run by the worker with
// every cycle close (src/workers/start.js closeDueCycles, after
// closeCycles). For every registry source that is COLLECTING (gate open,
// no database kill switch) and has a collection-state row:
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
//   source_refused  critical  the source refused access (F10-5); normally
//                             opened by state.recordRefusal — the evaluator
//                             only makes sure it exists
//
// One OPEN alert per (type, source) at most; each is RESOLVED (resolved_at,
// details.resolution) as soon as its condition clears, or when the source
// stops collecting (killed or closed: not a health problem of the source).
// Nothing is deleted.

'use strict';

const { dbAll, dbRun } = require('../db/connection');
const { getSource, sourceStatus } = require('../config/source-registry');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');

const FAILING_AFTER = 3;
const TYPES = Object.freeze(['source_stale', 'source_failing', 'source_refused']);

/** Pure: which conditions hold for one source row. */
function conditionsFor(row, src, now = Date.now()) {
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
    if (row.access_denied_at) {
        out.source_refused = { severity: 'critical', error_kind: row.access_denied_kind || null,
            http_status: row.access_denied_status || null, refused_until: row.refused_until || null };
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
                s.access_denied_status, s.refused_until
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
    const opened = [];
    const resolved = [];
    for (const row of rows) {
        const src = getSource(row.name);
        if (!src) continue;
        const collecting = sourceStatus(src, env).status === 'collecting' && !row.collection_disabled_at;
        const cond = collecting ? conditionsFor(row, src, now) : {};
        for (const type of TYPES) {
            const existing = openBy.get(`${type}:${row.id}`);
            if (cond[type] && !existing) {
                const { severity, ...details } = cond[type];
                await dbRun(
                    `INSERT INTO alert_events (alert_type, severity, source_table, source_id, details)
                     SELECT $1, $2, 'data_sources', $3::uuid, $4::jsonb
                     WHERE NOT EXISTS (SELECT 1 FROM alert_events
                                       WHERE alert_type = $1 AND source_id = $3::uuid AND resolved_at IS NULL)`,
                    [type, severity, row.id, JSON.stringify({ slug: src.slug, ...details })],
                );
                opened.push({ slug: src.slug, type });
            } else if (!cond[type] && existing) {
                const why = !collecting ? 'the source is no longer collecting (closed or switched off)'
                    : type === 'source_stale' ? 'a new post was stored' : type === 'source_failing' ? 'a run succeeded' : 'the refusal cleared';
                await dbRun(
                    `UPDATE alert_events SET resolved_at = NOW(),
                         details = COALESCE(details, '{}'::jsonb) || jsonb_build_object('resolution', $2::text)
                     WHERE id = $1 AND resolved_at IS NULL`,
                    [existing.id, `resolved by the source-health evaluator: ${why}`],
                );
                resolved.push({ slug: src.slug, type });
            }
        }
    }
    return { opened, resolved };
}

module.exports = { evaluateSourceHealth, conditionsFor, FAILING_AFTER, TYPES };
