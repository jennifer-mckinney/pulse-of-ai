// Pure unit tests for public/js/utils.js (PulseUtils module).
// No DB, no browser — runs under jest.pure.config.js.
// Behavior contracts ported from public/js/map.js (esc: lines 14-21,
// SENTIMENT_COLORS / SOURCE_PALETTE: lines 25-40).

'use strict';

const utils = require('../../../public/js/utils');

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

describe('SENTIMENT_COLORS', () => {
    test('has exactly the three sentiment keys with map.js hex values', () => {
        expect(utils.SENTIMENT_COLORS).toEqual({
            positive: '#62C370',
            neutral:  '#F5C842',
            negative: '#B63634',
        });
    });
});

describe('SOURCE_PALETTE', () => {
    test('is an array of 8 hex color strings', () => {
        expect(Array.isArray(utils.SOURCE_PALETTE)).toBe(true);
        expect(utils.SOURCE_PALETTE).toHaveLength(8);
        for (const color of utils.SOURCE_PALETTE) {
            expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
    });

    test('matches the exact map.js palette in order', () => {
        expect(utils.SOURCE_PALETTE).toEqual([
            '#60A5FA', '#A78BFA', '#34D399', '#FB923C',
            '#F472B6', '#FBBF24', '#38BDF8', '#4ADE80',
        ]);
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
            'fmtPct',
        ]);
    });
});
