// src/config/bias-vocabulary.js
// Shared mapping between stored bias_assessments rows and the vocabulary the
// frontend renders (severity alert|watch|pass, human layer names, literature
// citations, deterministic detail strings).
//
// Citations, layer display names, and planned-but-not-yet-enforced layers come
// from the VERSIONED 'bias' methodology config (methodology_versions,
// component='bias') — never hardcoded per response. The fallbacks below only
// title-case the assessment_type so the API degrades gracefully when a bias
// methodology row has not been seeded yet.
//
// Severity vocabulary mapping (stored → rendered):
//   is_violation && severity='critical' → 'alert'  (threshold breached, severe)
//   is_violation && severity='warning'  → 'watch'  (threshold breached, monitor)
//   !is_violation                       → 'pass'   (within threshold)

'use strict';

// ─── Read-time synonym mapping (THE standing pattern for vocabulary drift) ────
// When a stored assessment_type drifts from the pipeline's vocabulary of
// record (src/pipeline/bias.js), map the synonym HERE, at read time, instead
// of rewriting stored rows. bias_assessments is an audit record: its rows stay
// exactly as written, and every consumer (receipt layers, alert history)
// resolves names/citations/notes through canonicalAssessmentType().
// Migration 008 was the one-time exception that folded the pre-existing
// 'demographic_parity' rows in place (recorded in the bias@1.1.0
// justification); the synonym stays mapped here so any such row that
// reappears (older dumps, ad-hoc inserts) still resolves identically. Future
// drift: add an entry below — do NOT write another UPDATE migration.
const ASSESSMENT_TYPE_SYNONYMS = Object.freeze({
    demographic_parity: 'platform_sentiment_parity',
});

/**
 * Canonical (pipeline-vocabulary) assessment type for a stored value.
 * @param {string} assessmentType
 * @returns {string}
 */
function canonicalAssessmentType(assessmentType) {
    return Object.prototype.hasOwnProperty.call(ASSESSMENT_TYPE_SYNONYMS, assessmentType)
        ? ASSESSMENT_TYPE_SYNONYMS[assessmentType]
        : assessmentType;
}

/**
 * Map a stored bias_assessments row to the frontend severity vocabulary.
 * @param {{ is_violation: boolean, severity: string|null }} row
 * @returns {'alert'|'watch'|'pass'}
 */
function severityLabel(row) {
    if (!row.is_violation) return 'pass';
    return row.severity === 'critical' ? 'alert' : 'watch';
}

/** Fallback display name: 'location_concentration' → 'Location concentration'. */
function titleCase(assessmentType) {
    const words = String(assessmentType || '').split('_').join(' ');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Human layer name for an assessment type, from the versioned bias config.
 * @param {string} assessmentType
 * @param {object|null} biasConfig  methodology_versions.config for component='bias'
 */
function layerName(assessmentType, biasConfig) {
    const type = canonicalAssessmentType(assessmentType);
    return (biasConfig && biasConfig.layer_names && biasConfig.layer_names[type])
        || titleCase(type);
}

/**
 * Literature/spec citation for an assessment type, from the versioned bias config.
 * @returns {string|null}  null when the config carries no citation (never invented)
 */
function citationFor(assessmentType, biasConfig) {
    const type = canonicalAssessmentType(assessmentType);
    return (biasConfig && biasConfig.citations && biasConfig.citations[type]) || null;
}

/**
 * Methodology note for an assessment type, from the versioned bias config's
 * layer_notes (P0-3) — e.g. platform_sentiment_parity carries "parity
 * measured across source categories (platform), not user demographics" so
 * the receipt never overstates what the check measures.
 * @returns {string|null}  null when the config carries no note (never invented)
 */
function layerNoteFor(assessmentType, biasConfig) {
    const type = canonicalAssessmentType(assessmentType);
    return (biasConfig && biasConfig.layer_notes
        && biasConfig.layer_notes[type]) || null;
}

/**
 * Deterministic one-line detail for an alert-history row. Built ONLY from
 * stored fields — no generated prose.
 * @param {object} row  bias_assessments row
 * @param {object|null} biasConfig
 */
function alertDetail(row, biasConfig) {
    const value = Number(row.metric_value);
    const threshold = Number(row.threshold);
    const group = row.group_value && row.group_value !== 'all' && row.group_value !== 'none'
        ? ` for ${row.group_value}`
        : '';
    return `${layerName(row.assessment_type, biasConfig)}: ${row.metric_name} `
        + `${Number.isFinite(value) ? value.toFixed(3) : 'n/a'} `
        + `(τ = ${Number.isFinite(threshold) ? threshold : 'n/a'})${group}. `
        + (row.is_violation ? 'Threshold exceeded.' : 'Within threshold.');
}

/**
 * Build the per-job fairness layers for the audit receipt (gap G18).
 * One layer per assessment run on the job (latest row per assessment_type),
 * plus the planned-but-not-enforced layers declared in the versioned bias
 * config (value null, status 'n-a') so the receipt is honest about coverage.
 *
 * @param {Array<object>} assessments  bias_assessments rows for ONE job
 * @param {object|null}   biasConfig   methodology_versions.config (component='bias')
 * @returns {Array<{ name, assessment_type, value, threshold, citation, status, severity, note }>}
 */
function buildLayers(assessments, biasConfig) {
    // Latest row per assessment_type (rows arrive oldest→newest per route query)
    // Keyed by the CANONICAL type so a synonym row and its pipeline-vocabulary
    // twin collapse to one layer (latest wins), exactly as after 008's fold.
    const latestByType = new Map();
    for (const row of assessments || []) {
        latestByType.set(canonicalAssessmentType(row.assessment_type), row);
    }

    const layers = [...latestByType.entries()].map(([type, row]) => ({
        name:            layerName(type, biasConfig),
        assessment_type: type,
        value:           row.metric_value,
        threshold:       row.threshold,
        citation:        citationFor(type, biasConfig),
        status:          row.is_violation ? 'fail' : 'pass',
        severity:        severityLabel(row),
        // P0-3: computed layers carry the config's methodology note (what
        // the check actually measures), null when the config has none.
        note:            layerNoteFor(type, biasConfig),
    }));

    // Planned layers: declared in versioned config, never computed → 'n-a'
    const planned = (biasConfig && biasConfig.planned_layers) || [];
    for (const p of planned) {
        if (latestByType.has(p.id)) continue;   // computed after all — skip the placeholder
        layers.push({
            name:            p.name || titleCase(p.id),
            assessment_type: p.id,
            value:           null,
            threshold:       null,
            citation:        p.citation || null,
            status:          'n-a',
            severity:        null,
            note:            p.note || 'not yet enforced',
        });
    }

    // Presentation order from the versioned config (layer_order): the
    // prototype's three literature-named fairness layers lead — Demographic
    // parity, Equalized odds, Counterfactual fairness — and every
    // additional real check follows as an extra row in its original
    // (assessment) order. Stable sort: unordered layers keep their relative
    // order after the ordered ones. No layer_order in the config → the
    // assembled order stands (graceful degradation like every other
    // config-driven field here).
    const order = (biasConfig && Array.isArray(biasConfig.layer_order))
        ? biasConfig.layer_order
        : [];
    // A named layer the job never computed (and that is not a declared
    // planned layer either) still appears — as an HONEST n-a row with its
    // config name/citation and a "not computed" note. Values are never
    // fabricated; absence is stated, not hidden (the prototype's own
    // layer-3 pattern).
    for (const id of order) {
        if (layers.some(l => l.assessment_type === id)) continue;
        layers.push({
            name:            layerName(id, biasConfig),
            assessment_type: id,
            value:           null,
            threshold:       null,
            citation:        citationFor(id, biasConfig),
            status:          'n-a',
            severity:        null,
            note:            'not computed for this job',
        });
    }
    if (order.length > 0) {
        const rank = new Map(order.map((id, i) => [id, i]));
        return layers
            .map((layer, i) => ({
                layer,
                key: rank.has(layer.assessment_type)
                    ? rank.get(layer.assessment_type)
                    : order.length + i,
            }))
            .sort((a, b) => a.key - b.key)
            .map(entry => entry.layer);
    }

    return layers;
}

module.exports = {
    ASSESSMENT_TYPE_SYNONYMS,
    canonicalAssessmentType,
    severityLabel,
    layerName,
    citationFor,
    layerNoteFor,
    alertDetail,
    buildLayers,
};
