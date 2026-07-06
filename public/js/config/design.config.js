// PulseDesignConfig — design tokens for the Pulse of AI frontend (DATA ONLY).
// Every value is ported from the design handoff README "Design Tokens"
// section (design_handoff_pulse_of_ai/README.md) unless commented otherwise.
// Zero functions by contract — logic that consumes these tokens lives in
// utils.js / globe / story modules. Structural invariants are locked by
// tests/unit/pure/config.test.js.
//
// Dual export guard: CommonJS (module.exports) for jest,
// window.PulseDesignConfig for browser script tags (same pattern as utils.js).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();              // Node / jest
    } else {
        root.PulseDesignConfig = factory();      // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Deep-freeze: config is shared, data-only state — a consumer mutating a
    // token table would silently corrupt every other module. Frozen exports
    // make mutation attempts throw in strict mode instead.
    function deepFreeze(node) {
        if (node && typeof node === 'object' && !Object.isFrozen(node)) {
            Object.freeze(node);
            for (const key of Object.keys(node)) deepFreeze(node[key]);
        }
        return node;
    }

    // ── Themes (CSS custom-property sets, switchable at runtime) ────────────
    // Verbatim from the handoff README theme table. panelRgb feeds
    // `--panel: rgba(var(--panel-rgb), var(--panel-alpha))`.
    const THEMES = {
        Midnight: {
            bg: '#06090F',
            ink: '#E8EDF4',
            inkDim: '#93A0B4',
            line: 'rgba(140,165,205,0.14)',
            panelRgb: '13,19,30',
            accent: '#3BDCB2',
        },
        Void: {
            bg: '#000000',
            ink: '#EDEDF0',
            inkDim: '#8E8E9A',
            line: 'rgba(180,180,200,0.13)',
            panelRgb: '10,10,13',
            accent: '#4EA8FF',
        },
        Ember: {
            bg: '#0C0806',
            ink: '#F2EAE2',
            inkDim: '#A89A8C',
            line: 'rgba(220,180,140,0.14)',
            panelRgb: '24,16,11',
            accent: '#FFB454',
        },
    };

    const DEFAULT_THEME = 'Midnight';

    // ── Sentiment palette (default handoff palette: neg / neu / pos) ────────
    const SENTIMENT_PALETTE = {
        negative: '#FF6E5E',
        neutral:  '#7E8AA0',
        positive: '#3BDCB2',
    };

    // ── Category colors (consistent everywhere — FR-21) ─────────────────────
    // The handoff used display-cased prototype categories (Social, News,
    // Academic, Policy, Developer, Forums, Blogs). The REAL API categories
    // are lowercase slugs from data_sources.category, so the keys here are
    // the API slugs with the handoff hues mapped onto them:
    //   social ← Social, news ← News, academic ← Academic, policy ← Policy,
    //   developer ← Developer, blog ← Blogs.
    // Two slugs have no prototype counterpart and take colors from the same
    // handoff palette family (commented):
    const CAT_COLORS = {
        social:    '#FF9F5A',
        news:      '#5AA9FF',
        academic:  '#C08BFF',
        policy:    '#FF6E9C',
        nonprofit: '#B8E986', // addition — soft green from the handoff sentiment-palette family (palette 3 positive)
        developer: '#3BDCB2',
        blog:      '#7EE0FF',
        tech:      '#F5D95A', // addition — the handoff "Forums" yellow, reused for the tech/forums-adjacent slug
    };

    // ── Severity colors (bias/health drawer) ────────────────────────────────
    const SEVERITY_COLORS = {
        alert: '#FF6E5E',
        watch: '#F5C36B',
        pass:  '#3BDC7E',
    };

    // ── Sentiment bucket thresholds ─────────────────────────────────────────
    // Partitioned buckets over NET sentiment ((positive − negative) / total):
    //   net >  positiveMin → 'positive'
    //   net <  negativeMax → 'negative'
    //   otherwise          → 'neutral'
    // This deliberately FIXES the prototype's overlapping buckets (it used
    // >= 0.1 warm AND < 0.1 cold in one place, >= 0 positive elsewhere) —
    // here the three ranges partition the axis with no overlap and no gap.
    const SENTIMENT_BUCKETS = {
        positiveMin: 0.1,
        negativeMax: -0.1,
    };

    // ── Globe behavior constants ────────────────────────────────────────────
    const GLOBE = {
        spinPeriodMs: 300000,     // ~5 min per revolution at speed 1 (handoff-verified)
        ringPeriodMs: 2200,       // city pulse-ring expansion period
        idleResumeMs: 3000,       // auto-rotation resumes this long after a drag
        labelVolumeMin: 230,      // explore mode labels cities above this volume
        pacingVhPerChapter: 1.15, // scroll spacer: 1.15 × 100vh per chapter
    };

    return deepFreeze({
        THEMES,
        DEFAULT_THEME,
        SENTIMENT_PALETTE,
        CAT_COLORS,
        SEVERITY_COLORS,
        SENTIMENT_BUCKETS,
        GLOBE,
    });
}));
