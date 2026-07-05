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

const { computeInsights, regionOf, renderTemplate, TEMPLATES, MIN_TOTAL } = insights;

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
        ]));
        const { highest, lowest } = out.sentimentRatioExtremes;
        expect(Number.isFinite(highest.ratio)).toBe(true);
        expect(Number.isFinite(lowest.ratio)).toBe(true);
        expect(highest.ratio).toBeCloseTo(11 / 1, 10);
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
        expect(conc.city).toBe('Tokyo');
        expect(conc.source_name).toBe('twitter');
        expect(conc.source_category).toBe('social');
        expect(conc.pct).toBeCloseTo(0.9, 10);
    });

    test('concentration ignores cities below MIN_TOTAL', () => {
        // Delhi is 100% reddit but has only 4 posts — must not win.
        expect(fixtureInsights().largestSourceConcentration.city).not.toBe('Delhi');
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

describe('TEMPLATES — one entry per story chapter', () => {
    const CHAPTER_IDS = [
        'overview', 'volume', 'positivity', 'negativity',
        'divide', 'sources', 'explore',
    ];

    test('has exactly the seven chapter template ids', () => {
        expect(Object.keys(TEMPLATES).sort()).toEqual([...CHAPTER_IDS].sort());
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
            'computeInsights',
            'regionOf',
            'renderTemplate',
        ]);
    });
});
