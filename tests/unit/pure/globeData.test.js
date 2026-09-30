// Pure unit tests for public/js/data.js (PulseData module).
// No DB, no browser — runs under jest.pure.config.js (and the main suite).
//
// Contracts:
//   - DEMO_DATA: deterministic 30-launch-city set built from the canonical
//     city registry by buildDemoData (demo/live render the same cities).
//   - normalizeCities(raw): pure adapter — validates lat/lng, coerces counts,
//     recomputes total/dominant, computes sentiment shares, drops bad rows.
//   - mergeWithBaseline(rows): served rows overlaid on a zero-count baseline
//     of every launch city (zeros are honest, not hidden).
//   - loadCityData(): fetch the aggregation windowed to the trailing hour
//     (G16 — "posts/hr" honesty), resolve { cities, isDemo }. Demo fallback
//     ONLY when the unwindowed probe is also empty — an empty hour over a
//     seeded DB renders zeros, never fictional demo numbers.

'use strict';

const data = require('../../../public/js/data');
const design = require('../../../public/js/config/design.config');
const { launchCities } =
    require('../../../public/js/config/cities.config.js');

// normalizeCities warns loudly when it drops rows (see the loud-drop
// contract below); silence the noise for every test while still recording
// the calls so the contract tests can assert on them.
let warnSpy;
beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
    warnSpy.mockRestore();
});

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

describe('normalizeCities() — loud-drop contract (backend-flagged)', () => {
    test('warns once, naming every dropped city and the count', () => {
        data.normalizeCities([
            validRow({ city: 'Good A' }),
            validRow({ city: 'Mexico City', lat: null, lng: null }),
            validRow({ city: 'Brussels', lat: 999 }),
        ]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        const msg = warnSpy.mock.calls[0][0];
        expect(msg).toContain('dropped 2 row(s)');
        expect(msg).toContain('Mexico City');
        expect(msg).toContain('Brussels');
        expect(msg).not.toContain('Good A');
    });

    test('labels rows without a usable city name', () => {
        data.normalizeCities([validRow({ city: undefined, lat: null })]);
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('<unnamed row>');
    });

    test('stays silent when nothing is dropped', () => {
        data.normalizeCities([validRow()]);
        data.normalizeCities([]);
        expect(warnSpy).not.toHaveBeenCalled();
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

describe('DEMO_DATA / buildDemoData — registry-derived demo set', () => {
    test('DEMO_DATA covers exactly the 30 registry launch cities, in order', () => {
        const launch = launchCities();
        expect(data.DEMO_DATA).toHaveLength(30);
        expect(data.DEMO_DATA.map(c => c.city)).toEqual(launch.map(c => c.name));
        data.DEMO_DATA.forEach((row, i) => {
            expect(row.lat).toBe(launch[i].lat);
            expect(row.lng).toBe(launch[i].lng);
            expect(row.country).toBe(launch[i].country);
        });
    });

    test('buildDemoData is deterministic (seeded by city id)', () => {
        const a = data.buildDemoData(launchCities());
        const b = data.buildDemoData(launchCities());
        // last_updated is now-stamped; everything else must be identical
        const strip = rows => rows.map(({ last_updated, ...rest }) => rest);
        expect(strip(a)).toEqual(strip(b));
        expect(strip(a)).toEqual(strip(data.DEMO_DATA));
    });

    test('demo rows are internally consistent and showcase mixed sentiment', () => {
        const dominants = new Set();
        const categories = new Set();
        for (const row of data.DEMO_DATA) {
            const srcSum = row.sources.reduce((a, s) => a + s.total, 0);
            expect(row.positive + row.neutral + row.negative).toBe(row.total);
            expect(srcSum).toBe(row.total);
            expect(row.total).toBeGreaterThan(0);
            for (const s of row.sources) {
                expect(s.positive + s.neutral + s.negative).toBe(s.total);
                categories.add(s.source_category);
            }
            dominants.add(row.dominant);
        }
        // All three dominants must appear so every story chapter has
        // leaders/hotspots to talk about (FR-22), and the demo must put
        // VOLUME behind every canonical category (design.config CATEGORIES)
        // so no chip/legend/ribbon segment sits at zero in demo mode.
        expect(dominants).toEqual(new Set(['positive', 'neutral', 'negative']));
        expect(categories).toEqual(new Set(design.CATEGORY_SLUGS));
    });

    test('buildDemoData tolerates non-array input as []', () => {
        expect(data.buildDemoData(null)).toEqual([]);
        expect(data.buildDemoData(undefined)).toEqual([]);
    });
});

describe('mergeWithBaseline() — zero-count launch-city baseline', () => {
    test('no served rows → all 30 launch cities as honest zeros', () => {
        const merged = data.mergeWithBaseline([]);
        expect(merged).toHaveLength(30);
        for (const row of merged) {
            expect(row.total).toBe(0);
            expect(typeof row.lat).toBe('number');
            expect(row.sources).toEqual([]);
        }
    });

    test('served registry-city rows replace their baseline rows in place', () => {
        const served = { city: 'Tokyo', lat: 35.6762, lng: 139.6503,
            positive: 5, neutral: 2, negative: 1, total: 8, sources: [] };
        const merged = data.mergeWithBaseline([served]);
        expect(merged).toHaveLength(30);
        const tokyo = merged.find(c => c.city === 'Tokyo');
        expect(tokyo).toBe(served);
        expect(merged.filter(c => c.total > 0)).toHaveLength(1);
    });

    test('matching is case-insensitive and alias-aware (registry findCity)', () => {
        const served = { city: 'NYC', lat: 40.7128, lng: -74.006,
            positive: 3, neutral: 0, negative: 0, total: 3, sources: [] };
        const merged = data.mergeWithBaseline([served]);
        expect(merged).toHaveLength(30);           // replaced New York's slot
        expect(merged.some(c => c.city === 'NYC')).toBe(true);
        expect(merged.some(c => c.city === 'New York')).toBe(false);
    });

    test('non-registry rows are appended, never dropped here', () => {
        const served = { city: 'Atlantis', lat: null, lng: null,
            positive: 1, neutral: 0, negative: 0, total: 1, sources: [] };
        const merged = data.mergeWithBaseline([served]);
        expect(merged).toHaveLength(31);
        expect(merged[30].city).toBe('Atlantis');
    });

    test('a second alias row for a claimed registry city SUMS in with a loud warn (grumpy #8)', () => {
        const nyRow = { city: 'New York', lat: 40.7128, lng: -74.006,
            positive: 3, neutral: 1, negative: 0, total: 4,
            last_updated: '2026-09-28T10:00:00Z',
            sources: [{ source_name: 'a', source_category: 'social',
                positive: 3, neutral: 1, negative: 0, total: 4 }] };
        const aliasRow = { city: 'NYC', lat: 40.7128, lng: -74.006,
            positive: 2, neutral: 0, negative: 1, total: 3,
            last_updated: '2026-09-28T11:00:00Z',
            sources: [{ source_name: 'b', source_category: 'news',
                positive: 2, neutral: 0, negative: 1, total: 3 }] };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const merged = data.mergeWithBaseline([nyRow, aliasRow]);
            expect(merged).toHaveLength(30);                    // no duplicate marker
            expect(merged.some(c => c.city === 'NYC')).toBe(false);
            const ny = merged.find(c => c.city === 'New York');
            expect(ny.positive).toBe(5);
            expect(ny.neutral).toBe(1);
            expect(ny.negative).toBe(1);
            expect(ny.total).toBe(7);
            expect(ny.sources).toHaveLength(2);                 // both source rows kept
            expect(ny.last_updated).toBe('2026-09-28T11:00:00Z'); // newer wins
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0]).toContain('both resolve to registry city');
        } finally {
            warn.mockRestore();
        }
    });

    test('tier-2 registry rows (e.g. Seattle) ride along after the launch set', () => {
        const served = { city: 'Seattle', lat: 47.6062, lng: -122.3321,
            positive: 2, neutral: 1, negative: 0, total: 3, sources: [] };
        const merged = data.mergeWithBaseline([served]);
        expect(merged).toHaveLength(31);
        expect(merged.some(c => c.city === 'Seattle')).toBe(true);
    });
});

describe('loadCityData() — windowed fetch, demo-flip guard (G16)', () => {
    const realFetch = global.fetch;
    const AGG = '/api/posts/aggregated-by-location';

    afterEach(() => {
        global.fetch = realFetch;
    });

    test('requests the aggregation with a trailing-hour from= (posts/hr honesty)', async () => {
        const before = Date.now();
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [validRow()],
        });
        await data.loadCityData();
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const url = global.fetch.mock.calls[0][0];
        expect(url.startsWith(AGG + '?from=')).toBe(true);
        const from = Date.parse(decodeURIComponent(url.split('?from=')[1]));
        const age = before - from;                 // ≈ one hour ago
        expect(age).toBeGreaterThanOrEqual(3600000 - 50);
        expect(age).toBeLessThanOrEqual(3600000 + 5000);
    });

    test('windowed rows → live data merged onto the 30-city baseline, isDemo:false', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [validRow()],
        });
        const { cities, isDemo } = await data.loadCityData();
        expect(isDemo).toBe(false);
        expect(cities).toHaveLength(31);           // 30 launch zeros + Testville
        const testville = cities.find(c => c.city === 'Testville');
        expect(testville.shares.positive).toBeCloseTo(0.6, 10);
        expect(cities.filter(c => c.total === 0)).toHaveLength(30);
    });

    test('live rows report dataMode "live"; demo-feed rows report "demo" but stay isDemo:false', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, json: async () => [{ ...validRow(), demo_posts: 0 }],
        });
        expect(await data.loadCityData()).toMatchObject({ isDemo: false, dataMode: 'live' });

        // Backend demo feed: every windowed post is from a demo source. The
        // page must LABEL it demo (dataMode) without switching to the bundled
        // fallback (isDemo stays false, so receipts/posts are still fetched).
        const row = validRow();
        global.fetch = jest.fn().mockResolvedValue({
            ok: true, json: async () => [{ ...row, demo_posts: row.total }],
        });
        const demo = await data.loadCityData();
        expect(demo).toMatchObject({ isDemo: false, dataMode: 'demo' });
        expect(demo.cities.find(c => c.city === 'Testville').total).toBe(row.total);
        expect(data.labelsAsDemo(demo.dataMode)).toBe(true);
    });

    test('labelsAsDemo: demo, mixed and the bundled fallback are labeled; live and none are not', () => {
        expect(['live', 'none', 'demo', 'mixed', 'fallback'].map(data.labelsAsDemo))
            .toEqual([false, false, true, true, true]);
    });

    test('DEMO-FLIP GUARD: empty window + non-empty total → honest zeros, isDemo:false', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => [] })          // windowed
            .mockResolvedValueOnce({ ok: true, json: async () => [validRow()] }); // probe
        const { cities, isDemo, dataMode } = await data.loadCityData();
        expect(isDemo).toBe(false);
        expect(dataMode).toBe('none');
        expect(global.fetch).toHaveBeenCalledTimes(2);
        expect(global.fetch.mock.calls[1][0]).toBe(AGG);   // probe is UNWINDOWED
        expect(cities).toHaveLength(30);                   // zero baseline, no demo
        expect(cities.every(c => c.total === 0)).toBe(true);
    });

    test('empty window + empty total → demo fallback, isDemo:true', async () => {
        global.fetch = jest.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => [] })
            .mockResolvedValueOnce({ ok: true, json: async () => [] });
        const { cities, isDemo, dataMode } = await data.loadCityData();
        expect(isDemo).toBe(true);
        expect(dataMode).toBe('fallback');
        expect(cities).toHaveLength(data.DEMO_DATA.length);
        expect(cities.some(c => c.total > 0)).toBe(true);  // demo numbers, labeled
    });

    test('falls back to normalized DEMO_DATA with isDemo:true on network error', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
        const { cities, isDemo } = await data.loadCityData();
        expect(isDemo).toBe(true);
        expect(cities).toHaveLength(data.DEMO_DATA.length);
        expect(cities[0].city).toBe('San Francisco');
    });

    test('falls back to DEMO_DATA (isDemo:true) on a non-OK HTTP response', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });
        const { cities, isDemo } = await data.loadCityData();
        expect(isDemo).toBe(true);
        expect(cities).toHaveLength(data.DEMO_DATA.length);
    });

    test('falls back to DEMO_DATA (isDemo:true) when fetch is unavailable (Node safety guard)', async () => {
        // The `typeof fetch !== 'undefined'` guard keeps the module from
        // throwing ReferenceError in fetch-less environments.
        delete global.fetch;
        const { cities, isDemo } = await data.loadCityData();
        expect(isDemo).toBe(true);
        expect(cities).toHaveLength(data.DEMO_DATA.length);
        expect(cities[0].shares).toBeDefined(); // fallback is normalized too
    });

    test('windowed rows that are ALL invalid still render the baseline (isDemo:false, loud drop)', async () => {
        // The backend served data — dropping to fictional demo numbers would
        // hide a registry hole. The bad rows warn loudly; the launch-city
        // zero baseline still renders.
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => [validRow({ lat: null }), validRow({ lng: 999 })],
        });
        const { cities, isDemo } = await data.loadCityData();
        expect(isDemo).toBe(false);
        expect(cities).toHaveLength(30);
        expect(warnSpy).toHaveBeenCalled();
    });
});

describe('module export shape', () => {
    test('exports exactly the documented public API', () => {
        expect(Object.keys(data).sort()).toEqual([
            'DEMO_DATA',
            'buildDemoData',
            'dataModeOf',
            'labelsAsDemo',
            'loadCityData',
            'mergeWithBaseline',
            'normalizeCities',
        ]);
    });

    test('DEMO_DATA is the 30-city registry-derived demo set', () => {
        expect(Array.isArray(data.DEMO_DATA)).toBe(true);
        expect(data.DEMO_DATA).toHaveLength(30);
        expect(data.DEMO_DATA[0].city).toBe('San Francisco');
        expect(data.DEMO_DATA[29].city).toBe('Melbourne');
    });
});

describe('normalizeCities() — D3 publisher-location layer', () => {
    const row = (extra) => ({ city: 'London', lat: 51.5, lng: -0.12, positive: 2, neutral: 1, negative: 1, ...extra });

    test('passes publisher_posts through, clamped to the total', () => {
        expect(data.normalizeCities([row({ publisher_posts: 3 })])[0].publisher_posts).toBe(3);
        expect(data.normalizeCities([row({ publisher_posts: 99 })])[0].publisher_posts).toBe(4);
    });

    test('an older API without the field (or junk) serves 0', () => {
        expect(data.normalizeCities([row({})])[0].publisher_posts).toBe(0);
        expect(data.normalizeCities([row({ publisher_posts: 'x' })])[0].publisher_posts).toBe(0);
        expect(data.normalizeCities([row({ publisher_posts: -2 })])[0].publisher_posts).toBe(0);
    });
});
