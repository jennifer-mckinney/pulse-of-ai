// PulseUtils — shared pure helpers for the Pulse of AI frontend.
// Extracted from public/js/map.js so they can be unit-tested in Node
// (jest.pure.config.js) and reused by globe.js / insights.js / chapters.js.
//
// Dual export guard: CommonJS (module.exports) for jest, window.PulseUtils
// for browser script tags. No DOM access — this module must stay pure.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();          // Node / jest
    } else {
        root.PulseUtils = factory();         // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ── Escape HTML special characters in any data value rendered to the page ──
    // Prevents XSS if city names or source names contain &, <, >, ", ' chars.
    // '&' is replaced first so already-produced entities are not double-mangled.
    function esc(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ── Color palettes (ported verbatim from map.js) ────────────────────────────
    // green / yellow / red sentiment; multi-hue palette for source segments
    const SENTIMENT_COLORS = {
        positive: '#62C370',
        neutral:  '#F5C842',
        negative: '#B63634',
    };

    const SOURCE_PALETTE = [
        '#60A5FA', // blue
        '#A78BFA', // violet
        '#34D399', // emerald
        '#FB923C', // orange
        '#F472B6', // pink
        '#FBBF24', // amber
        '#38BDF8', // sky
        '#4ADE80', // lime
    ];

    // ── Formatters ──────────────────────────────────────────────────────────────
    // fmtPct: fraction (0..1) → percent string with one decimal, e.g. 0.4267 → "42.7%".
    // Non-finite input renders as an em-dash rather than "NaN%".
    function fmtPct(fraction) {
        if (!Number.isFinite(fraction)) return '—';
        return (fraction * 100).toFixed(1) + '%';
    }

    // fmtCount: integer count → locale-grouped string, e.g. 1234 → "1,234".
    // Fractions are truncated (counts are whole things); non-finite → em-dash.
    function fmtCount(count) {
        if (!Number.isFinite(count)) return '—';
        return Math.trunc(count).toLocaleString('en-US');
    }

    return { esc, SENTIMENT_COLORS, SOURCE_PALETTE, fmtPct, fmtCount };
}));
