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

    test('FALLBACK_COPY explains the demo view', () => {
        expect(typeof FALLBACK_COPY).toBe('string');
        expect(FALLBACK_COPY).toMatch(/data unavailable/i);
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
