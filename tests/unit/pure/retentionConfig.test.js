// tests/unit/pure/retentionConfig.test.js
// PR #22 security M1: one strict parser for every retention window. A bad
// value (0, negative, a float, "1e3", text, below the safe minimum) throws a
// clear error — it never falls back to a destructive value and never to a
// silent default. Unset means the documented default.

const { retentionDetailDays, retentionWindowDays, retentionHours, RETENTION_DETAIL_DAYS_MIN, getSource }
    = require('../../../src/config/source-registry');

describe('retentionDetailDays (RETENTION_DETAIL_DAYS)', () => {
    it('unset or empty is the §19 default, 90 days', () => {
        expect(retentionDetailDays({})).toBe(90);
        expect(retentionDetailDays({ RETENTION_DETAIL_DAYS: '' })).toBe(90);
        expect(retentionDetailDays({ RETENTION_DETAIL_DAYS: ' 120 ' })).toBe(120);
    });

    it.each(['0', '-1', '-30', 'abc', '1e3', '90.5', '12abc', String(RETENTION_DETAIL_DAYS_MIN - 1), '3651'])(
        'rejects %s with a clear error', (v) => {
            expect(() => retentionDetailDays({ RETENTION_DETAIL_DAYS: v })).toThrow(/RETENTION_DETAIL_DAYS/);
        });

    it('the safe minimum is 30 days', () => {
        expect(RETENTION_DETAIL_DAYS_MIN).toBe(30);
        expect(retentionDetailDays({ RETENTION_DETAIL_DAYS: '30' })).toBe(30);
    });

    it('retentionHours uses it and throws on a bad value for a detail-window source', () => {
        const hn = getSource('hacker_news');
        expect(retentionHours(hn, { RETENTION_DETAIL_DAYS: '60' })).toBe(60 * 24);
        expect(() => retentionHours(hn, { RETENTION_DETAIL_DAYS: '0' })).toThrow(/RETENTION_DETAIL_DAYS/);
    });
});

describe('retentionWindowDays — every other window', () => {
    it('SOURCE_RUNS_RAW_DAYS: default 30, minimum 7', () => {
        const o = { name: 'SOURCE_RUNS_RAW_DAYS', def: 30, min: 7 };
        expect(retentionWindowDays({}, o)).toBe(30);
        expect(retentionWindowDays({ SOURCE_RUNS_RAW_DAYS: '7' }, o)).toBe(7);
        for (const v of ['0', '-1', '6', 'x', '1e3']) {
            expect(() => retentionWindowDays({ SOURCE_RUNS_RAW_DAYS: v }, o)).toThrow(/SOURCE_RUNS_RAW_DAYS/);
        }
    });
});
