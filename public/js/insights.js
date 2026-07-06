// PulseInsights — pure client-side derivation engine for the scroll story.
// Consumes NORMALIZED cities (see public/js/data.js normalizeCities) and
// derives the numbers the chapter cards interpolate. No DOM access, no fetch —
// this module must stay pure so it runs under jest.pure.config.js.
//
// All card text produced from these values lands in the page via textContent
// (never innerHTML), so the interpolated strings are XSS-safe by construction.
// Do NOT "helpfully" switch the consumers to HTML rendering.
//
// Dual export guard with dependency injection: CommonJS requires utils for
// jest; browser script tags read the window global (load utils.js BEFORE
// this file). Same pattern as public/js/chapters.js.
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./utils'));   // Node / jest
    } else {
        root.PulseInsights = factory(root.PulseUtils);  // browser global
    }
}(typeof self !== 'undefined' ? self : this, function (utils) {
    'use strict';

    const { netSentiment } = utils;

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

    // ── 11-beat story derivations ───────────────────────────────────────────────

    // Categories owning less than this share of a city's posts are ignored by
    // the divide story — a 2%-share category with an extreme score is noise,
    // not a "split city" (prototype used the same 8% floor).
    const DIVIDE_MIN_SHARE = 0.08;

    // catBreakdown: aggregate one city's sources by source_category into
    // [{category, share, net}] sorted by share descending (ties break
    // alphabetically). Shares are fractions of the city's summed SOURCE
    // totals (self-consistent: they always sum to 1 when sources exist);
    // net is the category's own (positive − negative) / total.
    function catBreakdown(city) {
        if (!city || !Array.isArray(city.sources)) return [];
        const byCat = {}; // category → {positive, negative, total}
        let catSum = 0;
        for (const s of city.sources) {
            if (!s || typeof s !== 'object') continue;
            const cat = s.source_category;
            if (!byCat[cat]) byCat[cat] = { positive: 0, negative: 0, total: 0 };
            byCat[cat].positive += s.positive;
            byCat[cat].negative += s.negative;
            byCat[cat].total    += s.total;
            catSum += s.total;
        }
        const rows = Object.keys(byCat).map(category => ({
            category,
            share: catSum > 0 ? byCat[category].total / catSum : 0,
            net: netSentiment(byCat[category]),
        }));
        rows.sort((a, b) => (b.share - a.share)
            || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
        return rows;
    }

    // widestCategoryDivide: the city whose qualifying categories (share ≥
    // DIVIDE_MIN_SHARE) disagree the most about the same hour. MIN_TOTAL
    // guard applies (tiny cities are noise). Returns
    // {city, hi:{category,net}, lo:{category,net}, span} — city is the
    // OBJECT, never a name (same-name cities exist) — or null when no city
    // has two qualifying categories. Span ties break by higher city total,
    // then alphabetically by city name (deterministic).
    function widestCategoryDivide(cities) {
        const list = Array.isArray(cities) ? cities : [];
        let best = null;
        for (const c of list) {
            if (!c || !(c.total >= MIN_TOTAL)) continue;
            const rows = catBreakdown(c).filter(r => r.share >= DIVIDE_MIN_SHARE);
            if (rows.length < 2) continue; // a divide needs two sides
            let hi = rows[0];
            let lo = rows[0];
            for (const r of rows) {
                if (r.net > hi.net) hi = r;
                if (r.net < lo.net) lo = r;
            }
            const span = hi.net - lo.net;
            if (best === null
                || span > best.span
                || (span === best.span && c.total > best.city.total)
                || (span === best.span && c.total === best.city.total
                    && String(c.city) < String(best.city.city))) {
                best = {
                    city: c,
                    hi: { category: hi.category, net: hi.net },
                    lo: { category: lo.category, net: lo.net },
                    span,
                };
            }
        }
        return best;
    }

    // ribbonRows: the marimekko source-ribbon model. Aggregates every
    // source row across all cities by category into
    //   [{category, share, volume, net, split:{pos,neu,neg}, topSource}]
    // sorted by share descending (ties alphabetical). share is the fraction
    // of GLOBAL source volume; split is the category's own pos/neu/neg mix;
    // topSource is the highest-volume source_name within the category
    // (summed across cities; ties alphabetical) — the "led by <site>" voice.
    function ribbonRows(cities) {
        const list = Array.isArray(cities) ? cities : [];
        const byCat = {}; // category → {positive, neutral, negative, total, bySource}
        let globalVolume = 0;
        for (const c of list) {
            if (!c || !Array.isArray(c.sources)) continue;
            for (const s of c.sources) {
                if (!s || typeof s !== 'object') continue;
                const cat = s.source_category;
                if (!byCat[cat]) {
                    byCat[cat] = { positive: 0, neutral: 0, negative: 0, total: 0, bySource: {} };
                }
                byCat[cat].positive += s.positive;
                byCat[cat].neutral  += s.neutral;
                byCat[cat].negative += s.negative;
                byCat[cat].total    += s.total;
                byCat[cat].bySource[s.source_name] =
                    (byCat[cat].bySource[s.source_name] || 0) + s.total;
                globalVolume += s.total;
            }
        }
        const rows = Object.keys(byCat).map(category => {
            const agg = byCat[category];
            let topSource = null;
            for (const name of Object.keys(agg.bySource)) {
                if (topSource === null
                    || agg.bySource[name] > agg.bySource[topSource]
                    || (agg.bySource[name] === agg.bySource[topSource] && name < topSource)) {
                    topSource = name;
                }
            }
            return {
                category,
                share: globalVolume > 0 ? agg.total / globalVolume : 0,
                volume: agg.total,
                net: netSentiment(agg),
                split: agg.total > 0
                    ? { pos: agg.positive / agg.total,
                        neu: agg.neutral / agg.total,
                        neg: agg.negative / agg.total }
                    : { pos: 0, neu: 0, neg: 0 },
                topSource,
            };
        });
        rows.sort((a, b) => (b.share - a.share)
            || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
        return rows;
    }

    // Theme warm/cold boundary — prototype semantics: net ≥ 0.1 is a warm
    // theme, everything below (neutral included) is cold. Intentionally the
    // same 0.1 magnitude as design.config SENTIMENT_BUCKETS.positiveMin.
    const THEME_WARM_MIN = 0.1;

    // partitionThemes: split /api/themes rows into the warm or cold half.
    //   'warm' → net ≥ 0.1, sorted warmest first
    //   'cold' → net < 0.1, sorted coldest first
    // Together the two modes PARTITION the list (no overlap, no loss).
    // Accepts rows carrying `net`, falling back to the prototype's `sent`
    // field so the bundled demo themes work unchanged, then to the actual
    // /api/themes response shape ({keyword, volume, positive, neutral,
    // negative, top_category}) by deriving net = (positive − negative) /
    // volume — without this, live API rows would all silently score 0 and
    // land in the cold half. Throws on an unknown mode — a typo must fail
    // tests loudly, not silently render nothing.
    function partitionThemes(themes, mode) {
        if (mode !== 'warm' && mode !== 'cold') {
            throw new Error(`partitionThemes: unknown mode "${mode}"`);
        }
        const list = Array.isArray(themes) ? themes : [];
        const netOf = (t) => {
            if (t && Number.isFinite(t.net)) return t.net;
            if (t && Number.isFinite(t.sent)) return t.sent; // prototype shape
            if (t && Number.isFinite(t.positive) && Number.isFinite(t.negative)
                && Number.isFinite(t.volume) && t.volume > 0) {
                return (t.positive - t.negative) / t.volume;  // /api/themes shape
            }
            return 0;
        };
        const picked = list.filter(t => mode === 'warm'
            ? netOf(t) >= THEME_WARM_MIN
            : netOf(t) < THEME_WARM_MIN);
        picked.sort((a, b) => mode === 'warm'
            ? netOf(b) - netOf(a)   // warmest first
            : netOf(a) - netOf(b)); // coldest first
        return picked;
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
    // One entry per story beat (PulseStoryConfig.STORY, resolved by
    // public/js/chapters.js). Body copy is VERBATIM from the design handoff
    // prototype (design_handoff_pulse_of_ai/data.js buildChapters()) with
    // computed interpolations converted to {token} placeholders; the
    // prototype's "sentiment" values map to NET sentiment
    // ((positive − negative) / total, formatted ±0.00 via utils.fmtNet).
    // renderTemplate throws on any token it cannot resolve, so a typo here
    // fails tests loudly.
    const TEMPLATES = {
        overview:
            '50 sources. 7 categories. {cityCount} cities reporting in the ' +
            'last hour — every dot sized by volume, colored by sentiment. ' +
            'Scroll to read the pulse.',
        volume:
            '{volumeCity1} leads the world at {volumeCount1} posts/hr, with ' +
            '{volumeCity2} ({volumeCount2}) and {volumeCity3} ({volumeCount3}) ' +
            'close behind. Together the top three carry {topThreeSharePct} of ' +
            'everything measured this hour.',
        divide:
            'In {divideCity}, {divideHiCategory} sources run at {divideHiNet} ' +
            'while {divideLoCategory} coverage sits at {divideLoNet} — a ' +
            '{divideSpan} divergence, the widest split between source ' +
            'categories anywhere on the globe.',
        negativity:
            '{negCity1} runs the coolest sentiment on the map ({negNet1}), ' +
            'where {negCategory1} discourse dominates — followed by {negCity2} ' +
            '({negNet2}) and {negCity3} ({negNet3}). Every one of these scores ' +
            'has a receipt. Pull one:',
        positivity:
            'And the warmest: {posCity1} ({posNet1}), {posCity2} ({posNet2}), ' +
            '{posCity3} ({posNet3}) — all three led by builder communities ' +
            'posting their own results. The good news has receipts too. Pull one:',
        drivers:
            'Recolor the map by dominant source and the pattern jumps out: ' +
            '{catShare1Category} sources carry {catShare1Pct} of global volume ' +
            'this hour, with {catShare2Category} at {catShare2Pct}. Each dot ' +
            'now wears the color of the loudest voice in its city.',
        'themes-warm':
            'Zoom past cities and the conversation splits into themes. The ' +
            'warm ones are concrete: people shipping agents, clinics piloting ' +
            'triage, models running on-device. The map lights up where these ' +
            'themes live.',
        'themes-cold':
            'The cold themes are structural: regulation deadlines, jobs and ' +
            'displacement, the slow grind of safety evals. Now the map shows ' +
            'where the worry concentrates — policy and news capitals.',
        messengers:
            '{msgHiCategory} sources run warmest this hour ({msgHiNet}), led ' +
            'by {msgHiSource}. {msgLoCategory} sources run coldest ' +
            '({msgLoNet}), led by {msgLoSource}. Same hour, same cities — a ' +
            '{msgGap} gap depending on who’s talking.',
        summary:
            '{totalPosts} posts across 7 source categories. Global mood ' +
            '{globalNet}. {warmestCity} ran warmest, {coolestCity} coolest — ' +
            'and the biggest story wasn’t a place, it was the gap between ' +
            'messengers. Every number above has a receipt behind it.',
        explore:
            'The story’s over — the data isn’t. Try these:',
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

    return {
        MIN_TOTAL,
        computeInsights,
        regionOf,
        renderTemplate,
        TEMPLATES,
        catBreakdown,
        widestCategoryDivide,
        ribbonRows,
        partitionThemes,
    };
}));
