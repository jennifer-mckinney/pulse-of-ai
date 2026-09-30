// src/watchdog/store.js
// The watchdog's database writes (migration 050). Same audited pattern as the
// per-source alerts (src/collectors/source-alerts.js):
//   openAlert     INSERT … ON CONFLICT DO NOTHING against uq_alerts_open_watchdog
//                 — at most one OPEN alert per condition, atomically;
//   resolveAlert  closes it AND writes its alert_resolutions record (who, why,
//                 evidence) in one transaction;
//   recordClosed  a condition that opened AND cleared while the database was
//                 unreachable is still recorded, as an alert already resolved;
//   writeState    the one watchdog_state row /api/health reads;
//   recordNotification  append-only e-mail log.
// All functions take the db module ({ dbAll, dbGet, dbRun, dbTransaction }).

'use strict';

const { alertType } = require('./conditions');

const RESOLVED_BY = 'watchdog (scripts/watchdog.js)';
const OPEN_CONFLICT = `ON CONFLICT (alert_type) WHERE resolved_at IS NULL AND source_table = 'watchdog' DO NOTHING`;

function detailsOf(c) {
    return { condition: c.condition, title: c.title, summary: c.summary, ...c.details };
}

async function probe(db) {
    await db.dbGet('SELECT 1 AS ok');
    return true;
}

/** @returns {Promise<Array<{ id, alert_type, created_at, details }>>} open watchdog alerts */
async function listOpen(db) {
    return db.dbAll(
        `SELECT id, alert_type, created_at, details FROM alert_events
         WHERE source_table = 'watchdog' AND resolved_at IS NULL ORDER BY created_at`);
}

/** @returns {Promise<{ id: string, created: boolean }>} */
async function openAlert(db, c, since = new Date()) {
    // created_at = when the watchdog first saw it (it may have been seen
    // while the database was unreachable).
    const row = await db.dbRun(
        `INSERT INTO alert_events (alert_type, severity, source_table, details, created_at)
         VALUES ($1, 'critical', 'watchdog', $2::jsonb, $3)
         ${OPEN_CONFLICT}
         RETURNING id`,
        [alertType(c.condition), JSON.stringify(detailsOf(c)), since]);
    if (row) return { id: row.id, created: true };
    const open = await db.dbGet(
        `SELECT id FROM alert_events WHERE alert_type = $1 AND source_table = 'watchdog' AND resolved_at IS NULL`,
        [alertType(c.condition)]);
    return { id: open ? open.id : null, created: false };
}

/** @returns {Promise<string[]>} ids resolved */
async function resolveAlert(db, condition, { resolution, basis = {} }) {
    return db.dbTransaction(async (client) => {
        const ids = (await client.query(
            `UPDATE alert_events
             SET resolved_at = NOW(),
                 details = COALESCE(details, '{}'::jsonb) || jsonb_build_object('resolution', $2::text)
             WHERE alert_type = $1 AND source_table = 'watchdog' AND resolved_at IS NULL
             RETURNING id`,
            [alertType(condition), resolution])).rows.map(r => r.id);
        for (const id of ids) {
            await client.query(
                `INSERT INTO alert_resolutions (alert_id, resolved_by, resolution, basis) VALUES ($1, $2, $3, $4::jsonb)
                 ON CONFLICT (alert_id) DO NOTHING`,
                [id, RESOLVED_BY, resolution, JSON.stringify(basis)]);
        }
        return ids;
    });
}

/** A condition that opened and cleared while the database was down. */
async function recordClosed(db, c, { since, clearedAt, resolution }) {
    return db.dbTransaction(async (client) => {
        const { id } = (await client.query(
            `INSERT INTO alert_events (alert_type, severity, source_table, details, created_at, resolved_at)
             VALUES ($1, 'critical', 'watchdog', $2::jsonb, $3, $4) RETURNING id`,
            [alertType(c.condition), JSON.stringify({ ...detailsOf(c), resolution, recorded_late: true }), since, clearedAt])).rows[0];
        await client.query(
            `INSERT INTO alert_resolutions (alert_id, resolved_at, resolved_by, resolution, basis) VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [id, clearedAt, RESOLVED_BY, resolution, JSON.stringify({ recorded_late: true, reason: 'database unreachable while the condition was open' })]);
        return id;
    });
}

async function writeState(db, s) {
    await db.dbRun(
        `INSERT INTO watchdog_state (id, started_at, last_poll_at, poll_interval_s, health_reachable, open_conditions,
                                     email_configured, email_status, last_email_at, last_email_error, config_errors)
         VALUES (1, $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb)
         ON CONFLICT (id) DO UPDATE SET
             started_at = EXCLUDED.started_at, last_poll_at = EXCLUDED.last_poll_at,
             poll_interval_s = EXCLUDED.poll_interval_s, health_reachable = EXCLUDED.health_reachable,
             open_conditions = EXCLUDED.open_conditions, email_configured = EXCLUDED.email_configured,
             email_status = EXCLUDED.email_status, last_email_at = EXCLUDED.last_email_at,
             last_email_error = EXCLUDED.last_email_error, config_errors = EXCLUDED.config_errors`,
        [s.startedAt, s.lastPollAt, s.pollIntervalS, s.healthReachable, JSON.stringify(s.openConditions || []),
            s.emailConfigured, s.emailStatus, s.lastEmailAt || null, s.lastEmailError || null, JSON.stringify(s.configErrors || [])]);
}

async function recordNotification(db, { alertId, condition, kind, outcome, recipients = 0, error = null }) {
    await db.dbRun(
        `INSERT INTO watchdog_notifications (alert_id, condition, kind, outcome, recipients, error)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [alertId || null, condition, kind, outcome, recipients, error]);
}

/** Open watchdog alerts whose "opened" e-mail was never settled (sent, or deliberately skipped). */
async function unsettledOpenAlerts(db) {
    return db.dbAll(
        `SELECT ae.id, ae.alert_type, ae.created_at, ae.details FROM alert_events ae
         WHERE ae.source_table = 'watchdog' AND ae.resolved_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM watchdog_notifications n
                           WHERE n.alert_id = ae.id AND n.kind = 'opened'
                             AND n.outcome IN ('sent', 'rate_limited', 'not_configured'))
         ORDER BY ae.created_at`);
}

module.exports = {
    probe, listOpen, openAlert, resolveAlert, recordClosed, writeState, recordNotification, unsettledOpenAlerts, RESOLVED_BY,
};
