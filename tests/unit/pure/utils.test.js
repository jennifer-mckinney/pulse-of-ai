// Pure unit tests for public/js/utils.js (PulseUtils module).
// No DB, no browser — runs under jest.pure.config.js.
// esc/fmtPct/fmtCount contracts ported from public/js/map.js; the color
// tables re-export the design-handoff tokens from
// public/js/config/design.config.js; netSentiment/sentimentBucket/fmtNet
// implement the prototype→API data-model bridge (net = (pos−neg)/total).

'use strict';

const utils = require('../../../public/js/utils');
const design = require('../../../public/js/config/design.config');

describe('esc()', () => {
    test('escapes all five HTML special characters', () => {
        expect(utils.esc(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
    });

    test('escapes & first so entities are not double-mangled', () => {
        // '&lt;' input must become '&amp;lt;', not stay '&lt;'
        expect(utils.esc('&lt;')).toBe('&amp;lt;');
    });

    test('passes plain text through unchanged', () => {
        expect(utils.esc('Seattle, WA — 42 posts')).toBe('Seattle, WA — 42 posts');
    });

    test('coerces non-strings and handles null/undefined as empty string', () => {
        expect(utils.esc(null)).toBe('');
        expect(utils.esc(undefined)).toBe('');
        expect(utils.esc(1234)).toBe('1234');
    });

    test('escapes mixed content in context', () => {
        expect(utils.esc('<script>alert("x")</script>'))
            .toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    });
});

describe('SENTIMENT_COLORS (re-pointed to the design-config palette)', () => {
    test('has exactly the three sentiment keys with design-handoff hex values', () => {
        expect(utils.SENTIMENT_COLORS).toEqual({
            positive: '#3BDCB2',
            neutral:  '#7E8AA0',
            negative: '#FF6E5E',
        });
    });

    test('is the design.config SENTIMENT_PALETTE (single source of truth)', () => {
        expect(utils.SENTIMENT_COLORS).toEqual(design.SENTIMENT_PALETTE);
    });
});

describe('SOURCE_PALETTE (re-pointed to design-config CAT_COLORS)', () => {
    test('is an array of 8 hex color strings', () => {
        expect(Array.isArray(utils.SOURCE_PALETTE)).toBe(true);
        expect(utils.SOURCE_PALETTE).toHaveLength(8);
        for (const color of utils.SOURCE_PALETTE) {
            expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
    });

    test('carries the CAT_COLORS hues in category-key order', () => {
        expect(utils.SOURCE_PALETTE).toEqual(Object.values(design.CAT_COLORS));
        expect(utils.SOURCE_PALETTE).toEqual([
            '#FF9F5A', '#5AA9FF', '#C08BFF', '#FF6E9C',
            '#B8E986', '#3BDCB2', '#7EE0FF', '#F5D95A',
        ]);
    });
});

describe('netSentiment()', () => {
    // Bridge contract: prototype "sentiment −1..1" ≡ (positive − negative) / total.
    test('computes (positive − negative) / total', () => {
        expect(utils.netSentiment({ positive: 60, neutral: 20, negative: 20, total: 100 }))
            .toBeCloseTo(0.4, 10);
        expect(utils.netSentiment({ positive: 10, neutral: 30, negative: 60, total: 100 }))
            .toBeCloseTo(-0.5, 10);
    });

    test('spans the full −1..1 range at the extremes', () => {
        expect(utils.netSentiment({ positive: 10, neutral: 0, negative: 0, total: 10 })).toBe(1);
        expect(utils.netSentiment({ positive: 0, neutral: 0, negative: 10, total: 10 })).toBe(-1);
    });

    test('returns 0 when total is 0 (no NaN from 0/0)', () => {
        expect(utils.netSentiment({ positive: 0, neutral: 0, negative: 0, total: 0 })).toBe(0);
    });

    test('returns 0 for missing/non-finite fields instead of NaN', () => {
        expect(utils.netSentiment({})).toBe(0);
        expect(utils.netSentiment({ positive: 1, negative: 0, total: NaN })).toBe(0);
    });
});

describe('sentimentBucket()', () => {
    // Partitioned buckets (design.config SENTIMENT_BUCKETS):
    //   net > 0.1 → positive, net < −0.1 → negative, else neutral.
    test('classifies clear positives and negatives', () => {
        expect(utils.sentimentBucket(0.5)).toBe('positive');
        expect(utils.sentimentBucket(-0.5)).toBe('negative');
        expect(utils.sentimentBucket(0)).toBe('neutral');
    });

    test('thresholds themselves are NEUTRAL (strict inequalities partition the axis)', () => {
        expect(utils.sentimentBucket(0.1)).toBe('neutral');
        expect(utils.sentimentBucket(-0.1)).toBe('neutral');
        expect(utils.sentimentBucket(0.1000001)).toBe('positive');
        expect(utils.sentimentBucket(-0.1000001)).toBe('negative');
    });

    test('defaults to the design-config thresholds', () => {
        const { positiveMin, negativeMax } = design.SENTIMENT_BUCKETS;
        expect(utils.sentimentBucket(positiveMin + 0.001)).toBe('positive');
        expect(utils.sentimentBucket(negativeMax - 0.001)).toBe('negative');
    });

    test('accepts explicit thresholds as the second argument (stays pure)', () => {
        const buckets = { positiveMin: 0.3, negativeMax: -0.3 };
        expect(utils.sentimentBucket(0.2, buckets)).toBe('neutral');
        expect(utils.sentimentBucket(0.31, buckets)).toBe('positive');
        expect(utils.sentimentBucket(-0.31, buckets)).toBe('negative');
    });

    test('non-finite input is neutral (never a colored lie)', () => {
        expect(utils.sentimentBucket(NaN)).toBe('neutral');
        expect(utils.sentimentBucket(undefined)).toBe('neutral');
    });
});

describe('fmtNet()', () => {
    // Prototype fmt(): sign prefix + two decimals, U+2212 minus for negatives.
    test('formats positives with an explicit plus', () => {
        expect(utils.fmtNet(0.38)).toBe('+0.38');
        expect(utils.fmtNet(1)).toBe('+1.00');
    });

    test('formats negatives with U+2212 MINUS SIGN (not hyphen-minus)', () => {
        expect(utils.fmtNet(-0.26)).toBe('−0.26');
        expect(utils.fmtNet(-0.26)).not.toBe('-0.26');
    });

    test('zero is positive-signed (matches the prototype fmt())', () => {
        expect(utils.fmtNet(0)).toBe('+0.00');
    });

    test('rounds to two decimals', () => {
        expect(utils.fmtNet(0.456)).toBe('+0.46');
        expect(utils.fmtNet(-0.004)).toBe('−0.00');
    });

    test('returns em-dash for non-finite input', () => {
        expect(utils.fmtNet(NaN)).toBe('—');
        expect(utils.fmtNet(undefined)).toBe('—');
        expect(utils.fmtNet(Infinity)).toBe('—');
    });
});

describe('fmtPct()', () => {
    // Contract: takes a FRACTION (0..1), returns percent string with one
    // decimal place and a trailing '%'.
    test('formats a fraction with one decimal place', () => {
        expect(utils.fmtPct(0.4267)).toBe('42.7%');
    });

    test('handles 0 and 1 boundaries', () => {
        expect(utils.fmtPct(0)).toBe('0.0%');
        expect(utils.fmtPct(1)).toBe('100.0%');
    });

    test('rounds half up at the displayed precision', () => {
        expect(utils.fmtPct(0.12345)).toBe('12.3%');
        expect(utils.fmtPct(0.6789)).toBe('67.9%');
    });

    test('returns em-dash for non-finite input instead of "NaN%"', () => {
        expect(utils.fmtPct(NaN)).toBe('—');
        expect(utils.fmtPct(Infinity)).toBe('—');
        expect(utils.fmtPct(undefined)).toBe('—');
    });
});

describe('fmtCount()', () => {
    test('adds thousands separators', () => {
        expect(utils.fmtCount(1234)).toBe('1,234');
        expect(utils.fmtCount(9876543)).toBe('9,876,543');
    });

    test('leaves small numbers alone', () => {
        expect(utils.fmtCount(0)).toBe('0');
        expect(utils.fmtCount(999)).toBe('999');
    });

    test('truncates fractional counts to integers', () => {
        expect(utils.fmtCount(1234.9)).toBe('1,234');
    });

    test('returns em-dash for non-finite input', () => {
        expect(utils.fmtCount(NaN)).toBe('—');
        expect(utils.fmtCount(undefined)).toBe('—');
    });
});

describe('module export shape', () => {
    test('exports exactly the documented public API', () => {
        expect(Object.keys(utils).sort()).toEqual([
            'SENTIMENT_COLORS',
            'SOURCE_PALETTE',
            'esc',
            'fmtCount',
            'fmtNet',
            'fmtPct',
            'netSentiment',
            'sentimentBucket',
        ]);
    });
});
