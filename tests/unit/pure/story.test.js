// Pure unit tests for public/js/story.js (PulseStory module, `pure` namespace).
// No DB, no browser — runs under jest.pure.config.js (and the main suite).
//
// Contracts (prototype app.jsx / ui.jsx ZIP revision, verbatim math):
//   - progressFromScroll: prog = scrollY/max × (N−1) with the NaN guard
//     (max > 0 ? … : 0), clamped to [0 .. N−1].
//   - exploring ⇔ prog > N − 1.45; story chrome ⇔ !exploring && prog > 0.14.
//   - centerX = 0.5 + max(0, 0.5 − prog) × 0.3; intro = max(0, 1 − prog×5).
//   - card transition: vis = max(0, 1 − |offset| × 2.1), translateY =
//     offset × −46px.
//   - bar metrics: volume/maxVol, max(0,s)/0.5, max(0,−s)/0.35.
//   - zoom ↔ altitude inversion of the story.config mapping.
//   - Guards: nextSteps never .map'd when absent (bug a / G13); auditPick
//     receipts keyed to highlightCities[0], hidden when highlights are
//     empty — never cities[0] (bug b / G14).

'use strict';

const story = require('../../../public/js/story');
const chapters = require('../../../public/js/chapters');
const insightsMod = require('../../../public/js/insights');
const data = require('../../../public/js/data');
const utils = require('../../../public/js/utils');

const { pure } = story;
const { STORY, resolveChapter } = chapters;
const { computeInsights } = insightsMod;
const { netSentiment } = utils;

const N = STORY.length; // 11

const demoCities = data.normalizeCities(data.DEMO_DATA);
const demoInsights = computeInsights(demoCities);
const emptyInsights = computeInsights([]);

function beat(id) {
    return STORY.find(b => b.id === id);
}
function resolved(id, opts) {
    return resolveChapter(beat(id), demoInsights, demoCities, opts);
}

describe('module export shape', () => {
    test('exposes the pure namespace and the page API', () => {
        expect(pure).toBeDefined();
        expect(pure.N).toBe(11);
        expect(typeof story.init).toBe('function');
        expect(typeof story.getState).toBe('function');
        expect(typeof story.consumePendingCity).toBe('function');
        expect(typeof story.setExploreSelection).toBe('function');
    });
});

describe('progressFromScroll — scroll → progress with NaN guard', () => {
    const pacing = 1.15;

    test('0 scroll → 0 progress', () => {
        expect(pure.progressFromScroll(0, 800, N, pacing)).toBe(0);
    });

    test('full track → N−1', () => {
        const max = (N - 1) * pacing * 800;
        expect(pure.progressFromScroll(max, 800, N, pacing)).toBeCloseTo(N - 1, 10);
    });

    test('midpoint of the track → (N−1)/2', () => {
        const max = (N - 1) * pacing * 800;
        expect(pure.progressFromScroll(max / 2, 800, N, pacing))
            .toBeCloseTo((N - 1) / 2, 10);
    });

    test('overscroll clamps to N−1; negative scroll clamps to 0', () => {
        const max = (N - 1) * pacing * 800;
        expect(pure.progressFromScroll(max * 3, 800, N, pacing)).toBe(N - 1);
        expect(pure.progressFromScroll(-500, 800, N, pacing)).toBe(0);
    });

    test('NaN guard: zero/negative viewport (max ≤ 0) → 0, never NaN', () => {
        expect(pure.progressFromScroll(1234, 0, N, pacing)).toBe(0);
        expect(pure.progressFromScroll(1234, -10, N, pacing)).toBe(0);
        // single-beat story would also zero the track
        expect(pure.progressFromScroll(1234, 800, 1, pacing)).toBe(0);
    });
});

describe('activeIndexFor / isExploring / showStoryUi', () => {
    test('activeIndexFor rounds to the nearest beat, clamped', () => {
        expect(pure.activeIndexFor(0, N)).toBe(0);
        expect(pure.activeIndexFor(2.49, N)).toBe(2);
        expect(pure.activeIndexFor(2.5, N)).toBe(3);
        expect(pure.activeIndexFor(99, N)).toBe(N - 1);
        expect(pure.activeIndexFor(-1, N)).toBe(0);
    });

    test('exploring flips strictly past N − 1.45', () => {
        expect(pure.isExploring(N - 1.45, N)).toBe(false);
        expect(pure.isExploring(N - 1.4499, N)).toBe(true);
        expect(pure.isExploring(N - 1, N)).toBe(true);
        expect(pure.isExploring(0, N)).toBe(false);
    });

    test('story chrome shows only in (0.14, explore) window', () => {
        expect(pure.showStoryUi(0.14, false)).toBe(false);
        expect(pure.showStoryUi(0.141, false)).toBe(true);
        expect(pure.showStoryUi(5, false)).toBe(true);
        expect(pure.showStoryUi(5, true)).toBe(false); // exploring wins
    });
});

describe('centerXFor / introOpacityFor', () => {
    test('globe starts right of center and settles at center by prog 0.5', () => {
        expect(pure.centerXFor(0)).toBeCloseTo(0.65, 10);
        expect(pure.centerXFor(0.25)).toBeCloseTo(0.575, 10);
        expect(pure.centerXFor(0.5)).toBeCloseTo(0.5, 10);
        expect(pure.centerXFor(3)).toBeCloseTo(0.5, 10);
    });

    test('intro fades out over the first fifth of a beat', () => {
        expect(pure.introOpacityFor(0)).toBe(1);
        expect(pure.introOpacityFor(0.1)).toBeCloseTo(0.5, 10);
        expect(pure.introOpacityFor(0.2)).toBe(0);
        expect(pure.introOpacityFor(4)).toBe(0);
    });
});

describe('card transition math', () => {
    test('vis = max(0, 1 − |offset| × 2.1)', () => {
        expect(pure.cardVisibility(0)).toBe(1);
        expect(pure.cardVisibility(0.2)).toBeCloseTo(0.58, 10);
        expect(pure.cardVisibility(-0.2)).toBeCloseTo(0.58, 10);
        expect(pure.cardVisibility(0.5)).toBeCloseTo(0, 10);
        expect(pure.cardVisibility(1)).toBe(0);
    });

    test('translateY = offset × −46px (slides up while approaching)', () => {
        expect(pure.cardTranslateY(0)).toBe(-0);
        expect(pure.cardTranslateY(0.5)).toBeCloseTo(-23, 10);
        expect(pure.cardTranslateY(-0.5)).toBeCloseTo(23, 10);
    });
});

describe('zoomFromAltitude — inverse of the story.config camera mapping', () => {
    test('inverts the documented altitude anchor points', () => {
        expect(pure.zoomFromAltitude(2.5)).toBeCloseTo(1.0, 10);   // whole globe
        expect(pure.zoomFromAltitude(1.4)).toBeCloseTo(1.7, 10);   // close-up
        expect(pure.zoomFromAltitude(1.95)).toBeCloseTo(1.35, 2);  // volume beat
        expect(pure.zoomFromAltitude(1.64)).toBeCloseTo(1.55, 2);  // divide beat
        expect(pure.zoomFromAltitude(1.71)).toBeCloseTo(1.5, 2);   // neg/pos beats
        expect(pure.zoomFromAltitude(2.42)).toBeCloseTo(1.05, 2);  // drivers beat
        expect(pure.zoomFromAltitude(2.26)).toBeCloseTo(1.15, 2);  // explore beat
    });

    test('round-trips every configured beat altitude', () => {
        for (const b of STORY) {
            const zoom = pure.zoomFromAltitude(b.altitude);
            const back = 2.5 - (zoom - 1.0) * (2.5 - 1.4) / (1.7 - 1.0);
            expect(back).toBeCloseTo(b.altitude, 10);
        }
    });

    test('non-finite altitude falls back to zoom 1', () => {
        expect(pure.zoomFromAltitude(NaN)).toBe(1);
        expect(pure.zoomFromAltitude(undefined)).toBe(1);
    });
});

describe('barMetricFor — per-beat data-bar encodings (adapted city shape)', () => {
    test('volume metric normalizes by the loudest city', () => {
        const m = pure.barMetricFor('volume', 400);
        expect(m({ volume: 400, sentiment: 0 })).toBeCloseTo(1, 10);
        expect(m({ volume: 100, sentiment: 0 })).toBeCloseTo(0.25, 10);
    });

    test('volume metric with zero max volume returns 0, never NaN', () => {
        const m = pure.barMetricFor('volume', 0);
        expect(m({ volume: 100, sentiment: 0 })).toBe(0);
    });

    test('positiveNet: max(0, s) / 0.5 (prototype divisor)', () => {
        const m = pure.barMetricFor('positiveNet', 400);
        expect(m({ sentiment: 0.25, volume: 1 })).toBeCloseTo(0.5, 10);
        expect(m({ sentiment: -0.3, volume: 1 })).toBe(0); // clamped
    });

    test('negativeNet: max(0, −s) / 0.35 (prototype divisor)', () => {
        const m = pure.barMetricFor('negativeNet', 400);
        expect(m({ sentiment: -0.35, volume: 1 })).toBeCloseTo(1, 10);
        expect(m({ sentiment: 0.2, volume: 1 })).toBe(0); // clamped
    });

    test('unknown ids fall back to the volume metric', () => {
        const m = pure.barMetricFor('mystery', 200);
        expect(m({ volume: 100, sentiment: 0.9 })).toBeCloseTo(0.5, 10);
    });

    test('maxVolumeOf finds the loudest normalized city', () => {
        expect(pure.maxVolumeOf(demoCities))
            .toBe(Math.max(...demoCities.map(c => c.total)));
        expect(pure.maxVolumeOf([])).toBe(0);
        expect(pure.maxVolumeOf(null)).toBe(0);
    });
});

describe('storySplitFor — three-pillar split on the divide beat only', () => {
    test('divide beat: splits ONLY the first highlighted city', () => {
        const r = resolved('divide');
        expect(r.highlightCities.length).toBeGreaterThan(0);
        const splitFor = pure.storySplitFor(r);
        expect(typeof splitFor).toBe('function');
        const target = r.highlightCities[0];
        const split = splitFor(target.city);
        expect(split.pos).toBeCloseTo(target.shares.positive, 10);
        expect(split.neu).toBeCloseTo(target.shares.neutral, 10);
        expect(split.neg).toBeCloseTo(target.shares.negative, 10);
        expect(splitFor('Some Other City')).toBeNull();
    });

    test('every non-divide beat gets no split function', () => {
        for (const b of STORY) {
            if (b.id === 'divide') continue;
            expect(pure.storySplitFor(
                resolveChapter(b, demoInsights, demoCities))).toBeNull();
        }
    });

    test('divide beat without highlights (sparse data) → null', () => {
        const r = resolveChapter(beat('divide'), emptyInsights, []);
        expect(r.highlightCities).toEqual([]);
        expect(pure.storySplitFor(r)).toBeNull();
    });
});

describe('focusForBeat — prototype focus semantics', () => {
    test('a highlighted beat pins the view on the resolved camera', () => {
        const b = beat('volume');
        const r = resolved('volume');
        const focus = pure.focusForBeat(b, r);
        expect(focus).toEqual({ lat: r.camera.lat, lon: r.camera.lng });
        expect(focus.lat).toBe(r.highlightCities[0].lat);
    });

    test('a static-camera beat pins the configured view', () => {
        const b = beat('drivers');
        const focus = pure.focusForBeat(b, resolved('drivers'));
        expect(focus).toEqual({ lat: 15, lon: 10 });
    });

    test('camera:null beats with nothing highlighted auto-spin (focus null)', () => {
        // overview / messengers / explore had focus:null in the prototype.
        for (const id of ['overview', 'messengers', 'explore']) {
            expect(pure.focusForBeat(beat(id), resolved(id))).toBeNull();
        }
    });

    test('sparse data: highlight-following beats release to auto-spin', () => {
        const r = resolveChapter(beat('volume'), emptyInsights, []);
        expect(pure.focusForBeat(beat('volume'), r)).toBeNull();
    });
});

describe('highlightIdsFor — globe highlight prop', () => {
    test('story beats highlight their resolved city names', () => {
        const r = resolved('volume');
        expect(pure.highlightIdsFor(r, []))
            .toEqual(r.highlightCities.map(c => c.city));
    });

    test('explore beat never dims (null)', () => {
        expect(pure.highlightIdsFor(resolved('explore'), [])).toBeNull();
    });

    test('empty highlights become null (no dimming), not []', () => {
        const r = resolveChapter(beat('volume'), emptyInsights, []);
        expect(pure.highlightIdsFor(r, [])).toBeNull();
    });

    test('theme beats spotlight the runtime theme-derived cities', () => {
        const r = resolved('themes-warm');
        const themeCities = demoCities.slice(0, 2);
        expect(pure.highlightIdsFor(r, themeCities))
            .toEqual([demoCities[0].city, demoCities[1].city]);
        expect(pure.highlightIdsFor(r, [])).toBeNull();
    });
});

describe('nextStepsFor — guard for prototype bug a (audit G13)', () => {
    test('explore beat yields an independent copy of the checklist', () => {
        const r = resolved('explore');
        const steps = pure.nextStepsFor(r);
        expect(steps).toEqual(r.nextSteps);
        expect(steps).not.toBe(r.nextSteps);
        expect(steps.length).toBeGreaterThan(0);
    });

    test('null / undefined / empty nextSteps yield [] — never a .map crash', () => {
        expect(pure.nextStepsFor(resolved('overview'))).toEqual([]); // null by design
        expect(pure.nextStepsFor({ nextSteps: undefined })).toEqual([]);
        expect(pure.nextStepsFor({ nextSteps: [] })).toEqual([]);
        expect(pure.nextStepsFor(null)).toEqual([]);
    });
});

describe('featuredCityFor — guard for prototype bug b (audit G14)', () => {
    test('auditPick beats feature their FIRST highlighted city', () => {
        const neg = resolved('negativity');
        expect(pure.featuredCityFor(neg)).toBe(neg.highlightCities[0]);
        const pos = resolved('positivity');
        expect(pure.featuredCityFor(pos)).toBe(pos.highlightCities[0]);
    });

    test('empty highlights hide the block — NEVER cities[0]', () => {
        const r = resolveChapter(beat('negativity'), emptyInsights, []);
        expect(r.auditPick).toBe('neg');
        expect(r.highlightCities).toEqual([]);
        expect(pure.featuredCityFor(r)).toBeNull();
    });

    test('beats without auditPick never feature a post', () => {
        expect(pure.featuredCityFor(resolved('volume'))).toBeNull();
        expect(pure.featuredCityFor(null)).toBeNull();
    });
});

describe('pickExtremePost — featured-post selection from /api/query rows', () => {
    const rows = [
        { id: 'a', comparative: 0.2 },
        { id: 'b', comparative: -0.8 },
        { id: 'c', comparative: 0.9 },
        { id: 'd', comparative: null },       // skipped: not finite
        { id: 'e', comparative: 'wat' },      // skipped: not finite
    ];

    test('pos picks the highest comparative, neg the lowest', () => {
        expect(pure.pickExtremePost(rows, 'pos').id).toBe('c');
        expect(pure.pickExtremePost(rows, 'neg').id).toBe('b');
    });

    test('ties keep the earlier (newer) row', () => {
        const tied = [{ id: 'x', comparative: 0.5 }, { id: 'y', comparative: 0.5 }];
        expect(pure.pickExtremePost(tied, 'pos').id).toBe('x');
    });

    test('empty / invalid input → null', () => {
        expect(pure.pickExtremePost([], 'pos')).toBeNull();
        expect(pure.pickExtremePost(null, 'neg')).toBeNull();
        expect(pure.pickExtremePost([{ comparative: NaN }], 'pos')).toBeNull();
    });
});

describe('minutesAgoFrom', () => {
    test('whole minutes since the timestamp, floored at 0', () => {
        const now = Date.parse('2026-09-28T12:00:00Z');
        expect(pure.minutesAgoFrom('2026-09-28T11:47:00Z', now)).toBe(13);
        expect(pure.minutesAgoFrom('2026-09-28T12:05:00Z', now)).toBe(0); // future
    });

    test('unparseable timestamps → null', () => {
        expect(pure.minutesAgoFrom('not-a-date', Date.now())).toBeNull();
        expect(pure.minutesAgoFrom(undefined, Date.now())).toBeNull();
    });
});

describe('themeHighlightCitiesFor — prototype CH06/CH07 city spotlight', () => {
    test('spotlights cities whose dominant category matches a theme category', () => {
        // Every demo city is social-dominated except Beijing/SF variants —
        // derive the expectation from the same dominant-category rule.
        const themes = [{ keyword: 'agents', top_category: 'social' }];
        const out = pure.themeHighlightCitiesFor(demoCities, themes);
        expect(out.length).toBeGreaterThan(0);
        for (const c of out) {
            const totals = {};
            for (const s of c.sources) {
                totals[s.source_category] = (totals[s.source_category] || 0) + s.total;
            }
            const top = Object.keys(totals)
                .sort((a, b) => (totals[b] - totals[a]) || (a < b ? -1 : 1))[0];
            expect(top).toBe('social');
        }
    });

    test('display-cased prototype category names still match (slug bridge)', () => {
        const themes = [{ keyword: 'x', top_category: 'Social' }];
        expect(pure.themeHighlightCitiesFor(demoCities, themes).length)
            .toBeGreaterThan(0);
    });

    test('no themes (or no categories) → no spotlight', () => {
        expect(pure.themeHighlightCitiesFor(demoCities, [])).toEqual([]);
        expect(pure.themeHighlightCitiesFor(demoCities, null)).toEqual([]);
        expect(pure.themeHighlightCitiesFor(demoCities,
            [{ keyword: 'x', top_category: null }])).toEqual([]);
    });
});

describe('themeNet — /api/themes row net-sentiment ladder', () => {
    test('prefers net, then sent, then derives from counts/volume', () => {
        expect(pure.themeNet({ net: 0.4, sent: -1 })).toBe(0.4);
        expect(pure.themeNet({ sent: -0.2 })).toBe(-0.2);
        expect(pure.themeNet({ positive: 6, negative: 2, volume: 10 }))
            .toBeCloseTo(0.4, 10);
        expect(pure.themeNet({ positive: 1, negative: 1, volume: 0 })).toBe(0);
        expect(pure.themeNet(null)).toBe(0);
    });

    test('is the insights.js export, not a copy (grumpy #4 — one derivation)', () => {
        const insights = require('../../../public/js/insights');
        expect(pure.themeNet).toBe(insights.themeNet);
    });
});

describe('snapshotsEqual — quiet-poll gate for globe city pushes (grumpy #9)', () => {
    const row = () => ({ city: 'A', lat: 1, lng: 2, positive: 3, neutral: 2,
        negative: 1, total: 6, sources: [] });

    test('identical content (different identity) is equal', () => {
        expect(pure.snapshotsEqual([row()], [row()])).toBe(true);
        expect(pure.snapshotsEqual([], [])).toBe(true);
    });

    test('same identity is trivially equal', () => {
        const a = [row()];
        expect(pure.snapshotsEqual(a, a)).toBe(true);
    });

    test('any changed field, length, or non-array input is unequal', () => {
        const changed = row();
        changed.positive = 4;
        expect(pure.snapshotsEqual([row()], [changed])).toBe(false);
        expect(pure.snapshotsEqual([row()], [row(), row()])).toBe(false);
        expect(pure.snapshotsEqual(null, [])).toBe(false);
    });
});

describe('extraSlugs — shared canon-plus-extras enumeration (grumpy #4)', () => {
    const cityWith = (cat) => ({
        city: 'X', lat: 1, lng: 1, positive: 5, neutral: 3, negative: 2,
        total: 10, shares: { positive: 0.5, neutral: 0.3, negative: 0.2 },
        sources: [{ source_name: 's', source_category: cat,
            positive: 5, neutral: 3, negative: 2, total: 10 }],
    });

    test('canonical-only snapshots yield no extras', () => {
        expect(pure.extraSlugs([cityWith('social')])).toEqual([]);
        expect(pure.extraSlugs([])).toEqual([]);
    });

    test('non-canonical categories surface once, normalized', () => {
        const cities = [cityWith('Zines'), cityWith('zines'), cityWith('news')];
        expect(pure.extraSlugs(cities)).toEqual(['zines']);
    });

    test('legacy spellings that normalize onto the canon are NOT extras', () => {
        // 'tech' folds onto 'developer'; 'Blogs' onto 'blog'.
        expect(pure.extraSlugs([cityWith('tech'), cityWith('Blogs')]))
            .toEqual([]);
    });
});

describe('jumpTop — rail/drill scroll targets', () => {
    test('beat i sits at i × pacing × viewport height', () => {
        expect(pure.jumpTop(0, 1.15, 800)).toBe(0);
        expect(pure.jumpTop(10, 1.15, 800)).toBeCloseTo(9200, 10);
    });
});

describe('integration: resolved demo beats drive coherent globe state', () => {
    test('every beat yields a finite zoom and a callable bar metric', () => {
        const maxVol = pure.maxVolumeOf(demoCities);
        for (const b of STORY) {
            const r = resolveChapter(b, demoInsights, demoCities);
            const zoom = pure.zoomFromAltitude(r.camera.altitude);
            expect(Number.isFinite(zoom)).toBe(true);
            expect(zoom).toBeGreaterThanOrEqual(1);
            expect(zoom).toBeLessThanOrEqual(1.7);
            const metric = pure.barMetricFor(r.barMetric, maxVol);
            for (const c of demoCities) {
                const v = metric({ sentiment: netSentiment(c), volume: c.total });
                expect(Number.isFinite(v)).toBe(true);
                expect(v).toBeGreaterThanOrEqual(0);
            }
        }
    });
});

describe('demoFlipWarning — live → demo flips are never silent (principal #20)', () => {
    test('warns only when a load lands in demo after live data was served', () => {
        const msg = pure.demoFlipWarning(true, false, true);
        expect(msg).toMatch(/flipped from LIVE to fictional DEMO data/);
        expect(msg.startsWith('[pulse]')).toBe(true);
    });

    test('no warning for live loads, repeated demo loads, or a demo cold start', () => {
        expect(pure.demoFlipWarning(true, false, false)).toBeNull();   // live → live
        expect(pure.demoFlipWarning(true, true, true)).toBeNull();     // already demo
        expect(pure.demoFlipWarning(false, false, true)).toBeNull();   // never live
    });
});
