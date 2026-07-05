// Pure unit tests for public/js/chapters.js (PulseChapters module).
// No DB, no browser — runs under jest.pure.config.js (and the main suite).
//
// Contracts (from docs/plans/2026-07-05-globe-storytelling-design.md):
//   - CHAPTERS: 7-chapter config (Overview → Volume leaders → Positivity
//     leaders → Negativity hotspots → The divide → Who's driving the
//     conversation → explore) with schema {id, camera{lat,lng,altitude},
//     cameraMs, encoding{metric,colorMode,filter}, highlight, arcs,
//     insight{templateId,title}, autoRotate}.
//   - Every insight.templateId exists in PulseInsights.TEMPLATES.
//   - Every non-null highlight key exists on computeInsights() output.
//   - resolveChapter(chapter, insights, cities) over DEMO_DATA leaves no
//     unreplaced {tokens}; empty data → fallback copy + valid camera.

'use strict';

const chapters = require('../../../public/js/chapters');
const insightsMod = require('../../../public/js/insights');
const data = require('../../../public/js/data');

const { CHAPTERS, resolveChapter, FALLBACK_COPY } = chapters;
const { computeInsights, TEMPLATES } = insightsMod;

const demoCities = data.normalizeCities(data.DEMO_DATA);
const demoInsights = computeInsights(demoCities);
const emptyInsights = computeInsights([]);

function validCamera(camera) {
    return camera
        && Number.isFinite(camera.lat) && camera.lat >= -90 && camera.lat <= 90
        && Number.isFinite(camera.lng) && camera.lng >= -180 && camera.lng <= 180
        && Number.isFinite(camera.altitude) && camera.altitude > 0;
}

describe('CHAPTERS config — structure', () => {
    test('is the seven-chapter story sequence from the design doc', () => {
        expect(CHAPTERS.map(c => c.id)).toEqual([
            'overview', 'volume', 'positivity', 'negativity',
            'divide', 'sources', 'explore',
        ]);
    });

    test('chapter ids are unique', () => {
        const ids = CHAPTERS.map(c => c.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('has exactly one explore chapter, and it is last', () => {
        const explorers = CHAPTERS.filter(c => c.id === 'explore');
        expect(explorers).toHaveLength(1);
        expect(CHAPTERS[CHAPTERS.length - 1].id).toBe('explore');
    });

    test.each(
        // (id first so the test name reads well)
        []
            .concat(require('../../../public/js/chapters').CHAPTERS
                .map(c => [c.id, c]))
    )('chapter "%s" matches the schema', (_id, ch) => {
        expect(validCamera(ch.camera)).toBe(true);
        expect(Number.isFinite(ch.cameraMs)).toBe(true);
        expect(ch.cameraMs).toBeGreaterThan(0);
        expect(typeof ch.encoding).toBe('object');
        expect(typeof ch.encoding.metric).toBe('string');
        expect(ch.encoding.metric.length).toBeGreaterThan(0);
        expect(typeof ch.encoding.colorMode).toBe('string');
        expect('filter' in ch.encoding).toBe(true);
        expect('highlight' in ch).toBe(true);
        expect(typeof ch.arcs).toBe('boolean');
        expect(typeof ch.insight).toBe('object');
        expect(typeof ch.insight.templateId).toBe('string');
        expect(typeof ch.insight.title).toBe('string');
        expect(ch.insight.title.length).toBeGreaterThan(0);
        expect(typeof ch.autoRotate).toBe('boolean');
    });

    test('every insight.templateId exists in TEMPLATES', () => {
        for (const ch of CHAPTERS) {
            expect(TEMPLATES).toHaveProperty(ch.insight.templateId);
        }
    });

    test('every non-null highlight key exists on computeInsights() output', () => {
        const insightKeys = Object.keys(emptyInsights);
        for (const ch of CHAPTERS) {
            if (ch.highlight !== null) {
                expect(insightKeys).toContain(ch.highlight);
            }
        }
    });

    test('only the divide chapter draws arcs; only explore auto-rotates', () => {
        for (const ch of CHAPTERS) {
            expect(ch.arcs).toBe(ch.id === 'divide');
            expect(ch.autoRotate).toBe(ch.id === 'explore');
        }
    });
});

describe('resolveChapter() over DEMO_DATA', () => {
    test.each(CHAPTERS.map(c => [c.id, c]))(
        'chapter "%s" resolves with no unreplaced tokens', (_id, ch) => {
            const r = resolveChapter(ch, demoInsights, demoCities);
            expect(typeof r.cardTitle).toBe('string');
            expect(r.cardTitle.length).toBeGreaterThan(0);
            expect(typeof r.cardBody).toBe('string');
            expect(r.cardBody.length).toBeGreaterThan(0);
            expect(r.cardBody).not.toContain('{');
            expect(r.cardBody).not.toContain('}');
            expect(r.cardBody).not.toBe(FALLBACK_COPY); // demo data is rich enough
            expect(validCamera(r.camera)).toBe(true);
            expect(r.encoding).toEqual(ch.encoding);
        });

    test('highlight chapters resolve to real city objects with coordinates', () => {
        for (const ch of CHAPTERS) {
            const r = resolveChapter(ch, demoInsights, demoCities);
            expect(Array.isArray(r.highlightCities)).toBe(true);
            if (ch.highlight !== null) {
                expect(r.highlightCities.length).toBeGreaterThan(0);
                for (const c of r.highlightCities) {
                    expect(Number.isFinite(c.lat)).toBe(true);
                    expect(Number.isFinite(c.lng)).toBe(true);
                    expect(demoCities).toContain(c);
                }
            } else {
                expect(r.highlightCities).toEqual([]);
            }
        }
    });

    test('camera centers on the first highlighted city when one exists', () => {
        const volume = CHAPTERS.find(c => c.id === 'volume');
        const r = resolveChapter(volume, demoInsights, demoCities);
        expect(r.camera.lat).toBe(demoInsights.highestVolumeCity.lat);
        expect(r.camera.lng).toBe(demoInsights.highestVolumeCity.lng);
        expect(r.camera.altitude).toBe(volume.camera.altitude);
    });

    test('the divide chapter yields one arc between the ratio extremes', () => {
        const divide = CHAPTERS.find(c => c.id === 'divide');
        const r = resolveChapter(divide, demoInsights, demoCities);
        expect(r.arcs).toHaveLength(1);
        const arc = r.arcs[0];
        const { highest, lowest } = demoInsights.sentimentRatioExtremes;
        expect(arc.startLat).toBe(highest.city.lat);
        expect(arc.startLng).toBe(highest.city.lng);
        expect(arc.endLat).toBe(lowest.city.lat);
        expect(arc.endLng).toBe(lowest.city.lng);
    });

    test('non-divide chapters yield no arcs', () => {
        for (const ch of CHAPTERS.filter(c => c.id !== 'divide')) {
            expect(resolveChapter(ch, demoInsights, demoCities).arcs).toEqual([]);
        }
    });

    test('passes id, cameraMs, and autoRotate through for the story runner', () => {
        for (const ch of CHAPTERS) {
            const r = resolveChapter(ch, demoInsights, demoCities);
            expect(r.id).toBe(ch.id);
            expect(r.cameraMs).toBe(ch.cameraMs);
            expect(r.autoRotate).toBe(ch.autoRotate);
        }
    });
});

describe('resolveChapter() with empty data', () => {
    test.each(CHAPTERS.map(c => [c.id, c]))(
        'chapter "%s" falls back to safe copy and a valid static camera', (_id, ch) => {
            const r = resolveChapter(ch, emptyInsights, []);
            expect(r.cardBody).toBe(FALLBACK_COPY);
            expect(r.cardBody).not.toContain('{');
            expect(validCamera(r.camera)).toBe(true);
            expect(r.camera).toEqual(ch.camera);   // static fallback
            expect(r.highlightCities).toEqual([]);
            expect(r.arcs).toEqual([]);
        });

    test('FALLBACK_COPY says there is no data (its only trigger has none at all)', () => {
        expect(typeof FALLBACK_COPY).toBe('string');
        expect(FALLBACK_COPY).toMatch(/no data available/i);
        // Must NOT promise a demo view — demo mode is signalled via isDemo.
        expect(FALLBACK_COPY).not.toMatch(/demo/i);
    });
});

describe('resolveChapter() — divide chapter with fewer than 2 eligible cities', () => {
    test('falls back when only one city passes MIN_TOTAL (no single-city divide)', () => {
        const oneEligible = data.normalizeCities([
            { city: 'Lonely', lat: 10, lng: 20,
              positive: 10, neutral: 0, negative: 0, total: 10, sources: [] },
            { city: 'Tiny', lat: 0, lng: 0,
              positive: 2, neutral: 1, negative: 0, total: 3, sources: [] },
        ]);
        const ins = computeInsights(oneEligible);
        expect(ins.sentimentRatioExtremes).toBeNull();

        const divide = CHAPTERS.find(c => c.id === 'divide');
        const r = resolveChapter(divide, ins, oneEligible);
        expect(r.cardBody).toBe(FALLBACK_COPY);
        expect(r.arcs).toEqual([]);
        expect(r.highlightCities).toEqual([]);
        expect(r.camera).toEqual(divide.camera); // static fallback camera
    });
});

describe('resolveChapter() — isDemo propagation (demo-data transparency)', () => {
    test('isDemo:true marks the card title and the resolved chapter', () => {
        for (const ch of CHAPTERS) {
            const r = resolveChapter(ch, demoInsights, demoCities, { isDemo: true });
            expect(r.isDemo).toBe(true);
            expect(r.cardTitle).toBe(ch.insight.title + ' — Demo data');
        }
    });

    test('live data (isDemo omitted or false) carries no demo marker', () => {
        for (const ch of CHAPTERS) {
            const omitted = resolveChapter(ch, demoInsights, demoCities);
            expect(omitted.isDemo).toBe(false);
            expect(omitted.cardTitle).toBe(ch.insight.title);

            const explicit = resolveChapter(ch, demoInsights, demoCities, { isDemo: false });
            expect(explicit.isDemo).toBe(false);
            expect(explicit.cardTitle).toBe(ch.insight.title);
        }
    });

    test('loadCityData isDemo flag plugs straight into resolveChapter', async () => {
        // End-to-end wiring of the transparency contract: fallback load →
        // isDemo:true → visibly marked chapter.
        const realFetch = global.fetch;
        global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
        try {
            const { cities, isDemo } = await data.loadCityData();
            expect(isDemo).toBe(true);
            const ins = computeInsights(cities);
            const r = resolveChapter(CHAPTERS[0], ins, cities, { isDemo });
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

    function maliciousCities() {
        return data.normalizeCities([
            { city: XSS_CITY, lat: 10, lng: 20,
              positive: 90, neutral: 5, negative: 5, total: 100,
              sources: [
                  { source_name: '<script>steal()</script>',
                    source_category: '"><b>cat</b>',
                    positive: 90, neutral: 5, negative: 5, total: 100 },
              ] },
            { city: 'Plainville', lat: 0, lng: 0,
              positive: 1, neutral: 2, negative: 7, total: 10,
              sources: [
                  { source_name: 'reddit', source_category: 'social',
                    positive: 1, neutral: 2, negative: 7, total: 10 },
              ] },
        ]);
    }

    test.each(CHAPTERS.map(c => [c.id, c]))(
        'chapter "%s" card body contains no raw < or > from hostile data', (_id, ch) => {
            const cities = maliciousCities();
            const ins = computeInsights(cities);
            const r = resolveChapter(ch, ins, cities);
            expect(r.cardBody).not.toContain('<');
            expect(r.cardBody).not.toContain('>');
        });

    test('a hostile city name is escaped in the volume card (&lt;img …)', () => {
        const cities = maliciousCities();
        const ins = computeInsights(cities);
        expect(ins.highestVolumeCity.city).toBe(XSS_CITY); // it wins volume
        const volume = CHAPTERS.find(c => c.id === 'volume');
        const r = resolveChapter(volume, ins, cities);
        expect(r.cardBody).toContain('&lt;img');
        expect(r.cardBody).not.toContain('<img');
    });

    test('hostile source and category names are escaped in the sources card', () => {
        const cities = maliciousCities();
        const ins = computeInsights(cities);
        const sources = CHAPTERS.find(c => c.id === 'sources');
        const r = resolveChapter(sources, ins, cities);
        expect(r.cardBody).toContain('&lt;script&gt;');
        expect(r.cardBody).not.toContain('<script>');
        expect(r.cardBody).not.toContain('"><b>');
    });
});

describe('module export shape', () => {
    test('exports exactly the documented public API', () => {
        expect(Object.keys(chapters).sort()).toEqual([
            'CHAPTERS',
            'FALLBACK_COPY',
            'resolveChapter',
        ]);
    });
});
