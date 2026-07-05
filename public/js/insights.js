// PulseInsights — pure client-side derivation engine for the scroll story.
// Consumes NORMALIZED cities (see public/js/data.js normalizeCities) and
// derives the numbers the chapter cards interpolate. No DOM access, no fetch —
// this module must stay pure so it runs under jest.pure.config.js.
//
// All card text produced from these values lands in the page via textContent
// (never innerHTML), so the interpolated strings are XSS-safe by construction.
// Do NOT "helpfully" switch the consumers to HTML rendering.
//
// Dual export guard: CommonJS (module.exports) for jest, window.PulseInsights
// for browser script tags. Same pattern as public/js/utils.js.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();          // Node / jest
    } else {
        root.PulseInsights = factory();      // browser global
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Cities with fewer than MIN_TOTAL posts are excluded from SHARE-based
    // superlatives (a 4-post city being "100% positive" is noise, not signal).
    // Volume superlatives have no guard — small totals are the honest answer.
    const MIN_TOTAL = 5;

    // ── Region bucketing ────────────────────────────────────────────────────────
    // Three longitude bands; lat is accepted for signature stability (future
    // finer buckets) but unused today. Boundary convention: a band owns its
    // WESTERN edge, so -30 → Europe-Africa and 60 → Asia-Pacific.
    function regionOf(lat, lng) {
        if (lng < -30) return 'Americas';
        if (lng < 60) return 'Europe-Africa';
        return 'Asia-Pacific';
    }

    // ── Internal helpers ────────────────────────────────────────────────────────

    // Deterministic superlative pick: highest score wins; ties break by higher
    // total, then alphabetically by city name. Returns null on empty input.
    function pickBy(cities, scoreFn) {
        let best = null;
        let bestScore = -Infinity;
        for (const c of cities) {
            const score = scoreFn(c);
            if (best === null
                || score > bestScore
                || (score === bestScore && c.total > best.total)
                || (score === bestScore && c.total === best.total
                    && String(c.city) < String(best.city))) {
                best = c;
                bestScore = score;
            }
        }
        return best;
    }

    // Laplace-smoothed positive:negative ratio — the +1 on both sides keeps
    // the ratio finite for cities with zero negatives (or zero positives).
    function laplaceRatio(city) {
        return (city.positive + 1) / (city.negative + 1);
    }

    // ── Main derivation ─────────────────────────────────────────────────────────
    function computeInsights(cities) {
        const list = Array.isArray(cities) ? cities : [];
        const eligible = list.filter(c => c.total >= MIN_TOTAL); // share guard

        // Global totals + shares
        const globalTotals = { positive: 0, neutral: 0, negative: 0, total: 0 };
        for (const c of list) {
            globalTotals.positive += c.positive;
            globalTotals.neutral  += c.neutral;
            globalTotals.negative += c.negative;
            globalTotals.total    += c.total;
        }
        const globalShares = globalTotals.total > 0
            ? { positive: globalTotals.positive / globalTotals.total,
                neutral:  globalTotals.neutral  / globalTotals.total,
                negative: globalTotals.negative / globalTotals.total }
            : { positive: 0, neutral: 0, negative: 0 };

        // Superlatives
        const highestVolumeCity = pickBy(list, c => c.total);
        const mostPositiveCity  = pickBy(eligible, c => c.shares.positive);
        const mostNegativeCity  = pickBy(eligible, c => c.shares.negative);

        // Sentiment ratio extremes (Laplace smoothed; guard applies).
        // Requires at least TWO eligible cities — with one, "highest" and
        // "lowest" would be the same city and the divide story is a tautology.
        // Callers (the divide chapter) take their fallback path on null.
        let sentimentRatioExtremes = null;
        if (eligible.length >= 2) {
            const highest = pickBy(eligible, c => laplaceRatio(c));
            const lowest  = pickBy(eligible, c => -laplaceRatio(c));
            sentimentRatioExtremes = {
                highest: { city: highest, ratio: laplaceRatio(highest) },
                lowest:  { city: lowest,  ratio: laplaceRatio(lowest)  },
            };
        }

        // Source-category aggregation (global + per city)
        const categoryTotals = {};              // category → summed source totals
        const dominantSourceCategoryByCity = {}; // city name → top category
        let largestSourceConcentration = null;   // most single-source-dependent city
        for (const c of list) {
            const perCity = {};
            for (const s of c.sources) {
                categoryTotals[s.source_category] =
                    (categoryTotals[s.source_category] || 0) + s.total;
                perCity[s.source_category] = (perCity[s.source_category] || 0) + s.total;

                // Concentration: share of the city's posts owned by ONE source.
                // Same MIN_TOTAL guard — a 4-post city is trivially concentrated.
                // Clamped to 1: inconsistent upstream rows (source counts
                // exceeding the city's own counts) must not report >100%.
                if (c.total >= MIN_TOTAL) {
                    const pct = Math.min(1, s.total / c.total);
                    if (largestSourceConcentration === null
                        || pct > largestSourceConcentration.pct) {
                        largestSourceConcentration = {
                            // The city OBJECT (like the other superlatives) —
                            // consumers must not look it up by name, which
                            // breaks on same-name cities. Display the name
                            // via city.city.
                            city: c,
                            source_name: s.source_name,
                            source_category: s.source_category,
                            pct,
                        };
                    }
                }
            }
            const topCat = topCategory(perCity);
            if (topCat !== null) dominantSourceCategoryByCity[c.city] = topCat;
        }

        let dominantSourceCategoryGlobal = null;
        const globalTopCat = topCategory(categoryTotals);
        if (globalTopCat !== null) {
            const catSum = Object.values(categoryTotals).reduce((a, b) => a + b, 0);
            dominantSourceCategoryGlobal = {
                category: globalTopCat,
                total: categoryTotals[globalTopCat],
                share: catSum > 0 ? categoryTotals[globalTopCat] / catSum : 0,
            };
        }

        // Regional dominance
        const regionalTotals = { 'Americas': 0, 'Europe-Africa': 0, 'Asia-Pacific': 0 };
        for (const c of list) regionalTotals[regionOf(c.lat, c.lng)] += c.total;
        let leader = null;
        for (const region of Object.keys(regionalTotals)) {
            if (regionalTotals[region] > 0
                && (leader === null || regionalTotals[region] > regionalTotals[leader])) {
                leader = region;
            }
        }

        // Extremes delta: how far the extreme cities sit from the global average
        // (percentage points, as fractions — format with fmtPct at render time).
        const extremesDelta = (mostPositiveCity && mostNegativeCity)
            ? { positivePct: mostPositiveCity.shares.positive - globalShares.positive,
                negativePct: mostNegativeCity.shares.negative - globalShares.negative }
            : null;

        return {
            cityCount: list.length,
            globalTotals,
            globalShares,
            highestVolumeCity,
            mostPositiveCity,
            mostNegativeCity,
            sentimentRatioExtremes,
            dominantSourceCategoryGlobal,
            dominantSourceCategoryByCity,
            largestSourceConcentration,
            regionalDominance: { totals: regionalTotals, leader },
            extremesDelta,
        };
    }

    // Highest-count category; ties break alphabetically (deterministic).
    // Returns null when the map is empty.
    function topCategory(totalsByCategory) {
        let best = null;
        for (const cat of Object.keys(totalsByCategory)) {
            if (best === null
                || totalsByCategory[cat] > totalsByCategory[best]
                || (totalsByCategory[cat] === totalsByCategory[best] && cat < best)) {
                best = cat;
            }
        }
        return best;
    }

    // ── Chapter card templates ──────────────────────────────────────────────────
    // One entry per story chapter (see public/js/chapters.js). Tokens are
    // resolved by resolveChapter() from computeInsights() output; renderTemplate
    // throws on any token it cannot resolve, so a typo here fails tests loudly.
    const TEMPLATES = {
        overview:
            'The world is talking about AI. {totalPosts} posts across ' +
            '{cityCount} cities — {positivePct} positive, {negativePct} negative. ' +
            'Scroll to see where the conversation is loudest, warmest, and most wary.',
        volume:
            '{volumeCity} leads the conversation with {volumeTotal} posts — ' +
            'more than any other city tracked. {volumeSharePct} of everything ' +
            'we analyzed comes from this one place.',
        positivity:
            'Nowhere is the mood brighter than {positiveCity}, where ' +
            '{positiveSharePct} of posts lean positive — {positiveDeltaPct} ' +
            'above the global average.',
        negativity:
            '{negativeCity} is the most skeptical city on the map: ' +
            '{negativeSharePct} of its posts lean negative, {negativeDeltaPct} ' +
            'above the global average.',
        divide:
            'The divide is real. In {ratioHighCity} the positive-to-negative ' +
            'ratio runs {ratioHigh} to 1; in {ratioLowCity} it collapses to ' +
            '{ratioLow} to 1. Same technology, opposite moods.',
        sources:
            '{dominantCategory} sources drive {dominantCategoryPct} of global ' +
            'coverage. The most single-voice city is {concentrationCity}, where ' +
            '{concentrationSource} alone accounts for {concentrationPct} of posts.',
        explore:
            'Now it is your turn. Drag the globe, hover the bars, and filter by ' +
            'sentiment or source category to explore all {cityCount} cities yourself.',
    };

    // Interpolate {token} placeholders. Throws on unknown tokens instead of
    // leaving residue — a broken card should fail tests, not ship half-rendered.
    function renderTemplate(template, values) {
        return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (_, token) => {
            if (values === null || values === undefined
                || !Object.prototype.hasOwnProperty.call(values, token)) {
                throw new Error(`renderTemplate: unknown token "${token}"`);
            }
            return String(values[token]);
        });
    }

    return { MIN_TOTAL, computeInsights, regionOf, renderTemplate, TEMPLATES };
}));
