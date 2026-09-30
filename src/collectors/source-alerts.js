// src/collectors/source-alerts.js
// Opening and resolving the per-source alerts (source_stale,
// source_failing, source_refused, retention_overdue …) — PR #22 principal
// #6 / grumpy #13.
//
//   openSourceAlert     INSERT … ON CONFLICT DO NOTHING against the unique
//                       partial index of migration 038: at most one OPEN
//                       alert per (type, source), atomically, whatever runs
//                       concurrently (overlapping ticks, several workers).
//   escalateSourceAlert updates the OPEN alert's details to the current
//                       state (e.g. source_refused: the refusal count after a
//                       refused probe), merging — no key is removed — and
//                       counting the escalations (diagnosis 2026-09-30: the
//                       alert said refusal 1 after the escalation to 2)
//   resolveSourceAlert  closes the open alert AND writes its
//                       alert_resolutions record (who, why, evidence) in
//                       one transaction — the same audited design as the
//                       methodology resolutions (migration 028).

'use strict';

const { dbRun, dbTransaction } = require('../db/connection');

const OPEN_CONFLICT = `ON CONFLICT (alert_type, source_id)
    WHERE resolved_at IS NULL AND source_table = 'data_sources' AND source_id IS NOT NULL DO NOTHING`;

/**
 * @param {import('pg').PoolClient} [client]  write in the caller's transaction (PR #22 L16)
 * @returns {Promise<string|null>} the new alert id, or null when one was already open
 */
async function openSourceAlert(type, severity, sourceId, details, client = null) {
    const sql = `INSERT INTO alert_events (alert_type, severity, source_table, source_id, details)
         VALUES ($1, $2, 'data_sources', $3::uuid, $4::jsonb)
         ${OPEN_CONFLICT}
         RETURNING id`;
    const params = [type, severity, sourceId, JSON.stringify(details || {})];
    const row = client ? (await client.query(sql, params)).rows[0] : await dbRun(sql, params);
    return row ? row.id : null;
}

/**
 * Merge the current state into the open alert's details (a jsonb merge, the
 * same way a resolution is added), with escalated_at and an escalation
 * count. The opening values stay in keys the patch does not name (e.g.
 * source_refused's opened_refusal_count).
 * @returns {Promise<string|null>} the id of the open alert updated, or null when none is open
 */
async function escalateSourceAlert(type, sourceId, patch, client = null) {
    const sql = `UPDATE alert_events
         SET details = COALESCE(details, '{}'::jsonb) || $3::jsonb
                       || jsonb_build_object('escalated_at', NOW(),
                                             'escalations', COALESCE((details->>'escalations')::int, 0) + 1)
         WHERE alert_type = $1 AND source_id = $2::uuid AND source_table = 'data_sources' AND resolved_at IS NULL
         RETURNING id`;
    const params = [type, sourceId, JSON.stringify(patch || {})];
    const row = client ? (await client.query(sql, params)).rows[0] : await dbRun(sql, params);
    return row ? row.id : null;
}

/**
 * @param {string} type
 * @param {string} sourceId
 * @param {{ resolvedBy: string, resolution: string, basis?: object }} o
 * @param {import('pg').PoolClient} [outer]  run in the caller's transaction
 * @returns {Promise<string[]>} ids of the alerts resolved
 */
async function resolveSourceAlert(type, sourceId, { resolvedBy, resolution, basis = {} }, outer = null) {
    const inTx = (fn) => (outer ? fn(outer) : dbTransaction(fn));
    return inTx(async (client) => {
        const ids = (await client.query(
            `UPDATE alert_events
             SET resolved_at = NOW(),
                 details = COALESCE(details, '{}'::jsonb) || jsonb_build_object('resolution', $3::text)
             WHERE alert_type = $1 AND source_id = $2::uuid AND source_table = 'data_sources' AND resolved_at IS NULL
             RETURNING id`,
            [type, sourceId, resolution],
        )).rows.map(r => r.id);
        for (const id of ids) {
            await client.query(
                `INSERT INTO alert_resolutions (alert_id, resolved_by, resolution, basis) VALUES ($1, $2, $3, $4::jsonb)
                 ON CONFLICT (alert_id) DO NOTHING`,
                [id, resolvedBy, resolution, JSON.stringify(basis)],
            );
        }
        return ids;
    });
}

module.exports = { openSourceAlert, escalateSourceAlert, resolveSourceAlert };
