// src/config/bias-lineage.js
// Resolves which bias methodology version PRODUCED a bias_assessments row, so
// the audit receipt and the alert history render each row with that
// version's layer names, citations and notes, not the newest version's
// (PR #8 review).
//
// Lineage values:
//   'recorded': bias_assessments.methodology_version_id (migration 010)
//               names a registered bias version. This is the pipeline's
//               normal case (src/pipeline/bias.js writes the biasMvId it
//               ran with).
//   'inferred': a pre-lineage row (NULL column, written before migration
//               010). The version whose effective_from is at or before the
//               row's created_at is chosen. A row that predates every
//               registered version falls back to the EARLIEST version, with
//               fallback = true, so the guess is visible.
//   null:       no bias methodology is registered, and nothing is invented.
//
// Resolution happens at read time. Stored audit rows are never backfilled
// or rewritten, and methodology rows are never edited.

'use strict';

const toMs = (t) => (t instanceof Date ? t.getTime() : Date.parse(t));

/**
 * @param {{ methodology_version_id?: string|null, created_at: Date|string }} row
 * @param {Array<{ id, model_name, version, config, effective_from, deprecated_at }>} versions
 *        bias methodology rows (any order)
 * @returns {{ mv: object|null, lineage: 'recorded'|'inferred'|null, fallback: boolean }}
 */
function resolveBiasLineage(row, versions) {
    const list = Array.isArray(versions) ? versions : [];
    if (list.length === 0) return { mv: null, lineage: null, fallback: false };

    if (row && row.methodology_version_id) {
        const recorded = list.find(v => v.id === row.methodology_version_id);
        if (recorded) return { mv: recorded, lineage: 'recorded', fallback: false };
    }

    const sorted = [...list].sort((a, b) => toMs(a.effective_from) - toMs(b.effective_from));
    const at = toMs(row && row.created_at);
    let match = null;
    for (const v of sorted) {
        if (toMs(v.effective_from) <= at) match = v;
    }
    if (match) return { mv: match, lineage: 'inferred', fallback: false };
    return { mv: sorted[0], lineage: 'inferred', fallback: true };
}

/**
 * The currently effective bias version: newest non-deprecated by
 * effective_from. Used only when no assessment exists to resolve from.
 */
function currentBiasVersion(versions) {
    const active = (Array.isArray(versions) ? versions : [])
        .filter(v => !v.deprecated_at)
        .sort((a, b) => toMs(b.effective_from) - toMs(a.effective_from));
    return active[0] || null;
}

/**
 * Load every registered bias methodology version (small table: one row per
 * released version). dbAll is injected so this module stays pure-testable.
 */
async function loadBiasVersions(dbAll) {
    return dbAll(
        `SELECT id, model_name, version, config, effective_from, deprecated_at
         FROM methodology_versions
         WHERE component = 'bias'
         ORDER BY effective_from ASC`,
    );
}

module.exports = { resolveBiasLineage, currentBiasVersion, loadBiasVersions };
