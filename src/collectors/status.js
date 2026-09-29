// src/collectors/status.js
// Per-source status as served by GET /api/sources, GET /api/health, the
// health drawer and the smoke check: the registry entry (terms citation,
// attribution, auth kind), the RUNTIME gate status under this process's env
// (src/config/source-registry.js sourceStatus) and the latest collection
// state (src/collectors/state.js).
//
// 'blocked_by_source' (F10-5): a collecting source that refused access and
// is in its cooldown or awaiting a probe; never online.
//
// "Online" = gate status 'collecting' AND a successful run within
// ONLINE_WINDOW_MS that is not older than the last error (G10-19).
// "Sources online N/<registry size>" counts exactly these: a source the
// registry would collect but that has not succeeded recently, or has failed
// since, is not online.

'use strict';

const { dbAll } = require('../db/connection');
const { SOURCES, getSource, sourceStatus, killSwitchEnv, GATE_STATUSES } = require('../config/source-registry');
const { DEMO_SOURCE_TYPE } = require('../config/data-mode');
const { refusalGate, resetEnv, BLOCKED_BY_SOURCE } = require('./refusal');

// Runtime statuses: the registry gate statuses plus 'blocked_by_source' (a
// collecting source that refused us — F10-5; never online).
const RUNTIME_STATUSES = Object.freeze([...GATE_STATUSES, BLOCKED_BY_SOURCE]);

const ONLINE_WINDOW_MS = 60 * 60 * 1000;

/**
 * G10-19: online also requires that the last success is not older than the
 * last error (a source that succeeded 50 min ago and has failed since is not
 * online). A refused source is never 'collecting' here, so never online.
 */
function isOnline(status, lastSuccessAt, now = Date.now(), lastErrorAt = null) {
    if (status !== 'collecting' || !lastSuccessAt) return false;
    const ok = new Date(lastSuccessAt).getTime();
    if (now - ok > ONLINE_WINDOW_MS) return false;
    return !lastErrorAt || ok >= new Date(lastErrorAt).getTime();
}

/** Registry fields for one data_sources row (null for non-registry rows). */
function registryFields(row, env, now) {
    const src = getSource(row.name);
    if (!src || row.source_type === DEMO_SOURCE_TYPE) return null;
    const st = sourceStatus(src, env);
    // F10-5: a collecting source in the refused state (cooldown or awaiting
    // its probe) is reported as blocked_by_source until it succeeds again
    // or is reset.
    const gate = refusalGate(row, src.slug, env, now);
    const refused = st.status === 'collecting' && (gate.state === 'cooldown' || gate.state === 'probe');
    // F10-10: the database kill switch disables a source whatever its gate.
    const dbKilled = !!row.collection_disabled_at;
    const status = dbKilled ? 'disabled' : (refused ? BLOCKED_BY_SOURCE : st.status);
    const dbReason = dbKilled
        ? `kill switch (database): disabled${row.collection_disabled_by ? ` by ${row.collection_disabled_by}` : ''}${row.collection_disabled_reason ? ` — ${row.collection_disabled_reason}` : ''}`
        : null;
    return {
        registry: true,
        slug: src.slug,
        rank: src.rank,
        region: src.region,
        auth_kind: src.auth.kind,
        program: src.auth.program,
        signup_url: src.auth.signup,
        status,
        status_reason: dbReason || (refused ? gate.reason : st.reason),
        collection_disabled_at: row.collection_disabled_at || null,
        missing_env: st.missing,
        open_routes: st.openRoutes,
        licence_refs_on_file: st.recorded,
        kill_switch_env: killSwitchEnv(src.slug),
        online: isOnline(status, row.last_success_at, now, row.last_error_at),
        access_denied_at: row.access_denied_at || null,
        refused_until: row.refused_until || null,
        refusal_count: row.refusal_count || 0,
        reset_env: resetEnv(src.slug),
        last_attempt_at: row.last_attempt_at || null,
        last_success_at: row.last_success_at || null,
        last_item_count: row.last_item_count === undefined ? null : row.last_item_count,
        // F10-1: the classification only — never the error text.
        last_error_kind: row.last_error_kind || null,
        last_http_status: row.last_http_status === undefined ? null : row.last_http_status,
        last_error_at: row.last_error_at || null,
        consecutive_failures: row.consecutive_failures || 0,
        terms_url: src.termsUrl,
        terms_note: src.termsNote,
        attribution: src.attribution || null,
        license: src.license || null,
        blocked: src.blocked || null,
        ruling: src.ruling || null,
    };
}

/**
 * @param {{ includeInactive?: boolean, env?: object, now?: number }} [o]
 * @returns {Promise<object[]>} data_sources rows (registry rows enriched), registry order first
 */
async function sourceRows({ includeInactive = false, env = process.env, now = Date.now() } = {}) {
    const rows = await dbAll(
        `SELECT ds.id, ds.name, ds.display_name, ds.source_type, ds.category, ds.active,
                ds.retired_at, ds.retired_note,
                ds.collection_disabled_at, ds.collection_disabled_reason, ds.collection_disabled_by,
                s.last_attempt_at, s.last_success_at, s.last_item_count, s.last_error_kind, s.last_http_status,
                s.last_error_at, s.consecutive_failures,
                s.access_denied_at, s.access_denied_status, s.access_denied_kind, s.refused_until, s.refusal_count
         FROM data_sources ds
         LEFT JOIN source_collection_state s ON s.source_id = ds.id
         ${includeInactive ? '' : 'WHERE ds.active = true'}
         ORDER BY ds.category ASC, ds.name ASC`,
    );
    const out = rows.map((r) => {
        const base = {
            id: r.id, name: r.name, display_name: r.display_name, source_type: r.source_type,
            category: r.category, active: r.active, retired: !!r.retired_at,
        };
        if (r.retired_at) base.retired_note = r.retired_note;
        const reg = registryFields(r, env, now);
        return reg ? { ...base, ...reg } : { ...base, registry: false };
    });
    return out.sort((a, b) => (a.rank || 999) - (b.rank || 999));
}

/** Counts for /api/health and the smoke check. */
function summarize(rows) {
    const reg = rows.filter(r => r.registry);
    const byStatus = Object.fromEntries(RUNTIME_STATUSES.map(s => [s, 0]));
    for (const r of reg) byStatus[r.status]++;
    return {
        registry: SOURCES.length,
        seeded: reg.length,
        collecting: byStatus.collecting,
        online: reg.filter(r => r.online).length,
        by_status: byStatus,
    };
}

module.exports = { sourceRows, summarize, isOnline, registryFields, ONLINE_WINDOW_MS, RUNTIME_STATUSES };
