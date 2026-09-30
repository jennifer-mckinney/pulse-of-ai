// src/collectors/governance.js
// Source governance records (PR #10 review P10-14; migration 035).
//   recordGateEvent        append one source_gate_events row (who, when, why)
//   recordGateTransitions  compare each source's CURRENT gate status with the
//                          last recorded one and append gate_opened /
//                          gate_closed on a change (the worker's scheduler
//                          calls it with the env it runs under)
//   snapshotTerms          fetch and hash each source's terms page politely

'use strict';

const crypto = require('crypto');
const { dbAll, dbRun } = require('../db/connection');
const { SOURCES, getSource, sourceStatus } = require('../config/source-registry');

async function recordGateEvent({ sourceId, slug, event, gateStatus = null, actor, reason = null }) {
    await dbRun(
        `INSERT INTO source_gate_events (source_id, slug, event, gate_status, actor, reason) VALUES ($1, $2, $3, $4, $5, $6)`,
        [sourceId, slug, event, gateStatus, actor, reason],
    );
}

/** @returns {Promise<Array<{ slug, event, gate_status }>>} the events written */
async function recordGateTransitions({ env = process.env, actor = 'worker scheduler (runtime env)' } = {}) {
    const rows = await dbAll(
        `SELECT ds.id, ds.name,
                (SELECT e.gate_status FROM source_gate_events e
                 WHERE e.source_id = ds.id AND e.event IN ('gate_opened', 'gate_closed')
                 ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1) AS last_status
         FROM data_sources ds WHERE ds.name = ANY($1::text[])`,
        [SOURCES.map(s => s.slug)],
    );
    const written = [];
    for (const r of rows) {
        const st = sourceStatus(getSource(r.name), env);
        const open = st.status === 'collecting';
        // Recorded on the first observation and on every change of status.
        if (r.last_status === st.status) continue;
        const event = open ? 'gate_opened' : 'gate_closed';
        await recordGateEvent({ sourceId: r.id, slug: r.name, event, gateStatus: st.status, actor, reason: st.reason });
        written.push({ slug: r.name, event, gate_status: st.status });
    }
    return written;
}

/**
 * Fetch and hash each source's terms page (terms-snapshot script).
 * Never works around a wall: a blocked source, Reddit before approval, a
 * refusal (401/403/451, bot challenge) or a robots disallow is recorded as
 * unreachable / not fetched with the reason.
 * @param {{ http: import('./http').HttpClient, slugs?: string[] }} o
 */
async function snapshotTerms({ http, slugs, log = () => {} }) {
    const out = [];
    for (const src of SOURCES.filter(s => !slugs || slugs.includes(s.slug))) {
        const row = { slug: src.slug, terms_url: src.termsUrl, status: 'not_fetched', sha256: null, http_status: null, bytes: null, reason: null };
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
                } else {
                    row.status = 'unreachable';
                    row.reason = `HTTP ${res.status}`;
                }
            } catch (err) {
                row.status = 'unreachable';
                row.reason = String(err && err.message || err).slice(0, 300);
            }
        }
        log(`[terms] ${src.slug}: ${row.status}${row.sha256 ? ` ${row.sha256.slice(0, 12)}…` : ''}${row.reason ? ` — ${row.reason}` : ''}`);
        out.push(row);
    }
    return out;
}

/** Store snapshot rows. */
async function saveTermsSnapshots(rows) {
    for (const r of rows) {
        await dbRun(
            `INSERT INTO source_terms_snapshots (source_id, slug, terms_url, status, sha256, http_status, bytes, reason)
             VALUES ((SELECT id FROM data_sources WHERE name = $1), $1, $2, $3, $4, $5, $6, $7)`,
            [r.slug, r.terms_url, r.status, r.sha256, r.http_status, r.bytes, r.reason],
        );
    }
}

module.exports = { recordGateEvent, recordGateTransitions, snapshotTerms, saveTermsSnapshots };
