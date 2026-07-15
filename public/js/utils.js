// PulseUtils — shared pure helpers for the Pulse of AI frontend.
// Extracted from public/js/map.js so they can be unit-tested in Node
// (jest.pure.config.js) and reused by globe.js / insights.js / chapters.js.
//
// Dual export guard with dependency injection: CommonJS requires the design
// config for jest; browser script tags read the window global (load
// config/design.config.js BEFORE this file). No DOM access — this module
// must stay pure.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config/design.config')); // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseUtils = factory(root.PulseDesignConfig);           // browser global
    }
}(typeof self !== 'undefined' ? self : this, function (designConfig) {
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

    // ── Color palettes (re-exported from config/design.config.js) ───────────────
    // Single source of truth is the design config; these re-exports keep the
    // original PulseUtils consumer surface working (back-compat) while the
    // hues themselves now come from the design handoff:
    //   SENTIMENT_COLORS — neg/neu/pos sentiment hues (design SENTIMENT_PALETTE)
    //   SOURCE_PALETTE   — ordered category hues (design CAT_COLORS values)
    const SENTIMENT_COLORS = designConfig.SENTIMENT_PALETTE;
    const SOURCE_PALETTE = Object.values(designConfig.CAT_COLORS);

    // ── Sentiment bridge helpers ────────────────────────────────────────────────
    // The design prototype carried a per-city "sentiment" in −1..1; the real
    // normalized cities carry counts. NET sentiment is the bridge:
    //   net = (positive − negative) / total ∈ [−1 .. 1]
    // Everywhere the prototype displayed "sentiment", display net sentiment.

    // netSentiment: net score for a normalized city (or any object with
    // positive/negative/total counts). 0 when total is 0 or any input is
    // non-finite — a missing score must never become NaN downstream.
    function netSentiment(city) {
        if (!city) return 0;
        const positive = Number(city.positive);
        const negative = Number(city.negative);
        const total = Number(city.total);
        if (!Number.isFinite(positive) || !Number.isFinite(negative)
            || !Number.isFinite(total) || total <= 0) {
            return 0;
        }
        return (positive - negative) / total;
    }

    // sentimentBucket: classify a net score into 'positive' | 'neutral' |
    // 'negative'. Strict inequalities PARTITION the axis (net > positiveMin
    // is positive, net < negativeMax is negative, everything else — the
    // thresholds included — is neutral), deliberately fixing the prototype's
    // overlapping buckets. Thresholds default from the design config but are
    // injectable so the function stays pure and testable.
    function sentimentBucket(net, buckets) {
        const b = buckets || designConfig.SENTIMENT_BUCKETS;
        if (!Number.isFinite(net)) return 'neutral';
        if (net > b.positiveMin) return 'positive';
        if (net < b.negativeMax) return 'negative';
        return 'neutral';
    }

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

    // fmtNet: net sentiment → signed two-decimal string, e.g. +0.38 / −0.26.
    // Matches the prototype's fmt(): explicit '+' for >= 0, U+2212 MINUS SIGN
    // (not ASCII hyphen) for negatives. Non-finite → em-dash.
    function fmtNet(net) {
        if (!Number.isFinite(net)) return '—';
        return (net >= 0 ? '+' : '−') + Math.abs(net).toFixed(2);
    }

    return {
        esc,
        SENTIMENT_COLORS,
        SOURCE_PALETTE,
        netSentiment,
        sentimentBucket,
        fmtPct,
        fmtCount,
        fmtNet,
    };
}));
