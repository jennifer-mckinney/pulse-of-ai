// Pure unit tests for public/js/insights.js (PulseInsights module).
// No DB, no browser — runs under jest.pure.config.js (and the main suite).
//
// Contracts (from docs/plans/2026-07-05-globe-storytelling-design.md):
//   - computeInsights(cities): global totals, superlatives by SHARE with a
//     MIN_TOTAL guard, deterministic tie-breaks (higher total → alphabetical),
//     Laplace-smoothed sentiment ratios (never Infinity/NaN), source-category
//     aggregation, largest source concentration, regional dominance via
//     regionOf(), extremes delta vs the global average.
//   - computeInsights([]) → null superlatives + zeroed totals, no throw.
//   - TEMPLATES: one entry per story chapter; renderTemplate() interpolates
//     {tokens}, THROWS on unknown token, leaves no '{' residue.

'use strict';

const insights = require('../../../public/js/insights');
const data = require('../../../public/js/data');

const {
    computeInsights, regionOf, renderTemplate, TEMPLATES, MIN_TOTAL,
    catBreakdown, widestCategoryDivide, ribbonRows, partitionThemes,
} = insights;

// ── Hand-computed 4-city fixture ─────────────────────────────────────────────
// Austin  (Americas):      120 / 60 / 20  → total 200, shares .60/.30/.10
// Berlin  (Europe-Africa):  10 / 30 / 60  → total 100, shares .10/.30/.60
// Tokyo   (Asia-Pacific):   70 / 20 / 10  → total 100, shares .70/.20/.10
// Delhi   (Asia-Pacific):    4 /  0 /  0  → total   4 (below MIN_TOTAL guard)
//
// Global: positive 204, neutral 110, negative 90, total 404.
// Source categories across all cities:
//   social 120+30+90+4 = 244, news 80, policy 70, academic 10 (sum 404).
function rawFixture() {
    return [
        { city: 'Austin', lat: 30.2672, lng: -97.7431,
          positive: 120, neutral: 60, negative: 20, total: 200,
          sources: [
              { source_name: 'reddit',    source_category: 'social',
                positive: 80, neutral: 30, negative: 10, total: 120 },
              { source_name: 'statesman', source_category: 'news',
                positive: 40, neutral: 30, negative: 10, total: 80 },
          ] },
        { city: 'Berlin', lat: 52.5200, lng: 13.4050,
          positive: 10, neutral: 30, negative: 60, total: 100,
          sources: [
              { source_name: 'eu_commission', source_category: 'policy',
                positive: 5, neutral: 20, negative: 45, total: 70 },
              { source_name: 'reddit',        source_category: 'social',
                positive: 5, neutral: 10, negative: 15, total: 30 },
          ] },
        { city: 'Tokyo', lat: 35.6762, lng: 139.6503,
          positive: 70, neutral: 20, negative: 10, total: 100,
          sources: [
              { source_name: 'twitter', source_category: 'social',
                positive: 65, neutral: 17, negative: 8, total: 90 },
              { source_name: 'arxiv',   source_category: 'academic',
                positive: 5, neutral: 3, negative: 2, total: 10 },
          ] },
        { city: 'Delhi', lat: 28.6139, lng: 77.2090,
          positive: 4, neutral: 0, negative: 0, total: 4,
          sources: [
              { source_name: 'reddit', source_category: 'social',
                positive: 4, neutral: 0, negative: 0, total: 4 },
          ] },
    ];
}

// Insights consume NORMALIZED cities (the real pipeline is normalizeCities →
// computeInsights), so run the fixture through the actual adapter.
function fixtureInsights() {
    return computeInsights(data.normalizeCities(rawFixture()));
}

describe('computeInsights() — global totals', () => {
    test('sums sentiment counts across all cities', () => {
        const out = fixtureInsights();
        expect(out.cityCount).toBe(4);
        expect(out.globalTotals).toEqual({
            positive: 204, neutral: 110, negative: 90, total: 404,
        });
    });

    test('computes global shares from the totals', () => {
        const out = fixtureInsights();
        expect(out.globalShares.positive).toBeCloseTo(204 / 404, 10);
        expect(out.globalShares.neutral).toBeCloseTo(110 / 404, 10);
        expect(out.globalShares.negative).toBeCloseTo(90 / 404, 10);
    });
});

describe('computeInsights() — volume superlative', () => {
    test('highestVolumeCity is the city with the most posts', () => {
        const out = fixtureInsights();
        expect(out.highestVolumeCity.city).toBe('Austin');
        expect(out.highestVolumeCity.total).toBe(200);
    });

    test('volume ties break alphabetically', () => {
        const out = computeInsights(data.normalizeCities([
            { city: 'Zurich', lat: 47, lng: 8,
              positive: 50, neutral: 30, negative: 20, total: 100, sources: [] },
            { city: 'Athens', lat: 38, lng: 24,
              positive: 40, neutral: 40, negative: 20, total: 100, sources: [] },
        ]));
        expect(out.highestVolumeCity.city).toBe('Athens');
    });
});

describe('computeInsights() — share-based superlatives with MIN_TOTAL guard', () => {
    test('MIN_TOTAL is 5', () => {
        expect(MIN_TOTAL).toBe(5);
    });

    test('mostPositiveCity is chosen by SHARE, not raw count', () => {
        // Austin has more positive posts (120 vs 70) but Tokyo has the higher
        // positive share (0.70 vs 0.60) — share must win.
        expect(fixtureInsights().mostPositiveCity.city).toBe('Tokyo');
    });

    test('mostNegativeCity is chosen by negative share', () => {
        expect(fixtureInsights().mostNegativeCity.city).toBe('Berlin');
    });

    test('cities below MIN_TOTAL are excluded from share superlatives', () => {
        // Delhi is 100% positive but has only 4 posts — must not win.
        expect(fixtureInsights().mostPositiveCity.city).not.toBe('Delhi');
    });

    test('share ties break by higher total, then alphabetically', () => {
        // Same positive share (0.5): higher total wins.
        const byTotal = computeInsights(data.normalizeCities([
            { city: 'Alpha', lat: 0, lng: 0,
              positive: 10, neutral: 5, negative: 5, total: 20, sources: [] },
            { city: 'Zed', lat: 0, lng: 10,
              positive: 20, neutral: 10, negative: 10, total: 40, sources: [] },
        ]));
        expect(byTotal.mostPositiveCity.city).toBe('Zed');

        // Same share AND same total: alphabetical wins.
        const byName = computeInsights(data.normalizeCities([
            { city: 'Zed', lat: 0, lng: 10,
              positive: 10, neutral: 5, negative: 5, total: 20, sources: [] },
            { city: 'Alpha', lat: 0, lng: 0,
              positive: 10, neutral: 5, negative: 5, total: 20, sources: [] },
        ]));
        expect(byName.mostPositiveCity.city).toBe('Alpha');
    });

    test('all superlatives are null when no city meets MIN_TOTAL', () => {
        const out = computeInsights(data.normalizeCities([
            { city: 'Tiny', lat: 0, lng: 0,
              positive: 2, neutral: 1, negative: 0, total: 3, sources: [] },
        ]));
        expect(out.mostPositiveCity).toBeNull();
        expect(out.mostNegativeCity).toBeNull();
        expect(out.sentimentRatioExtremes).toBeNull();
        // volume superlative has no share guard — tiny city still leads volume
        expect(out.highestVolumeCity.city).toBe('Tiny');
    });
});

describe('computeInsights() — sentimentRatioExtremes (Laplace smoothed)', () => {
    test('ratio is (positive+1)/(negative+1); extremes from the fixture', () => {
        const { sentimentRatioExtremes: ext } = fixtureInsights();
        expect(ext.highest.city.city).toBe('Tokyo');
        expect(ext.highest.ratio).toBeCloseTo(71 / 11, 10);
        expect(ext.lowest.city.city).toBe('Berlin');
        expect(ext.lowest.ratio).toBeCloseTo(11 / 61, 10);
    });

    test('zero negatives never produce Infinity or NaN', () => {
        const out = computeInsights(data.normalizeCities([
            { city: 'Sunny', lat: 0, lng: 0,
              positive: 10, neutral: 0, negative: 0, total: 10, sources: [] },
            { city: 'Gloomy', lat: 10, lng: 10,
              positive: 1, neutral: 2, negative: 7, total: 10, sources: [] },
        ]));
        const { highest, lowest } = out.sentimentRatioExtremes;
        expect(Number.isFinite(highest.ratio)).toBe(true);
        expect(Number.isFinite(lowest.ratio)).toBe(true);
        expect(highest.ratio).toBeCloseTo(11 / 1, 10);
    });

    test('is null when fewer than 2 cities pass MIN_TOTAL (no single-city "divide")', () => {
        // One eligible city would make highest === lowest — a tautology, not
        // a divide. The divide chapter must take its fallback path instead.
        const out = computeInsights(data.normalizeCities([
            { city: 'Lonely', lat: 0, lng: 0,
              positive: 10, neutral: 0, negative: 0, total: 10, sources: [] },
            { city: 'Tiny', lat: 10, lng: 10,
              positive: 2, neutral: 1, negative: 0, total: 3, sources: [] }, // below guard
        ]));
        expect(out.sentimentRatioExtremes).toBeNull();
    });
});

describe('computeInsights() — source category aggregation', () => {
    test('dominantSourceCategoryGlobal aggregates across cities', () => {
        const { dominantSourceCategoryGlobal: dom } = fixtureInsights();
        expect(dom.category).toBe('social');
        expect(dom.total).toBe(244);
        expect(dom.share).toBeCloseTo(244 / 404, 10);
    });

    test('global category ties break alphabetically', () => {
        const out = computeInsights(data.normalizeCities([
            { city: 'X', lat: 0, lng: 0,
              positive: 10, neutral: 5, negative: 5, total: 20,
              sources: [
                  { source_name: 'a', source_category: 'social',
                    positive: 5, neutral: 3, negative: 2, total: 10 },
                  { source_name: 'b', source_category: 'news',
                    positive: 5, neutral: 2, negative: 3, total: 10 },
              ] },
        ]));
        expect(out.dominantSourceCategoryGlobal.category).toBe('news');
    });

    test('dominantSourceCategoryByCity maps every city to its top category', () => {
        expect(fixtureInsights().dominantSourceCategoryByCity).toEqual({
            Austin: 'social',
            Berlin: 'policy',
            Tokyo:  'social',
            Delhi:  'social',
        });
    });

    test('largestSourceConcentration finds the most single-source-dependent city', () => {
        const { largestSourceConcentration: conc } = fixtureInsights();
        expect(conc.city.city).toBe('Tokyo'); // carries the city OBJECT
        expect(conc.source_name).toBe('twitter');
        expect(conc.source_category).toBe('social');
        expect(conc.pct).toBeCloseTo(0.9, 10);
    });

    test('largestSourceConcentration carries the full city object, not just a name', () => {
        const cities = data.normalizeCities(rawFixture());
        const { largestSourceConcentration: conc } = computeInsights(cities);
        const tokyo = cities.find(c => c.city === 'Tokyo');
        expect(conc.city).toBe(tokyo); // same reference as the input city
        expect(Number.isFinite(conc.city.lat)).toBe(true);
        expect(Number.isFinite(conc.city.lng)).toBe(true);
    });

    test('concentration disambiguates same-name cities by carrying the object', () => {
        // Two cities both named "Springfield" — a name lookup would resolve
        // to the wrong (first) one; the object carry must reference the
        // actually concentrated city (the one at lng 20).
        const cities = data.normalizeCities([
            { city: 'Springfield', lat: 40, lng: -90,
              positive: 5, neutral: 3, negative: 2, total: 10,
              sources: [
                  { source_name: 'reddit', source_category: 'social',
                    positive: 3, neutral: 1, negative: 1, total: 5 },
                  { source_name: 'gazette', source_category: 'news',
                    positive: 2, neutral: 2, negative: 1, total: 5 },
              ] },
            { city: 'Springfield', lat: 10, lng: 20,
              positive: 8, neutral: 1, negative: 1, total: 10,
              sources: [
                  { source_name: 'reddit', source_category: 'social',
                    positive: 8, neutral: 1, negative: 1, total: 10 },
              ] },
        ]);
        const { largestSourceConcentration: conc } = computeInsights(cities);
        expect(conc.pct).toBeCloseTo(1, 10);
        expect(conc.city).toBe(cities[1]); // the 100%-reddit Springfield
        expect(conc.city.lng).toBe(20);
    });

    test('concentration pct is clamped to 1 on inconsistent upstream rows', () => {
        // Source counts exceeding the city's own counts (bad upstream
        // aggregation) must not report a >100% concentration.
        const cities = data.normalizeCities([
            { city: 'Broken', lat: 0, lng: 0,
              positive: 5, neutral: 0, negative: 0, total: 5,
              sources: [
                  { source_name: 'firehose', source_category: 'social',
                    positive: 100, neutral: 0, negative: 0, total: 100 },
              ] },
        ]);
        const { largestSourceConcentration: conc } = computeInsights(cities);
        expect(conc.pct).toBe(1);
        expect(conc.city.city).toBe('Broken');
    });

    test('concentration ignores cities below MIN_TOTAL', () => {
        // Delhi is 100% reddit but has only 4 posts — must not win.
        expect(fixtureInsights().largestSourceConcentration.city.city).not.toBe('Delhi');
    });
});

describe('regionOf(lat, lng)', () => {
    test('buckets the three reference cities correctly', () => {
        expect(regionOf(40.7128, -74.0060)).toBe('Americas');        // NYC
        expect(regionOf(52.5200, 13.4050)).toBe('Europe-Africa');    // Berlin
        expect(regionOf(35.6762, 139.6503)).toBe('Asia-Pacific');    // Tokyo
    });

    test('boundary longitudes land in a deterministic bucket', () => {
        expect(regionOf(0, -30)).toBe('Europe-Africa');   // Americas/E-A boundary
        expect(regionOf(0, 60)).toBe('Asia-Pacific');     // E-A/A-P boundary
        expect(regionOf(0, -180)).toBe('Americas');       // antimeridian west
        expect(regionOf(0, 180)).toBe('Asia-Pacific');    // antimeridian east
        expect(regionOf(0, -30.0001)).toBe('Americas');
        expect(regionOf(0, 59.9999)).toBe('Europe-Africa');
    });

    test('regionalDominance totals and leader from the fixture', () => {
        const { regionalDominance: reg } = fixtureInsights();
        expect(reg.totals).toEqual({
            'Americas': 200,          // Austin
            'Europe-Africa': 100,     // Berlin
            'Asia-Pacific': 104,      // Tokyo 100 + Delhi 4
        });
        expect(reg.leader).toBe('Americas');
    });
});

describe('computeInsights() — extremesDelta vs global average', () => {
    test('deltas are percentage-point gaps between extreme city and global share', () => {
        const { extremesDelta: delta } = fixtureInsights();
        expect(delta.positivePct).toBeCloseTo(0.70 - 204 / 404, 10);
        expect(delta.negativePct).toBeCloseTo(0.60 - 90 / 404, 10);
    });
});

describe('computeInsights() — empty / invalid input', () => {
    test.each([[[]], [null], [undefined]])('input %p does not throw', (input) => {
        expect(() => computeInsights(input)).not.toThrow();
    });

    test('empty input yields zeroed totals and null superlatives', () => {
        const out = computeInsights([]);
        expect(out.cityCount).toBe(0);
        expect(out.globalTotals).toEqual({ positive: 0, neutral: 0, negative: 0, total: 0 });
        expect(out.globalShares).toEqual({ positive: 0, neutral: 0, negative: 0 });
        expect(out.highestVolumeCity).toBeNull();
        expect(out.mostPositiveCity).toBeNull();
        expect(out.mostNegativeCity).toBeNull();
        expect(out.sentimentRatioExtremes).toBeNull();
        expect(out.dominantSourceCategoryGlobal).toBeNull();
        expect(out.dominantSourceCategoryByCity).toEqual({});
        expect(out.largestSourceConcentration).toBeNull();
        expect(out.extremesDelta).toBeNull();
        expect(out.regionalDominance.leader).toBeNull();
        expect(out.regionalDominance.totals).toEqual({
            'Americas': 0, 'Europe-Africa': 0, 'Asia-Pacific': 0,
        });
    });
});

// ── 11-beat story derivations ────────────────────────────────────────────────

describe('catBreakdown(city)', () => {
    const austin = () => data.normalizeCities(rawFixture())[0];
    const tokyo = () => data.normalizeCities(rawFixture())[2];

    test('aggregates sources by category into {category, share, net} rows', () => {
        // Austin: social 120 of 200 (net (80−10)/120), news 80 of 200 (net 30/80)
        const rows = catBreakdown(austin());
        expect(rows).toHaveLength(2);
        expect(rows[0].category).toBe('social');
        expect(rows[0].share).toBeCloseTo(120 / 200, 10);
        expect(rows[0].net).toBeCloseTo(70 / 120, 10);
        expect(rows[1].category).toBe('news');
        expect(rows[1].share).toBeCloseTo(80 / 200, 10);
        expect(rows[1].net).toBeCloseTo(30 / 80, 10);
    });

    test('rows are sorted by share descending', () => {
        const rows = catBreakdown(tokyo());
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i - 1].share).toBeGreaterThanOrEqual(rows[i].share);
        }
        expect(rows[0].category).toBe('social');   // 90 of 100
        expect(rows[1].category).toBe('academic'); // 10 of 100
    });

    test('merges multiple sources of the same category into one row', () => {
        const [city] = data.normalizeCities([
            { city: 'Twin', lat: 0, lng: 0,
              positive: 20, neutral: 0, negative: 10, total: 30,
              sources: [
                  { source_name: 'reddit',  source_category: 'social',
                    positive: 10, neutral: 0, negative: 0, total: 10 },
                  { source_name: 'twitter', source_category: 'social',
                    positive: 10, neutral: 0, negative: 10, total: 20 },
              ] },
        ]);
        const rows = catBreakdown(city);
        expect(rows).toHaveLength(1);
        expect(rows[0].category).toBe('social');
        expect(rows[0].share).toBe(1);
        expect(rows[0].net).toBeCloseTo(10 / 30, 10); // (20 − 10) / 30
    });

    test('shares sum to 1 when the city has sources', () => {
        for (const city of data.normalizeCities(data.DEMO_DATA)) {
            const rows = catBreakdown(city);
            const sum = rows.reduce((a, r) => a + r.share, 0);
            expect(sum).toBeCloseTo(1, 10);
        }
    });

    test('empty/missing sources yield an empty array (no throw)', () => {
        const [bare] = data.normalizeCities([
            { city: 'Bare', lat: 0, lng: 0,
              positive: 1, neutral: 1, negative: 1, total: 3, sources: [] },
        ]);
        expect(catBreakdown(bare)).toEqual([]);
        expect(catBreakdown(null)).toEqual([]);
        expect(catBreakdown({})).toEqual([]);
    });
});

describe('widestCategoryDivide(cities)', () => {
    test('finds the city with the widest net span among ≥8%-share categories', () => {
        // Hand-computed spans (categories all ≥ 0.08 share):
        //   Austin: social 70/120 − news 30/80  ≈ 0.208
        //   Berlin: social −10/30 − policy −40/70 ≈ 0.238
        //   Tokyo:  social 57/90 − academic 3/10 ≈ 0.333  ← widest
        //   Delhi:  below MIN_TOTAL — excluded
        const d = widestCategoryDivide(data.normalizeCities(rawFixture()));
        expect(d.city.city).toBe('Tokyo');
        expect(d.hi).toEqual({ category: 'social', net: expect.closeTo(57 / 90, 10) });
        expect(d.lo).toEqual({ category: 'academic', net: expect.closeTo(3 / 10, 10) });
        expect(d.span).toBeCloseTo(57 / 90 - 3 / 10, 10);
    });

    test('carries the city OBJECT (not just a name)', () => {
        const cities = data.normalizeCities(rawFixture());
        const d = widestCategoryDivide(cities);
        expect(d.city).toBe(cities.find(c => c.city === 'Tokyo'));
        expect(Number.isFinite(d.city.lat)).toBe(true);
    });

    test('categories under the 8% share floor cannot set the divide', () => {
        // 'fringe' is wildly negative but owns only 5% of the city's posts —
        // the divide must come from the two big categories instead.
        const cities = data.normalizeCities([
            { city: 'Floor', lat: 0, lng: 0,
              positive: 60, neutral: 20, negative: 20, total: 100,
              sources: [
                  { source_name: 'a', source_category: 'social',
                    positive: 40, neutral: 10, negative: 0, total: 50 },
                  { source_name: 'b', source_category: 'news',
                    positive: 18, neutral: 9, negative: 18, total: 45 },
                  { source_name: 'c', source_category: 'fringe',
                    positive: 0, neutral: 0, negative: 5, total: 5 },
              ] },
        ]);
        const d = widestCategoryDivide(cities);
        expect(d.city.city).toBe('Floor');
        expect(d.lo.category).toBe('news');   // not 'fringe' (net −1, share 0.05)
        expect(d.hi.category).toBe('social');
    });

    test('MIN_TOTAL guard: tiny cities never win', () => {
        const cities = data.normalizeCities([
            { city: 'Tiny', lat: 0, lng: 0,
              positive: 2, neutral: 0, negative: 2, total: 4,
              sources: [
                  { source_name: 'a', source_category: 'social',
                    positive: 2, neutral: 0, negative: 0, total: 2 },
                  { source_name: 'b', source_category: 'news',
                    positive: 0, neutral: 0, negative: 2, total: 2 },
              ] },
        ]);
        expect(widestCategoryDivide(cities)).toBeNull();
    });

    test('null when no city has two qualifying categories', () => {
        const oneCat = data.normalizeCities([
            { city: 'Mono', lat: 0, lng: 0,
              positive: 10, neutral: 5, negative: 5, total: 20,
              sources: [
                  { source_name: 'reddit', source_category: 'social',
                    positive: 10, neutral: 5, negative: 5, total: 20 },
              ] },
        ]);
        expect(widestCategoryDivide(oneCat)).toBeNull();
        expect(widestCategoryDivide([])).toBeNull();
        expect(widestCategoryDivide(null)).toBeNull();
    });

    test('span ties break by higher city total, then alphabetically', () => {
        // Identical two-category structure → identical span; Big has more posts.
        const mk = (name, lng, scale) => ({
            city: name, lat: 0, lng,
            positive: 10 * scale, neutral: 0, negative: 10 * scale, total: 20 * scale,
            sources: [
                { source_name: 'a', source_category: 'social',
                  positive: 10 * scale, neutral: 0, negative: 0, total: 10 * scale },
                { source_name: 'b', source_category: 'news',
                  positive: 0, neutral: 0, negative: 10 * scale, total: 10 * scale },
            ],
        });
        const byTotal = widestCategoryDivide(
            data.normalizeCities([mk('Small', 0, 1), mk('Big', 10, 2)]));
        expect(byTotal.city.city).toBe('Big');

        const byName = widestCategoryDivide(
            data.normalizeCities([mk('Zed', 0, 1), mk('Alpha', 10, 1)]));
        expect(byName.city.city).toBe('Alpha');
    });
});

describe('ribbonRows(cities)', () => {
    test('aggregates per category across all cities with share/volume/net/split', () => {
        // Fixture totals: social 244 (pos 154 / neu 57 / neg 33), news 80,
        // policy 70, academic 10; global source volume 404.
        const rows = ribbonRows(data.normalizeCities(rawFixture()));
        expect(rows.map(r => r.category)).toEqual(['social', 'news', 'policy', 'academic']);

        const social = rows[0];
        expect(social.volume).toBe(244);
        expect(social.share).toBeCloseTo(244 / 404, 10);
        expect(social.net).toBeCloseTo((154 - 33) / 244, 10);
        expect(social.split.pos).toBeCloseTo(154 / 244, 10);
        expect(social.split.neu).toBeCloseTo(57 / 244, 10);
        expect(social.split.neg).toBeCloseTo(33 / 244, 10);

        const policy = rows.find(r => r.category === 'policy');
        expect(policy.volume).toBe(70);
        expect(policy.net).toBeCloseTo((5 - 45) / 70, 10);
    });

    test('rows are sorted by share descending and shares sum to 1', () => {
        const rows = ribbonRows(data.normalizeCities(data.DEMO_DATA));
        for (let i = 1; i < rows.length; i++) {
            expect(rows[i - 1].share).toBeGreaterThanOrEqual(rows[i].share);
        }
        expect(rows.reduce((a, r) => a + r.share, 0)).toBeCloseTo(1, 10);
    });

    test('topSource is the highest-volume source within the category', () => {
        // social: reddit 120 + 30 + 4 = 154 across cities vs twitter 90.
        const rows = ribbonRows(data.normalizeCities(rawFixture()));
        expect(rows.find(r => r.category === 'social').topSource).toBe('reddit');
        expect(rows.find(r => r.category === 'news').topSource).toBe('statesman');
    });

    test('topSource merges the same source across cities before ranking', () => {
        const rows = ribbonRows(data.normalizeCities([
            { city: 'A', lat: 0, lng: 0, positive: 6, neutral: 0, negative: 0, total: 6,
              sources: [
                  { source_name: 'big_in_a', source_category: 'social',
                    positive: 4, neutral: 0, negative: 0, total: 4 },
                  { source_name: 'spread',   source_category: 'social',
                    positive: 2, neutral: 0, negative: 0, total: 2 },
              ] },
            { city: 'B', lat: 0, lng: 10, positive: 3, neutral: 0, negative: 0, total: 3,
              sources: [
                  { source_name: 'spread', source_category: 'social',
                    positive: 3, neutral: 0, negative: 0, total: 3 },
              ] },
        ]));
        expect(rows[0].topSource).toBe('spread'); // 2 + 3 = 5 beats 4
    });

    test('zero-volume categories report zeroed split and net (no NaN)', () => {
        const rows = ribbonRows(data.normalizeCities([
            { city: 'Ghost', lat: 0, lng: 0, positive: 0, neutral: 0, negative: 0, total: 0,
              sources: [
                  { source_name: 'quiet', source_category: 'social',
                    positive: 0, neutral: 0, negative: 0, total: 0 },
              ] },
        ]));
        expect(rows).toHaveLength(1);
        expect(rows[0].share).toBe(0);
        expect(rows[0].net).toBe(0);
        expect(rows[0].split).toEqual({ pos: 0, neu: 0, neg: 0 });
    });

    test('empty/invalid input yields an empty array', () => {
        expect(ribbonRows([])).toEqual([]);
        expect(ribbonRows(null)).toEqual([]);
        expect(ribbonRows(data.normalizeCities([
            { city: 'NoSrc', lat: 0, lng: 0,
              positive: 5, neutral: 0, negative: 0, total: 5, sources: [] },
        ]))).toEqual([]);
    });
});

describe('partitionThemes(themes, mode)', () => {
    // Prototype semantics: warm = net ≥ 0.1 sorted warmest-first,
    // cold = net < 0.1 sorted coldest-first.
    const themes = [
        { id: 'agents',     label: 'AI agents & automation', net: 0.34 },
        { id: 'regulation', label: 'Regulation & AI Act',    net: -0.22 },
        { id: 'jobs',       label: 'Jobs & displacement',    net: -0.17 },
        { id: 'health',     label: 'AI in healthcare',       net: 0.29 },
        { id: 'safety',     label: 'Safety & evals',         net: 0.08 },
        { id: 'boundary',   label: 'Boundary theme',         net: 0.1 },
    ];

    test('warm: net ≥ 0.1 (inclusive), sorted warmest first', () => {
        expect(partitionThemes(themes, 'warm').map(t => t.id))
            .toEqual(['agents', 'health', 'boundary']);
    });

    test('cold: net < 0.1, sorted coldest first (neutral themes are cold)', () => {
        expect(partitionThemes(themes, 'cold').map(t => t.id))
            .toEqual(['regulation', 'jobs', 'safety']);
    });

    test('warm and cold partition the theme list (no overlap, no loss)', () => {
        const warm = partitionThemes(themes, 'warm');
        const cold = partitionThemes(themes, 'cold');
        expect(warm.length + cold.length).toBe(themes.length);
        const ids = new Set([...warm, ...cold].map(t => t.id));
        expect(ids.size).toBe(themes.length);
    });

    test('accepts prototype-shaped themes carrying `sent` instead of `net`', () => {
        const proto = [
            { id: 'a', sent: 0.34 },
            { id: 'b', sent: -0.22 },
        ];
        expect(partitionThemes(proto, 'warm').map(t => t.id)).toEqual(['a']);
        expect(partitionThemes(proto, 'cold').map(t => t.id)).toEqual(['b']);
    });

    test('empty/invalid theme lists yield an empty array', () => {
        expect(partitionThemes([], 'warm')).toEqual([]);
        expect(partitionThemes(null, 'cold')).toEqual([]);
    });

    test('THROWS on an unknown mode (a typo must fail tests, not ship)', () => {
        expect(() => partitionThemes(themes, 'lukewarm')).toThrow(/lukewarm/);
        expect(() => partitionThemes(themes)).toThrow();
    });
});

describe('renderTemplate()', () => {
    test('replaces multiple distinct tokens', () => {
        expect(renderTemplate('{a} beats {b} by {gap}', { a: 'X', b: 'Y', gap: '12%' }))
            .toBe('X beats Y by 12%');
    });

    test('replaces repeated occurrences of the same token', () => {
        expect(renderTemplate('{city}, oh {city}!', { city: 'Berlin' }))
            .toBe('Berlin, oh Berlin!');
    });

    test('THROWS on a token missing from the values map', () => {
        expect(() => renderTemplate('hello {nope}', { yep: 1 }))
            .toThrow(/nope/);
    });

    test('leaves no brace residue when all tokens are supplied', () => {
        const out = renderTemplate('{a}-{b}', { a: 1, b: 2 });
        expect(out).not.toContain('{');
        expect(out).not.toContain('}');
    });
});

describe('TEMPLATES — one entry per story beat', () => {
    const CHAPTER_IDS = [
        'overview', 'volume', 'divide', 'negativity', 'positivity',
        'drivers', 'themes-warm', 'themes-cold', 'messengers',
        'summary', 'explore',
    ];

    test('has exactly the eleven story-beat template ids', () => {
        expect(Object.keys(TEMPLATES).sort()).toEqual([...CHAPTER_IDS].sort());
    });

    test('carries the verbatim prototype copy on the tokenless beats', () => {
        expect(TEMPLATES['themes-warm']).toBe(
            'Zoom past cities and the conversation splits into themes. '
            + 'The warm ones are concrete: people shipping agents, clinics '
            + 'piloting triage, models running on-device. The map lights up '
            + 'where these themes live.');
        expect(TEMPLATES['themes-cold']).toBe(
            'The cold themes are structural: regulation deadlines, jobs and '
            + 'displacement, the slow grind of safety evals. Now the map shows '
            + 'where the worry concentrates — policy and news capitals.');
        expect(TEMPLATES['explore']).toBe('The story’s over — the data isn’t. Try these:');
    });

    test('every template is a non-empty string that renders without residue', () => {
        for (const id of CHAPTER_IDS) {
            const tpl = TEMPLATES[id];
            expect(typeof tpl).toBe('string');
            expect(tpl.length).toBeGreaterThan(0);
            // Supply a dummy value for every token the template declares;
            // rendering must succeed and leave no '{' behind.
            const tokens = [...tpl.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(m => m[1]);
            const values = Object.fromEntries(tokens.map(t => [t, 'x']));
            const rendered = renderTemplate(tpl, values);
            expect(rendered).not.toContain('{');
            expect(rendered).not.toContain('}');
        }
    });
});

describe('module export shape', () => {
    test('exports exactly the documented public API', () => {
        expect(Object.keys(insights).sort()).toEqual([
            'MIN_TOTAL',
            'TEMPLATES',
            'catBreakdown',
            'computeInsights',
            'partitionThemes',
            'regionOf',
            'renderTemplate',
            'ribbonRows',
            'widestCategoryDivide',
        ]);
    });
});
