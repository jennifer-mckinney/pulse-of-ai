// tests/unit/pure/dataMode.test.js
// The data-mode classification (demo | live | mixed | none) must be the SAME
// on the backend (src/config/data-mode.js — /api/health, aggregated rows) and
// the frontend (public/js/data.js dataModeOf — sums demo_posts over the
// rows the globe renders). One table drives both.

'use strict';

const { deriveDataMode, DATA_MODES, DEMO_SOURCE_TYPE } = require('../../../src/config/data-mode');
const data = require('../../../public/js/data.js');

const TABLE = [
    // [demoPosts, totalPosts, mode]
    [0, 0, 'none'],
    [5, 5, 'demo'],
    [0, 7, 'live'],
    [2, 7, 'mixed'],
    [9, 7, 'demo'],        // over-count clamps to total, never "more demo than posts"
    ['3', '3', 'demo'],    // pg/JSON string counts coerce
    [null, undefined, 'none'],
];

describe('deriveDataMode (backend)', () => {
    test.each(TABLE)('demo %p of %p → %p', (demo, total, mode) => {
        expect(deriveDataMode(demo, total)).toBe(mode);
    });

    test('exports the mode vocabulary and the demo source type', () => {
        expect(DATA_MODES).toEqual(['none', 'demo', 'live', 'mixed']);
        expect(DEMO_SOURCE_TYPE).toBe('demo');
    });
});

describe('dataModeOf (frontend, over aggregated rows)', () => {
    const rowsFor = (demo, total) => [{ city: 'A', total, demo_posts: demo }];

    test.each(TABLE.filter(([d, t]) => typeof d === 'number' && typeof t === 'number'))(
        'demo %p of %p → %p (same answer as the backend)', (demo, total, mode) => {
            expect(data.dataModeOf(rowsFor(demo, total))).toBe(mode);
        });

    test('sums across cities: all-demo cities → demo, any live post → mixed', () => {
        expect(data.dataModeOf([
            { total: 4, demo_posts: 4 }, { total: 6, demo_posts: 6 },
        ])).toBe('demo');
        expect(data.dataModeOf([
            { total: 4, demo_posts: 4 }, { total: 6, demo_posts: 0 },
        ])).toBe('mixed');
    });

    test('rows without demo_posts (an older API) count as live, never as demo', () => {
        expect(data.dataModeOf([{ total: 3 }])).toBe('live');
    });

    test('non-array input is "none"', () => {
        expect(data.dataModeOf(null)).toBe('none');
        expect(data.dataModeOf([])).toBe('none');
    });
});
