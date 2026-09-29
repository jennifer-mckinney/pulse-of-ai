// PulseChapters — pure resolver for the 11-beat scroll story.
// Consumes the data-only beat definitions in PulseStoryConfig.STORY and the
// PulseInsights derivations, producing concrete, render-ready state per beat:
//   {id, kicker, cardTitle, cardBody, camera, cameraMs, colorMode, barMetric,
//    auditPick, themePartition, explore, nextSteps, stats, highlightCities,
//    isDemo}
//
// Pure module: no DOM, no fetch — globe.js/story.js apply the resolved state.
//
// XSS rule (THE one rule, stated once): card strings reach the page ONLY via
// textContent — that DOM sink is the escaping boundary, and the repo Write
// hook blocks innerHTML in client JS to keep it that way. Token values are
// therefore RAW strings; nothing here pre-escapes them, because escaping
// before textContent double-encodes ('&' would render as '&amp;'). Any
// consumer that wants HTML rendering must not get it from this resolver.
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
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseChapters = factory(
            root.PulseUtils, root.PulseInsights, root.PulseStoryConfig);
    }
}(typeof self !== 'undefined' ? self : this, function (utils, insightsMod, storyConfig) {
    'use strict';

    const { catLabel, fmtPct, fmtCount, fmtNet, netSentiment } = utils;
    const {
        TEMPLATES, renderTemplate, MIN_TOTAL,
        catBreakdown, widestCategoryDivide, ribbonRows, allCategoryRows,
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
    // XSS: token values are RAW strings — see the file-header rule.
    // textContent is the boundary; pre-escaping here would double-encode.
    //
    // Category tokens interpolate the canonical DISPLAY label
    // (utils.catLabel — 'blog' → 'Blogs', 'nonprofit' → 'Non-profit'),
    // matching the prototype's display-cased chapter copy, never the raw
    // API slug.
    const TOKEN_BUILDERS = {
        overview(ins, cities) {
            if (ins.cityCount === 0) return null;
            return {
                cityCount: fmtCount(ins.cityCount),
                totalPosts: fmtCount(ins.globalTotals.total),
                globalNet: fmtNet(netSentiment(ins.globalTotals)),
                // Canonical category count (taxonomy padded over the data) —
                // still derived, never the prototype's hardcoded "50
                // sources. 7 categories." editorial claim, but it always
                // matches the full taxonomy the ribbon/chips/legend show,
                // even when some categories have no posts this hour.
                categoryCount: fmtCount(allCategoryRows(cities).length),
            };
        },
        volume(ins, cities) {
            const top = rankByVolume(cities).slice(0, 3);
            if (top.length < 3 || ins.globalTotals.total === 0) return null;
            const topSum = top[0].total + top[1].total + top[2].total;
            return {
                volumeCity1: top[0].city,
                volumeCount1: fmtCount(top[0].total),
                volumeCity2: top[1].city,
                volumeCount2: fmtCount(top[1].total),
                volumeCity3: top[2].city,
                volumeCount3: fmtCount(top[2].total),
                topThreeSharePct: fmtPct(topSum / ins.globalTotals.total),
            };
        },
        divide(ins, cities) {
            const d = widestCategoryDivide(cities);
            if (!d) return null;
            return {
                divideCity: d.city.city,
                divideHiCategory: catLabel(d.hi.category),
                divideHiNet: fmtNet(d.hi.net),
                divideLoCategory: catLabel(d.lo.category),
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
                negCity1: coolest[0].city,
                negNet1: fmtNet(netSentiment(coolest[0])),
                negCategory1: catLabel(topCat.category),
                negCity2: coolest[1].city,
                negNet2: fmtNet(netSentiment(coolest[1])),
                negCity3: coolest[2].city,
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
                posCity1: warmest[0].city,
                posNet1: fmtNet(netSentiment(warmest[0])),
                posCategory1: catLabel(topCat.category),
                posCity2: warmest[1].city,
                posNet2: fmtNet(netSentiment(warmest[1])),
                posCity3: warmest[2].city,
                posNet3: fmtNet(netSentiment(warmest[2])),
            };
        },
        drivers(ins, cities) {
            // Global leader from the insights aggregation; the runner-up
            // from the DATA-derived ribbon rows (a padded zero row must
            // never be named a driver); the tracked count from the
            // canonical taxonomy enumeration.
            const dom = ins.dominantSourceCategoryGlobal;
            const rows = ribbonRows(cities);
            if (!dom || rows.length < 2) return null;
            const second = rows.find(r => r.category !== dom.category);
            if (!second) return null;
            return {
                catShare1Category: catLabel(dom.category),
                catShare1Pct: fmtPct(dom.share),
                catShare2Category: catLabel(second.category),
                catShare2Pct: fmtPct(second.share),
                categoryCount: fmtCount(allCategoryRows(cities).length),
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
                msgHiCategory: catLabel(hi.category),
                msgHiNet: fmtNet(hi.net),
                msgHiSource: hi.topSource,
                msgLoCategory: catLabel(lo.category),
                msgLoNet: fmtNet(lo.net),
                msgLoSource: lo.topSource,
                msgGap: (hi.net - lo.net).toFixed(2),
            };
        },
        summary(ins, cities) {
            const ranked = rankByNet(cities, +1);
            // One eligible city would make warmest === coolest — a tautology,
            // not an hour-in-review. Fall back instead.
            if (ranked.length < 2 || ins.globalTotals.total === 0) return null;
            const warmest = ranked[0];
            // Same coolest definition as the summaryTrio highlight rule —
            // taking the LAST of the warm ranking would flip the tie-break
            // (net ties resolve by higher total in BOTH directions), letting
            // the card name a different city than the globe spotlights.
            const coolest = rankByNet(cities, -1)[0];
            return {
                totalPosts: fmtCount(ins.globalTotals.total),
                globalNet: fmtNet(netSentiment(ins.globalTotals)),
                // Canonical category count — same derivation as the
                // overview card (allCategoryRows), never hardcoded.
                categoryCount: fmtCount(allCategoryRows(cities).length),
                warmestCity: warmest.city,
                warmestNet: fmtNet(netSentiment(warmest)),
                coolestCity: coolest.city,
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
    // opts.demoLabel (default = isDemo): show the SAME "Demo data" marker
    // without the bundled-fallback behaviour — set when the API itself
    // serves demo-feed posts (data mode 'demo' / 'mixed'), so backend demo
    // data is labeled exactly like the bundled set. resolved.isDemo keeps
    // meaning "bundled fallback" (consumers skip fetches on it).
    function resolveChapter(beat, ins, cities, opts) {
        const isDemo = Boolean(opts && opts.isDemo);
        const demoLabel = isDemo || Boolean(opts && opts.demoLabel);

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
            cardTitle: demoLabel ? beat.title + ' — Demo data' : beat.title,
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
            demoLabel,
        };
    }

    // ── Intro (editorial lede) ──────────────────────────────────────────────────
    // FR-19 + the prototype README: the intro's numbers are INTERPOLATED from
    // the same aggregated data the globe renders, never hard-coded (the old
    // static "4,500 posts an hour across 50 sources and 30 cities"). The
    // kicker states where that data came from.
    //
    // dataMode (PulseData.loadCityData): 'live' | 'none' | 'demo' | 'mixed' |
    // 'fallback' (bundled demo set, backend unavailable). Anything else —
    // missing, misspelled, from an older caller — is 'unknown' and gets the
    // neutral text index.html ships with: never LIVE, never DEMO (G9-5).
    const INTRO_KICKERS = {
        live:     'LIVE · UPDATED EVERY 2–3 MINUTES',
        // G9-5: an empty trailing hour is not live — nothing is moving.
        none:     'NO POSTS IN THE LAST HOUR',
        mixed:    'LIVE + DEMO · UPDATED EVERY 2–3 MINUTES',
        demo:     'DEMO · UPDATED EVERY 2–3 MINUTES',
        fallback: 'DEMO · BUNDLED SAMPLE DATA',
        unknown:  'UPDATED EVERY 2–3 MINUTES',
    };
    const INTRO_LEAD = 'Everyone has an opinion about artificial intelligence. ';
    const INTRO_TAIL = ', every score traceable to the model that made it.';
    const INTRO_TEMPLATES = {
        live: INTRO_LEAD + 'Right now you can watch all of them move — '
            + '{postCount} posts an hour across {sourceCount} sources and {cityCount} cities',
        none: INTRO_LEAD + 'No posts have arrived in the last hour, so the globe shows honest '
            + 'zeros across its {cityCount} cities until the next update',
        mixed: INTRO_LEAD + 'Right now you can watch them move — {postCount} posts an hour, '
            + 'some of them fictional demo posts, across {sourceCount} sources and demo feeds '
            + 'and {cityCount} cities',
        demo: INTRO_LEAD + 'This installation is running on demo data — {postCount} fictional '
            + 'posts an hour across {sourceCount} demo feeds and {cityCount} cities',
        fallback: INTRO_LEAD + 'The live backend is unavailable, so this is a bundled demo view — '
            + '{postCount} fictional posts an hour across {sourceCount} sources and {cityCount} cities',
        // Same wording as the static index.html lede (claims neither).
        unknown: INTRO_LEAD + 'Watch them move on the globe',
    };
    const DEMO_LABEL_MODES = ['demo', 'mixed', 'fallback'];

    // introFacts: the three intro numbers from the rendered snapshot.
    //   postCount   — posts in the window (ins.globalTotals.total)
    //   cityCount   — cities REPORTING (ins.cityCount: total > 0)
    //   sourceCount — distinct sources with posts in the window
    function introFacts(ins, cities) {
        const names = new Set();
        for (const c of (Array.isArray(cities) ? cities : [])) {
            if (!c || !Array.isArray(c.sources)) continue;
            for (const src of c.sources) {
                if (src && src.total > 0 && src.source_name) names.add(src.source_name);
            }
        }
        return {
            postCount: ins && ins.globalTotals ? ins.globalTotals.total : 0,
            cityCount: ins ? ins.cityCount || 0 : 0,
            sourceCount: names.size,
        };
    }

    // resolveIntro: pure → { kicker, sub, dataMode, demoLabel, facts }.
    // dataMode comes from PulseData.loadCityData, which only ever produces
    // the known modes; anything else resolves to 'unknown' (G9-5 — never
    // the live copy).
    function resolveIntro(ins, cities, dataMode) {
        const mode = typeof dataMode === 'string' && dataMode !== 'unknown'
            && Object.prototype.hasOwnProperty.call(INTRO_KICKERS, dataMode)
            ? dataMode : 'unknown';
        const facts = introFacts(ins, cities);
        const sub = renderTemplate(INTRO_TEMPLATES[mode], {
            postCount: fmtCount(facts.postCount),
            cityCount: fmtCount(facts.cityCount),
            sourceCount: fmtCount(facts.sourceCount),
        }) + INTRO_TAIL;
        return {
            kicker: INTRO_KICKERS[mode],
            sub,
            dataMode: mode,
            demoLabel: DEMO_LABEL_MODES.indexOf(mode) !== -1,
            facts,
        };
    }

    return { STORY, FALLBACK_COPY, resolveChapter, resolveIntro, introFacts, INTRO_KICKERS };
}));
