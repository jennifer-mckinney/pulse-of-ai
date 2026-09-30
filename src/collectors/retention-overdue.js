// src/collectors/retention-overdue.js
// Retention lag detection (PR #22 principal P0-1).
//
// Text retention is a deletion obligation (platform terms, spec §19). A
// failing or stalled maintenance job must not keep text past its window
// silently. This module measures, per real source, the posts whose text is
// still stored although the source's window ended more than
// RETENTION_OVERDUE_GRACE_MINUTES (default 60) ago:
//
//   overdueBySource()          → [{ source_id, slug, posts, oldest_collected_at, window_hours }]
//                                (read-only; /api/health reports it)
//   evaluateRetentionOverdue() → opens ONE critical `retention_overdue`
//                                alert per source while it is overdue and
//                                resolves it (audited alert_resolutions
//                                record) once the text is gone.
//
// The query rides idx_raw_posts_text_live (source_id, collected_at) WHERE
// text_removed_at IS NULL (migration 031).

'use strict';

const { dbAll } = require('../db/connection');
const { getSource, retentionHours } = require('../config/source-registry');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');
const { openSourceAlert, resolveSourceAlert } = require('./source-alerts');

const ALERT_TYPE = 'retention_overdue';
const DEFAULT_GRACE_MINUTES = 60;

function graceMinutes(env = process.env) {
    const n = Number(env.RETENTION_OVERDUE_GRACE_MINUTES);
    return Number.isInteger(n) && n >= 10 && n <= 24 * 60 ? n : DEFAULT_GRACE_MINUTES;
}

/**
 * Posts past their window + grace with their text still stored, per source.
 * Throws when a retention window is misconfigured (M1): the caller reports it.
 * @param {{ env?: object }} [o]
 */
async function overdueBySource({ env = process.env } = {}) {
    const sources = await dbAll('SELECT id, name FROM data_sources WHERE source_type <> $1 ORDER BY name', [DEMO_SOURCE_TYPE]);
    if (!sources.length) return [];
    const names = sources.map(s => s.name);
    const hours = sources.map(s => retentionHours(getSource(s.name), env));
    const rows = await dbAll(
        `WITH w(name, hours) AS (SELECT * FROM unnest($1::text[], $2::int[]))
         SELECT ds.id AS source_id, ds.name AS slug, w.hours AS window_hours,
                COUNT(*)::int AS posts, MIN(rp.collected_at) AS oldest_collected_at
         FROM w
         JOIN data_sources ds ON ds.name = w.name AND ds.source_type <> $3
         JOIN raw_posts rp ON rp.source_id = ds.id
         WHERE rp.text_removed_at IS NULL
           AND rp.collected_at < NOW() - make_interval(hours => w.hours) - make_interval(mins => $4)
         GROUP BY ds.id, ds.name, w.hours
         ORDER BY ds.name`,
        [names, hours, DEMO_SOURCE_TYPE, graceMinutes(env)],
    );
    return rows;
}

/**
 * Open / resolve the per-source critical alert.
 * @returns {Promise<{ opened: string[], resolved: string[], overdue: Array<object> }>}
 */
async function evaluateRetentionOverdue({ env = process.env } = {}) {
    const overdue = await overdueBySource({ env });
    const bySource = new Map(overdue.map(r => [r.source_id, r]));
    const opened = [];
    const resolved = [];
    for (const r of overdue) {
        const id = await openSourceAlert(ALERT_TYPE, 'critical', r.source_id, {
            slug: r.slug, posts: r.posts, window_hours: r.window_hours,
            oldest_collected_at: r.oldest_collected_at, grace_minutes: graceMinutes(env),
        });
        if (id) opened.push(r.slug);
    }
    const open = await dbAll(
        `SELECT ae.source_id, ds.name AS slug FROM alert_events ae
         JOIN data_sources ds ON ds.id = ae.source_id
         WHERE ae.alert_type = $1 AND ae.resolved_at IS NULL AND ae.source_table = 'data_sources'`,
        [ALERT_TYPE],
    );
    for (const a of open) {
        if (bySource.has(a.source_id)) continue;
        await resolveSourceAlert(ALERT_TYPE, a.source_id, {
            resolvedBy: 'retention-overdue evaluator (src/collectors/retention-overdue.js)',
            resolution: 'resolved by the retention-overdue evaluator: no post of the source holds text past its window',
            basis: { slug: a.slug },
        });
        resolved.push(a.slug);
    }
    return { opened, resolved, overdue };
}

module.exports = { overdueBySource, evaluateRetentionOverdue, graceMinutes, ALERT_TYPE, DEFAULT_GRACE_MINUTES };
