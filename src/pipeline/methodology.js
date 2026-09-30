// src/pipeline/methodology.js
// Resolves the methodology_versions rows the CURRENT code implements.
//
// The code declares its versions (src/config/methodology-registry.js
// CURRENT_VERSIONS — the last registry entry per component); every decision
// the pipeline writes references exactly that row. Selecting "the newest row
// by effective_from" instead would let a re-seed or an out-of-order insert
// attach a decision to a configuration the code does not run — the drift
// `npm run replay` reported for relevance and discourse (ADR 0001).

'use strict';

const { dbAll } = require('../db/connection');
const { CURRENT_VERSIONS } = require('../config/methodology-registry');

// Components the collection pipeline records decisions under.
// admission_filter (PR #22 G6): the version each collected post was admitted under.
const PIPELINE_COMPONENTS = Object.freeze(['sentiment', 'relevance', 'discourse', 'bias', 'ingest', 'admission_filter']);

/**
 * @returns {Promise<{ sentimentMvId, relevanceMvId, discourseMvId, biasMvId,
 *                     ingestMvId, admissionMvId, versions: object }>}
 * @throws when a current version is not registered (migrations/seed not run)
 */
async function resolveCurrentMethodology() {
    const pairs = PIPELINE_COMPONENTS.map(c => `${c}@${CURRENT_VERSIONS[c]}`);
    const rows = await dbAll(
        `SELECT id, component, version FROM methodology_versions
         WHERE component || '@' || version = ANY($1::text[])`,
        [pairs],
    );
    const byComponent = Object.fromEntries(rows.map(r => [r.component, r.id]));
    const missing = PIPELINE_COMPONENTS.filter(c => !byComponent[c]);
    if (missing.length) {
        throw new Error(`methodology not registered for ${missing.map(c => `${c}@${CURRENT_VERSIONS[c]}`).join(', ')} `
            + '— run `npm run migrate` and `npm run seed`');
    }
    return {
        sentimentMvId: byComponent.sentiment,
        relevanceMvId: byComponent.relevance,
        discourseMvId: byComponent.discourse,
        biasMvId:      byComponent.bias,
        ingestMvId:    byComponent.ingest,
        admissionMvId: byComponent.admission_filter,
        versions:      Object.fromEntries(PIPELINE_COMPONENTS.map(c => [c, CURRENT_VERSIONS[c]])),
    };
}

module.exports = { resolveCurrentMethodology, PIPELINE_COMPONENTS };
