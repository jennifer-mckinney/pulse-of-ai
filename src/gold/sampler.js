// src/gold/sampler.js
// Relevance-accuracy Stage 0 (P3): the PURE parts of the stratified gold-set
// sampler (scripts/gold-sample.js reads the candidates and writes the items).
//
// Strata: source category × route scope × current relevance decision ×
// writing script. Allocation: every stratum gets at least `minPerStratum`
// items (capped at its population), the rest is shared in proportion to
// population × stratum weight (largest remainder, water-filling over the
// strata that still have room). Stratum weights come from `--weight
// dim:value=x` specs and multiply across dimensions; they over-sample rare
// strata (non-Latin scripts, rejected decisions) without biasing estimates,
// because every item records its DESIGN WEIGHT N_h / n_h.
//
// The draw is deterministic: within a stratum, posts are ordered by
// sha256(seed:raw_post_id) and the first n_h are taken. The same seed over
// the same candidates reproduces the sample exactly; the selected items are
// returned in draw-rank order, which interleaves strata (a blind labelling
// order that does not group by stratum or decision).
//
// Offline only: nothing in the production pipeline requires src/gold.

'use strict';

const crypto = require('crypto');
const { getSource } = require('../config/source-registry');

/** Version of this sampler (relevance_gold_items.sampler_version). */
const SAMPLER_VERSION = '1.0.0';

const DIMENSIONS = Object.freeze(['category', 'scope', 'decision', 'script']);
const SCOPES = Object.freeze(['filter', 'ai', 'unknown']);
const DECISIONS = Object.freeze(['relevant', 'not_relevant', 'unscored']);
const SCRIPTS = Object.freeze(['latin', 'cjk', 'cyrillic', 'arabic', 'other']);
const ALLOWED = Object.freeze({ scope: SCOPES, decision: DECISIONS, script: SCRIPTS });

const SCRIPT_RES = Object.freeze([
    ['latin', /\p{Script=Latin}/u],
    ['cjk', /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u],
    ['cyrillic', /\p{Script=Cyrillic}/u],
    ['arabic', /\p{Script=Arabic}/u],
]);

const WEIGHT_SPEC_RE = /^([a-z]+):([a-z0-9_-]+)=([^=]+)$/;

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Dominant writing script of a text, by letter count (ties: the order of
 * SCRIPTS). Letters of any other script, or no letters, give 'other'.
 * @param {unknown} text
 * @returns {'latin'|'cjk'|'cyrillic'|'arabic'|'other'}
 */
function scriptOf(text) {
    if (typeof text !== 'string' || !text) return 'other';
    const counts = { latin: 0, cjk: 0, cyrillic: 0, arabic: 0, other: 0 };
    for (const ch of text.normalize('NFKC')) {
        if (!/\p{L}/u.test(ch)) continue;
        const hit = SCRIPT_RES.find(([, re]) => re.test(ch));
        counts[hit ? hit[0] : 'other'] += 1;
    }
    let best = 'other';
    let bestN = 0;
    for (const k of SCRIPTS) {
        if (counts[k] > bestN) { best = k; bestN = counts[k]; }
    }
    return best;
}

/**
 * The registry scope ('filter' | 'ai') of the route that collected a post,
 * or 'unknown' when the source or route is not in the registry.
 * @param {string} slug     data_sources.name
 * @param {string|null} routeId  raw_payload->>'route'
 */
function scopeOf(slug, routeId) {
    const src = getSource(slug);
    const route = src && routeId ? src.routes.find(r => r.id === routeId) : null;
    return route && SCOPES.includes(route.scope) ? route.scope : 'unknown';
}

/** relevance_results.is_relevant → decision stratum. */
function decisionOf(isRelevant) {
    if (isRelevant === true) return 'relevant';
    if (isRelevant === false) return 'not_relevant';
    return 'unscored';
}

/** "category|scope|decision|script" (migration 070 checks the same form). */
function stratumKey(d) {
    return DIMENSIONS.map(k => d[k]).join('|');
}

function parseStratumKey(key) {
    const parts = String(key).split('|');
    return Object.fromEntries(DIMENSIONS.map((k, i) => [k, parts[i]]));
}

/**
 * Parse `dim:value=x` stratum-weight specs.
 * @param {string[]} specs
 * @returns {Map<string, number>}  "dim:value" → multiplier
 */
function parseWeightSpecs(specs = []) {
    const out = new Map();
    for (const spec of specs) {
        const m = String(spec).match(WEIGHT_SPEC_RE);
        if (!m) throw new Error(`invalid stratum weight "${spec}" (expected dim:value=x)`);
        const [, dim, value, raw] = m;
        if (!DIMENSIONS.includes(dim)) throw new Error(`invalid stratum weight "${spec}": dimension must be one of ${DIMENSIONS.join(', ')}`);
        if (ALLOWED[dim] && !ALLOWED[dim].includes(value)) {
            throw new Error(`invalid stratum weight "${spec}": ${dim} must be one of ${ALLOWED[dim].join(', ')}`);
        }
        const x = Number(raw);
        if (!Number.isFinite(x) || x <= 0) throw new Error(`invalid stratum weight "${spec}": the multiplier must be a positive number`);
        const key = `${dim}:${value}`;
        if (out.has(key)) throw new Error(`invalid stratum weight "${spec}": ${key} given twice`);
        out.set(key, x);
    }
    return out;
}

/** Product of the multipliers that apply to a stratum's dimensions (default 1). */
function stratumWeight(weights, d) {
    return DIMENSIONS.reduce((w, k) => w * (weights.get(`${k}:${d[k]}`) || 1), 1);
}

/**
 * Sample size per stratum.
 * @param {Array<{key: string, population: number, weight?: number}>} strata
 * @param {number} total
 * @param {{ minPerStratum?: number }} [opts]
 * @returns {Map<string, number>}
 */
function allocate(strata, total, { minPerStratum = 1 } = {}) {
    if (!Number.isInteger(total) || total <= 0) throw new Error('total must be a positive integer');
    const rows = [...strata].sort((a, b) => byKey(a.key, b.key));
    const plan = new Map(rows.map(s => [s.key, 0]));
    if (!rows.length) return plan;
    const popTotal = rows.reduce((n, s) => n + s.population, 0);
    if (total >= popTotal) {
        for (const s of rows) plan.set(s.key, s.population);
        return plan;
    }
    const minFloor = rows.reduce((n, s) => n + Math.min(s.population, minPerStratum), 0);
    if (minFloor > total) {
        throw new Error(`total ${total} is below the per-stratum minimum (${minPerStratum} × ${rows.length} strata needs ${minFloor})`);
    }
    for (const s of rows) plan.set(s.key, Math.min(s.population, minPerStratum));
    let remaining = total - minFloor;
    // Water-filling: share `remaining` by population × weight among strata
    // with room; when a share hits a stratum's cap, the units it could not
    // take are re-shared in the next round.
    while (remaining > 0) {
        const open = rows.filter(s => plan.get(s.key) < s.population);
        const mass = open.reduce((n, s) => n + s.population * (s.weight || 1), 0);
        const shares = open.map(s => {
            const exact = remaining * (s.population * (s.weight || 1)) / mass;
            return { s, base: Math.floor(exact), frac: exact - Math.floor(exact) };
        });
        let given = 0;
        let capped = false;
        for (const x of shares) {
            const room = x.s.population - plan.get(x.s.key);
            if (x.base > room) capped = true;
            const add = Math.min(x.base, room);
            plan.set(x.s.key, plan.get(x.s.key) + add);
            given += add;
        }
        remaining -= given;
        if (capped) continue;
        // Largest remainder for the leftover units (ties: key order).
        const order = shares
            .filter(x => plan.get(x.s.key) < x.s.population)
            .sort((a, b) => b.frac - a.frac || byKey(a.s.key, b.s.key));
        for (const x of order) {
            if (remaining <= 0) break;
            plan.set(x.s.key, plan.get(x.s.key) + 1);
            remaining -= 1;
        }
    }
    return plan;
}

/** sha256(seed:id), hex — the deterministic draw order. */
function drawRank(seed, id) {
    return crypto.createHash('sha256').update(`${seed}:${id}`).digest('hex');
}

/**
 * Draw n_h rows per stratum, by draw rank.
 * @param {Array<{rawPostId: string, stratum: string}>} rows
 * @param {Map<string, number>} plan
 * @param {string} seed
 * @returns {Array<object>} the selected rows, each with drawRank,
 *          stratumPopulation, stratumSampleSize and designWeight, in draw-rank order
 */
function selectSample(rows, plan, seed) {
    if (typeof seed !== 'string' || !seed.trim()) throw new Error('a non-empty seed is required');
    const byStratum = new Map();
    for (const r of rows) {
        if (!byStratum.has(r.stratum)) byStratum.set(r.stratum, []);
        byStratum.get(r.stratum).push({ ...r, drawRank: drawRank(seed, r.rawPostId) });
    }
    const out = [];
    for (const [key, n] of plan) {
        const pool = byStratum.get(key) || [];
        if (!n || !pool.length) continue;
        pool.sort((a, b) => byKey(a.drawRank, b.drawRank));
        const take = Math.min(n, pool.length);
        for (const r of pool.slice(0, take)) {
            out.push({ ...r, stratumPopulation: pool.length, stratumSampleSize: take, designWeight: pool.length / take });
        }
    }
    return out.sort((a, b) => byKey(a.drawRank, b.drawRank));
}

/**
 * From classified candidates to the sample: strata summary + selected items.
 * @param {Array<{rawPostId, category, scope, decision, script, inputHash, relevanceMvId}>} candidates
 * @param {{ total: number, seed: string, minPerStratum?: number, weights?: Map<string, number> }} opts
 */
function planSample(candidates, { total, seed, minPerStratum = 1, weights = new Map() }) {
    const pops = new Map();
    const rows = candidates.map(c => {
        const stratum = stratumKey(c);
        pops.set(stratum, (pops.get(stratum) || 0) + 1);
        return { ...c, stratum };
    });
    const strataRows = [...pops].map(([key, population]) => ({ key, population, weight: stratumWeight(weights, parseStratumKey(key)) }));
    const plan = allocate(strataRows, total, { minPerStratum });
    const weightOf = new Map(strataRows.map(s => [s.key, s.weight]));
    const items = selectSample(rows, plan, seed).map(r => ({ ...r, stratumWeight: weightOf.get(r.stratum) }));
    const strata = strataRows
        .map(s => ({ ...parseStratumKey(s.key), key: s.key, population: s.population, weight: s.weight, sampleSize: plan.get(s.key) }))
        .sort((a, b) => byKey(a.key, b.key));
    return { strata, items };
}

module.exports = {
    SAMPLER_VERSION, DIMENSIONS, SCOPES, DECISIONS, SCRIPTS,
    scriptOf, scopeOf, decisionOf, stratumKey, parseStratumKey,
    parseWeightSpecs, stratumWeight, allocate, drawRank, selectSample, planSample,
};
