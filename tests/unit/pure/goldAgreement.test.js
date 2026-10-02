// tests/unit/pure/goldAgreement.test.js
// Relevance-accuracy Stage 0 (P3): Cohen's kappa and the pairwise agreement
// report behind scripts/gold-agreement.js (src/gold/agreement.js).

'use strict';

const a = require('../../../src/gold/agreement');

const pairsFrom = (counts) => Object.entries(counts).flatMap(([k, n]) => {
    const [x, y] = k.split('/');
    return Array.from({ length: n }, () => [x, y]);
});

describe('cohenKappa', () => {
    it('reproduces the textbook 2×2 example (po 0.70, pe 0.50, kappa 0.40)', () => {
        const r = a.cohenKappa(pairsFrom({ 'Y/Y': 20, 'Y/N': 5, 'N/Y': 10, 'N/N': 15 }));
        expect(r.n).toBe(50);
        expect(r.po).toBeCloseTo(0.70, 10);
        expect(r.pe).toBeCloseTo(0.50, 10);
        expect(r.kappa).toBeCloseTo(0.40, 10);
        expect(r.confusion).toEqual({ N: { N: 15, Y: 10 }, Y: { N: 5, Y: 20 } });
    });

    it('perfect agreement over two or more categories is kappa 1', () => {
        const r = a.cohenKappa(pairsFrom({ 'A/A': 3, 'B/B': 4, 'C/C': 5 }));
        expect(r.kappa).toBe(1);
        // Perfect agreement has no valid normal-approximation interval: none is reported.
        expect(r.ci95).toBeNull();
    });

    it('never reports a certain-looking interval from a tiny sample (two agreeing items)', () => {
        const r = a.cohenKappa(pairsFrom({ 'A/A': 1, 'B/B': 1 }));
        expect(r.kappa).toBe(1);
        expect(r.ci95).toBeNull();
    });

    it('the interval uses the estimated-chance-agreement variance (Fleiss, Cohen & Everitt 1969)', () => {
        const r = a.cohenKappa(pairsFrom({ 'Y/Y': 20, 'Y/N': 5, 'N/Y': 10, 'N/N': 15 }));
        // Worked by hand from the published formula (po .7, pe .5, n 50): the numerator terms are
        // .02743 + .09 * .283 - .05^2 = .0504, over 50 * .5^4, so variance .016128 and se .1270.
        expect(r.se).toBeCloseTo(0.1270, 4);
        expect(r.ci95[0]).toBeCloseTo(0.4 - 1.96 * r.se, 12);
        expect(r.ci95[1]).toBeCloseTo(0.4 + 1.96 * r.se, 12);
    });

    it('agreement exactly at chance is kappa 0', () => {
        expect(a.cohenKappa(pairsFrom({ 'A/A': 25, 'A/B': 25, 'B/A': 25, 'B/B': 25 })).kappa).toBeCloseTo(0, 12);
    });

    it('systematic disagreement is negative', () => {
        expect(a.cohenKappa(pairsFrom({ 'A/B': 10, 'B/A': 10 })).kappa).toBe(-1);
    });

    it('3-class example computed by hand', () => {
        // rows = rater A, cols = rater B over C/I/N
        const r = a.cohenKappa(pairsFrom({ 'C/C': 10, 'C/I': 2, 'I/I': 5, 'I/N': 3, 'N/N': 18, 'N/C': 2 }));
        // po = 33/40; pA = C12 I8 N20; pB = C12 I7 N21
        const pe = (12 * 12 + 8 * 7 + 20 * 21) / (40 * 40);
        expect(r.po).toBeCloseTo(33 / 40, 12);
        expect(r.pe).toBeCloseTo(pe, 12);
        expect(r.kappa).toBeCloseTo((33 / 40 - pe) / (1 - pe), 12);
        expect(r.ci95[0]).toBeLessThan(r.kappa);
        expect(r.ci95[1]).toBeGreaterThan(r.kappa);
    });

    it('is undefined (null) with no items or when both raters use one category only', () => {
        expect(a.cohenKappa([]).kappa).toBeNull();
        const one = a.cohenKappa(pairsFrom({ 'A/A': 5 }));
        expect(one.kappa).toBeNull();
        expect(one.po).toBe(1);
    });
});

describe('interpretKappa (codebook v1 thresholds)', () => {
    it.each([
        [0.85, 'reliable'], [0.80, 'reliable'], [0.79, 'tentative'], [0.667, 'tentative'],
        [0.66, 'unreliable'], [-0.2, 'unreliable'], [null, 'undefined'],
    ])('%s → %s', (k, v) => {
        expect(a.interpretKappa(k)).toBe(v);
    });
});

describe('toBinary — the binary metric (central + incidental = AI)', () => {
    it('maps the three labels', () => {
        expect(a.toBinary('AI_CENTRAL')).toBe('AI');
        expect(a.toBinary('AI_INCIDENTAL')).toBe('AI');
        expect(a.toBinary('NOT_AI')).toBe('NOT_AI');
    });

    it('throws on an unknown label', () => {
        expect(() => a.toBinary('MAYBE')).toThrow(/label/);
    });
});

describe('latestPerLabeller', () => {
    it('keeps each labeller\'s latest label per item (created_at, then id)', () => {
        const rows = [
            { item_id: 'i1', labeller: 'ann', label: 'NOT_AI', flags: [], created_at: '2026-10-01T10:00:00Z', id: '1' },
            { item_id: 'i1', labeller: 'ann', label: 'AI_CENTRAL', flags: [], created_at: '2026-10-01T11:00:00Z', id: '2' },
            { item_id: 'i1', labeller: 'bob', label: 'AI_INCIDENTAL', flags: ['LANG'], created_at: '2026-10-01T09:00:00Z', id: '3' },
            { item_id: 'i1', labeller: 'bob', label: 'NOT_AI', flags: [], created_at: '2026-10-01T09:00:00Z', id: '4' },
        ];
        const m = a.latestPerLabeller(rows);
        expect(m.get('ann').get('i1').label).toBe('AI_CENTRAL');
        expect(m.get('bob').get('i1').label).toBe('NOT_AI');
    });
});

describe('pairReport', () => {
    const lab = (entries) => new Map(entries.map(([id, label, flags = []]) => [id, { label, flags }]));

    it('scores only the items both labellers labelled, three-class, binary and per flag', () => {
        const A = lab([['1', 'AI_CENTRAL'], ['2', 'AI_INCIDENTAL'], ['3', 'NOT_AI', ['SPAM']], ['4', 'NOT_AI'], ['x', 'NOT_AI']]);
        const B = lab([['1', 'AI_CENTRAL'], ['2', 'AI_CENTRAL'], ['3', 'NOT_AI', ['SPAM']], ['4', 'AI_INCIDENTAL'], ['y', 'NOT_AI']]);
        const r = a.pairReport(A, B);
        expect(r.n).toBe(4);
        expect(r.threeClass.po).toBeCloseTo(2 / 4, 12);
        expect(r.binary.po).toBeCloseTo(3 / 4, 12);
        expect(r.flags.SPAM.po).toBe(1);
        expect(r.flags.SPAM.kappa).toBe(1);
        expect(r.flags.BOT_GENERATED.kappa).toBeNull();   // never used by either: undefined
        expect(Object.keys(r.flags).sort()).toEqual(['BOT_GENERATED', 'LANG', 'SPAM']);
    });

    it('no shared items gives n 0 and undefined kappas', () => {
        const r = a.pairReport(lab([['1', 'NOT_AI']]), lab([['2', 'NOT_AI']]));
        expect(r.n).toBe(0);
        expect(r.binary.kappa).toBeNull();
    });
});

describe('agreementReport — every labeller pair with shared items', () => {
    it('builds sorted pairs and skips pairs that share nothing', () => {
        const rows = [
            { item_id: 'i1', labeller: 'bob', label: 'NOT_AI', flags: [], created_at: 't1', id: '1' },
            { item_id: 'i1', labeller: 'ann', label: 'NOT_AI', flags: [], created_at: 't1', id: '2' },
            { item_id: 'i2', labeller: 'cat', label: 'AI_CENTRAL', flags: [], created_at: 't1', id: '3' },
        ];
        const r = a.agreementReport(rows);
        expect(r.pairs.map(p => `${p.a}~${p.b}`)).toEqual(['ann~bob']);
        expect(r.labellers).toEqual(['ann', 'bob', 'cat']);
    });

    it('restricts to one named pair when asked', () => {
        const rows = [
            { item_id: 'i1', labeller: 'ann', label: 'NOT_AI', flags: [], created_at: 't', id: '1' },
            { item_id: 'i1', labeller: 'bob', label: 'NOT_AI', flags: [], created_at: 't', id: '2' },
            { item_id: 'i1', labeller: 'cat', label: 'NOT_AI', flags: [], created_at: 't', id: '3' },
        ];
        expect(a.agreementReport(rows, { pair: ['cat', 'ann'] }).pairs.map(p => `${p.a}~${p.b}`)).toEqual(['cat~ann']);
    });
});

describe('review fixes: design-weighted, ordinal and seq-ordered agreement', () => {
    it('weightedKappa with equal weights equals Cohen kappa; heavier weights shift it', () => {
        const pairs = pairsFrom({ 'Y/Y': 20, 'Y/N': 5, 'N/Y': 10, 'N/N': 15 });
        const plain = a.cohenKappa(pairs).kappa;
        expect(a.weightedKappa(pairs, pairs.map(() => 1)).kappa).toBeCloseTo(plain, 12);
        // Count the N/N pairs ten times: prevalence of N rises, kappa moves.
        const w = pairs.map(([x, y]) => (x === 'N' && y === 'N' ? 10 : 1));
        const k = a.weightedKappa(pairs, w);
        expect(k.kappa).not.toBeCloseTo(plain, 3);
        expect(k.po).toBeCloseTo((20 + 150) / (20 + 5 + 10 + 150), 12);
    });

    it('weightedKappa: needs one weight per pair; empty and pe=1 are undefined', () => {
        expect(() => a.weightedKappa([['A', 'A']], [])).toThrow(/weight/);
        expect(a.weightedKappa([], []).kappa).toBeNull();
        expect(a.weightedKappa([['A', 'A']], [3]).kappa).toBeNull();
    });

    it('ordinalKappa: a near miss costs less than a far miss', () => {
        const near = a.ordinalKappa(pairsFrom({ 'AI_CENTRAL/AI_CENTRAL': 10, 'AI_CENTRAL/AI_INCIDENTAL': 5, 'NOT_AI/NOT_AI': 10 }));
        const far = a.ordinalKappa(pairsFrom({ 'AI_CENTRAL/AI_CENTRAL': 10, 'AI_CENTRAL/NOT_AI': 5, 'NOT_AI/NOT_AI': 10 }));
        expect(near.kappa).toBeGreaterThan(far.kappa);
        expect(a.ordinalKappa(pairsFrom({ 'AI_CENTRAL/AI_CENTRAL': 4, 'NOT_AI/NOT_AI': 4 })).kappa).toBe(1);
        expect(a.ordinalKappa([]).kappa).toBeNull();
        expect(() => a.ordinalKappa([['X', 'NOT_AI']])).toThrow(/outside/);
    });

    it('2/3 is tentative (the codebook 0.667 is Krippendorff 2/3)', () => {
        expect(a.interpretKappa(2 / 3)).toBe('tentative');
    });

    it('latestPerLabeller orders by seq (a bigint string), not by created_at or id', () => {
        const rows = [
            { item_id: 'i', labeller: 'ann', label: 'NOT_AI', flags: [], seq: '10', created_at: 't', id: 'z' },
            { item_id: 'i', labeller: 'ann', label: 'AI_CENTRAL', flags: [], seq: '9', created_at: 't', id: 'a' },
            { item_id: 'j', labeller: 'ann', label: 'NOT_AI', flags: [], seq: '2', created_at: 't', id: 'b' },
            { item_id: 'j', labeller: 'ann', label: 'AI_CENTRAL', flags: [], seq: '11', created_at: 't', id: 'a' },
        ];
        const m = a.latestPerLabeller(rows).get('ann');
        expect(m.get('i').label).toBe('NOT_AI');
        expect(m.get('j').label).toBe('AI_CENTRAL');
    });

    it('pairReport carries a design-weighted kappa and flags a small n as not enough items', () => {
        const lab = (e) => new Map(e.map(([id, label, w]) => [id, { label, flags: [], design_weight: w }]));
        const A = lab([['1', 'AI_CENTRAL', 5], ['2', 'NOT_AI', 1], ['3', 'NOT_AI', 1]]);
        const B = lab([['1', 'AI_CENTRAL', 5], ['2', 'AI_CENTRAL', 1], ['3', 'NOT_AI', 1]]);
        const r = a.pairReport(A, B);
        expect(r.enoughItems).toBe(false);
        expect(r.weighted.binary.po).toBeCloseTo((5 + 1) / 7, 12);
        expect(r.ordinal.kappa).not.toBeNull();
    });
});
