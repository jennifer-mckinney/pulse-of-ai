#!/usr/bin/env node
// scripts/correct-legacy-seed-attribution.js
// NOT RUN AUTOMATICALLY — it changes rows that the audit trail refers to, so
// it needs Jennifer's OK (no npm script, migration, compose service or
// worker invokes it). It is a forward-only DATA CORRECTION, with an audit
// row per change. It never edits a migration, and never deletes or
// rewrites an audit row.
//
// The defect (diagnosis 2026-10-01): FICTIONAL posts sit under REAL source
// rows. The demo/live classifier reads the post's source
// (src/config/data-mode.js: data_sources.source_type = 'demo'), so it
// counts them as LIVE data in every unwindowed view. In the dev database:
//   - 240 `demo-<city>-<n>` posts under reddit_artificial
//     (source_type 'reddit'), written by scripts/seed-demo.js. That script
//     attached them to "any active source"; it was removed in c9844b2;
//   - 66 `dev-seed-<c>-<p>` posts under 43 legacy sources (one under
//     reddit_artificial, so it holds 241), written by
//     scripts/test/seed-e2e.js run against the dev database. That path is
//     now refused by scripts/lib/fixture-db-guard.js.
// Every one of the 306 bypassed the real ingest path (storeRawPost), so no
// ingest or admission version, provenance fingerprint or payload was ever
// written. All of them sit under the legacy sources that migration 013
// retired.
//
// The correction moves each such post to the demo feed of its own category
// (data_sources demo_<category>, source_type 'demo', created by
// scripts/populate.js). From then on, every surface classifies it as demo.
// One data_retention_log row per post (action 'source_reattributed') records:
// - the old and new source;
// - the evidence;
// - the named approval.
// decision_audit_log, sentiment, relevance and every other row are left as
// they are.
//
// NOTE for the approver: once a post is a demo-feed post, the daily demo
// purge (scripts/compact.js purgeDemoPosts) removes it, with its dependent
// rows, after the detail window (RETENTION_DETAIL_DAYS, 90 days). For these
// posts that is about 2026-12-27. Each purge batch is recorded as a
// 'purged_demo' data_retention_log row.
//
//   node scripts/correct-legacy-seed-attribution.js           # dry run: read-only report
//   GATE_APPROVED_BY="Name YYYY-MM-DD" \
//     node scripts/correct-legacy-seed-attribution.js --apply # one transaction
//
// Exit codes: 0 done (or nothing to do), 1 refused / blocked / failed.

'use strict';

require('dotenv').config();
const { dbAll, dbTransaction, closePool } = require('../src/db/connection');
const { namedApproval, GATE_APPROVAL_ENV } = require('../src/config/source-registry');
const { DEMO_SOURCE_TYPE } = require('../src/config/data-mode');

const ACTION = 'source_reattributed';
const SCRIPT = 'scripts/correct-legacy-seed-attribution.js';

const ORIGIN = Object.freeze({
    seedDemo: 'scripts/seed-demo.js (removed in c9844b2)',
    devSeed: 'scripts/test/seed-e2e.js run against this database',
});

// The legacy signature. Every condition must hold:
// - a non-demo source that is retired (the legacy sources migration 013
//   retired);
// - none of the fields the real ingest path writes;
// - an id of either seed script: seed-demo.js `demo-<city>-<n>`, or
//   seed-e2e.js `dev-seed-<city index>-<post index>`.
const CANDIDATES_FILTER = `
    SELECT rp.id, rp.external_id, rp.pseudo_user_id,
           ds.id AS from_id, ds.name AS from_name, ds.category
    FROM raw_posts rp
    JOIN data_sources ds ON ds.id = rp.source_id
    WHERE ds.source_type <> $1
      AND ds.retired_at IS NOT NULL
      AND rp.ingest_mv_id IS NULL
      AND rp.admission_mv_id IS NULL
      AND rp.provenance_fingerprint IS NULL
      AND rp.raw_payload IS NULL
      AND (rp.external_id LIKE 'demo-%' OR rp.external_id ~ '^dev-seed-[0-9]+-[0-9]+$')`;
const CANDIDATES_SQL = `${CANDIDATES_FILTER}
    ORDER BY ds.name, rp.external_id`;
// The same rows, locked for the transaction (the lock needs no order).
const LOCK_CANDIDATES_SQL = `${CANDIDATES_FILTER}
    FOR UPDATE OF rp`;

/**
 * What the correction would do, and what blocks it.
 * @param {Function} [query] (sql, params) → rows; default the pool (no lock)
 * @returns {Promise<{ candidates: object[], blockers: string[] }>}
 */
async function planCorrection(query = (sql, params) => dbAll(sql, params)) {
    const rows = await query(CANDIDATES_SQL, [DEMO_SOURCE_TYPE]);
    const demo = await query(
        `SELECT id, name, category FROM data_sources WHERE source_type = $1 AND name = 'demo_' || category`,
        [DEMO_SOURCE_TYPE]);
    const target = new Map(demo.map(d => [d.category, d]));
    const blockers = [];
    const missing = new Set();
    const candidates = [];
    for (const r of rows) {
        const to = target.get(r.category);
        if (!to) { missing.add(r.category); continue; }
        // Correlation sightings are keyed on the pseudonymous user; a linked
        // post is out of this correction's scope.
        if (r.pseudo_user_id) blockers.push(`post ${r.id} (${r.external_id}) is linked to a pseudonymous user`);
        candidates.push({
            id: r.id, external_id: r.external_id, from_id: r.from_id, from_name: r.from_name,
            category: r.category, to_id: to.id, to_name: to.name,
            origin: r.external_id.startsWith('demo-') ? ORIGIN.seedDemo : ORIGIN.devSeed,
        });
    }
    for (const c of [...missing].sort()) blockers.push(`no demo feed source for category "${c}" (demo_${c}; run the demo feed once)`);
    if (candidates.length) {
        // (source_id, external_id) is unique: the target must not hold the id.
        const clash = await query(
            `SELECT ds.name, rp.external_id FROM raw_posts rp JOIN data_sources ds ON ds.id = rp.source_id
             WHERE (rp.source_id, rp.external_id) IN (SELECT * FROM unnest($1::uuid[], $2::text[]))`,
            [candidates.map(c => c.to_id), candidates.map(c => c.external_id)]);
        for (const c of clash) blockers.push(`external id ${c.external_id} already exists under ${c.name}`);
    }
    return { candidates, blockers };
}

/**
 * @param {object} o
 * @param {boolean} [o.apply]  false (default): read-only report
 * @param {object}  [o.env]
 * @param {Function} [o.log]
 * @returns {Promise<{ applied: boolean, candidates: number, moved?: number, plan: object }>}
 */
async function correctLegacySeedAttribution({ apply = false, env = process.env, log = () => {} } = {}) {
    if (!apply) {
        const plan = await planCorrection();
        return { applied: false, candidates: plan.candidates.length, plan };
    }
    const approval = namedApproval(env);
    if (!approval.ok) throw new Error(`--apply needs a named approval: ${approval.reason} (${GATE_APPROVAL_ENV}="Name YYYY-MM-DD")`);
    return dbTransaction(async (client) => {
        const query = async (sql, params) => (await client.query(sql, params)).rows;
        // Lock the candidates so the plan and the update see the same rows.
        await query(LOCK_CANDIDATES_SQL, [DEMO_SOURCE_TYPE]);
        const plan = await planCorrection(query);
        if (plan.blockers.length) throw new Error(`correction blocked — nothing changed:\n  ${plan.blockers.join('\n  ')}`);
        for (const c of plan.candidates) {
            await client.query('UPDATE raw_posts SET source_id = $2 WHERE id = $1 AND source_id = $3', [c.id, c.to_id, c.from_id]);
            await client.query(
                `INSERT INTO data_retention_log (raw_post_id, action, reason, legal_basis, performed_by)
                 VALUES ($1, $2, $3, NULL, $4)`,
                [c.id, ACTION, JSON.stringify({
                    correction: 'source attribution of a fictional post',
                    external_id: c.external_id,
                    from_source: c.from_name, from_source_id: c.from_id,
                    to_source: c.to_name, to_source_id: c.to_id,
                    origin: c.origin,
                    evidence: 'retired non-demo source; no ingest/admission version, provenance fingerprint or payload '
                        + '(never through storeRawPost); seed-script external id',
                    diagnosis: '2026-10-01 sparse-UI diagnosis: fictional posts counted as live data',
                }), `${SCRIPT} (approved by ${approval.value})`]);
        }
        log(`moved ${plan.candidates.length} post(s); ${plan.candidates.length} ${ACTION} row(s) written`);
        return { applied: true, candidates: plan.candidates.length, moved: plan.candidates.length, plan };
    });
}

/** Human-readable summary of a plan (counts per origin and source → target). */
function describe(plan) {
    const groups = new Map();
    for (const c of plan.candidates) {
        const k = `${c.origin}: ${c.from_name} → ${c.to_name}`;
        groups.set(k, (groups.get(k) || 0) + 1);
    }
    const lines = [...groups].sort().map(([k, n]) => `  ${String(n).padStart(4)}  ${k}`);
    return [`${plan.candidates.length} fictional post(s) under real sources:`, ...lines,
        ...(plan.blockers.length ? ['BLOCKED:', ...plan.blockers.map(b => `  ${b}`)] : [])].join('\n');
}

if (require.main === module) {
    const apply = process.argv.includes('--apply');
    correctLegacySeedAttribution({ apply, log: m => console.log(m) })
        .then((r) => {
            console.log(describe(r.plan));
            console.log(r.applied ? 'APPLIED.' : 'Dry run — nothing changed. Re-run with --apply and GATE_APPROVED_BY to correct.');
            return r.plan.blockers.length && !r.applied ? 1 : 0;
        })
        .catch((err) => {
            console.error(require('../src/collectors/redact').scrub(`correct-legacy-seed-attribution: FAILED — ${err.message}`));
            return 1;
        })
        .then(async (code) => {
            await closePool();
            process.exit(code);
        });
}

module.exports = { planCorrection, correctLegacySeedAttribution, describe, ACTION, ORIGIN, CANDIDATES_SQL };
