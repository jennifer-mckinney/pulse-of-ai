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
        expect(r.ci95[1]).toBe(1);
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
