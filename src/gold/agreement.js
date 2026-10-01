// src/gold/agreement.js
// Relevance-accuracy Stage 0 (P3): inter-annotator agreement for the gold
// set (scripts/gold-agreement.js prints it). Pure.
//
// Cohen's kappa for two labellers over the items both labelled:
//   kappa = (po - pe) / (1 - pe)
//   po = observed agreement, pe = chance agreement from the two labellers'
//   own marginals (Cohen 1960). Undefined (null) with no shared items or
//   when pe = 1 (both used one and the same category only).
// The 95% interval uses the large-sample approximation
//   SE = sqrt(po (1 - po) / (n (1 - pe)^2))
// clamped to [-1, 1]; with small n it is indicative only.
//
// Reported per labeller pair: three-class kappa (AI_CENTRAL / AI_INCIDENTAL /
// NOT_AI), binary kappa (the codebook metric: central + incidental = AI) and
// one binary kappa per flag (present / absent).

'use strict';

const { BINARY, FLAGS, KAPPA_RELIABLE, KAPPA_TENTATIVE } = require('./codebook');

const sorted = (xs) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

/**
 * @param {Array<[string, string]>} pairs  [labelA, labelB] per shared item
 * @returns {{ n: number, po: number|null, pe: number|null, kappa: number|null,
 *             se: number|null, ci95: [number, number]|null,
 *             categories: string[], confusion: Record<string, Record<string, number>> }}
 */
function cohenKappa(pairs) {
    const n = pairs.length;
    const categories = sorted(new Set(pairs.flat()));
    const confusion = {};
    for (const a of categories) {
        confusion[a] = {};
        for (const b of categories) confusion[a][b] = 0;
    }
    for (const [a, b] of pairs) confusion[a][b] += 1;
    if (!n) return { n, po: null, pe: null, kappa: null, se: null, ci95: null, categories, confusion };

    const agree = categories.reduce((s, c) => s + confusion[c][c], 0);
    const po = agree / n;
    let pe = 0;
    for (const c of categories) {
        const rowA = categories.reduce((s, b) => s + confusion[c][b], 0);
        const colB = categories.reduce((s, a) => s + confusion[a][c], 0);
        pe += (rowA / n) * (colB / n);
    }
    if (pe >= 1) return { n, po, pe, kappa: null, se: null, ci95: null, categories, confusion };
    const kappa = (po - pe) / (1 - pe);
    const se = Math.sqrt((po * (1 - po)) / (n * (1 - pe) ** 2));
    const clamp = (x) => Math.max(-1, Math.min(1, x));
    return { n, po, pe, kappa, se, ci95: [clamp(kappa - 1.96 * se), clamp(kappa + 1.96 * se)], categories, confusion };
}

/** Codebook thresholds: reliable ≥ 0.80, tentative ≥ 0.667, else unreliable. */
function interpretKappa(k) {
    if (k === null || k === undefined || !Number.isFinite(k)) return 'undefined';
    if (k >= KAPPA_RELIABLE) return 'reliable';
    if (k >= KAPPA_TENTATIVE) return 'tentative';
    return 'unreliable';
}

/** The binary metric: AI_CENTRAL / AI_INCIDENTAL → AI, NOT_AI → NOT_AI. */
function toBinary(label) {
    if (!Object.prototype.hasOwnProperty.call(BINARY, label)) throw new Error(`unknown label "${label}"`);
    return BINARY[label];
}

/**
 * Each labeller's LATEST label per item (labels are append-only; a
 * correction is a later row). Ordered by created_at, then id.
 * @param {Array<{item_id, labeller, label, flags, created_at, id}>} rows
 * @returns {Map<string, Map<string, object>>}  labeller → item_id → row
 */
function latestPerLabeller(rows) {
    const out = new Map();
    for (const r of rows) {
        if (!out.has(r.labeller)) out.set(r.labeller, new Map());
        const m = out.get(r.labeller);
        const prev = m.get(r.item_id);
        if (!prev || isLater(r, prev)) m.set(r.item_id, r);
    }
    return out;
}

/** created_at (Date or ISO string; compared as text when unparseable), then id. */
function isLater(r, prev) {
    const a = new Date(r.created_at).getTime();
    const b = new Date(prev.created_at).getTime();
    if (!Number.isNaN(a) && !Number.isNaN(b)) {
        if (a !== b) return a > b;
    } else if (String(r.created_at) !== String(prev.created_at)) {
        return String(r.created_at) > String(prev.created_at);
    }
    return String(r.id) > String(prev.id);
}

/**
 * Agreement between two labellers' label maps (item_id → {label, flags}).
 */
function pairReport(A, B) {
    const shared = sorted([...A.keys()].filter(id => B.has(id)));
    const three = shared.map(id => [A.get(id).label, B.get(id).label]);
    const flags = {};
    for (const f of FLAGS) {
        flags[f] = cohenKappa(shared.map(id => [
            (A.get(id).flags || []).includes(f) ? 'yes' : 'no',
            (B.get(id).flags || []).includes(f) ? 'yes' : 'no',
        ]));
    }
    return {
        n: shared.length,
        threeClass: cohenKappa(three),
        binary: cohenKappa(three.map(([a, b]) => [toBinary(a), toBinary(b)])),
        flags,
    };
}

/**
 * Every labeller pair that shares at least one item (or one named pair).
 * @param {Array<object>} rows  label rows (see latestPerLabeller)
 * @param {{ pair?: [string, string] }} [opts]
 */
function agreementReport(rows, { pair = null } = {}) {
    const latest = latestPerLabeller(rows);
    const labellers = sorted(latest.keys());
    const candidates = [];
    if (pair) {
        candidates.push(pair);
    } else {
        for (let i = 0; i < labellers.length; i++) {
            for (let j = i + 1; j < labellers.length; j++) candidates.push([labellers[i], labellers[j]]);
        }
    }
    const pairs = [];
    for (const [a, b] of candidates) {
        const r = pairReport(latest.get(a) || new Map(), latest.get(b) || new Map());
        if (r.n || pair) pairs.push({ a, b, ...r });
    }
    return { labellers, pairs };
}

module.exports = { cohenKappa, interpretKappa, toBinary, latestPerLabeller, pairReport, agreementReport };
