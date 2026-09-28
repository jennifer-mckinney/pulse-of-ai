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
    return (biasConfig && biasConfig.layer_names && biasConfig.layer_names[assessmentType])
        || titleCase(assessmentType);
}

/**
 * Literature/spec citation for an assessment type, from the versioned bias config.
 * @returns {string|null}  null when the config carries no citation (never invented)
 */
function citationFor(assessmentType, biasConfig) {
    return (biasConfig && biasConfig.citations && biasConfig.citations[assessmentType]) || null;
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
    const latestByType = new Map();
    for (const row of assessments || []) {
        latestByType.set(row.assessment_type, row);
    }

    const layers = [...latestByType.values()].map(row => ({
        name:            layerName(row.assessment_type, biasConfig),
        assessment_type: row.assessment_type,
        value:           row.metric_value,
        threshold:       row.threshold,
        citation:        citationFor(row.assessment_type, biasConfig),
        status:          row.is_violation ? 'fail' : 'pass',
        severity:        severityLabel(row),
        note:            null,
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

    return layers;
}

module.exports = {
    severityLabel,
    layerName,
    citationFor,
    alertDetail,
    buildLayers,
};
