// PulseStoryConfig — the 11-beat scroll-story definition (DATA ONLY).
// Kickers, titles, camera intents, color/bar encodings, highlight rules,
// audit picks, declarative stats specs, and the explore next-steps list are
// ported VERBATIM from the design handoff prototype
// (design_handoff_pulse_of_ai/data.js buildChapters()); computed
// interpolations became {token} placeholders resolved by
// public/js/chapters.js via the PulseInsights TEMPLATES.
//
// This module must stay data-only: zero functions, zero derivation. All
// logic lives in utils.js / insights.js / chapters.js so it can be
// unit-tested; config structural invariants are locked by
// tests/unit/pure/config.test.js.
//
// Camera model — prototype zoom → globe.gl altitude:
//   The prototype used an orthographic canvas zoom in [1.0 .. 1.7]
//   (bigger = closer). globe.gl expresses the same intent as camera
//   ALTITUDE in earth radii (smaller = closer). Linear mapping:
//       altitude = 2.5 − (zoom − 1.0) × (2.5 − 1.4) / (1.7 − 1.0)
//   so zoom 1.0 → 2.5 (whole globe), 1.35 → ~1.95, 1.5 → ~1.71,
//   1.55 → ~1.64, 1.7 → 1.4 (tight close-up). Values below are that
//   mapping rounded to 2 decimals.
//
// Field semantics:
//   camera        {lat,lng,altitude} static pan target, or null. Null means
//                 the resolver follows the FIRST highlighted city (when the
//                 beat has a highlightRule) or keeps a global default view.
//   altitude      zoom intent, ALWAYS present — the resolver needs it even
//                 when camera is null (camera.altitude === altitude when a
//                 static camera exists).
//   colorMode     'sentiment' | 'category' | 'warm' | 'cold' (globe recolor).
//   barMetric     'volume' | 'positiveNet' | 'negativeNet' (per-city bars).
//   highlightRule string key interpreted by chapters.js HIGHLIGHT_RULES,
//                 or null (no highlight set).
//   auditPick     'pos' | 'neg' | null — which extreme post of the first
//                 highlighted city feeds the embedded audit receipt.
//   statsSpec     declarative [labelTemplate, valueTemplate] token-string
//                 pairs, resolved with the SAME token map as the body copy.
//   themePartition 'warm' | 'cold' | null — which half of /api/themes the
//                 theme beats display (see PulseInsights.partitionThemes).
//   explore       true only on the final free-exploration beat.
//   nextSteps     explore beat only — verbatim prototype checklist.
//
// Dual export guard: CommonJS (module.exports) for jest,
// window.PulseStoryConfig for browser script tags (same pattern as utils.js).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();              // Node / jest
    } else {
        root.PulseStoryConfig = factory();       // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const STORY = [
        {
            id: 'overview',
            kicker: 'LIVE · REFRESH CYCLE 2–3 MIN',
            title: 'Right now, the world is talking about AI.',
            templateId: 'overview',
            camera: null,            // global view (prototype focus: null)
            altitude: 2.5,           // zoom 1.0
            cameraMs: 1200,
            colorMode: 'sentiment',
            barMetric: 'volume',
            highlightRule: null,
            auditPick: null,
            themePartition: null,
            explore: false,
            statsSpec: [
                ['posts / hour', '{totalPosts}'],
                ['global sentiment', '{globalNet}'],
                // Prototype showed a HARDCODED 'sources online 48 / 50' —
                // source health is not derivable from the aggregation
                // payload, and this repo never passes demo numbers off as
                // live. Replaced with a real derivable stat.
                ['cities reporting', '{cityCount}'],
            ],
        },
        {
            id: 'volume',
            kicker: 'CHAPTER 01 · VOLUME LEADERS',
            title: 'The conversation has capitals.',
            templateId: 'volume',
            camera: null,            // follows the #1 volume city
            altitude: 1.95,          // zoom 1.35
            cameraMs: 1000,
            colorMode: 'sentiment',
            barMetric: 'volume',
            highlightRule: 'volumeTop3',
            auditPick: null,
            themePartition: null,
            explore: false,
            statsSpec: [
                ['{volumeCity1}', '{volumeCount1}/hr'],
                ['{volumeCity2}', '{volumeCount2}/hr'],
                ['{volumeCity3}', '{volumeCount3}/hr'],
            ],
        },
        {
            id: 'divide',
            kicker: 'CHAPTER 02 · THE DIVIDE',
            title: 'Same city, opposite moods.',
            templateId: 'divide',
            camera: null,            // follows the widest-divide city
            altitude: 1.64,          // zoom 1.55
            cameraMs: 1000,
            colorMode: 'sentiment',
            barMetric: 'volume',
            highlightRule: 'widestDivide',
            auditPick: null,
            themePartition: null,
            explore: false,
            statsSpec: [
                ['{divideCity} · {divideHiCategory}', '{divideHiNet}'],
                ['{divideCity} · {divideLoCategory}', '{divideLoNet}'],
                ['divergence', '{divideSpan} — global max'],
            ],
        },
        {
            id: 'negativity',
            kicker: 'CHAPTER 03 · NEGATIVITY HOTSPOTS',
            title: 'Where the mood cools.',
            templateId: 'negativity',
            camera: null,            // follows the coolest city
            altitude: 1.71,          // zoom 1.5
            cameraMs: 1000,
            colorMode: 'sentiment',
            barMetric: 'negativeNet',
            highlightRule: 'negativeTop3',
            auditPick: 'neg',        // embedded receipt: most negative post
            themePartition: null,
            explore: false,
            statsSpec: [],           // prototype shows the audit demo instead
        },
        {
            id: 'positivity',
            kicker: 'CHAPTER 04 · POSITIVITY LEADERS',
            title: 'Optimism has an address.',
            templateId: 'positivity',
            camera: null,            // follows the warmest city
            altitude: 1.71,          // zoom 1.5
            cameraMs: 1000,
            colorMode: 'sentiment',
            barMetric: 'positiveNet',
            highlightRule: 'positiveTop3',
            auditPick: 'pos',        // embedded receipt: most positive post
            themePartition: null,
            explore: false,
            statsSpec: [],           // prototype shows the audit demo instead
        },
        {
            id: 'drivers',
            kicker: 'CHAPTER 05 · WHO’S DRIVING',
            title: 'Who’s driving the conversation?',
            templateId: 'drivers',
            camera: { lat: 15, lng: 10, altitude: 2.42 }, // prototype focus {15,10}
            altitude: 2.42,          // zoom 1.05
            cameraMs: 1200,
            colorMode: 'category',
            barMetric: 'volume',
            highlightRule: null,
            auditPick: null,
            themePartition: null,
            explore: false,
            statsSpec: [
                ['{catShare1Category}', '{catShare1Pct}'],
                ['{catShare2Category}', '{catShare2Pct}'],
                ['categories', '{categoryCount} tracked'],
            ],
        },
        {
            id: 'themes-warm',
            kicker: 'CHAPTER 06 · WHAT RUNS WARM',
            title: 'What the world is excited about.',
            templateId: 'themes-warm',
            camera: { lat: 18, lng: 80, altitude: 2.5 }, // prototype focus {18,80}
            altitude: 2.5,           // zoom 1.0
            cameraMs: 1200,
            colorMode: 'warm',
            barMetric: 'volume',
            highlightRule: null,     // theme-led city spotlight is a runtime
            auditPick: null,         // concern (needs live /api/themes data)
            themePartition: 'warm',
            explore: false,
            statsSpec: [],           // theme rows render from live theme data
        },
        {
            id: 'themes-cold',
            kicker: 'CHAPTER 07 · WHAT RUNS COLD',
            title: 'What the world is worried about.',
            templateId: 'themes-cold',
            camera: { lat: 45, lng: 0, altitude: 2.5 }, // prototype focus {45,0}
            altitude: 2.5,           // zoom 1.0
            cameraMs: 1200,
            colorMode: 'cold',
            barMetric: 'volume',
            highlightRule: null,     // see themes-warm note
            auditPick: null,
            themePartition: 'cold',
            explore: false,
            statsSpec: [],
        },
        {
            id: 'messengers',
            kicker: 'CHAPTER 08 · THE MESSENGERS',
            title: 'Don’t shoot the messenger — score them.',
            templateId: 'messengers',
            camera: null,            // global view (prototype focus: null)
            altitude: 2.34,          // zoom 1.1
            cameraMs: 1000,
            colorMode: 'category',
            barMetric: 'volume',
            highlightRule: null,
            auditPick: null,
            themePartition: null,
            explore: false,
            statsSpec: [
                ['most positive · {msgHiSource}', '{msgHiCategory} {msgHiNet}'],
                ['most negative · {msgLoSource}', '{msgLoCategory} {msgLoNet}'],
                ['gap by messenger', '{msgGap}'],
            ],
        },
        {
            id: 'summary',
            kicker: 'CHAPTER 09 · THE HOUR IN REVIEW',
            title: 'The hour, on one card.',
            templateId: 'summary',
            camera: null,            // global view with the trio highlighted
            altitude: 2.5,           // zoom 1.0
            cameraMs: 1200,
            colorMode: 'sentiment',
            barMetric: 'volume',
            highlightRule: 'summaryTrio',
            auditPick: null,
            themePartition: null,
            explore: false,
            statsSpec: [
                ['posts / hour', '{totalPosts}'],
                ['warmest · {warmestCity}', '{warmestNet}'],
                ['coolest · {coolestCity}', '{coolestNet}'],
            ],
        },
        {
            id: 'explore',
            kicker: 'CHAPTER 10 · YOUR TURN · NEXT STEPS',
            title: 'Now you drive.',
            templateId: 'explore',
            camera: null,            // global free-explore view
            altitude: 2.26,          // zoom 1.15
            cameraMs: 800,
            colorMode: 'sentiment',
            barMetric: 'volume',
            highlightRule: null,
            auditPick: null,
            themePartition: null,
            explore: true,
            statsSpec: [],
            nextSteps: [
                'Drag the globe — it resumes spinning when you let go',
                'Click any city for its posts and sentiment split',
                'Hit “why?” on a post to pull its audit receipt',
                'Hover the ribbon below to spotlight a source on the map',
                'Open Tweaks to change theme, palette, and spin',
            ],
        },
    ];

    return { STORY };
}));
