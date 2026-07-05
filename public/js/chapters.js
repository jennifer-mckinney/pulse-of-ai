// PulseChapters — scroll-story chapter config + pure resolver.
// Turns the static 7-chapter narrative config into concrete, render-ready
// state ({camera, encoding, cardTitle, cardBody, highlightCities, arcs}) by
// interpolating PulseInsights derivations into the chapter templates.
//
// Pure module: no DOM, no fetch — globe.js/story.js apply the resolved state.
// Card text is rendered by consumers via textContent (never innerHTML), so
// interpolated strings are XSS-safe by construction. Keep it that way.
//
// Dual export guard with dependency injection: CommonJS requires siblings for
// jest; browser script tags read the window globals (load utils.js and
// insights.js BEFORE this file).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./utils'), require('./insights'));
    } else {
        root.PulseChapters = factory(root.PulseUtils, root.PulseInsights);
    }
}(typeof self !== 'undefined' ? self : this, function (utils, insightsMod) {
    'use strict';

    const { fmtPct, fmtCount } = utils;
    const { TEMPLATES, renderTemplate } = insightsMod;

    // Shown when the data cannot support a chapter's story (empty API + demo
    // failure, or superlatives suppressed by the MIN_TOTAL guard).
    const FALLBACK_COPY =
        'Data unavailable — showing demo view. Scroll on to explore the globe.';

    // ── Chapter config ──────────────────────────────────────────────────────────
    // Sequence locked by the design doc: Overview → Volume leaders → Positivity
    // leaders → Negativity hotspots → The divide (arc) → Who's driving the
    // conversation → explore. Cameras are static DEFAULTS — resolveChapter
    // re-centers on the first highlighted city when the data provides one.
    const CHAPTERS = [
        {
            id: 'overview',
            camera: { lat: 20, lng: 10, altitude: 2.5 },   // Europe/Africa axis, whole globe
            cameraMs: 1200,
            encoding: { metric: 'total', colorMode: 'dominant', filter: null },
            highlight: null,
            arcs: false,
            insight: { templateId: 'overview', title: 'The Global Pulse' },
            autoRotate: false,
        },
        {
            id: 'volume',
            camera: { lat: 35, lng: -80, altitude: 1.6 },  // North America default
            cameraMs: 1000,
            encoding: { metric: 'total', colorMode: 'highlight', filter: null },
            highlight: 'highestVolumeCity',
            arcs: false,
            insight: { templateId: 'volume', title: 'Volume Leaders' },
            autoRotate: false,
        },
        {
            id: 'positivity',
            camera: { lat: 30, lng: 120, altitude: 1.6 },  // East Asia default
            cameraMs: 1000,
            encoding: { metric: 'positiveShare', colorMode: 'highlight', filter: null },
            highlight: 'mostPositiveCity',
            arcs: false,
            insight: { templateId: 'positivity', title: 'Positivity Leaders' },
            autoRotate: false,
        },
        {
            id: 'negativity',
            camera: { lat: 48, lng: 12, altitude: 1.6 },   // Europe default
            cameraMs: 1000,
            encoding: { metric: 'negativeShare', colorMode: 'highlight', filter: null },
            highlight: 'mostNegativeCity',
            arcs: false,
            insight: { templateId: 'negativity', title: 'Negativity Hotspots' },
            autoRotate: false,
        },
        {
            id: 'divide',
            camera: { lat: 35, lng: 70, altitude: 2.2 },   // wide view spanning the arc
            cameraMs: 1200,
            encoding: { metric: 'netSentiment', colorMode: 'net', filter: null },
            highlight: 'sentimentRatioExtremes',
            arcs: true,
            insight: { templateId: 'divide', title: 'The Divide' },
            autoRotate: false,
        },
        {
            id: 'sources',
            camera: { lat: 20, lng: 0, altitude: 2.0 },
            cameraMs: 1000,
            encoding: { metric: 'total', colorMode: 'sourceCategory', filter: null },
            highlight: 'largestSourceConcentration',
            arcs: false,
            insight: { templateId: 'sources', title: "Who's Driving the Conversation" },
            autoRotate: false,
        },
        {
            id: 'explore',
            camera: { lat: 20, lng: 10, altitude: 2.5 },
            cameraMs: 800,
            encoding: { metric: 'stacked', colorMode: 'sentiment', filter: null },
            highlight: null,
            arcs: false,
            insight: { templateId: 'explore', title: 'Explore the Pulse' },
            autoRotate: true,
        },
    ];

    // ── Template token builders ─────────────────────────────────────────────────
    // One builder per templateId. Each returns the {token: value} map for
    // renderTemplate, or null when the insights cannot support the story
    // (→ resolveChapter substitutes FALLBACK_COPY). Values are preformatted
    // strings so templates stay presentation-only.
    const TOKEN_BUILDERS = {
        overview(ins) {
            if (ins.cityCount === 0) return null;
            return {
                totalPosts: fmtCount(ins.globalTotals.total),
                cityCount: fmtCount(ins.cityCount),
                positivePct: fmtPct(ins.globalShares.positive),
                negativePct: fmtPct(ins.globalShares.negative),
            };
        },
        volume(ins) {
            const v = ins.highestVolumeCity;
            if (!v || ins.globalTotals.total === 0) return null;
            return {
                volumeCity: v.city,
                volumeTotal: fmtCount(v.total),
                volumeSharePct: fmtPct(v.total / ins.globalTotals.total),
            };
        },
        positivity(ins) {
            const c = ins.mostPositiveCity;
            if (!c || !ins.extremesDelta) return null;
            return {
                positiveCity: c.city,
                positiveSharePct: fmtPct(c.shares.positive),
                positiveDeltaPct: fmtPct(ins.extremesDelta.positivePct),
            };
        },
        negativity(ins) {
            const c = ins.mostNegativeCity;
            if (!c || !ins.extremesDelta) return null;
            return {
                negativeCity: c.city,
                negativeSharePct: fmtPct(c.shares.negative),
                negativeDeltaPct: fmtPct(ins.extremesDelta.negativePct),
            };
        },
        divide(ins) {
            const ext = ins.sentimentRatioExtremes;
            if (!ext) return null;
            return {
                ratioHighCity: ext.highest.city.city,
                ratioHigh: ext.highest.ratio.toFixed(1),
                ratioLowCity: ext.lowest.city.city,
                ratioLow: ext.lowest.ratio.toFixed(1),
            };
        },
        sources(ins) {
            const dom = ins.dominantSourceCategoryGlobal;
            const conc = ins.largestSourceConcentration;
            if (!dom || !conc) return null;
            return {
                dominantCategory: dom.category,
                dominantCategoryPct: fmtPct(dom.share),
                concentrationCity: conc.city,
                concentrationSource: conc.source_name,
                concentrationPct: fmtPct(conc.pct),
            };
        },
        explore(ins) {
            if (ins.cityCount === 0) return null;
            return { cityCount: fmtCount(ins.cityCount) };
        },
    };

    // Resolve a chapter's highlight key into concrete city objects.
    // Superlative keys hold the city object itself; sentimentRatioExtremes
    // holds two nested cities; largestSourceConcentration holds a city NAME
    // that must be looked up in the normalized city list.
    function highlightCitiesFor(chapter, ins, cities) {
        if (chapter.highlight === null) return [];
        const value = ins[chapter.highlight];
        if (!value) return [];
        if (chapter.highlight === 'sentimentRatioExtremes') {
            return [value.highest.city, value.lowest.city];
        }
        if (chapter.highlight === 'largestSourceConcentration') {
            const match = cities.find(c => c.city === value.city);
            return match ? [match] : [];
        }
        return [value]; // city-object superlatives (volume / positivity / negativity)
    }

    // ── Resolver ────────────────────────────────────────────────────────────────
    // Pure: (chapter config, computeInsights output, normalized cities) →
    // concrete render state for globe.js/story.js. Never throws on sparse
    // insights — it degrades to FALLBACK_COPY + the chapter's static camera.
    function resolveChapter(chapter, ins, cities) {
        const cityList = Array.isArray(cities) ? cities : [];
        const highlightCities = highlightCitiesFor(chapter, ins, cityList);

        // Camera: follow the story's subject when there is one, else default.
        const camera = highlightCities.length > 0
            ? { lat: highlightCities[0].lat,
                lng: highlightCities[0].lng,
                altitude: chapter.camera.altitude }
            : { lat: chapter.camera.lat,
                lng: chapter.camera.lng,
                altitude: chapter.camera.altitude };

        // Card body: interpolate, or fall back when the data can't tell the story.
        const values = TOKEN_BUILDERS[chapter.insight.templateId](ins);
        const cardBody = values === null
            ? FALLBACK_COPY
            : renderTemplate(TEMPLATES[chapter.insight.templateId], values);

        // Arcs: only the divide chapter, and only when both extremes exist.
        let arcs = [];
        if (chapter.arcs && ins.sentimentRatioExtremes) {
            const { highest, lowest } = ins.sentimentRatioExtremes;
            arcs = [{
                startLat: highest.city.lat,
                startLng: highest.city.lng,
                endLat: lowest.city.lat,
                endLng: lowest.city.lng,
            }];
        }

        return {
            id: chapter.id,
            camera,
            cameraMs: chapter.cameraMs,
            encoding: chapter.encoding,
            cardTitle: chapter.insight.title,
            cardBody,
            highlightCities,
            arcs,
            autoRotate: chapter.autoRotate,
        };
    }

    return { CHAPTERS, FALLBACK_COPY, resolveChapter };
}));
