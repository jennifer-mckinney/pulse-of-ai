// Pure unit tests for public/js/data.js (PulseData module).
// No DB, no browser — runs under jest.pure.config.js (and the main suite).
//
// Contracts:
//   - DEMO_DATA: moved verbatim from public/js/map.js lines 219-293.
//   - normalizeCities(raw): pure adapter — validates lat/lng, coerces counts,
//     recomputes total/dominant, computes sentiment shares, drops bad rows.
//   - loadCityData(): fetch /api/posts/aggregated-by-location with demo
//     fallback on error/empty (mirrors map.js:394-400 behavior).

'use strict';

const data = require('../../../public/js/data');

// A fully valid raw row used as the baseline in several tests.
function validRow(overrides = {}) {
    return Object.assign({
        city: 'Testville',
        lat: 10,
        lng: 20,
        positive: 6,
        neutral: 3,
        negative: 1,
        total: 10,
        sources: [
            { source_name: 'reddit', source_category: 'social',
              positive: 4, neutral: 2, negative: 1, total: 7 },
            { source_name: 'arxiv', source_category: 'academic',
              positive: 2, neutral: 1, negative: 0, total: 3 },
        ],
    }, overrides);
}

describe('normalizeCities() — valid rows', () => {
    test('passes a valid row through and computes sentiment shares', () => {
        const [city] = data.normalizeCities([validRow()]);
        expect(city).toBeDefined();
        expect(city.city).toBe('Testville');
        expect(city.lat).toBe(10);
        expect(city.lng).toBe(20);
        expect(city.positive).toBe(6);
        expect(city.neutral).toBe(3);
        expect(city.negative).toBe(1);
        expect(city.total).toBe(10);
        expect(city.shares).toEqual({ positive: 0.6, neutral: 0.3, negative: 0.1 });
    });

    test('computes dominant sentiment from the counts', () => {
        expect(data.normalizeCities([validRow()])[0].dominant).toBe('positive');
        expect(data.normalizeCities([
            validRow({ positive: 1, neutral: 8, negative: 1, total: 10 }),
        ])[0].dominant).toBe('neutral');
        expect(data.normalizeCities([
            validRow({ positive: 1, neutral: 2, negative: 7, total: 10 }),
        ])[0].dominant).toBe('negative');
    });

    test('returns [] for non-array input instead of throwing', () => {
        expect(data.normalizeCities(null)).toEqual([]);
        expect(data.normalizeCities(undefined)).toEqual([]);
        expect(data.normalizeCities({ not: 'an array' })).toEqual([]);
    });

    test('zero-total city gets all-zero shares (no NaN from 0/0)', () => {
        const [city] = data.normalizeCities([
            validRow({ positive: 0, neutral: 0, negative: 0, total: 0 }),
        ]);
        expect(city.total).toBe(0);
        expect(city.shares).toEqual({ positive: 0, neutral: 0, negative: 0 });
    });
});

describe('normalizeCities() — bad coordinates are dropped', () => {
    test('drops rows with missing lat or lng', () => {
        expect(data.normalizeCities([validRow({ lat: undefined })])).toEqual([]);
        expect(data.normalizeCities([validRow({ lng: undefined })])).toEqual([]);
        expect(data.normalizeCities([validRow({ lat: null })])).toEqual([]);
        expect(data.normalizeCities([validRow({ lng: null })])).toEqual([]);
    });

    test('drops rows with NaN / non-numeric coordinates', () => {
        expect(data.normalizeCities([validRow({ lat: NaN })])).toEqual([]);
        expect(data.normalizeCities([validRow({ lng: 'not-a-number' })])).toEqual([]);
    });

    test('drops rows with out-of-range coordinates', () => {
        expect(data.normalizeCities([validRow({ lat: 90.0001 })])).toEqual([]);
        expect(data.normalizeCities([validRow({ lat: -91 })])).toEqual([]);
        expect(data.normalizeCities([validRow({ lng: 180.5 })])).toEqual([]);
        expect(data.normalizeCities([validRow({ lng: -181 })])).toEqual([]);
    });

    test('keeps rows exactly on the coordinate boundaries', () => {
        expect(data.normalizeCities([validRow({ lat: 90, lng: 180 })])).toHaveLength(1);
        expect(data.normalizeCities([validRow({ lat: -90, lng: -180 })])).toHaveLength(1);
    });

    test('coerces numeric-string coordinates (pg NUMERIC serializes as string)', () => {
        const [city] = data.normalizeCities([validRow({ lat: '37.7749', lng: '-122.4194' })]);
        expect(city.lat).toBeCloseTo(37.7749, 6);
        expect(city.lng).toBeCloseTo(-122.4194, 6);
    });

    test('drops only the bad rows, keeping valid neighbors', () => {
        const rows = [
            validRow({ city: 'Good A' }),
            validRow({ city: 'Bad', lat: 999 }),
            validRow({ city: 'Good B' }),
        ];
        const out = data.normalizeCities(rows);
        expect(out.map(c => c.city)).toEqual(['Good A', 'Good B']);
    });
});

describe('normalizeCities() — count coercion', () => {
    test('coerces string counts to numbers', () => {
        const [city] = data.normalizeCities([
            validRow({ positive: '142', neutral: '89', negative: '47', total: '278' }),
        ]);
        expect(city.positive).toBe(142);
        expect(city.neutral).toBe(89);
        expect(city.negative).toBe(47);
        expect(city.total).toBe(278);
    });

    test('clamps negative counts to 0', () => {
        const [city] = data.normalizeCities([
            validRow({ positive: -5, neutral: 3, negative: -1, total: 10 }),
        ]);
        expect(city.positive).toBe(0);
        expect(city.neutral).toBe(3);
        expect(city.negative).toBe(0);
        expect(city.total).toBe(3); // recomputed from clamped counts
    });

    test('treats missing / non-numeric counts as 0', () => {
        const [city] = data.normalizeCities([
            validRow({ positive: undefined, neutral: 'garbage', negative: 2, total: 99 }),
        ]);
        expect(city.positive).toBe(0);
        expect(city.neutral).toBe(0);
        expect(city.negative).toBe(2);
        expect(city.total).toBe(2);
    });

    test('recomputes total when it disagrees with positive+neutral+negative', () => {
        const [city] = data.normalizeCities([
            validRow({ positive: 6, neutral: 3, negative: 1, total: 9999 }),
        ]);
        expect(city.total).toBe(10);
        expect(city.shares.positive).toBeCloseTo(0.6, 10);
    });
});

describe('normalizeCities() — sources handling', () => {
    test('preserves the sources array shape (name, category, counts, total)', () => {
        const [city] = data.normalizeCities([validRow()]);
        expect(city.sources).toEqual([
            { source_name: 'reddit', source_category: 'social',
              positive: 4, neutral: 2, negative: 1, total: 7 },
            { source_name: 'arxiv', source_category: 'academic',
              positive: 2, neutral: 1, negative: 0, total: 3 },
        ]);
    });

    test('tolerates a missing sources array as []', () => {
        const row = validRow();
        delete row.sources;
        const [city] = data.normalizeCities([row]);
        expect(city.sources).toEqual([]);
    });

    test('tolerates a non-array sources value as []', () => {
        const [city] = data.normalizeCities([validRow({ sources: 'oops' })]);
        expect(city.sources).toEqual([]);
    });

    test('coerces and clamps source counts, recomputing source totals', () => {
        const [city] = data.normalizeCities([validRow({
            sources: [{ source_name: 's', source_category: 'news',
                        positive: '3', neutral: -2, negative: 1, total: 999 }],
        })]);
        expect(city.sources).toEqual([
            { source_name: 's', source_category: 'news',
              positive: 3, neutral: 0, negative: 1, total: 4 },
        ]);
    });
});

describe('normalizeCities(DEMO_DATA) — lossless demo normalization', () => {
    test('every demo city survives normalization', () => {
        const out = data.normalizeCities(data.DEMO_DATA);
        expect(out).toHaveLength(data.DEMO_DATA.length);
        expect(out.map(c => c.city)).toEqual(data.DEMO_DATA.map(c => c.city));
    });

    test('counts, coordinates, dominant, and sources are unchanged', () => {
        const out = data.normalizeCities(data.DEMO_DATA);
        out.forEach((city, i) => {
            const raw = data.DEMO_DATA[i];
            expect(city.lat).toBe(raw.lat);
            expect(city.lng).toBe(raw.lng);
            expect(city.positive).toBe(raw.positive);
            expect(city.neutral).toBe(raw.neutral);
            expect(city.negative).toBe(raw.negative);
            expect(city.total).toBe(raw.total);          // demo totals are consistent
            expect(city.dominant).toBe(raw.dominant);    // recomputed == authored
            expect(city.sources).toEqual(raw.sources);   // shape preserved exactly
        });
    });

    test('every demo city gains shares that sum to 1', () => {
        for (const city of data.normalizeCities(data.DEMO_DATA)) {
            const sum = city.shares.positive + city.shares.neutral + city.shares.negative;
            expect(sum).toBeCloseTo(1, 10);
        }
    });
});

describe('loadCityData() — fetch with demo fallback', () => {
    const realFetch = global.fetch;

    afterEach(() => {
        global.fetch = realFetch;
    });

    test('returns normalized API rows when the endpoint has data', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [validRow()],
        });
        const cities = await data.loadCityData();
        expect(global.fetch).toHaveBeenCalledWith('/api/posts/aggregated-by-location');
        expect(cities).toHaveLength(1);
        expect(cities[0].city).toBe('Testville');
        expect(cities[0].shares.positive).toBeCloseTo(0.6, 10);
    });

    test('falls back to normalized DEMO_DATA on network error', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
        const cities = await data.loadCityData();
        expect(cities).toHaveLength(data.DEMO_DATA.length);
        expect(cities[0].city).toBe('San Francisco');
    });

    test('falls back to DEMO_DATA when the API returns an empty array', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => [] });
        const cities = await data.loadCityData();
        expect(cities).toHaveLength(data.DEMO_DATA.length);
    });

    test('falls back to DEMO_DATA on a non-OK HTTP response', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
        const cities = await data.loadCityData();
        expect(cities).toHaveLength(data.DEMO_DATA.length);
    });

    test('falls back to DEMO_DATA when fetch is unavailable (Node safety guard)', async () => {
        // The plan requires a `typeof fetch !== 'undefined'` guard so the module
        // never throws ReferenceError in fetch-less environments.
        delete global.fetch;
        const cities = await data.loadCityData();
        expect(cities).toHaveLength(data.DEMO_DATA.length);
        expect(cities[0].shares).toBeDefined(); // fallback is normalized too
    });

    test('falls back to DEMO_DATA when every API row is invalid', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [validRow({ lat: null }), validRow({ lng: 999 })],
        });
        const cities = await data.loadCityData();
        expect(cities).toHaveLength(data.DEMO_DATA.length);
    });
});

describe('module export shape', () => {
    test('exports exactly the documented public API', () => {
        expect(Object.keys(data).sort()).toEqual([
            'DEMO_DATA',
            'loadCityData',
            'normalizeCities',
        ]);
    });

    test('DEMO_DATA is the 12-city demo set from map.js', () => {
        expect(Array.isArray(data.DEMO_DATA)).toBe(true);
        expect(data.DEMO_DATA).toHaveLength(12);
        expect(data.DEMO_DATA[0].city).toBe('San Francisco');
        expect(data.DEMO_DATA[11].city).toBe('Toronto');
    });
});
