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
//
// Two limitations, stated rather than hidden:
//  1. The sample is STRATIFIED with deliberate over-sampling (design weights
//     N_h / n_h), and kappa depends on prevalence, so the kappa over the
//     sample is not the population kappa. Each pair therefore also carries a
//     DESIGN-WEIGHTED kappa (every item counts N_h / n_h times), the closer
//     estimate of the population value; the sample kappa and its interval
//     describe the labelling exercise itself.
//  2. Below KAPPA_MIN_ITEMS shared items (the codebook's double-coding
//     floor) every reading is indicative only: `enoughItems` is false.
// The three-class kappa treats CENTRAL vs INCIDENTAL like CENTRAL vs NOT_AI;
// the ordinal (linearly weighted) kappa orders the labels and is reported
// beside it.

'use strict';

const { BINARY, FLAGS, LABELS, KAPPA_RELIABLE, KAPPA_TENTATIVE, KAPPA_MIN_ITEMS } = require('./codebook');

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
    // Large-sample variance of kappa with the chance agreement ESTIMATED, not fixed
    // (Fleiss, Cohen & Everitt 1969). When it is not positive (perfect or no agreement on a tiny
    // sample) the normal approximation is not valid, so no interval is reported.
    const p = (a, b) => confusion[a][b] / n;
    const rowM = new Map(categories.map(c => [c, categories.reduce((s, b) => s + p(c, b), 0)]));
    const colM = new Map(categories.map(c => [c, categories.reduce((s, a) => s + p(a, c), 0)]));
    let t1 = 0;
    let t2 = 0;
    for (const a of categories) {
        t1 += p(a, a) * ((1 - pe) - (rowM.get(a) + colM.get(a)) * (1 - po)) ** 2;
        for (const b of categories) if (a !== b) t2 += p(a, b) * (colM.get(a) + rowM.get(b)) ** 2;
    }
    const variance = (t1 + (1 - po) ** 2 * t2 - (po * pe - 2 * pe + po) ** 2) / (n * (1 - pe) ** 4);
    if (po === 1 || !(variance > 1e-12) || !Number.isFinite(variance)) {
        return { n, po, pe, kappa, se: null, ci95: null, categories, confusion };
    }
    const se = Math.sqrt(variance);
    const clamp = (x) => Math.max(-1, Math.min(1, x));
    return { n, po, pe, kappa, se, ci95: [clamp(kappa - 1.96 * se), clamp(kappa + 1.96 * se)], categories, confusion };
}

/**
 * Kappa with every pair counted `weights[i]` times (design weights), Cohen's
 * formula over weighted counts. No interval: the design-based variance needs
 * the stratum structure, which a pair of label lists does not carry.
 * @param {Array<[string, string]>} pairs
 * @param {number[]} weights  one positive weight per pair
 * @returns {{ n: number, po: number|null, pe: number|null, kappa: number|null }}
 */
function weightedKappa(pairs, weights) {
    if (!Array.isArray(weights) || weights.length !== pairs.length) throw new Error('one weight per pair is required');
    const total = weights.reduce((s, w) => s + w, 0);
    if (!pairs.length || !(total > 0)) return { n: pairs.length, po: null, pe: null, kappa: null };
    const categories = sorted(new Set(pairs.flat()));
    const rowSum = new Map(categories.map(c => [c, 0]));
    const colSum = new Map(categories.map(c => [c, 0]));
    let agree = 0;
    pairs.forEach(([x, y], i) => {
        rowSum.set(x, rowSum.get(x) + weights[i]);
        colSum.set(y, colSum.get(y) + weights[i]);
        if (x === y) agree += weights[i];
    });
    const po = agree / total;
    const pe = categories.reduce((s, c) => s + (rowSum.get(c) / total) * (colSum.get(c) / total), 0);
    if (pe >= 1) return { n: pairs.length, po, pe, kappa: null };
    return { n: pairs.length, po, pe, kappa: (po - pe) / (1 - pe) };
}

/**
 * Linearly weighted kappa over an ORDERED label list (disagreement weight
 * |i - j| / (k - 1)): CENTRAL vs INCIDENTAL counts as a smaller disagreement
 * than CENTRAL vs NOT_AI. Undefined (null) with no pairs or no expected
 * disagreement.
 * @param {Array<[string, string]>} pairs
 * @param {string[]} order
 */
function ordinalKappa(pairs, order = LABELS) {
    const n = pairs.length;
    const k = order.length;
    if (!n || k < 2) return { n, kappa: null };
    const idx = new Map(order.map((l, i) => [l, i]));
    const row = new Array(k).fill(0);
    const col = new Array(k).fill(0);
    let observed = 0;
    for (const [x, y] of pairs) {
        if (!idx.has(x) || !idx.has(y)) throw new Error(`label outside the ordered set: ${!idx.has(x) ? x : y}`);
        row[idx.get(x)] += 1;
        col[idx.get(y)] += 1;
        observed += Math.abs(idx.get(x) - idx.get(y)) / (k - 1);
    }
    let expected = 0;
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) expected += (Math.abs(i - j) / (k - 1)) * (row[i] / n) * (col[j] / n);
    if (expected === 0) return { n, kappa: null };
    return { n, kappa: 1 - (observed / n) / expected };
}

/** Codebook thresholds: reliable >= 0.80, tentative >= 2/3, else unreliable. */
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
 * correction is a later row). Ordered by seq (the table's strict insertion
 * order); rows without a seq (not from the database) by created_at, then id.
 * @param {Array<{item_id, labeller, label, flags, seq?, created_at, id}>} rows
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
    if (r.seq !== undefined && r.seq !== null && prev.seq !== undefined && prev.seq !== null) {
        return BigInt(String(r.seq)) > BigInt(String(prev.seq));
    }
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
    const binaryPairs = three.map(([a, b]) => [toBinary(a), toBinary(b)]);
    const w = shared.map(id => {
        const x = Number(A.get(id).design_weight);
        return Number.isFinite(x) && x > 0 ? x : 1;
    });
    return {
        n: shared.length,
        enoughItems: shared.length >= KAPPA_MIN_ITEMS,
        threeClass: cohenKappa(three),
        binary: cohenKappa(binaryPairs),
        ordinal: ordinalKappa(three),
        weighted: { threeClass: weightedKappa(three, w), binary: weightedKappa(binaryPairs, w) },
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

module.exports = { cohenKappa, weightedKappa, ordinalKappa, interpretKappa, toBinary, latestPerLabeller, pairReport, agreementReport };
