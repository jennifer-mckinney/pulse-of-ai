// src/gold/eval.js
// Relevance-accuracy Stage 0 (P5): the offline comparison behind
// scripts/relevance-eval.js. For each stored post it runs
//   - the RELEASED relevance scorer (relevance@current, computeRelevance),
//   - the RELEASED admission filter (admission_filter@1.0.0, isAiRelated),
//   - the tiered library (src/config/ai-lexicon-tiers.js, offline draft),
// and aggregates per source category. Pure: no database, no writes. It
// reports counts only — never post text — so its output can be shared.
//
// It changes no production behaviour and no methodology version: the
// released scorers are called exactly as the pipeline calls them.

'use strict';

const { computeRelevance, CURRENT_VERSION } = require('../pipeline/relevance');
const { isAiRelated, ADMISSION_FILTER_VERSION } = require('../collectors/ai-filter');
const { classifyTiered, EDGE_CASES, TIERS_LIBRARY_VERSION } = require('../config/ai-lexicon-tiers');

/**
 * @param {string} text
 * @returns {{ current: boolean, admission: boolean, tiered: object }}
 */
function evaluateText(text) {
    const t = typeof text === 'string' ? text : '';
    return {
        current: computeRelevance(t).score > 0,
        admission: isAiRelated(t),
        tiered: classifyTiered(t),
    };
}

function emptyBucket(category) {
    return {
        category, n: 0,
        stored_relevant: 0, stored_unscored: 0,
        current_relevant: 0, admission_ai: 0, tiered_ai: 0,
        both: 0, current_only: 0, tiered_only: 0, spam: 0,
        delta: 0, delta_rate: 0,
        edge_cases: Object.fromEntries(EDGE_CASES.map(e => [e.id, 0])),
    };
}

function add(b, row, ev) {
    b.n += 1;
    if (row.storedRelevant === true) b.stored_relevant += 1;
    if (row.storedRelevant === null || row.storedRelevant === undefined) b.stored_unscored += 1;
    if (ev.current) b.current_relevant += 1;
    if (ev.admission) b.admission_ai += 1;
    if (ev.tiered.ai) b.tiered_ai += 1;
    if (ev.current && ev.tiered.ai) b.both += 1;
    if (ev.current && !ev.tiered.ai) b.current_only += 1;
    if (!ev.current && ev.tiered.ai) b.tiered_only += 1;
    if (ev.tiered.spam.length) b.spam += 1;
    for (const id of ev.tiered.edgeCases) b.edge_cases[id] += 1;
}

function finish(b) {
    b.delta = b.tiered_ai - b.current_relevant;
    b.delta_rate = b.n ? b.delta / b.n : 0;
    return b;
}

/**
 * Accumulator for streaming use (the script feeds it batch by batch).
 */
function createAccumulator() {
    const buckets = new Map();
    const total = emptyBucket('TOTAL');
    return {
        push(row) {
            const ev = evaluateText(row.text);
            const cat = row.category || 'unknown';
            if (!buckets.has(cat)) buckets.set(cat, emptyBucket(cat));
            add(buckets.get(cat), row, ev);
            add(total, row, ev);
        },
        report() {
            const categories = [...buckets.keys()].sort().map(k => finish({ ...buckets.get(k), edge_cases: { ...buckets.get(k).edge_cases } }));
            return { categories, total: finish({ ...total, edge_cases: { ...total.edge_cases } }) };
        },
    };
}

/**
 * @param {Array<{category: string, storedRelevant: boolean|null, text: string}>} rows
 */
function aggregate(rows) {
    const acc = createAccumulator();
    for (const r of rows) acc.push(r);
    return acc.report();
}

const VERSIONS = Object.freeze({ relevance: CURRENT_VERSION, admission: ADMISSION_FILTER_VERSION, tiers: TIERS_LIBRARY_VERSION });

const pct = (x) => `${(x * 100).toFixed(1)}%`;

/**
 * Fixed-width text report (counts only).
 * @returns {string[]}
 */
function formatReport(report, { versions = VERSIONS } = {}) {
    const cols = ['n', 'stored_relevant', 'current_relevant', 'admission_ai', 'tiered_ai', 'both', 'current_only', 'tiered_only', 'spam', 'delta'];
    const head = ['category'.padEnd(12), ...cols.map(c => c.padStart(16)), 'delta_rate'.padStart(11)].join(' ');
    const line = (b) => [String(b.category).padEnd(12), ...cols.map(c => String(b[c]).padStart(16)), pct(b.delta_rate).padStart(11)].join(' ');
    const out = [
        `relevance-eval: relevance@${versions.relevance} and admission_filter@${versions.admission} (released) vs tiers ${versions.tiers} (offline library)`,
        'delta = tiered_ai - current_relevant (negative: the tiered library would count fewer posts as AI)',
        head,
        ...report.categories.map(line),
        line(report.total),
    ];
    const edges = Object.entries(report.total.edge_cases).filter(([, n]) => n > 0);
    if (edges.length) out.push(`codebook OPEN edge cases tagged: ${edges.map(([k, n]) => `${k}=${n}`).join(', ')}`);
    return out;
}

module.exports = { evaluateText, createAccumulator, aggregate, formatReport, VERSIONS };
