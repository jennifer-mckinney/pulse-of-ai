// Pure unit tests for public/js/chapters.js (PulseChapters module).
// No DB, no browser — runs under jest.pure.config.js (and the main suite).
//
// Contracts (11-beat scroll story, config-driven):
//   - The resolver consumes PulseStoryConfig.STORY (dependency-injected via
//     the UMD factory) and re-exports it as STORY.
//   - resolveChapter(beat, insights, cities, opts) → render-ready state:
//     {id, kicker, cardTitle, cardBody, camera, cameraMs, colorMode,
//      barMetric, auditPick, themePartition, explore, nextSteps, stats,
//      highlightCities, isDemo}.
//   - No unresolved {tokens} on DEMO_DATA (body OR stats); empty insights →
//     FALLBACK_COPY + valid camera; camera follows the FIRST highlighted
//     city; isDemo suffixes the card title; attacker-influenceable strings
//     are esc()-escaped at token entry (defense in depth — consumers still
//     render via textContent, never innerHTML).

'use strict';

const chapters = require('../../../public/js/chapters');
const insightsMod = require('../../../public/js/insights');
const storyConfig = require('../../../public/js/config/story.config');
const utils = require('../../../public/js/utils');
const data = require('../../../public/js/data');

const { STORY, resolveChapter, FALLBACK_COPY } = chapters;
const { computeInsights, MIN_TOTAL } = insightsMod;
const { netSentiment, fmtNet, fmtCount } = utils;

const demoCities = data.normalizeCities(data.DEMO_DATA);
const demoInsights = computeInsights(demoCities);
const emptyInsights = computeInsights([]);

function validCamera(camera) {
    return camera
        && Number.isFinite(camera.lat) && camera.lat >= -90 && camera.lat <= 90
        && Number.isFinite(camera.lng) && camera.lng >= -180 && camera.lng <= 180
        && Number.isFinite(camera.altitude) && camera.altitude > 0;
}

function beat(id) {
    return STORY.find(b => b.id === id);
}

describe('STORY re-export', () => {
    test('is the injected PulseStoryConfig.STORY (same reference)', () => {
        expect(STORY).toBe(storyConfig.STORY);
    });

    test('is the 11-beat sequence in design order', () => {
        expect(STORY.map(b => b.id)).toEqual([
            'overview', 'volume', 'divide', 'negativity', 'positivity',
            'drivers', 'themes-warm', 'themes-cold', 'messengers',
            'summary', 'explore',
        ]);
    });
});

describe('resolveChapter() over DEMO_DATA', () => {
    test.each(STORY.map(b => [b.id, b]))(
        'beat "%s" resolves with no unreplaced tokens', (_id, b) => {
            const r = resolveChapter(b, demoInsights, demoCities);
            expect(r.id).toBe(b.id);
            expect(r.kicker).toBe(b.kicker);
            expect(typeof r.cardTitle).toBe('string');
            expect(r.cardTitle.length).toBeGreaterThan(0);
            expect(typeof r.cardBody).toBe('string');
            expect(r.cardBody.length).toBeGreaterThan(0);
            expect(r.cardBody).not.toContain('{');
            expect(r.cardBody).not.toContain('}');
            expect(r.cardBody).not.toBe(FALLBACK_COPY); // demo data is rich enough
            expect(validCamera(r.camera)).toBe(true);
            // stats resolved from statsSpec with the same token map
            expect(Array.isArray(r.stats)).toBe(true);
            expect(r.stats).toHaveLength(b.statsSpec.length);
            for (const [label, value] of r.stats) {
                expect(typeof label).toBe('string');
                expect(typeof value).toBe('string');
                expect(label + value).not.toContain('{');
                expect(label + value).not.toContain('}');
            }
        });

    test.each(STORY.map(b => [b.id, b]))(
        'beat "%s" carries its encodings through unchanged', (_id, b) => {
            const r = resolveChapter(b, demoInsights, demoCities);
            expect(r.cameraMs).toBe(b.cameraMs);
            expect(r.colorMode).toBe(b.colorMode);
            expect(r.barMetric).toBe(b.barMetric);
            expect(r.auditPick).toBe(b.auditPick);
            expect(r.themePartition).toBe(b.themePartition);
            expect(r.explore).toBe(b.explore);
        });

    test('highlighted beats resolve to real city objects with coordinates', () => {
        for (const b of STORY) {
            const r = resolveChapter(b, demoInsights, demoCities);
            expect(Array.isArray(r.highlightCities)).toBe(true);
            if (b.highlightRule !== null) {
                expect(r.highlightCities.length).toBeGreaterThan(0);
                for (const c of r.highlightCities) {
                    expect(demoCities).toContain(c);
                    expect(Number.isFinite(c.lat)).toBe(true);
                    expect(Number.isFinite(c.lng)).toBe(true);
                }
            } else {
                expect(r.highlightCities).toEqual([]);
            }
        }
    });

    test('volumeTop3: the three highest-volume demo cities in order', () => {
        const r = resolveChapter(beat('volume'), demoInsights, demoCities);
        expect(r.highlightCities.map(c => c.city))
            .toEqual(['New York', 'Beijing', 'Tokyo']); // 400, 330, 292
    });

    test('negativeTop3: the three coolest eligible cities, coolest first', () => {
        const r = resolveChapter(beat('negativity'), demoInsights, demoCities);
        expect(r.highlightCities.map(c => c.city))
            .toEqual(['Berlin', 'London', 'São Paulo']); // −0.20, +0.08, +0.09
    });

    test('positiveTop3: the three warmest eligible cities, warmest first', () => {
        const r = resolveChapter(beat('positivity'), demoInsights, demoCities);
        expect(r.highlightCities.map(c => c.city))
            .toEqual(['Bangalore', 'Tokyo', 'Seoul']); // +0.57, +0.57, +0.54
        // independent check against netSentiment itself
        const ranked = demoCities.filter(c => c.total >= MIN_TOTAL)
            .sort((a, b) => netSentiment(b) - netSentiment(a));
        expect(r.highlightCities).toEqual(ranked.slice(0, 3));
    });

    test('widestDivide: highlights exactly the divide city', () => {
        const d = insightsMod.widestCategoryDivide(demoCities);
        const r = resolveChapter(beat('divide'), demoInsights, demoCities);
        expect(r.highlightCities).toEqual([d.city]);
    });

    test('summaryTrio: warmest + coolest + volume leader, deduplicated', () => {
        const r = resolveChapter(beat('summary'), demoInsights, demoCities);
        expect(r.highlightCities.map(c => c.city))
            .toEqual(['Bangalore', 'Berlin', 'New York']);
        expect(new Set(r.highlightCities).size).toBe(r.highlightCities.length);
    });

    test('camera follows the FIRST highlighted city (beat altitude kept)', () => {
        for (const id of ['volume', 'divide', 'negativity', 'positivity', 'summary']) {
            const b = beat(id);
            const r = resolveChapter(b, demoInsights, demoCities);
            expect(r.camera.lat).toBe(r.highlightCities[0].lat);
            expect(r.camera.lng).toBe(r.highlightCities[0].lng);
            expect(r.camera.altitude).toBe(b.altitude);
        }
    });

    test('static-camera beats pan to their configured region', () => {
        for (const id of ['drivers', 'themes-warm', 'themes-cold']) {
            const b = beat(id);
            const r = resolveChapter(b, demoInsights, demoCities);
            expect(r.camera).toEqual(b.camera);
        }
    });

    test('global beats (camera null, no highlight) use the global default view', () => {
        for (const id of ['overview', 'messengers', 'explore']) {
            const b = beat(id);
            const r = resolveChapter(b, demoInsights, demoCities);
            expect(r.camera).toEqual({ lat: 20, lng: 10, altitude: b.altitude });
        }
    });

    test('overview stats resolve to the hand-computed demo values', () => {
        const r = resolveChapter(beat('overview'), demoInsights, demoCities);
        // DEMO_DATA sums: total 3,062; net (1539 − 566) / 3062 ≈ +0.32
        expect(r.stats).toEqual([
            ['posts / hour', '3,062'],
            ['global sentiment', '+0.32'],
            ['cities reporting', '12'],
        ]);
        expect(fmtCount(demoInsights.globalTotals.total)).toBe('3,062');
        expect(fmtNet(netSentiment(demoInsights.globalTotals))).toBe('+0.32');
    });

    test('volume stats are the top-three city/volume pairs', () => {
        const r = resolveChapter(beat('volume'), demoInsights, demoCities);
        expect(r.stats).toEqual([
            ['New York', '400/hr'],
            ['Beijing', '330/hr'],
            ['Tokyo', '292/hr'],
        ]);
    });

    test('divide card interpolates the widest-divide derivation', () => {
        const d = insightsMod.widestCategoryDivide(demoCities);
        const r = resolveChapter(beat('divide'), demoInsights, demoCities);
        expect(r.cardBody).toContain(`In ${d.city.city}, ${d.hi.category} sources run at ${fmtNet(d.hi.net)}`);
        expect(r.cardBody).toContain(`a ${d.span.toFixed(2)} divergence`);
        expect(r.stats[2]).toEqual(['divergence', `${d.span.toFixed(2)} — global max`]);
    });

    test('overview and summary interpolate the DERIVED category count — no hardcoded editorial claims', () => {
        // The payload cannot support "50 sources" / "7 categories" claims;
        // the count must come from ribbonRows (5 categories in DEMO_DATA).
        const catCount = insightsMod.ribbonRows(demoCities).length;
        expect(catCount).toBe(5); // fixture sanity — demo is NOT 7 categories

        const overview = resolveChapter(beat('overview'), demoInsights, demoCities);
        expect(overview.cardBody).not.toContain('50 sources');
        expect(overview.cardBody).not.toContain('7 categories');
        expect(overview.cardBody).toContain(`${catCount} source categories`);

        const summary = resolveChapter(beat('summary'), demoInsights, demoCities);
        expect(summary.cardBody).not.toContain('7 source categories');
        expect(summary.cardBody).toContain(`${catCount} source categories`);
    });

    test('positivity interpolates the warmest city\'s dominant category (mirrors negativity)', () => {
        const r = resolveChapter(beat('positivity'), demoInsights, demoCities);
        // The prototype hardcoded "builder communities posting their own
        // results" — an editorial claim the data cannot back. The card must
        // name the dominant source category of the warmest city instead.
        expect(r.cardBody).not.toContain('builder communities');
        const topCat = insightsMod.catBreakdown(r.highlightCities[0])[0];
        expect(r.cardBody).toContain(topCat.category);
    });

    test('messengers card names the warmest/coldest categories and their lead sources', () => {
        const rows = insightsMod.ribbonRows(demoCities);
        const bySent = [...rows].sort((a, b) => b.net - a.net);
        const hi = bySent[0];
        const lo = bySent[bySent.length - 1];
        const r = resolveChapter(beat('messengers'), demoInsights, demoCities);
        expect(r.cardBody).toContain(`${hi.category} sources run warmest this hour (${fmtNet(hi.net)}), led by ${hi.topSource}`);
        expect(r.cardBody).toContain(`${lo.category} sources run coldest (${fmtNet(lo.net)}), led by ${lo.topSource}`);
        expect(r.cardBody).toContain(`a ${(hi.net - lo.net).toFixed(2)} gap`);
    });

    test('explore beat carries nextSteps as an independent copy', () => {
        const b = beat('explore');
        const r = resolveChapter(b, demoInsights, demoCities);
        expect(r.nextSteps).toEqual(b.nextSteps);
        expect(r.nextSteps).not.toBe(b.nextSteps); // mutation-safe copy
        r.nextSteps.push('mutated');
        expect(b.nextSteps).toHaveLength(5);
    });

    test('non-explore beats carry nextSteps: null', () => {
        for (const b of STORY.filter(x => !x.explore)) {
            expect(resolveChapter(b, demoInsights, demoCities).nextSteps).toBeNull();
        }
    });
});

describe('resolveChapter() with empty data', () => {
    test.each(STORY.map(b => [b.id, b]))(
        'beat "%s" falls back to safe copy and a valid camera', (_id, b) => {
            const r = resolveChapter(b, emptyInsights, []);
            expect(r.cardBody).toBe(FALLBACK_COPY);
            expect(r.cardBody).not.toContain('{');
            expect(validCamera(r.camera)).toBe(true);
            if (b.camera !== null) {
                expect(r.camera).toEqual(b.camera);            // static fallback
            } else {
                expect(r.camera).toEqual({ lat: 20, lng: 10, altitude: b.altitude });
            }
            expect(r.highlightCities).toEqual([]);
            expect(r.stats).toEqual([]);
        });

    test('FALLBACK_COPY says there is no data and never promises a demo view', () => {
        expect(typeof FALLBACK_COPY).toBe('string');
        expect(FALLBACK_COPY).toMatch(/no data available/i);
        expect(FALLBACK_COPY).not.toMatch(/demo/i);
    });
});

describe('resolveChapter() — degraded data (partial fallbacks)', () => {
    test('volume falls back when fewer than three cities exist', () => {
        const two = data.normalizeCities([
            { city: 'A', lat: 0, lng: 0, positive: 10, neutral: 0, negative: 0, total: 10, sources: [] },
            { city: 'B', lat: 10, lng: 10, positive: 5, neutral: 0, negative: 5, total: 10, sources: [] },
        ]);
        const r = resolveChapter(beat('volume'), computeInsights(two), two);
        expect(r.cardBody).toBe(FALLBACK_COPY);
        expect(r.stats).toEqual([]);
        // highlight rule still surfaces what exists — the globe can highlight
        // two capitals even when the three-city sentence cannot be told
        expect(r.highlightCities.map(c => c.city)).toEqual(['A', 'B']);
    });

    test('divide falls back when no city has two qualifying categories', () => {
        const mono = data.normalizeCities([
            { city: 'Mono', lat: 0, lng: 0, positive: 10, neutral: 5, negative: 5, total: 20,
              sources: [{ source_name: 'reddit', source_category: 'social',
                  positive: 10, neutral: 5, negative: 5, total: 20 }] },
        ]);
        const r = resolveChapter(beat('divide'), computeInsights(mono), mono);
        expect(r.cardBody).toBe(FALLBACK_COPY);
        expect(r.highlightCities).toEqual([]);
        expect(r.camera).toEqual({ lat: 20, lng: 10, altitude: beat('divide').altitude });
    });

    test('positivity falls back when the warmest city has no sources (no category to name)', () => {
        const cities = data.normalizeCities([
            { city: 'A', lat: 0, lng: 0, positive: 10, neutral: 0, negative: 0, total: 10, sources: [] },
            { city: 'B', lat: 5, lng: 5, positive: 8, neutral: 1, negative: 1, total: 10, sources: [] },
            { city: 'C', lat: 9, lng: 9, positive: 6, neutral: 2, negative: 2, total: 10, sources: [] },
        ]);
        const r = resolveChapter(beat('positivity'), computeInsights(cities), cities);
        expect(r.cardBody).toBe(FALLBACK_COPY);
        expect(r.stats).toEqual([]);
    });

    test('summary falls back when fewer than two cities pass MIN_TOTAL', () => {
        const one = data.normalizeCities([
            { city: 'Lonely', lat: 0, lng: 0, positive: 10, neutral: 0, negative: 0, total: 10, sources: [] },
            { city: 'Tiny', lat: 10, lng: 10, positive: 2, neutral: 1, negative: 0, total: 3, sources: [] },
        ]);
        const r = resolveChapter(beat('summary'), computeInsights(one), one);
        expect(r.cardBody).toBe(FALLBACK_COPY);
    });
});

describe('resolveChapter() — isDemo propagation (demo-data transparency)', () => {
    test('isDemo:true marks the card title and the resolved chapter', () => {
        for (const b of STORY) {
            const r = resolveChapter(b, demoInsights, demoCities, { isDemo: true });
            expect(r.isDemo).toBe(true);
            expect(r.cardTitle).toBe(b.title + ' — Demo data');
        }
    });

    test('live data (isDemo omitted or false) carries no demo marker', () => {
        for (const b of STORY) {
            const omitted = resolveChapter(b, demoInsights, demoCities);
            expect(omitted.isDemo).toBe(false);
            expect(omitted.cardTitle).toBe(b.title);

            const explicit = resolveChapter(b, demoInsights, demoCities, { isDemo: false });
            expect(explicit.isDemo).toBe(false);
            expect(explicit.cardTitle).toBe(b.title);
        }
    });

    test('loadCityData isDemo flag plugs straight into resolveChapter', async () => {
        const realFetch = global.fetch;
        global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
        try {
            const { cities, isDemo } = await data.loadCityData();
            expect(isDemo).toBe(true);
            const ins = computeInsights(cities);
            const r = resolveChapter(STORY[0], ins, cities, { isDemo });
            expect(r.isDemo).toBe(true);
            expect(r.cardTitle).toMatch(/Demo data$/);
        } finally {
            global.fetch = realFetch;
        }
    });
});

describe('resolveChapter() — XSS defense in depth (esc on data-derived names)', () => {
    // Attacker-controlled strings enter via API city/source/category names.
    // Consumers render via textContent, but the token builders must ALSO
    // HTML-escape these values so a wrong consumer cannot inject markup.
    const XSS_CITY = '<img src=x onerror=alert(1)>';

    // The hostile city dominates every ranking (volume, warmth) and its
    // hostile source/category dominate the ribbon, so the payloads flow
    // through every token path.
    function maliciousCities() {
        return data.normalizeCities([
            { city: XSS_CITY, lat: 10, lng: 20,
              positive: 900, neutral: 50, negative: 50, total: 1000,
              sources: [
                  { source_name: '<script>steal()</script>',
                    source_category: '"><b>cat</b>',
                    positive: 700, neutral: 40, negative: 40, total: 780 },
                  { source_name: 'reddit', source_category: 'social',
                    positive: 200, neutral: 10, negative: 10, total: 220 },
              ] },
            { city: 'Plainville', lat: 0, lng: 0,
              positive: 1, neutral: 2, negative: 7, total: 10,
              sources: [
                  { source_name: 'reddit', source_category: 'social',
                    positive: 1, neutral: 2, negative: 7, total: 10 },
              ] },
            { city: 'Midtown', lat: 5, lng: 5,
              positive: 5, neutral: 5, negative: 5, total: 15,
              sources: [
                  { source_name: 'wire', source_category: 'news',
                    positive: 5, neutral: 5, negative: 5, total: 15 },
              ] },
        ]);
    }

    test.each(STORY.map(b => [b.id, b]))(
        'beat "%s" card body and stats contain no raw < or > from hostile data', (_id, b) => {
            const cities = maliciousCities();
            const ins = computeInsights(cities);
            const r = resolveChapter(b, ins, cities);
            expect(r.cardBody).not.toContain('<');
            expect(r.cardBody).not.toContain('>');
            for (const [label, value] of r.stats) {
                expect(label).not.toContain('<');
                expect(label).not.toContain('>');
                expect(value).not.toContain('<');
                expect(value).not.toContain('>');
            }
        });

    test('a hostile city name is escaped in the volume card (&lt;img …)', () => {
        const cities = maliciousCities();
        const ins = computeInsights(cities);
        expect(ins.highestVolumeCity.city).toBe(XSS_CITY); // it wins volume
        const r = resolveChapter(beat('volume'), ins, cities);
        expect(r.cardBody).toContain('&lt;img');
        expect(r.cardBody).not.toContain('<img');
    });

    test('hostile source and category names are escaped in the messengers card', () => {
        const cities = maliciousCities();
        const ins = computeInsights(cities);
        const r = resolveChapter(beat('messengers'), ins, cities);
        expect(r.cardBody).toContain('&lt;script&gt;');
        expect(r.cardBody).not.toContain('<script>');
        expect(r.cardBody).not.toContain('"><b>');
    });
});

describe('module export shape', () => {
    test('exports exactly the documented public API', () => {
        expect(Object.keys(chapters).sort()).toEqual([
            'FALLBACK_COPY',
            'STORY',
            'resolveChapter',
        ]);
    });
});
