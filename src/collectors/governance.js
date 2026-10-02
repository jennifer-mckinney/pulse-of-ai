// src/collectors/governance.js
// Source governance records (PR #10 review P10-14; migration 035).
//   recordGateEvent        append one source_gate_events row (who, when, why)
//   recordGateTransitions  compare each source's CURRENT gate status with the
//                          last recorded one and append gate_opened /
//                          gate_closed on a change (the worker's scheduler
//                          calls it with the env it runs under). The
//                          database kill switch counts (PR #22 grumpy L14),
//                          and an opening of a gated route carries its
//                          named approver, GATE_APPROVED_BY (decision G5).
//                          The route kill switches count too (migration
//                          073): a change of an open gate's routes (a route
//                          switched off or back on, by env or database) is
//                          a new gate_opened naming the routes that run
//   recordCorrelationGate  append a correlation_gate_events row whenever the
//                          correlation DPIA gate changes (principal #19)
//   snapshotTerms          fetch each source's terms page politely; keep its
//                          normalised text and hash (P1-13, migration 041)
//   saveTermsSnapshots     store the rows; a changed text hash opens a
//                          terms_changed alert for the source

'use strict';

const crypto = require('crypto');
const { dbAll, dbGet, dbRun, dbTransaction } = require('../db/connection');
const { SOURCES, getSource, sourceStatus } = require('../config/source-registry');
const { correlationStatus } = require('../pipeline/correlation-gate');
const termsText = require('./terms-text');

const SCHEDULER_ACTOR = 'worker scheduler (runtime env)';

/**
 * Append one source_gate_events row. Pass `client` to write it in the
 * caller's transaction, with the state change it records (PR #22 L6 / L16).
 * `approvedBy` is the GATE_APPROVED_BY value behind the event (G5); the
 * operator events 'enabled' / 'disabled' / 'refusal_reset' must carry one
 * and use it as the actor (migration 056 CHECK).
 */
async function recordGateEvent({
    sourceId, slug, event, gateStatus = null, actor, reason = null, approvedBy = null, routes = null, client = null,
}) {
    // Copilot round 2: migration 073's CHECK accepts ARRAY[NULL] (a NULL
    // regex result passes a CHECK). Until a follow-up migration closes that,
    // a route event must name exactly one well-formed route id here.
    if ((event === 'route_disabled' || event === 'route_enabled')
        && !(Array.isArray(routes) && routes.length === 1 && typeof routes[0] === 'string'
             && require('../config/source-registry').ROUTE_ID_PATTERN.test(routes[0]))) {
        throw new Error(`a ${event} event names exactly one route id`);
    }
    const sql = `INSERT INTO source_gate_events (source_id, slug, event, gate_status, actor, reason, approved_by, routes)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[])`;
    const params = [sourceId, slug, event, gateStatus, actor, reason, approvedBy, routes];
    if (client) await client.query(sql, params);
    else await dbRun(sql, params);
}

/** Whether two route-id lists hold the same ids (order-insensitive; null = []). */
function sameSet(a, b) {
    const x = [...new Set(a || [])].sort();
    const y = [...new Set(b || [])].sort();
    return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * @param {{ env?: object, actor?: string }} [o]  `actor` is used when no
 *   named approval stands behind the event (a closing, a keyless opening).
 * @returns {Promise<Array<{ slug, event, gate_status, approved_by }>>} the events written
 */
async function recordGateTransitions({ env = process.env, actor = SCHEDULER_ACTOR } = {}) {
    const rows = await dbAll(
        `SELECT ds.id, ds.name, ds.collection_disabled_at, ds.collection_disabled_reason, ds.collection_disabled_by,
                last.gate_status AS last_status, last.approved_by AS last_approved_by, last.routes AS last_routes
         FROM data_sources ds
         LEFT JOIN LATERAL (
             SELECT e.gate_status, e.approved_by, e.routes FROM source_gate_events e
             WHERE e.source_id = ds.id AND e.event IN ('gate_opened', 'gate_closed')
             ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) last ON TRUE
         WHERE ds.name = ANY($1::text[])`,
        [SOURCES.map(s => s.slug)],
    );
    // Migration 073: the database route kill switches count too — a source
    // whose every runnable route is switched off is closed, and a change of
    // an open gate's routes is recorded (below), so the latest gate_opened
    // never lists a route that is switched off.
    const routeKills = await require('./state').allRouteKillSwitches();
    const written = [];
    for (const r of rows) {
        let st = sourceStatus(getSource(r.name), env, { routeKills: routeKills.get(r.id) || [] });
        // Grumpy L14: the database kill switch closes the gate whatever the
        // env says, so the log never shows a disabled source as open.
        if (r.collection_disabled_at && st.status === 'collecting') {
            st = {
                ...st, status: 'disabled', openRoutes: [], approvedBy: null,
                reason: `database kill switch${r.collection_disabled_by ? ` (${r.collection_disabled_by})` : ''}`
                    + `${r.collection_disabled_reason ? `: ${r.collection_disabled_reason}` : ''}`,
            };
        }
        const open = st.status === 'collecting';
        const approvedBy = open ? st.approvedBy || null : null;
        // Recorded on the first observation, on every change of status, when
        // an open gate's named approver changes (G5), and when an open gate's
        // routes change (a route kill switch set or cleared by env or
        // database — security review F5: an env route change leaves a record).
        // A gate event written before migration 056 has no routes (NULL):
        // the first run after deploy records ONE baseline gate_opened with
        // its routes, which every later route change is compared with
        // (Copilot: treating NULL as "same" would hide every later change).
        const sameRoutes = r.last_routes != null && sameSet(r.last_routes, st.openRoutes);
        if (r.last_status === st.status && (!open || ((r.last_approved_by || null) === approvedBy && sameRoutes))) continue;
        const event = open ? 'gate_opened' : 'gate_closed';
        await recordGateEvent({
            sourceId: r.id, slug: r.name, event, gateStatus: st.status, actor: approvedBy || actor, reason: st.reason,
            approvedBy, routes: st.openRoutes || [],
        });
        written.push({ slug: r.name, event, gate_status: st.status, approved_by: approvedBy });
    }
    return written;
}

/**
 * Principal #19: every change of the correlation DPIA gate is recorded in
 * correlation_gate_events (migration 056) — its status, reason, DPIA
 * reference and who (the named GATE_APPROVED_BY approval when one is set,
 * otherwise `actor`). Written on the first observation and on any change
 * of status or DPIA reference.
 * @returns {Promise<object|null>} the row written, or null when unchanged
 */
async function recordCorrelationGate({ env = process.env, actor = SCHEDULER_ACTOR } = {}) {
    const { namedApproval } = require('../config/source-registry');
    const st = correlationStatus(env);
    const ref = typeof env.CORRELATION_DPIA_REF === 'string' && env.CORRELATION_DPIA_REF.trim() ? env.CORRELATION_DPIA_REF.trim() : null;
    const approval = namedApproval(env);
    const approvedBy = approval.ok ? approval.value : null;
    const last = await dbGet(
        `SELECT status, dpia_ref FROM correlation_gate_events ORDER BY occurred_at DESC, id DESC LIMIT 1`);
    if (last && last.status === st.status && (last.dpia_ref || null) === ref) return null;
    return dbRun(
        `INSERT INTO correlation_gate_events (status, enabled, reason, dpia_ref, actor, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING status, enabled, reason, dpia_ref, actor, approved_by`,
        [st.status, !!st.enabled, st.reason, ref, approvedBy || actor, approvedBy],
    );
}

/**
 * Fetch and hash each source's terms page (terms-snapshot script).
 * Never works around a wall: a blocked source, Reddit before approval, a
 * refusal (401/403/451, bot challenge) or a robots disallow is recorded as
 * unreachable / not fetched with the reason.
 * A host backing off after a rate limit (any source's stored hold —
 * diagnosis 2026-10-01, security F5) is not requested: the HTTP client
 * refuses it unsent and the row says why.
 * A rate limit met here (or a success that ends a streak) is saved on the
 * sources concerned (grumpy N2), so the next run honours it.
 * @param {{ http: import('./http').HttpClient, slugs?: string[], loadHolds?: Function, saveHoldChanges?: Function }} o
 *   loadHolds: the stored holds (default: every source's, from the database);
 *   saveHoldChanges: persists the client's hold changes (default: the database)
 */
async function snapshotTerms({
    http, slugs, log = () => {},
    loadHolds = () => require('./state').loadHolds(),
    saveHoldChanges = (changes, view) => require('./state').saveHoldChanges(changes, view),
}) {
    if (typeof http.loadHolds === 'function') http.loadHolds(await loadHolds());
    if (typeof http.drainHoldChanges === 'function') http.drainHoldChanges();
    const out = [];
    for (const src of SOURCES.filter(s => !slugs || slugs.includes(s.slug))) {
        const row = { slug: src.slug, terms_url: src.termsUrl, status: 'not_fetched', sha256: null, http_status: null, bytes: null, reason: null,
            terms_text: null, text_sha256: null, normaliser: null };
        if (src.auth.kind === 'blocked') {
            row.reason = 'blocked source (ADR 0001 ruling 5): its site is walled to automated clients; not fetched, never worked around';
            row.status = 'unreachable';
        } else if (src.slug === 'reddit') {
            row.reason = 'Reddit is never contacted before the Data API approval (ADR 0001 ruling 8)';
        } else {
            try {
                const host = new URL(src.termsUrl).hostname;
                const res = await http.request(src.termsUrl, { robots: true, allowedHosts: [host], maxBytes: 5 * 1024 * 1024, minIntervalMs: 1000 });
                row.http_status = res.status;
                if (res.status >= 200 && res.status < 300) {
                    const body = typeof res.body === 'string' ? res.body : String(res.body || '');
                    row.status = 'fetched';
                    row.sha256 = crypto.createHash('sha256').update(body).digest('hex');
                    row.bytes = Buffer.byteLength(body);
                    // P1-13: the normalised text is the evidence; its hash is
                    // reproducible from the stored text.
                    const ct = res.headers && (res.headers['content-type'] || res.headers['Content-Type']) || '';
                    row.terms_text = termsText.normaliseTermsText(body, ct);
                    row.text_sha256 = termsText.sha256(row.terms_text);
                    row.normaliser = termsText.VERSION;
                } else {
                    row.status = 'unreachable';
                    row.reason = `HTTP ${res.status}`;
                }
            } catch (err) {
                row.status = 'unreachable';
                row.reason = String(err && err.message || err).slice(0, 300);
            }
        }
        log(`[terms] ${src.slug}: ${row.status}${row.text_sha256 ? ` text ${row.text_sha256.slice(0, 12)}…` : ''}${row.reason ? ` — ${row.reason}` : ''}`);
        out.push(row);
    }
    if (typeof http.drainHoldChanges === 'function') await saveHoldChanges(http.drainHoldChanges(), http.holds);
    return out;
}

/**
 * Store snapshot rows. For a fetched page whose normalised-text hash differs
 * from the source's previous fetched snapshot, open ONE terms_changed alert
 * (warning) for the source — an operator reviews the new terms. Each row and
 * its alert are written in one transaction (PR #22 grumpy L16).
 * @returns {Promise<{ saved: number, changed: string[] }>}
 */
async function saveTermsSnapshots(rows) {
    const { openSourceAlert } = require('./source-alerts');
    const changed = [];
    for (const r of rows) {
        await dbTransaction(async (client) => {
            const one = async (sql, params) => (await client.query(sql, params)).rows[0];
            const prev = r.text_sha256 ? await one(
                `SELECT text_sha256, captured_at FROM source_terms_snapshots
                 WHERE slug = $1 AND status = 'fetched' AND text_sha256 IS NOT NULL
                 ORDER BY captured_at DESC, id DESC LIMIT 1`, [r.slug]) : null;
            const saved = await one(
                `INSERT INTO source_terms_snapshots (source_id, slug, terms_url, status, sha256, http_status, bytes, reason,
                                                     terms_text, text_sha256, normaliser)
                 VALUES ((SELECT id FROM data_sources WHERE name = $1), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                 RETURNING id, source_id`,
                [r.slug, r.terms_url, r.status, r.sha256, r.http_status, r.bytes, r.reason, r.terms_text || null,
                    r.text_sha256 || null, r.normaliser || null],
            );
            if (prev && prev.text_sha256 !== r.text_sha256 && saved.source_id) {
                await openSourceAlert('terms_changed', 'warning', saved.source_id, {
                    slug: r.slug, terms_url: r.terms_url, previous_text_sha256: prev.text_sha256,
                    previous_captured_at: prev.captured_at, text_sha256: r.text_sha256, snapshot_id: saved.id,
                }, client);
                changed.push(r.slug);
            }
        });
    }
    return { saved: rows.length, changed };
}

module.exports = { recordGateEvent, recordGateTransitions, recordCorrelationGate, snapshotTerms, saveTermsSnapshots, SCHEDULER_ACTOR };
