// PulseChapters — pure resolver for the 11-beat scroll story.
// Consumes the data-only beat definitions in PulseStoryConfig.STORY and the
// PulseInsights derivations, producing concrete, render-ready state per beat:
//   {id, kicker, cardTitle, cardBody, camera, cameraMs, colorMode, barMetric,
//    auditPick, themePartition, explore, nextSteps, stats, highlightCities,
//    isDemo}
//
// Pure module: no DOM, no fetch — globe.js/story.js apply the resolved state.
// Card text is rendered by consumers via textContent (never innerHTML), so
// interpolated strings are XSS-safe by construction. Keep it that way.
// Defense in depth: attacker-influenceable strings (city names, source names,
// category names from API data) are additionally HTML-escaped via
// PulseUtils.esc() at the point they enter card values, so even a consumer
// that wrongly switches to HTML rendering cannot inject markup.
//
// Dual export guard with dependency injection: CommonJS requires siblings for
// jest; browser script tags read the window globals (load config/*.js,
// utils.js and insights.js BEFORE this file).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(
            require('./utils'),
            require('./insights'),
            require('./config/story.config'));
    } else {
        root.PulseChapters = factory(
            root.PulseUtils, root.PulseInsights, root.PulseStoryConfig);
    }
}(typeof self !== 'undefined' ? self : this, function (utils, insightsMod, storyConfig) {
    'use strict';

    const { esc, fmtPct, fmtCount, fmtNet, netSentiment } = utils;
    const {
        TEMPLATES, renderTemplate, MIN_TOTAL,
        catBreakdown, widestCategoryDivide, ribbonRows,
    } = insightsMod;
    const { STORY } = storyConfig;

    // Shown when the data cannot support a beat's story at all (empty
    // normalized city list, or derivations suppressed by the MIN_TOTAL /
    // qualifying-category guards). By this point even the demo fallback has
    // produced nothing, so the copy must not promise a demo view — demo mode
    // is signalled separately via the isDemo flag on the resolved chapter.
    const FALLBACK_COPY =
        'No data available right now. Scroll on to explore the globe.';

    // Default whole-globe view for beats with camera:null and no highlight
    // (overview / messengers / explore) — Europe/Africa axis, matching the
    // previous story's global framing. Altitude comes from the beat.
    const GLOBAL_VIEW = { lat: 20, lng: 10 };

    // ── Deterministic city rankings ─────────────────────────────────────────────

    function cmpName(a, b) {
        const an = String(a.city);
        const bn = String(b.city);
        return an < bn ? -1 : an > bn ? 1 : 0;
    }

    // All cities by raw volume, highest first. No MIN_TOTAL guard — small
    // totals are the honest answer for a volume ranking. Ties break by name.
    function rankByVolume(cities) {
        return (Array.isArray(cities) ? cities : [])
            .filter(c => c && typeof c === 'object')
            .slice()
            .sort((a, b) => (b.total - a.total) || cmpName(a, b));
    }

    // Eligible cities (MIN_TOTAL guard — a 4-post city being "warmest" is
    // noise) by net sentiment. dir +1 → warmest first, dir −1 → coolest
    // first. Ties break by higher total, then name.
    function rankByNet(cities, dir) {
        return (Array.isArray(cities) ? cities : [])
            .filter(c => c && c.total >= MIN_TOTAL)
            .sort((a, b) => dir * (netSentiment(b) - netSentiment(a))
                || (b.total - a.total)
                || cmpName(a, b));
    }

    // ── Highlight rules ─────────────────────────────────────────────────────────
    // One resolver per story.config highlightRule key. Each returns city
    // OBJECTS from the normalized list (never names — same-name cities
    // exist). Rules surface whatever the data supports; the token builders
    // separately decide whether the card SENTENCE can be told.
    const HIGHLIGHT_RULES = {
        volumeTop3(ins, cities) {
            return rankByVolume(cities).slice(0, 3);
        },
        widestDivide(ins, cities) {
            const d = widestCategoryDivide(cities);
            return d ? [d.city] : [];
        },
        negativeTop3(ins, cities) {
            return rankByNet(cities, -1).slice(0, 3);
        },
        positiveTop3(ins, cities) {
            return rankByNet(cities, +1).slice(0, 3);
        },
        summaryTrio(ins, cities) {
            const warmest = rankByNet(cities, +1)[0];
            const coolest = rankByNet(cities, -1)[0];
            const loudest = rankByVolume(cities)[0];
            const out = [];
            for (const c of [warmest, coolest, loudest]) {
                if (c && !out.includes(c)) out.push(c); // dedupe by reference
            }
            return out;
        },
    };

    // ── Template token builders ─────────────────────────────────────────────────
    // One builder per templateId. Each returns the {token: value} map for
    // renderTemplate (body AND statsSpec share it), or null when the data
    // cannot support the story (→ resolveChapter substitutes FALLBACK_COPY
    // and empty stats). Values are preformatted strings so templates stay
    // presentation-only.
    //
    // XSS boundary: every attacker-influenceable string (city / source /
    // category names originating from API data) passes through esc() HERE,
    // where it enters a card value. Numeric values are formatter output and
    // need no escaping. Consumers still must render via textContent — esc()
    // is defense in depth, not permission to use innerHTML.
    const TOKEN_BUILDERS = {
        overview(ins, cities) {
            if (ins.cityCount === 0) return null;
            return {
                cityCount: fmtCount(ins.cityCount),
                totalPosts: fmtCount(ins.globalTotals.total),
                globalNet: fmtNet(netSentiment(ins.globalTotals)),
                // Derived category count — replaces the prototype's
                // hardcoded "50 sources. 7 categories." editorial claim.
                categoryCount: fmtCount(ribbonRows(cities).length),
            };
        },
        volume(ins, cities) {
            const top = rankByVolume(cities).slice(0, 3);
            if (top.length < 3 || ins.globalTotals.total === 0) return null;
            const topSum = top[0].total + top[1].total + top[2].total;
            return {
                volumeCity1: esc(top[0].city),
                volumeCount1: fmtCount(top[0].total),
                volumeCity2: esc(top[1].city),
                volumeCount2: fmtCount(top[1].total),
                volumeCity3: esc(top[2].city),
                volumeCount3: fmtCount(top[2].total),
                topThreeSharePct: fmtPct(topSum / ins.globalTotals.total),
            };
        },
        divide(ins, cities) {
            const d = widestCategoryDivide(cities);
            if (!d) return null;
            return {
                divideCity: esc(d.city.city),
                divideHiCategory: esc(d.hi.category),
                divideHiNet: fmtNet(d.hi.net),
                divideLoCategory: esc(d.lo.category),
                divideLoNet: fmtNet(d.lo.net),
                divideSpan: d.span.toFixed(2),
            };
        },
        negativity(ins, cities) {
            const coolest = rankByNet(cities, -1).slice(0, 3);
            if (coolest.length < 3) return null;
            const topCat = catBreakdown(coolest[0])[0]; // dominant category
            if (!topCat) return null;
            return {
                negCity1: esc(coolest[0].city),
                negNet1: fmtNet(netSentiment(coolest[0])),
                negCategory1: esc(topCat.category),
                negCity2: esc(coolest[1].city),
                negNet2: fmtNet(netSentiment(coolest[1])),
                negCity3: esc(coolest[2].city),
                negNet3: fmtNet(netSentiment(coolest[2])),
            };
        },
        positivity(ins, cities) {
            const warmest = rankByNet(cities, +1).slice(0, 3);
            if (warmest.length < 3) return null;
            // Dominant category of the warmest city (mirrors negativity) —
            // replaces the prototype's unverifiable "builder communities"
            // editorial claim with a data-derived voice.
            const topCat = catBreakdown(warmest[0])[0];
            if (!topCat) return null;
            return {
                posCity1: esc(warmest[0].city),
                posNet1: fmtNet(netSentiment(warmest[0])),
                posCategory1: esc(topCat.category),
                posCity2: esc(warmest[1].city),
                posNet2: fmtNet(netSentiment(warmest[1])),
                posCity3: esc(warmest[2].city),
                posNet3: fmtNet(netSentiment(warmest[2])),
            };
        },
        drivers(ins, cities) {
            // Global leader from the insights aggregation; runner-up and
            // category count from the ribbon model (same source totals).
            const dom = ins.dominantSourceCategoryGlobal;
            const rows = ribbonRows(cities);
            if (!dom || rows.length < 2) return null;
            const second = rows.find(r => r.category !== dom.category);
            if (!second) return null;
            return {
                catShare1Category: esc(dom.category),
                catShare1Pct: fmtPct(dom.share),
                catShare2Category: esc(second.category),
                catShare2Pct: fmtPct(second.share),
                categoryCount: fmtCount(rows.length),
            };
        },
        'themes-warm'(ins) {
            // Static copy — themes render from live /api/themes data at
            // runtime (see PulseInsights.partitionThemes). No data → fallback.
            return ins.cityCount === 0 ? null : {};
        },
        'themes-cold'(ins) {
            return ins.cityCount === 0 ? null : {};
        },
        messengers(ins, cities) {
            const rows = ribbonRows(cities);
            if (rows.length < 2) return null;
            const bySent = rows.slice().sort((a, b) => (b.net - a.net)
                || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
            const hi = bySent[0];
            const lo = bySent[bySent.length - 1];
            return {
                msgHiCategory: esc(hi.category),
                msgHiNet: fmtNet(hi.net),
                msgHiSource: esc(hi.topSource),
                msgLoCategory: esc(lo.category),
                msgLoNet: fmtNet(lo.net),
                msgLoSource: esc(lo.topSource),
                msgGap: (hi.net - lo.net).toFixed(2),
            };
        },
        summary(ins, cities) {
            const ranked = rankByNet(cities, +1);
            // One eligible city would make warmest === coolest — a tautology,
            // not an hour-in-review. Fall back instead.
            if (ranked.length < 2 || ins.globalTotals.total === 0) return null;
            const warmest = ranked[0];
            const coolest = ranked[ranked.length - 1];
            return {
                totalPosts: fmtCount(ins.globalTotals.total),
                globalNet: fmtNet(netSentiment(ins.globalTotals)),
                // Derived category count — replaces the prototype's
                // hardcoded "7 source categories".
                categoryCount: fmtCount(ribbonRows(cities).length),
                warmestCity: esc(warmest.city),
                warmestNet: fmtNet(netSentiment(warmest)),
                coolestCity: esc(coolest.city),
                coolestNet: fmtNet(netSentiment(coolest)),
            };
        },
        explore(ins) {
            return ins.cityCount === 0 ? null : {};
        },
    };

    // ── Resolver ────────────────────────────────────────────────────────────────
    // Pure: (story beat, computeInsights output, normalized cities, options)
    // → concrete render state for globe.js/story.js. Never throws on sparse
    // insights — it degrades to FALLBACK_COPY + empty stats + the beat's
    // static (or global default) camera.
    //
    // opts.isDemo (default false): set by the loader when the cities came
    // from the bundled demo fallback rather than the API. The resolved
    // chapter then carries isDemo:true and a visible "Demo data" marker on
    // the card title so viewers are never shown demo numbers as live ones.
    function resolveChapter(beat, ins, cities, opts) {
        const isDemo = Boolean(opts && opts.isDemo);

        const rule = beat.highlightRule === null
            ? null
            : HIGHLIGHT_RULES[beat.highlightRule];
        const highlightCities = rule ? rule(ins, cities) : [];

        // Camera precedence: follow the story's subject when there is one;
        // else the beat's static camera; else the global default view. The
        // beat's altitude (zoom intent) applies in every case.
        let camera;
        if (highlightCities.length > 0) {
            camera = {
                lat: highlightCities[0].lat,
                lng: highlightCities[0].lng,
                altitude: beat.altitude,
            };
        } else if (beat.camera !== null) {
            camera = {
                lat: beat.camera.lat,
                lng: beat.camera.lng,
                altitude: beat.camera.altitude,
            };
        } else {
            camera = {
                lat: GLOBAL_VIEW.lat,
                lng: GLOBAL_VIEW.lng,
                altitude: beat.altitude,
            };
        }

        // Card body + stats: interpolate from ONE shared token map, or fall
        // back together when the data can't tell this beat's story.
        const values = TOKEN_BUILDERS[beat.templateId](ins, cities);
        const cardBody = values === null
            ? FALLBACK_COPY
            : renderTemplate(TEMPLATES[beat.templateId], values);
        const stats = values === null
            ? []
            : beat.statsSpec.map(([labelTpl, valueTpl]) => [
                renderTemplate(labelTpl, values),
                renderTemplate(valueTpl, values),
            ]);

        return {
            id: beat.id,
            kicker: beat.kicker,
            // Visible demo marker: renderers show the suffixed title as-is,
            // and can additionally badge on the isDemo flag below.
            cardTitle: isDemo ? beat.title + ' — Demo data' : beat.title,
            cardBody,
            camera,
            cameraMs: beat.cameraMs,
            colorMode: beat.colorMode,
            barMetric: beat.barMetric,
            auditPick: beat.auditPick,
            themePartition: beat.themePartition,
            explore: beat.explore,
            // Mutation-safe copy — resolved chapters must not be able to
            // corrupt the shared story config.
            nextSteps: beat.explore ? beat.nextSteps.slice() : null,
            stats,
            highlightCities,
            isDemo,
        };
    }

    return { STORY, FALLBACK_COPY, resolveChapter };
}));
