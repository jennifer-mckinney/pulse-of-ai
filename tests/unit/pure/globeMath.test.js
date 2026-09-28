// Pure unit tests for public/js/globe.js (PulseGlobe.math namespace).
// No DB, no browser, no canvas — runs under jest.pure.config.js.
//
// Contracts under test (handoff README "Globe rendering spec" + ZIP-revision
// user zoom + audit gaps G7/G8/G10/G11):
//   - color math: hexToRgb / mix / sentColor lerp across [neg, neu, pos]
//   - category slug mapping (display names → API slugs, unknown fallback)
//   - adaptCities: prototype demo shape AND normalized API shape
//   - orthographic projection + far-hemisphere culling
//   - rotation targets (drag / focus drift / auto-spin / reduced motion)
//   - user zoom: clamp, wheel factors, key steps, eased composition
//   - marker/bar/pillar/ring/land-dot formulas
//   - hit-test geometry (18px tolerance, radius discount)
//   - land generation: Fibonacci fallback, ringsFromLand (Feature vs
//     FeatureCollection guard), pointInRings, raster grid, nearest-city
//     land-heat assignment

'use strict';

const globe = require('../../../public/js/globe');
const design = require('../../../public/js/config/design.config');

const m = globe.math;
const D2R = Math.PI / 180;

// Default handoff palette in the array form the renderer consumes.
const PALETTE = [
    design.SENTIMENT_PALETTE.negative,  // #FF6E5E
    design.SENTIMENT_PALETTE.neutral,   // #7E8AA0
    design.SENTIMENT_PALETTE.positive,  // #3BDCB2
];

describe('color math', () => {
    test('hexToRgb unpacks channels', () => {
        expect(m.hexToRgb('#FF6E5E')).toEqual([255, 110, 94]);
        expect(m.hexToRgb('#000000')).toEqual([0, 0, 0]);
        expect(m.hexToRgb('#3BDCB2')).toEqual([59, 220, 178]);
    });

    test('mix lerps channel-wise and rounds', () => {
        expect(m.mix([0, 0, 0], [255, 255, 255], 0)).toEqual([0, 0, 0]);
        expect(m.mix([0, 0, 0], [255, 255, 255], 1)).toEqual([255, 255, 255]);
        expect(m.mix([0, 100, 200], [100, 200, 0], 0.5)).toEqual([50, 150, 100]);
    });

    test('sentColor endpoints hit the palette hues exactly', () => {
        expect(m.sentColor(1, PALETTE)).toBe('rgb(59,220,178)');   // pos
        expect(m.sentColor(-1, PALETTE)).toBe('rgb(255,110,94)');  // neg
        expect(m.sentColor(0, PALETTE)).toBe('rgb(126,138,160)');  // neu #7E8AA0
    });

    test('sentColor clamps scores beyond ±1', () => {
        expect(m.sentColor(5, PALETTE)).toBe(m.sentColor(1, PALETTE));
        expect(m.sentColor(-5, PALETTE)).toBe(m.sentColor(-1, PALETTE));
    });

    test('sentColor lerps neutral→positive at t=0.5', () => {
        // channel-wise midpoint of #7E8AA0 and #3BDCB2
        const mid = m.mix([126, 138, 160], [59, 220, 178], 0.5);
        expect(m.sentColor(0.5, PALETTE)).toBe(`rgb(${mid[0]},${mid[1]},${mid[2]})`);
    });
});

describe('category slug mapping (G11)', () => {
    test('prototype display names map to API slugs', () => {
        expect(m.normalizeCategorySlug('Social')).toBe('social');
        expect(m.normalizeCategorySlug('News')).toBe('news');
        expect(m.normalizeCategorySlug('Academic')).toBe('academic');
        expect(m.normalizeCategorySlug('Policy')).toBe('policy');
        expect(m.normalizeCategorySlug('Developer')).toBe('developer');
        expect(m.normalizeCategorySlug('Blogs')).toBe('blog');
        expect(m.normalizeCategorySlug('Forums')).toBe('tech'); // handoff yellow reuse
    });

    test('API slugs pass through unchanged', () => {
        for (const slug of Object.keys(design.CAT_COLORS)) {
            expect(m.normalizeCategorySlug(slug)).toBe(slug);
        }
    });

    test('unknown strings lowercase-pass-through; empty/null → null', () => {
        expect(m.normalizeCategorySlug('Mystery')).toBe('mystery');
        expect(m.normalizeCategorySlug('')).toBeNull();
        expect(m.normalizeCategorySlug(null)).toBeNull();
        expect(m.normalizeCategorySlug(undefined)).toBeNull();
    });
});

describe('cityColor', () => {
    test('category mode uses CAT_COLORS by slug', () => {
        expect(m.cityColor({ top: 'social' }, 'category', PALETTE))
            .toBe(design.CAT_COLORS.social);
        expect(m.cityColor({ top: 'nonprofit' }, 'category', PALETTE))
            .toBe(design.CAT_COLORS.nonprofit);
    });

    test('category mode falls back to neutral for unknown slugs (G11)', () => {
        expect(m.cityColor({ top: 'mystery' }, 'category', PALETTE))
            .toBe(design.SENTIMENT_PALETTE.neutral);
        expect(m.cityColor({ top: null }, 'category', PALETTE))
            .toBe(design.SENTIMENT_PALETTE.neutral);
    });

    test('warm/cold modes are fixed ±0.7 sentiment hues', () => {
        expect(m.cityColor({}, 'warm', PALETTE)).toBe(m.sentColor(0.7, PALETTE));
        expect(m.cityColor({}, 'cold', PALETTE)).toBe(m.sentColor(-0.7, PALETTE));
    });

    test('sentiment mode lerps the city sentiment', () => {
        expect(m.cityColor({ sentiment: -1 }, 'sentiment', PALETTE))
            .toBe('rgb(255,110,94)');
    });
});

describe('adaptCities', () => {
    test('prototype demo shape passes through', () => {
        const [c] = m.adaptCities([{
            id: 'sf', name: 'San Francisco', lat: 37.77, lon: -122.42,
            sentiment: 0.38, volume: 420, top: 'Developer',
        }]);
        expect(c).toEqual({
            id: 'sf', name: 'San Francisco', lat: 37.77, lon: -122.42,
            sentiment: 0.38, volume: 420, top: 'developer',
        });
    });

    test('normalized API shape derives sentiment/volume/top from counts (G11)', () => {
        const [c] = m.adaptCities([{
            city: 'Testville', lat: 10, lng: 20,
            positive: 6, neutral: 3, negative: 1, total: 10,
            sources: [
                { source_name: 'reddit', source_category: 'social',
                  positive: 4, neutral: 2, negative: 1, total: 7 },
                { source_name: 'arxiv', source_category: 'academic',
                  positive: 2, neutral: 1, negative: 0, total: 3 },
            ],
        }]);
        expect(c.id).toBe('Testville');
        expect(c.name).toBe('Testville');
        expect(c.lon).toBe(20);              // lng → lon
        expect(c.sentiment).toBeCloseTo(0.5); // (6−1)/10
        expect(c.volume).toBe(10);            // total → volume
        expect(c.top).toBe('social');         // highest-volume source category
    });

    test('counts win over a raw sentiment field when both exist (G11)', () => {
        const [c] = m.adaptCities([{
            city: 'X', lat: 0, lng: 0, sentiment: 0.99,
            positive: 1, neutral: 0, negative: 1, total: 2,
        }]);
        expect(c.sentiment).toBe(0); // net-from-counts, never the raw field
    });

    test('drops rows with unusable coordinates; tolerates junk input', () => {
        expect(m.adaptCities([{ city: 'NoCoords', lat: null, lng: 5 }])).toEqual([]);
        expect(m.adaptCities([{ city: 'BadLon', lat: 5, lng: 'x' }])).toEqual([]);
        expect(m.adaptCities(null)).toEqual([]);
        expect(m.adaptCities([null, 42, 'city'])).toEqual([]);
    });

    test('missing sentiment/volume/top default to 0/0/null', () => {
        const [c] = m.adaptCities([{ id: 'a', name: 'A', lat: 1, lon: 2 }]);
        expect(c.sentiment).toBe(0);
        expect(c.volume).toBe(0);
        expect(c.top).toBeNull();
    });

    test('topCategoryFromSources breaks total ties alphabetically', () => {
        expect(m.topCategoryFromSources([
            { source_category: 'news', total: 5 },
            { source_category: 'academic', total: 5 },
        ])).toBe('academic');
        expect(m.topCategoryFromSources([])).toBeNull();
        expect(m.topCategoryFromSources(null)).toBeNull();
    });
});

describe('orthographic projection', () => {
    // View looking at lat 0 / lon 0, unit-ish sphere at the canvas center.
    const view = { lam: 0, sinP0: 0, cosP0: 1, R: 100, cx: 200, cy: 150 };

    test('the sub-viewer point projects to the center at full depth', () => {
        expect(m.project(0, 0, view)).toEqual([200, 150, 1]);
    });

    test('the limb projects to the rim at zero depth', () => {
        const pt = m.project(0, 90 * D2R, view);
        expect(pt[0]).toBeCloseTo(300); // cx + R
        expect(pt[1]).toBeCloseTo(150);
        expect(pt[2]).toBeCloseTo(0);
    });

    test('the far hemisphere is culled (null)', () => {
        expect(m.project(0, 180 * D2R, view)).toBeNull();
        expect(m.project(0, -135 * D2R, view)).toBeNull();
    });

    test('north pole under a tilted view lands above center', () => {
        const phi0 = 16 * D2R;
        const tilted = {
            lam: 0, sinP0: Math.sin(phi0), cosP0: Math.cos(phi0),
            R: 100, cx: 0, cy: 0,
        };
        const pt = m.project(90 * D2R, 0, tilted);
        expect(pt[1]).toBeCloseTo(-100 * Math.cos(phi0)); // cy − R·cosP0
        expect(pt[2]).toBeCloseTo(Math.sin(phi0));
    });

    test('sphereRadius is min(W,H) × 0.38 × zoom', () => {
        expect(m.sphereRadius(1000, 500, 1)).toBe(190);
        expect(m.sphereRadius(400, 800, 2)).toBe(304);
    });
});

describe('rotation targets and easing', () => {
    test('angleDelta takes the short way around the wrap', () => {
        expect(m.angleDelta(350 * D2R, 10 * D2R)).toBeCloseTo(-20 * D2R);
        expect(m.angleDelta(10 * D2R, 350 * D2R)).toBeCloseTo(20 * D2R);
        expect(m.angleDelta(1, 1)).toBe(0);
    });

    test('dragging holds both axes at full ease', () => {
        const t = m.rotationTargets({
            dragging: true, lam: 1.2, phi: 0.3,
            focus: { lat: 50, lon: 100 }, interactive: true, idle: false,
            speed: 1, dt: 0.016, now: 5000, reducedMotion: false,
        });
        expect(t).toEqual({ tLam: 1.2, tPhi: 0.3, lamEase: 1 });
    });

    test('focus targets chapter lat/lon with ±7° sin(now/9000) drift at ease 0.055', () => {
        const now = 4500;
        const t = m.rotationTargets({
            dragging: false, focus: { lat: 40, lon: -73 },
            interactive: false, idle: true, speed: 1,
            lam: 0, phi: 0, dt: 0.016, now, reducedMotion: false,
        });
        expect(t.tLam).toBeCloseTo(-73 * D2R + Math.sin(now / 9000) * 7 * D2R, 10);
        expect(t.tPhi).toBeCloseTo(30 * D2R); // 40 × 0.75
        expect(t.lamEase).toBe(0.055);
    });

    test('focus latitude is clamped to ±50° after the 0.75 scale', () => {
        const t = m.rotationTargets({
            dragging: false, focus: { lat: 80, lon: 0 },
            interactive: false, idle: true, speed: 1,
            lam: 0, phi: 0, dt: 0.016, now: 0, reducedMotion: false,
        });
        expect(t.tPhi).toBeCloseTo(50 * D2R);
    });

    test('reduced motion removes the focus drift (G10)', () => {
        const t = m.rotationTargets({
            dragging: false, focus: { lat: 0, lon: 30 },
            interactive: false, idle: true, speed: 1,
            lam: 0, phi: 0, dt: 0.016, now: 4500, reducedMotion: true,
        });
        expect(t.tLam).toBeCloseTo(30 * D2R, 10); // no sin term
    });

    test('idle auto-spin advances by speed × (2π/spinPeriod) × dt westward', () => {
        const dt = 0.016;
        const spinPerSec = (2 * Math.PI) / (design.GLOBE.spinPeriodMs / 1000);
        const t = m.rotationTargets({
            dragging: false, focus: null, interactive: false, idle: true,
            speed: 2, lam: 1, phi: 0.5, dt, now: 0, reducedMotion: false,
        });
        expect(t.tLam).toBeCloseTo(1 - 2 * spinPerSec * dt, 12);
        expect(t.tPhi).toBeCloseTo(16 * D2R); // non-interactive snaps target to rest
        expect(t.lamEase).toBe(1);
        // ≈ the prototype's 0.00035 × 60 rad/s at speed 1
        expect(spinPerSec).toBeCloseTo(0.021, 3);
    });

    test('interactive idle eases latitude back toward 16° at 2% per frame', () => {
        const phi = 0.9;
        const t = m.rotationTargets({
            dragging: false, focus: null, interactive: true, idle: true,
            speed: 1, lam: 0, phi, dt: 0.016, now: 0, reducedMotion: false,
        });
        expect(t.tPhi).toBeCloseTo(phi + (16 * D2R - phi) * 0.02, 12);
    });

    test('reduced motion suppresses the auto-spin (G10)', () => {
        const t = m.rotationTargets({
            dragging: false, focus: null, interactive: false, idle: true,
            speed: 3, lam: 1, phi: 0, dt: 0.05, now: 0, reducedMotion: true,
        });
        expect(t.tLam).toBe(1);
    });

    test('interactive and not idle holds under the user', () => {
        const t = m.rotationTargets({
            dragging: false, focus: null, interactive: true, idle: false,
            speed: 1, lam: 0.4, phi: 0.2, dt: 0.016, now: 0, reducedMotion: false,
        });
        expect(t).toEqual({ tLam: 0.4, tPhi: 0.2, lamEase: 1 });
    });
});

describe('drag geometry', () => {
    test('dragRotate applies 0.005 rad/px (west-positive dx)', () => {
        const r = m.dragRotate(1, 0.5, 10, -4);
        expect(r.lam).toBeCloseTo(1 - 0.05);
        expect(r.phi).toBeCloseTo(0.5 - 0.02);
    });

    test('latitude is clamped at ±70°', () => {
        expect(m.dragRotate(0, 69 * D2R, 0, 1000).phi).toBeCloseTo(70 * D2R);
        expect(m.dragRotate(0, -69 * D2R, 0, -1000).phi).toBeCloseTo(-70 * D2R);
        expect(m.clampPhi(2)).toBeCloseTo(70 * D2R);
        expect(m.clampPhi(-2)).toBeCloseTo(-70 * D2R);
    });
});

describe('user zoom (ZIP revision, G7)', () => {
    test('clampUserZoom clamps to the config window', () => {
        expect(m.clampUserZoom(0.1)).toBe(design.GLOBE.userZoomMin);
        expect(m.clampUserZoom(99)).toBe(design.GLOBE.userZoomMax);
        expect(m.clampUserZoom(2)).toBe(2);
        expect(m.clampUserZoom(NaN)).toBe(1);
    });

    test('wheelZoomFactor uses the ctrl vs plain factors', () => {
        expect(m.wheelZoomFactor(-100, true))
            .toBeCloseTo(Math.exp(100 * design.GLOBE.wheelZoomCtrlFactor), 12);
        expect(m.wheelZoomFactor(-100, false))
            .toBeCloseTo(Math.exp(100 * design.GLOBE.wheelZoomPlainFactor), 12);
        // scroll down (positive deltaY) zooms out
        expect(m.wheelZoomFactor(100, false)).toBeLessThan(1);
    });

    test('keyZoomFactor maps +/=/−/_ and rejects everything else', () => {
        expect(m.keyZoomFactor('+')).toBe(design.GLOBE.keyZoomStep);
        expect(m.keyZoomFactor('=')).toBe(design.GLOBE.keyZoomStep);
        expect(m.keyZoomFactor('-')).toBeCloseTo(1 / design.GLOBE.keyZoomStep, 12);
        expect(m.keyZoomFactor('_')).toBeCloseTo(1 / design.GLOBE.keyZoomStep, 12);
        expect(m.keyZoomFactor('0')).toBeNull(); // reset handled by caller
        expect(m.keyZoomFactor('a')).toBeNull();
    });

    test('composeZoomStep chases (chapterZoom || 1) × userZoom at 0.055', () => {
        expect(m.composeZoomStep(1, 1.15, 2)).toBeCloseTo(1 + (2.3 - 1) * 0.055, 12);
        // null chapter zoom is treated as 1 (prototype `p.zoom || 1`)
        expect(m.composeZoomStep(1, null, 1)).toBe(1);
        // converges: repeated steps approach the composed target
        let z = 1;
        for (let i = 0; i < 500; i++) z = m.composeZoomStep(z, 1.15, 2);
        expect(z).toBeCloseTo(2.3, 6);
    });
});

describe('marker / bar / ring formulas', () => {
    test('markerRadius = (2.2 + √vol × 0.28) × (0.6 + z×0.4) × (d×0.4 + 0.6)', () => {
        expect(m.markerRadius(0, 1, 1)).toBeCloseTo(2.2, 12);
        expect(m.markerRadius(100, 1, 1))
            .toBeCloseTo((2.2 + 10 * 0.28) * 1 * 1, 12);
        expect(m.markerRadius(100, 2, 0.5))
            .toBeCloseTo((2.2 + 2.8) * (0.6 + 0.8) * (0.2 + 0.6), 12);
    });

    test('barHeight = R × (0.015 + m × 0.13) × depth with metric clamped', () => {
        expect(m.barHeight(200, 0.5, 1)).toBeCloseTo(200 * (0.015 + 0.065), 12);
        expect(m.barHeight(200, -1, 1)).toBeCloseTo(200 * 0.015, 12);  // clamp low
        expect(m.barHeight(200, 5, 0.5)).toBeCloseTo(200 * 0.145 * 0.5, 12); // clamp high
    });

    test('pillarHeight = R × (0.04 + share × 0.18) × depth (final handoff values)', () => {
        expect(m.pillarHeight(200, 0, 1)).toBeCloseTo(8, 12);
        expect(m.pillarHeight(200, 1, 1)).toBeCloseTo(200 * 0.22, 12);
        expect(m.pillarHeight(200, 0.5, 0.8)).toBeCloseTo(200 * 0.13 * 0.8, 12);
    });

    test('pulsePhase stays in [0,1), staggers by longitude, cycles at 1000/ringPeriodMs', () => {
        const rate = 1000 / design.GLOBE.ringPeriodMs;
        expect(rate).toBeCloseTo(0.4545, 3); // ≈ the prototype's 0.45
        const a = m.pulsePhase(0, -180);
        expect(a).toBe(0); // (0 + 0/137) % 1
        const b = m.pulsePhase(1, -180);
        expect(b).toBeCloseTo(rate % 1, 12);
        // longitude stagger: (137/137) % 1 wraps to 0
        expect(m.pulsePhase(0, -43)).toBeCloseTo(0, 12);
        expect(m.pulsePhase(0, 25.5)).toBeCloseTo((205.5 / 137) % 1, 12);
        for (const [t, lon] of [[0.3, 12], [7.7, -100], [123.4, 179]]) {
            const ph = m.pulsePhase(t, lon);
            expect(ph).toBeGreaterThanOrEqual(0);
            expect(ph).toBeLessThan(1);
        }
    });

    test('land dot size/alpha formulas', () => {
        expect(m.landDotSize(200, 1)).toBeCloseTo(200 * 0.006 + 200 * 0.0025, 12);
        expect(m.landDotSize(200, 0.02)).toBeCloseTo(1.2 + 0.02 * 0.5, 12);
        expect(m.landDotAlpha(1, false, 0)).toBeCloseTo(0.64, 12);
        expect(m.landDotAlpha(1, true, 1)).toBeCloseTo(0.64 * 1.2, 12);
        expect(m.landDotAlpha(0.5, true, 0)).toBeCloseTo(0.39 * 0.45, 12);
    });
});

describe('hit-test geometry', () => {
    const screen = [
        { id: 'a', x: 100, y: 100, r: 9 },
        { id: 'b', x: 160, y: 100, r: 20 },
    ];

    test('a point within 18px (after the r×0.4 discount) hits', () => {
        expect(m.hitTest(screen, 100, 100)).toBe('a');
        // 21px away from a, but 21 − 9×0.4 = 17.4 < 18 → still a hit
        expect(m.hitTest(screen, 121, 100)).toBe('a');
    });

    test('beyond the tolerance is a miss', () => {
        // 30px from a: 30 − 3.6 = 26.4; 39px from b: 39 − 8 = 31 → null
        expect(m.hitTest(screen, 100, 130)).toBeNull();
        expect(m.hitTest([], 0, 0)).toBeNull();
    });

    test('the nearest discounted marker wins', () => {
        // midpoint x=130: a → 30 − 3.6 = 26.4 (miss); b → 30 − 8 = 22 (miss)
        expect(m.hitTest(screen, 130, 100)).toBeNull();
        // x=140: a → 40−3.6=36.4; b → 20−8=12 → b
        expect(m.hitTest(screen, 140, 100)).toBe('b');
    });
});

describe('land geometry', () => {
    test('fibFallback yields 2600 unit-sphere dots', () => {
        const dots = m.fibFallback();
        expect(dots).toHaveLength(2600);
        for (const d of [dots[0], dots[1300], dots[2599]]) {
            expect(d.sinp * d.sinp + d.cosp * d.cosp).toBeCloseTo(1, 10);
            expect(d.lam).toBeGreaterThanOrEqual(0);
            expect(d.lam).toBeLessThan(2 * Math.PI);
        }
    });

    // 20°-square land patch centered on the origin.
    const square = [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]];
    const polygonGeom = { type: 'Polygon', coordinates: [square] };

    test('ringsFromLand handles Feature, FeatureCollection, and bare geometry', () => {
        const feature = { type: 'Feature', geometry: polygonGeom };
        const collection = { type: 'FeatureCollection', features: [feature] };
        for (const land of [feature, collection, polygonGeom]) {
            const rings = m.ringsFromLand(land);
            expect(rings).toHaveLength(1);
            expect(rings[0]).toMatchObject({ minX: -10, maxX: 10, minY: -10, maxY: 10 });
            expect(rings[0].pts).toBe(square);
        }
    });

    test('ringsFromLand flattens MultiPolygon rings', () => {
        const multi = {
            type: 'Feature',
            geometry: {
                type: 'MultiPolygon',
                coordinates: [[square], [[[100, 40], [110, 40], [110, 50], [100, 50], [100, 40]]]],
            },
        };
        expect(m.ringsFromLand(multi)).toHaveLength(2);
    });

    test('pointInRings ray-cast with bbox early-out', () => {
        const rings = m.ringsFromLand(polygonGeom);
        expect(m.pointInRings(0, 0, rings)).toBe(true);
        expect(m.pointInRings(9.9, -9.9, rings)).toBe(true);
        expect(m.pointInRings(11, 0, rings)).toBe(false);  // bbox reject
        expect(m.pointInRings(0, 40, rings)).toBe(false);
    });

    test('landDotsFromRings rasterizes only inside the rings and the lat band', () => {
        const rings = m.ringsFromLand(polygonGeom);
        const dots = m.landDotsFromRings(rings);
        expect(dots.length).toBeGreaterThan(100);
        for (const d of dots) {
            // Every dot decodes back inside the square (small epsilon).
            const lat = Math.asin(d.sinp) / D2R;
            const lon = d.lam / D2R;
            expect(Math.abs(lat)).toBeLessThanOrEqual(10.01);
            expect(Math.abs(lon)).toBeLessThanOrEqual(10.01);
        }
        // A polar cap above the 78° raster ceiling yields no dots.
        const cap = m.ringsFromLand({
            type: 'Polygon',
            coordinates: [[[-180, 80], [180, 80], [180, 90], [-180, 90], [-180, 80]]],
        });
        expect(m.landDotsFromRings(cap)).toHaveLength(0);
    });

    test('assignNearestCity tags dots with nearest index and falloff weight', () => {
        const mk = (lat, lon) => ({
            sinp: Math.sin(lat * D2R), cosp: Math.cos(lat * D2R), lam: lon * D2R,
        });
        const dots = [
            mk(0, 0),      // on city 0
            mk(0, 10),     // 10° ≈ 0.1745 rad from city 0, inside falloff
            mk(0, 170),    // far from everything
            mk(50, 100),   // near city 1
        ];
        const cities = [{ lat: 0, lon: 0 }, { lat: 52, lon: 100 }];
        m.assignNearestCity(dots, cities);
        expect(dots[0].ci).toBe(0);
        expect(dots[0].wt).toBeCloseTo(1, 6);
        expect(dots[1].ci).toBe(0);
        expect(dots[1].wt).toBeCloseTo(1 - (10 * D2R) / 0.38, 6);
        expect(dots[2].ci).toBe(-1);
        expect(dots[2].wt).toBe(0);
        expect(dots[3].ci).toBe(1);
        expect(dots[3].wt).toBeGreaterThan(0);
    });
});

describe('module surface', () => {
    test('exports the factory API and the vendored land path (FR-25)', () => {
        expect(typeof globe.create).toBe('function');
        expect(typeof globe.init).toBe('function');
        expect(typeof globe.getInstance).toBe('function');
        expect(globe.LAND_URL).toBe('vendor/world-atlas/land-110m-geo.json');
        expect(globe.LAND_URL).not.toMatch(/^https?:/); // never a CDN
    });

    test('derived rates come from the design config tokens', () => {
        expect(m.SPIN_RAD_PER_SEC)
            .toBeCloseTo((2 * Math.PI) / (design.GLOBE.spinPeriodMs / 1000), 12);
        expect(m.RING_RATE_PER_SEC)
            .toBeCloseTo(1000 / design.GLOBE.ringPeriodMs, 12);
    });
});
