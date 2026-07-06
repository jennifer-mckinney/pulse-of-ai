// Pure unit tests for the frontend config layer:
//   public/js/config/story.config.js   (PulseStoryConfig)
//   public/js/config/design.config.js  (PulseDesignConfig)
//   public/js/config/api.config.js     (PulseApiConfig)
//
// These modules are DATA ONLY — structural invariants are the whole contract:
//   - STORY: 11 beats in the exact design order, schema-complete, enums valid.
//   - design: complete theme/palette/category/severity tables, bucket
//     thresholds that PARTITION the sentiment axis (no overlap).
//   - api: every endpoint the story frontend calls, plus polling constants.
//
'use strict';

const story = require('../../../public/js/config/story.config');
const design = require('../../../public/js/config/design.config');
const api = require('../../../public/js/config/api.config');
const insights = require('../../../public/js/insights');

const { STORY } = story;

// ── Shared walkers ───────────────────────────────────────────────────────────

// Recursively assert a config object tree contains no functions — the config
// layer is data-only by contract (functions belong in utils/insights/chapters).
function assertNoFunctions(node, path) {
    expect(typeof node).not.toBe('function');
    if (node && typeof node === 'object') {
        for (const key of Object.keys(node)) {
            assertNoFunctions(node[key], `${path}.${key}`);
        }
    }
}

const HEX_RE = /^#[0-9A-Fa-f]{6}$/;

function validCamera(camera) {
    return camera
        && Number.isFinite(camera.lat) && camera.lat >= -90 && camera.lat <= 90
        && Number.isFinite(camera.lng) && camera.lng >= -180 && camera.lng <= 180
        && Number.isFinite(camera.altitude) && camera.altitude > 0;
}

// ── story.config ─────────────────────────────────────────────────────────────

describe('story.config — STORY beat sequence', () => {
    test('is the 11-beat design sequence in exact order', () => {
        expect(STORY.map(b => b.id)).toEqual([
            'overview', 'volume', 'divide', 'negativity', 'positivity',
            'drivers', 'themes-warm', 'themes-cold', 'messengers',
            'summary', 'explore',
        ]);
    });

    test('beat ids are unique', () => {
        const ids = STORY.map(b => b.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test.each(STORY.map(b => [b.id, b]))('beat "%s" matches the schema', (_id, b) => {
        expect(typeof b.kicker).toBe('string');
        expect(b.kicker.length).toBeGreaterThan(0);
        expect(typeof b.title).toBe('string');
        expect(b.title.length).toBeGreaterThan(0);
        expect(typeof b.templateId).toBe('string');
        expect(b.templateId.length).toBeGreaterThan(0);

        // camera: static {lat,lng,altitude} or null (null = follow highlight
        // / global view); altitude is ALWAYS present at beat level so the
        // resolver has a zoom intent even when the camera follows the data.
        expect(b.camera === null || validCamera(b.camera)).toBe(true);
        expect(Number.isFinite(b.altitude)).toBe(true);
        expect(b.altitude).toBeGreaterThan(0);
        if (b.camera !== null) {
            expect(b.camera.altitude).toBe(b.altitude); // single zoom intent
        }

        expect(Number.isFinite(b.cameraMs)).toBe(true);
        expect(b.cameraMs).toBeGreaterThan(0);

        expect(['sentiment', 'category', 'warm', 'cold']).toContain(b.colorMode);
        expect(['volume', 'positiveNet', 'negativeNet']).toContain(b.barMetric);

        expect(b.highlightRule === null
            || (typeof b.highlightRule === 'string' && b.highlightRule.length > 0))
            .toBe(true);
        expect([null, 'pos', 'neg']).toContain(b.auditPick);
        expect([null, 'warm', 'cold']).toContain(b.themePartition);
        expect(typeof b.explore).toBe('boolean');

        // statsSpec: declarative [labelTemplate, valueTemplate] string pairs
        expect(Array.isArray(b.statsSpec)).toBe(true);
        for (const pair of b.statsSpec) {
            expect(Array.isArray(pair)).toBe(true);
            expect(pair).toHaveLength(2);
            expect(typeof pair[0]).toBe('string');
            expect(typeof pair[1]).toBe('string');
        }
    });

    test('altitude stays within the documented zoom mapping range (~1.4 – 2.5)', () => {
        for (const b of STORY) {
            expect(b.altitude).toBeGreaterThanOrEqual(1.4);
            expect(b.altitude).toBeLessThanOrEqual(2.5);
        }
    });

    test('exactly one explore beat, last in sequence, carrying nextSteps', () => {
        const explorers = STORY.filter(b => b.explore);
        expect(explorers).toHaveLength(1);
        expect(STORY[STORY.length - 1].explore).toBe(true);

        const explore = STORY[STORY.length - 1];
        expect(Array.isArray(explore.nextSteps)).toBe(true);
        expect(explore.nextSteps.length).toBeGreaterThan(0);
        for (const step of explore.nextSteps) {
            expect(typeof step).toBe('string');
            expect(step.length).toBeGreaterThan(0);
        }
        // nextSteps is explore-only
        for (const b of STORY.filter(x => !x.explore)) {
            expect(b.nextSteps).toBeUndefined();
        }
    });

    test('auditPick: negativity=neg, positivity=pos, all others null', () => {
        for (const b of STORY) {
            if (b.id === 'negativity') expect(b.auditPick).toBe('neg');
            else if (b.id === 'positivity') expect(b.auditPick).toBe('pos');
            else expect(b.auditPick).toBeNull();
        }
    });

    test('themePartition: warm/cold on the theme beats only', () => {
        for (const b of STORY) {
            if (b.id === 'themes-warm') expect(b.themePartition).toBe('warm');
            else if (b.id === 'themes-cold') expect(b.themePartition).toBe('cold');
            else expect(b.themePartition).toBeNull();
        }
    });

    test('colorMode per beat matches the prototype intent', () => {
        const expected = {
            'overview': 'sentiment', 'volume': 'sentiment', 'divide': 'sentiment',
            'negativity': 'sentiment', 'positivity': 'sentiment',
            'drivers': 'category', 'themes-warm': 'warm', 'themes-cold': 'cold',
            'messengers': 'category', 'summary': 'sentiment', 'explore': 'sentiment',
        };
        for (const b of STORY) expect(b.colorMode).toBe(expected[b.id]);
    });

    test('barMetric: negativity/positivity use net metrics, others volume', () => {
        for (const b of STORY) {
            if (b.id === 'negativity') expect(b.barMetric).toBe('negativeNet');
            else if (b.id === 'positivity') expect(b.barMetric).toBe('positiveNet');
            else expect(b.barMetric).toBe('volume');
        }
    });

    test('kickers carry the verbatim prototype chapter labels', () => {
        const byId = Object.fromEntries(STORY.map(b => [b.id, b]));
        expect(byId['overview'].kicker).toBe('LIVE · REFRESH CYCLE 2–3 MIN');
        expect(byId['volume'].kicker).toBe('CHAPTER 01 · VOLUME LEADERS');
        expect(byId['divide'].kicker).toBe('CHAPTER 02 · THE DIVIDE');
        expect(byId['negativity'].kicker).toBe('CHAPTER 03 · NEGATIVITY HOTSPOTS');
        expect(byId['positivity'].kicker).toBe('CHAPTER 04 · POSITIVITY LEADERS');
        expect(byId['drivers'].kicker).toBe('CHAPTER 05 · WHO’S DRIVING');
        expect(byId['themes-warm'].kicker).toBe('CHAPTER 06 · WHAT RUNS WARM');
        expect(byId['themes-cold'].kicker).toBe('CHAPTER 07 · WHAT RUNS COLD');
        expect(byId['messengers'].kicker).toBe('CHAPTER 08 · THE MESSENGERS');
        expect(byId['summary'].kicker).toBe('CHAPTER 09 · THE HOUR IN REVIEW');
        expect(byId['explore'].kicker).toBe('CHAPTER 10 · YOUR TURN · NEXT STEPS');
    });

    test('titles carry the verbatim prototype copy', () => {
        const byId = Object.fromEntries(STORY.map(b => [b.id, b]));
        expect(byId['overview'].title).toBe('Right now, the world is talking about AI.');
        expect(byId['volume'].title).toBe('The conversation has capitals.');
        expect(byId['divide'].title).toBe('Same city, opposite moods.');
        expect(byId['negativity'].title).toBe('Where the mood cools.');
        expect(byId['positivity'].title).toBe('Optimism has an address.');
        expect(byId['drivers'].title).toBe('Who’s driving the conversation?');
        expect(byId['themes-warm'].title).toBe('What the world is excited about.');
        expect(byId['themes-cold'].title).toBe('What the world is worried about.');
        expect(byId['messengers'].title).toBe('Don’t shoot the messenger — score them.');
        expect(byId['summary'].title).toBe('The hour, on one card.');
        expect(byId['explore'].title).toBe('Now you drive.');
    });

    test('static cameras exist exactly where the prototype had static focus', () => {
        const byId = Object.fromEntries(STORY.map(b => [b.id, b]));
        // drivers / themes-warm / themes-cold pan to fixed regions
        expect(byId['drivers'].camera).toEqual({ lat: 15, lng: 10, altitude: byId['drivers'].altitude });
        expect(byId['themes-warm'].camera).toEqual({ lat: 18, lng: 80, altitude: byId['themes-warm'].altitude });
        expect(byId['themes-cold'].camera).toEqual({ lat: 45, lng: 0, altitude: byId['themes-cold'].altitude });
        // everything else follows the highlight or stays global
        for (const b of STORY) {
            if (!['drivers', 'themes-warm', 'themes-cold'].includes(b.id)) {
                expect(b.camera).toBeNull();
            }
        }
    });

    test('highlightRule assignments match the story beats', () => {
        const byId = Object.fromEntries(STORY.map(b => [b.id, b]));
        expect(byId['volume'].highlightRule).toBe('volumeTop3');
        expect(byId['divide'].highlightRule).toBe('widestDivide');
        expect(byId['negativity'].highlightRule).toBe('negativeTop3');
        expect(byId['positivity'].highlightRule).toBe('positiveTop3');
        expect(byId['summary'].highlightRule).toBe('summaryTrio');
        for (const id of ['overview', 'drivers', 'themes-warm', 'themes-cold',
            'messengers', 'explore']) {
            expect(byId[id].highlightRule).toBeNull();
        }
    });

    test('module is data-only (no functions anywhere in the tree)', () => {
        assertNoFunctions(story, 'PulseStoryConfig');
    });

    test('every templateId exists in PulseInsights.TEMPLATES (cross-module)', () => {
        for (const b of STORY) {
            expect(insights.TEMPLATES).toHaveProperty(b.templateId);
        }
    });

    test('every statsSpec token appears in no template-unknown form', () => {
        // statsSpec strings must only reference {tokens}; renderTemplate is
        // the runtime enforcer, this just pins the declarative shape.
        for (const b of STORY) {
            for (const [label, value] of b.statsSpec) {
                for (const part of [label, value]) {
                    // braces, if any, must wrap well-formed token names
                    const stripped = part.replace(/\{[A-Za-z0-9_]+\}/g, '');
                    expect(stripped).not.toContain('{');
                    expect(stripped).not.toContain('}');
                }
            }
        }
    });
});

// ── design.config ────────────────────────────────────────────────────────────

describe('design.config — themes and palettes', () => {
    test('THEMES has Midnight, Void, Ember with complete token sets', () => {
        expect(Object.keys(design.THEMES).sort()).toEqual(['Ember', 'Midnight', 'Void']);
        for (const name of Object.keys(design.THEMES)) {
            const t = design.THEMES[name];
            expect(t.bg).toMatch(HEX_RE);
            expect(t.ink).toMatch(HEX_RE);
            expect(t.inkDim).toMatch(HEX_RE);
            expect(typeof t.line).toBe('string');
            expect(t.line).toMatch(/^rgba\(/);
            expect(t.panelRgb).toMatch(/^\d+,\s*\d+,\s*\d+$/);
            expect(t.accent).toMatch(HEX_RE);
        }
    });

    test('theme hex values are verbatim from the design handoff', () => {
        expect(design.THEMES.Midnight).toEqual({
            bg: '#06090F', ink: '#E8EDF4', inkDim: '#93A0B4',
            line: 'rgba(140,165,205,0.14)', panelRgb: '13,19,30', accent: '#3BDCB2',
        });
        expect(design.THEMES.Void).toEqual({
            bg: '#000000', ink: '#EDEDF0', inkDim: '#8E8E9A',
            line: 'rgba(180,180,200,0.13)', panelRgb: '10,10,13', accent: '#4EA8FF',
        });
        expect(design.THEMES.Ember).toEqual({
            bg: '#0C0806', ink: '#F2EAE2', inkDim: '#A89A8C',
            line: 'rgba(220,180,140,0.14)', panelRgb: '24,16,11', accent: '#FFB454',
        });
    });

    test('Midnight is the default theme', () => {
        expect(design.DEFAULT_THEME).toBe('Midnight');
        expect(design.THEMES[design.DEFAULT_THEME]).toBeDefined();
    });

    test('SENTIMENT_PALETTE carries the handoff default palette', () => {
        expect(design.SENTIMENT_PALETTE).toEqual({
            negative: '#FF6E5E', neutral: '#7E8AA0', positive: '#3BDCB2',
        });
    });

    test('CAT_COLORS keys are the REAL API category slugs (plus demo "tech")', () => {
        expect(Object.keys(design.CAT_COLORS).sort()).toEqual([
            'academic', 'blog', 'developer', 'news',
            'nonprofit', 'policy', 'social', 'tech',
        ]);
        for (const cat of Object.keys(design.CAT_COLORS)) {
            expect(design.CAT_COLORS[cat]).toMatch(HEX_RE);
        }
    });

    test('CAT_COLORS handoff hues map onto their API slugs verbatim', () => {
        expect(design.CAT_COLORS.social).toBe('#FF9F5A');
        expect(design.CAT_COLORS.news).toBe('#5AA9FF');
        expect(design.CAT_COLORS.academic).toBe('#C08BFF');
        expect(design.CAT_COLORS.policy).toBe('#FF6E9C');
        expect(design.CAT_COLORS.developer).toBe('#3BDCB2');
        expect(design.CAT_COLORS.blog).toBe('#7EE0FF');
    });

    test('every category color is unique (categories must be tellable apart)', () => {
        const colors = Object.values(design.CAT_COLORS).map(c => c.toUpperCase());
        expect(new Set(colors).size).toBe(colors.length);
    });

    test('SEVERITY_COLORS matches the handoff severity tokens', () => {
        expect(design.SEVERITY_COLORS).toEqual({
            alert: '#FF6E5E', watch: '#F5C36B', pass: '#3BDC7E',
        });
    });

    test('SENTIMENT_BUCKETS partitions the axis: positiveMin > 0 > negativeMax', () => {
        const { positiveMin, negativeMax } = design.SENTIMENT_BUCKETS;
        expect(Number.isFinite(positiveMin)).toBe(true);
        expect(Number.isFinite(negativeMax)).toBe(true);
        expect(positiveMin).toBeGreaterThan(0);
        expect(negativeMax).toBeLessThan(0);
        expect(positiveMin).toBeGreaterThan(negativeMax); // no overlap possible
    });

    test('bucket thresholds are the design values ±0.1', () => {
        expect(design.SENTIMENT_BUCKETS).toEqual({ positiveMin: 0.1, negativeMax: -0.1 });
    });

    test('GLOBE timing/threshold constants are complete and positive', () => {
        expect(design.GLOBE).toEqual({
            spinPeriodMs: 300000,
            ringPeriodMs: 2200,
            idleResumeMs: 3000,
            labelVolumeMin: 230,
            pacingVhPerChapter: 1.15,
        });
        for (const v of Object.values(design.GLOBE)) {
            expect(v).toBeGreaterThan(0);
        }
    });

    test('module is data-only (no functions anywhere in the tree)', () => {
        assertNoFunctions(design, 'PulseDesignConfig');
    });
});

// ── api.config ───────────────────────────────────────────────────────────────

describe('api.config — endpoints and polling constants', () => {
    test('ENDPOINTS lists every route the story frontend calls', () => {
        expect(api.ENDPOINTS).toEqual({
            aggregated: '/api/posts/aggregated-by-location',
            query: '/api/query',
            audit: '/api/audit/',
            health: '/api/health',
            bias: '/api/bias/latest',
            methodology: '/api/methodology',
            timeseries: '/api/sources/timeseries',
            themes: '/api/themes',
            refresh: '/api/refresh',
        });
    });

    test('every endpoint is a rooted /api/ path', () => {
        for (const url of Object.values(api.ENDPOINTS)) {
            expect(url.startsWith('/api/')).toBe(true);
        }
    });

    test('polling and paging constants', () => {
        expect(api.REFRESH_MS).toBe(150000);   // 2.5 min — inside the 2–3 min design window
        expect(api.CITY_POSTS_LIMIT).toBe(3);
        expect(api.TIMESERIES_HOURS).toBe(12);
    });

    test('module is data-only (no functions anywhere in the tree)', () => {
        assertNoFunctions(api, 'PulseApiConfig');
    });
});
