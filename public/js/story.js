// PulseStory — scroll-driven story orchestration for the Pulse of AI page.
// Vanilla-JS port of the design handoff's app.jsx narrative loop (ZIP
// revision): scroll → progress → beat activation on the globe + docked
// chapter cards + progress rail + skip pill + legend + explore handoff.
//
// Division of labor (C3 scope):
//   - PulseChapters.resolveChapter is the CONTENT engine (kickers, titles,
//     card copy, stats, cameras, highlight cities) — nothing is re-derived
//     here.
//   - PulseGlobe renders; this module only drives it through setState().
//   - The explore-mode panels (filters, city detail, tooltip, drawers,
//     source ribbon) are C4 (ui.js). This module flips the globe into
//     interactive mode at the explore threshold and exposes the hooks C4
//     binds to (see "C4 integration surface" below).
//
// C4 integration surface (events fire on document; all optional to bind):
//   - CustomEvent 'pulse:exploring-changed'  detail {exploring: boolean}
//         fired every time the explore threshold flips.
//   - CustomEvent 'pulse:drill'              detail {cityId: string}
//         fired when a story-card drill chip is clicked; the same id is
//         also held until consumePendingCity() is called, so ui.js can pick
//         it up after its own init even if it missed the event.
//   - CustomEvent 'pulse:trace'              detail {post: apiQueryRow}
//         fired by the featured-post "Why does it say that? →" button when
//         window.PulseUI.openAudit is absent; when present it is called
//         directly with the same post row instead.
//   - CustomEvent 'pulse:data'               detail {cities, isDemo}
//         fired after every successful snapshot (re)load, so ui.js can
//         re-render the explore list / detail / ribbon from fresh data.
//   - PulseStory.getCities() → the current normalized city snapshot (copy)
//   - PulseStory.consumePendingCity() → cityId|null (clears it)
//   - PulseStory.setExploreSelection(cityId|null) — ui.js reports its city
//         selection so the next-steps card hides while a city is open
//         (prototype: exploring && !selectedId && !stepsDone).
//   - PulseStory.getState() → {prog, exploring, activeIndex, isDemo}
//
// DOM discipline: createElement/textContent/classList/style ONLY — the repo
// Write hook blocks innerHTML in client JS, and card strings may echo API
// data. Values are rendered RAW via textContent (never pre-escaped anywhere
// — escaping before textContent double-encodes; textContent IS the XSS
// boundary, the one rule stated in the chapters.js header).
//
// Dual export guard with dependency injection (same pattern as chapters.js):
// CommonJS requires the siblings for jest (the pure namespace is what the
// tests exercise); browser script tags read the window globals (load
// config/*.js, utils.js, data.js, insights.js, chapters.js and globe.js
// BEFORE this file — the index.html script order is a contract).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(
            require('./utils'),
            require('./data'),
            require('./insights'),
            require('./chapters'),
            require('./globe'),
            require('./config/design.config'),
            require('./config/api.config'),
            require('./config/story.config'));
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseStory = factory(
            root.PulseUtils, root.PulseData, root.PulseInsights,
            root.PulseChapters, root.PulseGlobe,
            root.PulseDesignConfig, root.PulseApiConfig, root.PulseStoryConfig);
    }
}(typeof self !== 'undefined' ? self : this, function (
    utils, dataMod, insightsMod, chaptersMod, globeMod,
    designConfig, apiConfig, storyConfig) {
    'use strict';

    const { catLabel, fmtNet, netSentiment } = utils;
    const {
        computeInsights, allCategoryRows, partitionThemes, themeNet,
    } = insightsMod;
    const { STORY, resolveChapter } = chaptersMod;
    const gmath = globeMod.math;
    const GLOBE = designConfig.GLOBE;
    const CAT_COLORS = designConfig.CAT_COLORS;
    const SENTIMENT_PALETTE = designConfig.SENTIMENT_PALETTE;
    const ENDPOINTS = apiConfig.ENDPOINTS;

    // Sentiment palette in the prototype's [neg, neu, pos] array form —
    // the shape sentColor() and the globe's palette prop consume.
    const PALETTE = [
        SENTIMENT_PALETTE.negative,
        SENTIMENT_PALETTE.neutral,
        SENTIMENT_PALETTE.positive,
    ];

    // ═══ Pure story math (no DOM — unit-tested in tests/unit/pure) ═════════
    // Every constant is prototype-verbatim (app.jsx / ui.jsx ZIP revision).

    const N = STORY.length;                 // 11 beats
    const EXPLORE_OFFSET = 1.45;            // exploring ⇔ prog > N − 1.45
    const STORY_UI_MIN_PROG = 0.14;         // cards/rail-pill/legend appear past this
    const INTRO_FADE_RATE = 5;              // intro opacity = max(0, 1 − prog×5)
    const CENTER_DRIFT = 0.3;               // centerX = 0.5 + max(0, 0.5−prog)×0.3
    const CARD_FADE_RATE = 2.1;             // vis = max(0, 1 − |offset|×2.1)
    const CARD_TRANSLATE_PX = -46;          // translateY = offset × −46px
    const CARD_HIDE_EPSILON = 0.01;         // vis ≤ 0.01 ⇒ card not rendered
    const POS_BAR_DIVISOR = 0.5;            // positivity bar: max(0,s)/0.5
    const NEG_BAR_DIVISOR = 0.35;           // negativity bar: max(0,−s)/0.35
    const DRILL_CHIP_MAX = 3;               // drill row shows first 3 highlights
    const FEATURED_QUERY_LIMIT = 50;        // posts sampled to find the extreme

    // Prototype zoom ⇄ story.config altitude mapping (story.config header):
    //   altitude = 2.5 − (zoom − 1.0) × (2.5 − 1.4) / (1.7 − 1.0)
    // The canvas globe consumes ZOOM, the resolver serves ALTITUDE — invert:
    const ZOOM_PER_ALTITUDE = (1.7 - 1.0) / (2.5 - 1.4);
    function zoomFromAltitude(altitude) {
        if (!Number.isFinite(altitude)) return 1;
        return 1 + (2.5 - altitude) * ZOOM_PER_ALTITUDE;
    }

    // progressFromScroll: scrollY → prog ∈ [0 .. N−1], with the prototype's
    // NaN guard verbatim (max > 0 ? … : 0 — a zero/negative track must
    // never divide).
    function progressFromScroll(scrollY, viewportHeight, beatCount, pacing) {
        const max = (beatCount - 1) * pacing * viewportHeight;
        return max > 0
            ? Math.max(0, Math.min(beatCount - 1, (scrollY / max) * (beatCount - 1)))
            : 0;
    }

    // activeIndexFor: nearest beat (prototype: Math.round, clamped).
    function activeIndexFor(prog, beatCount) {
        return Math.max(0, Math.min(beatCount - 1, Math.round(prog)));
    }

    // isExploring: the story releases the globe past the final threshold.
    function isExploring(prog, beatCount) {
        return prog > beatCount - EXPLORE_OFFSET;
    }

    // centerXFor: globe slides from right-of-center to center over the
    // first half-beat of scroll.
    function centerXFor(prog) {
        return 0.5 + Math.max(0, 0.5 - prog) * CENTER_DRIFT;
    }

    // introOpacityFor: editorial lede fades out over the first fifth-beat.
    function introOpacityFor(prog) {
        return Math.max(0, 1 - prog * INTRO_FADE_RATE);
    }

    // cardVisibility / cardTranslateY: the docked-card transition math.
    function cardVisibility(offset) {
        return Math.max(0, 1 - Math.abs(offset) * CARD_FADE_RATE);
    }
    function cardTranslateY(offset) {
        return offset * CARD_TRANSLATE_PX;
    }

    // showStoryUi: chapter cards, skip pill and legend share this window.
    function showStoryUi(prog, exploring) {
        return !exploring && prog > STORY_UI_MIN_PROG;
    }

    // jumpTop: scroll offset of beat i (rail dots, drill chips, skip).
    function jumpTop(index, pacing, viewportHeight) {
        return index * pacing * viewportHeight;
    }

    // barMetricFor: per-beat data-bar encoding over the globe's ADAPTED city
    // shape ({sentiment: net −1…1, volume}). Divisors are prototype-verbatim
    // (app.jsx barMetric memo); volume normalizes by the hour's loudest city.
    function barMetricFor(barMetricId, maxVolume) {
        if (barMetricId === 'positiveNet') {
            return (c) => Math.max(0, c.sentiment) / POS_BAR_DIVISOR;
        }
        if (barMetricId === 'negativeNet') {
            return (c) => Math.max(0, -c.sentiment) / NEG_BAR_DIVISOR;
        }
        return (c) => (maxVolume > 0 ? c.volume / maxVolume : 0);
    }

    // maxVolumeOf: loudest normalized city's total (0 for empty lists).
    function maxVolumeOf(cities) {
        let max = 0;
        for (const c of (Array.isArray(cities) ? cities : [])) {
            if (c && Number.isFinite(c.total) && c.total > max) max = c.total;
        }
        return max;
    }

    // storySplitFor: the divide beat renders its subject city as three
    // sentiment pillars (prototype splitFor: ch.id === 'divide' &&
    // highlight[0] === id). Explore-mode selection splitting is C4's wiring.
    // Returns a splitFor(id) function, or null for every other beat.
    function storySplitFor(resolved) {
        if (!resolved || resolved.id !== 'divide'
            || !Array.isArray(resolved.highlightCities)
            || resolved.highlightCities.length === 0) {
            return null;
        }
        const target = resolved.highlightCities[0];
        const shares = target.shares || { positive: 0, neutral: 0, negative: 0 };
        const split = {
            pos: shares.positive,
            neu: shares.neutral,
            neg: shares.negative,
        };
        return (id) => (id === target.city ? split : null);
    }

    // focusForBeat: the globe's focus prop for a story beat. Prototype
    // semantics: a beat with a subject (highlight) or a static camera pins
    // the view there; a beat whose prototype focus was null (camera: null
    // AND nothing highlighted) leaves focus null so the globe auto-spins.
    function focusForBeat(beat, resolved) {
        if (resolved && Array.isArray(resolved.highlightCities)
            && resolved.highlightCities.length > 0) {
            return { lat: resolved.camera.lat, lon: resolved.camera.lng };
        }
        if (beat && beat.camera !== null && beat.camera !== undefined) {
            return { lat: beat.camera.lat, lon: beat.camera.lng };
        }
        return null;
    }

    // highlightIdsFor: the globe's highlight prop (city ids = normalized
    // city names, matching adaptCities' id fallback). Theme beats spotlight
    // the runtime theme-derived cities; empty lists become null (no dimming)
    // rather than dimming the whole globe.
    function highlightIdsFor(resolved, themeHighlightCities) {
        if (!resolved || resolved.explore) return null;
        const list = resolved.themePartition
            ? themeHighlightCities
            : resolved.highlightCities;
        if (!Array.isArray(list) || list.length === 0) return null;
        return list.map((c) => c.city);
    }

    // nextStepsFor (audit G13 / prototype bug a): the checklist renders ONLY
    // from a non-empty array — resolveChapter returns null on every
    // non-explore beat by design, and a sparse-data fallback could serve an
    // explore beat without steps. Never .map over undefined.
    function nextStepsFor(resolved) {
        return (resolved && Array.isArray(resolved.nextSteps)
            && resolved.nextSteps.length > 0)
            ? resolved.nextSteps.slice()
            : [];
    }

    // featuredCityFor (audit G14 / prototype bug b): the embedded receipt is
    // keyed to the FIRST highlighted city of an auditPick beat. When the
    // highlights are empty (sparse-data fallback) the block is hidden
    // entirely — never default to cities[0] like the prototype did.
    function featuredCityFor(resolved) {
        if (!resolved || !resolved.auditPick
            || !Array.isArray(resolved.highlightCities)
            || resolved.highlightCities.length === 0) {
            return null;
        }
        return resolved.highlightCities[0];
    }

    // pickExtremePost: most positive ('pos') or most negative ('neg') post
    // of an /api/query result set, by the clamped comparative score
    // (prototype auditPostFor reduced over post.sentiment). Rows without a
    // finite comparative are skipped; ties keep the earlier (newer) row.
    function pickExtremePost(results, pick) {
        if (!Array.isArray(results)) return null;
        let best = null;
        for (const row of results) {
            if (!row || !Number.isFinite(Number(row.comparative))) continue;
            if (best === null) { best = row; continue; }
            const a = Number(row.comparative);
            const b = Number(best.comparative);
            if (pick === 'neg' ? a < b : a > b) best = row;
        }
        return best;
    }

    // minutesAgoFrom: whole minutes since an ISO timestamp (floored at 0);
    // null when the timestamp is missing/unparseable.
    function minutesAgoFrom(isoString, nowMs) {
        const t = Date.parse(isoString);
        if (!Number.isFinite(t)) return null;
        return Math.max(0, Math.round((nowMs - t) / 60000));
    }

    // themeHighlightCitiesFor: prototype CH06/CH07 highlight — the cities
    // whose dominant source category matches one of the partition's theme
    // categories (data.js: CITIES.filter(c => warmCats.includes(c.top))).
    // Theme rows come from /api/themes; city tops from their source mix.
    function themeHighlightCitiesFor(cities, partitionedThemes) {
        const cats = new Set();
        for (const t of (Array.isArray(partitionedThemes) ? partitionedThemes : [])) {
            const slug = gmath.normalizeCategorySlug(t && t.top_category);
            if (slug) cats.add(slug);
        }
        if (cats.size === 0) return [];
        const out = [];
        for (const c of (Array.isArray(cities) ? cities : [])) {
            const top = gmath.normalizeCategorySlug(
                gmath.topCategoryFromSources(c && c.sources));
            if (top && cats.has(top)) out.push(c);
        }
        return out;
    }

    // snapshotsEqual: deep equality over two normalized city snapshots
    // (grumpy #9). Snapshots are small (≤ ~50 plain-JSON rows) and compared
    // once per 150s poll, so JSON serialization is the simplest correct
    // check. An unchanged snapshot keeps its array identity, so the globe
    // never re-adapts cities / re-memoizes the land-heat assignment for a
    // poll that changed nothing.
    function snapshotsEqual(a, b) {
        if (a === b) return true;
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }
        return JSON.stringify(a) === JSON.stringify(b);
    }

    // extraSlugs: the NON-canonical category slugs present in a snapshot,
    // deduped, in allCategoryRows order. THE shared helper behind every
    // canon-plus-extras enumeration surface (grumpy #4): the CH05 legend
    // (renderLegend below) and the explore filter chips (ui.js) both build
    // their list as CATEGORY_SLUGS.concat(extraSlugs(cities)) — extras are
    // kept visible, never hidden, and never duplicated.
    function extraSlugs(cities) {
        const canon = designConfig.CATEGORY_SLUGS;
        const out = [];
        for (const row of allCategoryRows(cities)) {
            const s = gmath.normalizeCategorySlug(row.category);
            if (s !== null && canon.indexOf(s) === -1
                && out.indexOf(s) === -1) {
                out.push(s);
            }
        }
        return out;
    }

    // demoFlipWarning: the console.warn text for a load that lands in demo
    // mode after live data had been served (live → demo flip), else null.
    // The page already labels demo numbers visibly; this makes the flip
    // loud for operators too, instead of a silent downgrade to fiction.
    function demoFlipWarning(liveSeen, wasDemo, isDemo) {
        if (!isDemo || wasDemo || !liveSeen) return null;
        return '[pulse] live data unavailable — the story flipped from LIVE to '
            + 'fictional DEMO data (API error, non-OK response, or an empty backend).';
    }

    const pure = {
        N,
        EXPLORE_OFFSET,
        STORY_UI_MIN_PROG,
        CARD_HIDE_EPSILON,
        zoomFromAltitude,
        progressFromScroll,
        activeIndexFor,
        isExploring,
        centerXFor,
        introOpacityFor,
        cardVisibility,
        cardTranslateY,
        showStoryUi,
        jumpTop,
        barMetricFor,
        maxVolumeOf,
        storySplitFor,
        focusForBeat,
        highlightIdsFor,
        nextStepsFor,
        featuredCityFor,
        pickExtremePost,
        minutesAgoFrom,
        themeHighlightCitiesFor,
        // Re-export: the derivation lives in insights.js (single source);
        // kept on the story pure surface for its existing consumers/tests.
        themeNet,
        extraSlugs,
        snapshotsEqual,
        demoFlipWarning,
    };

    // ═══ DOM orchestration (browser only — everything below needs a page) ═══

    const state = {
        initialized: false,
        prog: 0,
        exploring: false,
        activeIndex: -1,     // last beat applied to the globe (−1 = none yet)
        cities: [],
        isDemo: false,
        liveSeen: false,     // a live snapshot has been served at least once
        citiesDirty: false,  // snapshot changed since the globe last got it (#9)
        resolved: [],        // resolveChapter output per beat
        themes: [],          // raw /api/themes rows
        themeHighlights: { 'themes-warm': [], 'themes-cold': [] },
        cards: [],           // [{el, resolved}] in beat order
        legendMode: null,    // last rendered legend flavor
        pendingCityId: null, // drill-chip selection awaiting C4 pickup
        selectedId: null,    // explore selection reported by C4
        stepsDone: false,    // next-steps card dismissed
        refreshTimer: null,
        loading: false,
    };

    let els = null;   // page elements, resolved once in init()
    let globe = null; // shared PulseGlobe instance

    function prefersReducedMotion() {
        return typeof window !== 'undefined' && window.matchMedia
            && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    }

    // jump: smooth-scroll to beat i (rail dots, drill chips); instant under
    // prefers-reduced-motion, matching main.js scrollToExplore.
    function jump(index) {
        window.scrollTo({
            top: jumpTop(index, GLOBE.pacingVhPerChapter, window.innerHeight),
            behavior: prefersReducedMotion() ? 'auto' : 'smooth',
        });
    }

    function dispatch(name, detail) {
        document.dispatchEvent(new CustomEvent(name, { detail }));
    }

    // openTrace: featured-post receipt hand-off — call the C4 hook when it
    // exists, otherwise fire the event so a later-loaded ui.js can replay it.
    function openTrace(post) {
        const ui = window.PulseUI;
        if (ui && typeof ui.openAudit === 'function') {
            ui.openAudit(post);
        } else {
            dispatch('pulse:trace', { post });
        }
    }

    // drill: story-card chip → remember the city for C4, tell everyone, and
    // ride the existing skip path down to the explore beat.
    function drill(cityId) {
        state.pendingCityId = cityId;
        dispatch('pulse:drill', { cityId });
        jump(N - 1);
    }

    // ── Card DOM builders (createElement/textContent only) ──────────────────

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    function buildStatsBlock(stats) {
        const wrap = el('div', 'ch-stats');
        for (const [label, value] of stats) {
            const stat = el('div', 'ch-stat');
            stat.appendChild(el('div', 'ch-stat-v mono', value));
            stat.appendChild(el('div', 'ch-stat-k', label));
            wrap.appendChild(stat);
        }
        return wrap;
    }

    // buildMiniPost: the CH03/CH04 embedded receipt teaser. `post` is a raw
    // /api/query result row (id, content_snippet, source_name, platform,
    // comparative, collected_at, …) — passed through to C4 untouched.
    function buildMiniPost(post) {
        const wrap = el('div', 'mini-post');
        const minutes = minutesAgoFrom(post.collected_at, Date.now());
        const metaParts = [];
        if (post.source_name) metaParts.push(String(post.source_name));
        // Category meta: display label lowercased (prototype mini-post
        // casing — 'blogs', 'non-profit'), never the raw slug.
        if (post.platform) metaParts.push(catLabel(post.platform).toLowerCase());
        if (minutes !== null) metaParts.push(minutes + 'm ago');
        wrap.appendChild(el('div', 'mini-post-meta mono', metaParts.join(' · ')));
        wrap.appendChild(el('div', 'mini-post-text', post.content_snippet || ''));
        const row = el('div', 'mini-post-row');
        const score = Number(post.comparative);
        const pill = el('span', 'score-pill mono', fmtNet(score));
        pill.style.color = gmath.sentColor(score, PALETTE);
        row.appendChild(pill);
        const btn = el('button', 'btn-trace', 'Why does it say that? →');
        btn.type = 'button';
        btn.addEventListener('click', () => openTrace(post));
        row.appendChild(btn);
        wrap.appendChild(row);
        wrap.hidden = false;
        return wrap;
    }

    function buildThemeRow(theme) {
        const row = el('div', 'theme-row');
        const head = el('div', 'theme-head');
        const dot = el('span', 'theme-dot');
        const slug = gmath.normalizeCategorySlug(theme.top_category);
        dot.style.background = (slug && CAT_COLORS[slug])
            || SENTIMENT_PALETTE.neutral;
        head.appendChild(dot);
        head.appendChild(el('span', 'theme-name', theme.keyword || ''));
        // Cue words (backend serves keyword-first words[]): quote the
        // co-matched cues, skipping the keyword itself to avoid echoing the
        // row label.
        const cues = (Array.isArray(theme.words) ? theme.words : [])
            .filter((w) => w && w !== theme.keyword)
            .map((w) => '“' + w + '”')
            .join(' ');
        head.appendChild(el('span', 'theme-words mono', cues));
        const net = themeNet(theme);
        const sent = el('span', 'theme-sent mono', fmtNet(net));
        sent.style.color = gmath.sentColor(net, PALETTE);
        head.appendChild(sent);
        row.appendChild(head);

        const volume = Number(theme.volume) || 0;
        const share = (key) => (volume > 0
            ? Math.max(0, Number(theme[key]) || 0) / volume : 0);
        const mix = el('div', 'mix-bar');
        const segs = [
            [share('positive'), gmath.sentColor(0.6, PALETTE)],
            [share('neutral'), gmath.sentColor(0, PALETTE)],
            [share('negative'), gmath.sentColor(-0.6, PALETTE)],
        ];
        for (const [w, color] of segs) {
            const seg = el('span');
            seg.style.width = (w * 100) + '%';
            seg.style.background = color;
            mix.appendChild(seg);
        }
        row.appendChild(mix);
        return row;
    }

    function buildDrillRow(cities) {
        const row = el('div', 'drill-row');
        row.appendChild(el('span', 'drill-lbl mono', 'DRILL IN'));
        for (const c of cities.slice(0, DRILL_CHIP_MAX)) {
            const chip = el('button', 'drill-chip');
            chip.type = 'button';
            const dot = el('span', 'city-dot');
            dot.style.background = gmath.sentColor(netSentiment(c), PALETTE);
            chip.appendChild(dot);
            chip.appendChild(document.createTextNode(c.city + ' →'));
            chip.addEventListener('click', () => drill(c.city));
            row.appendChild(chip);
        }
        return row;
    }

    function buildNextStepsList(steps) {
        const list = el('ol', 'next-steps');
        for (const step of steps) list.appendChild(el('li', null, step));
        return list;
    }

    // buildCard: one .chapter-card per resolved beat. Async blocks (featured
    // post, theme rows, theme drill chips) render into the returned slots
    // when their fetches settle.
    function buildCard(resolved) {
        const card = el('div', 'chapter-card');
        card.setAttribute('data-screen-label', resolved.kicker);
        card.appendChild(el('div', 'ch-kicker mono', resolved.kicker));
        card.appendChild(el('h2', 'ch-title', resolved.cardTitle));
        card.appendChild(el('p', 'ch-body', resolved.cardBody));
        if (Array.isArray(resolved.stats) && resolved.stats.length > 0) {
            card.appendChild(buildStatsBlock(resolved.stats));
        }

        let miniPostSlot = null;
        if (featuredCityFor(resolved)) {
            miniPostSlot = el('div');
            miniPostSlot.hidden = true;
            card.appendChild(miniPostSlot);
        }

        let themeListSlot = null;
        let themeDrillSlot = null;
        if (resolved.themePartition) {
            themeListSlot = el('div', 'theme-list');
            card.appendChild(themeListSlot);
            themeDrillSlot = el('div');
            card.appendChild(themeDrillSlot);
        }

        if (!resolved.explore && !resolved.themePartition
            && Array.isArray(resolved.highlightCities)
            && resolved.highlightCities.length > 0) {
            card.appendChild(buildDrillRow(resolved.highlightCities));
        }

        if (resolved.explore) {
            const steps = nextStepsFor(resolved);   // guard: bug a / G13
            if (steps.length > 0) card.appendChild(buildNextStepsList(steps));
            card.appendChild(el('div', 'ch-hint mono',
                '↓ keep scrolling to unlock the globe'));
        }

        card.hidden = true;
        return { el: card, resolved, miniPostSlot, themeListSlot, themeDrillSlot };
    }

    function rebuildCards() {
        state.cards = state.resolved.map(buildCard);
        while (els.cardCol.firstChild) {
            els.cardCol.removeChild(els.cardCol.firstChild);
        }
        for (const card of state.cards) els.cardCol.appendChild(card.el);
        renderThemeBlocks();
    }

    // ── Async data blocks ───────────────────────────────────────────────────

    // renderThemeBlocks: fill the warm/cold cards from the fetched themes and
    // recompute the theme-beat city spotlights (prototype CH06/CH07
    // highlight). Called after both the cards and the themes (re)load.
    function renderThemeBlocks() {
        for (const card of state.cards) {
            const partition = card.resolved.themePartition;
            if (!partition || !card.themeListSlot) continue;
            const rows = partitionThemes(state.themes, partition);
            state.themeHighlights[card.resolved.id] =
                themeHighlightCitiesFor(state.cities, rows);
            while (card.themeListSlot.firstChild) {
                card.themeListSlot.removeChild(card.themeListSlot.firstChild);
            }
            for (const theme of rows) {
                card.themeListSlot.appendChild(buildThemeRow(theme));
            }
            while (card.themeDrillSlot.firstChild) {
                card.themeDrillSlot.removeChild(card.themeDrillSlot.firstChild);
            }
            const spotlight = state.themeHighlights[card.resolved.id];
            if (spotlight.length > 0) {
                card.themeDrillSlot.appendChild(buildDrillRow(spotlight));
            }
        }
        // The active beat may be a theme beat whose highlight just changed.
        state.activeIndex = -1;
        apply();
    }

    function loadThemes() {
        if (typeof fetch !== 'function') return Promise.resolve();
        return fetch(ENDPOINTS.themes)
            .then((res) => {
                if (!res || !res.ok) throw new Error('themes ' + (res && res.status));
                return res.json();
            })
            .then((rows) => {
                state.themes = Array.isArray(rows) ? rows : [];
                renderThemeBlocks();
            })
            .catch(() => {
                // Theme rows are additive card content — the beats still read
                // fine from their static copy (insights.partitionThemes on []
                // is empty, never a crash).
                state.themes = [];
                renderThemeBlocks();
            });
    }

    // loadFeaturedPosts: CH03/CH04 embedded receipts — sample the audit
    // city's posts via POST /api/query and feature the extreme one.
    // Demo mode NEVER fetches (audit G16: demo ids are not UUIDs and demo
    // numbers must not be silently backed by live posts) — the teaser block
    // simply stays hidden until ui.js (C4) supplies local demo receipts.
    function loadFeaturedPosts() {
        if (state.isDemo || typeof fetch !== 'function') return Promise.resolve();
        const jobs = [];
        for (const card of state.cards) {
            const city = featuredCityFor(card.resolved);   // guard: bug b / G14
            if (!city || !card.miniPostSlot) continue;
            const pick = card.resolved.auditPick;
            const slot = card.miniPostSlot;
            jobs.push(fetch(ENDPOINTS.query, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    location: city.city,
                    limit: FEATURED_QUERY_LIMIT,
                }),
            })
                .then((res) => {
                    if (!res || !res.ok) throw new Error('query ' + (res && res.status));
                    return res.json();
                })
                .then((payload) => {
                    const post = pickExtremePost(payload && payload.results, pick);
                    if (!post) return;
                    while (slot.firstChild) slot.removeChild(slot.firstChild);
                    slot.appendChild(buildMiniPost(post));
                    slot.hidden = false;
                })
                .catch(() => { /* teaser is optional — card reads fine without it */ }));
        }
        return Promise.all(jobs);
    }

    // ── Legend ──────────────────────────────────────────────────────────────

    function renderLegend(colorMode) {
        const flavor = colorMode === 'category' ? 'category' : 'sentiment';
        if (state.legendMode === flavor && els.legend.childNodes.length > 0) return;
        state.legendMode = flavor;
        while (els.legend.firstChild) els.legend.removeChild(els.legend.firstChild);
        if (flavor === 'category') {
            // One swatch per CANONICAL category, always, in REGISTRY order
            // (prototype contract: PULSE.CATEGORIES.map — fixed order,
            // never the share ranking), so quiet categories never vanish
            // from the legend. Labels are the DISPLAY name lowercased
            // ('Blogs' → 'blogs', 'Non-profit' → 'non-profit'), never the
            // raw slug. Non-canonical categories present in the data are
            // appended after the canon (kept, never hidden).
            const slugs = designConfig.CATEGORY_SLUGS
                .concat(extraSlugs(state.cities));
            for (const slug of slugs) {
                const span = el('span', null, '● ' + catLabel(slug).toLowerCase());
                span.style.color = CAT_COLORS[slug] || SENTIMENT_PALETTE.neutral;
                els.legend.appendChild(span);
            }
        } else {
            const neg = el('span', null, '● neg');
            neg.style.color = PALETTE[0];
            els.legend.appendChild(neg);
            const grad = el('span', 'legend-grad');
            grad.style.background = 'linear-gradient(90deg, ' + PALETTE[0]
                + ', ' + PALETTE[1] + ', ' + PALETTE[2] + ')';
            els.legend.appendChild(grad);
            const pos = el('span', null, 'pos ●');
            pos.style.color = PALETTE[2];
            els.legend.appendChild(pos);
            els.legend.appendChild(el('span', 'legend-sep', 'size = volume/hr'));
        }
    }

    // ── Next-steps card (persists into explore until picked/dismissed) ──────

    function renderNextCard() {
        const slot = els.nextSlot;
        if (!slot) return;
        const show = state.exploring && !state.selectedId && !state.stepsDone;
        slot.hidden = !show;
        if (!show) return;
        if (slot.childNodes.length > 0) return; // already built
        const resolved = state.resolved[N - 1];
        if (!resolved) return;
        const card = el('div', 'chapter-card next-card');
        card.setAttribute('data-screen-label', 'NEXT STEPS');
        const x = el('button', 'det-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', 'Dismiss');
        x.addEventListener('click', () => {
            state.stepsDone = true;
            renderNextCard();
        });
        card.appendChild(x);
        card.appendChild(el('div', 'ch-kicker mono', resolved.kicker));
        const title = el('h2', 'ch-title', resolved.cardTitle);
        title.style.fontSize = '22px';
        card.appendChild(title);
        card.appendChild(el('p', 'ch-body', resolved.cardBody));
        const steps = nextStepsFor(resolved);   // guard: bug a / G13
        if (steps.length > 0) card.appendChild(buildNextStepsList(steps));
        slot.appendChild(card);
    }

    // ── Globe state per beat ────────────────────────────────────────────────

    // citiesPartial: {cities} ONLY when the snapshot changed since the last
    // push (grumpy #9) — every globe.setState({cities}) re-adapts the rows
    // and invalidates the land-heat memo, so an unchanged snapshot must not
    // be re-sent on every beat change.
    function citiesPartial() {
        if (!state.citiesDirty) return {};
        state.citiesDirty = false;
        return { cities: state.cities };
    }

    function applyBeatToGlobe(index) {
        if (!globe) return;
        const resolved = state.resolved[index];
        const beat = STORY[index];
        if (!resolved || !beat) return;
        globe.setState(Object.assign(citiesPartial(), {
            palette: PALETTE,
            colorMode: resolved.colorMode,
            barMetric: barMetricFor(resolved.barMetric, maxVolumeOf(state.cities)),
            splitFor: storySplitFor(resolved),
            focus: focusForBeat(beat, resolved),
            zoom: zoomFromAltitude(resolved.camera.altitude),
            highlight: highlightIdsFor(resolved,
                state.themeHighlights[resolved.id] || []),
            dimTest: null,
            interactive: false,
            labels: false,
        }));
    }

    function enterExplore() {
        if (globe) {
            const exploreBeat = state.resolved[N - 1];
            globe.setState(Object.assign(citiesPartial(), {
                palette: PALETTE,
                colorMode: 'sentiment',
                barMetric: barMetricFor('volume', maxVolumeOf(state.cities)),
                splitFor: null,        // explore selection split is C4's wiring
                focus: null,
                zoom: zoomFromAltitude(exploreBeat
                    ? exploreBeat.camera.altitude
                    : STORY[N - 1].altitude),   // ≈ prototype zoom 1.15
                highlight: null,
                dimTest: null,
                interactive: true,
                labels: true,
            }));
        }
        if (els.explore) els.explore.hidden = false;
        if (els.strip) els.strip.hidden = false;
        renderNextCard();
        dispatch('pulse:exploring-changed', { exploring: true });
    }

    function exitExplore() {
        if (els.explore) els.explore.hidden = true;
        if (els.strip) els.strip.hidden = true;
        if (els.nextSlot) els.nextSlot.hidden = true;
        state.activeIndex = -1;   // force a full beat re-apply below
        dispatch('pulse:exploring-changed', { exploring: false });
    }

    // ── Frame application ───────────────────────────────────────────────────

    function apply() {
        const prog = state.prog;
        const exploring = isExploring(prog, N);
        const active = activeIndexFor(prog, N);

        if (exploring !== state.exploring) {
            state.exploring = exploring;
            if (exploring) enterExplore();
            else exitExplore();
        }

        // Intro lede fade.
        if (els.intro) {
            const opacity = introOpacityFor(prog);
            els.intro.style.opacity = String(opacity);
            els.intro.hidden = opacity <= CARD_HIDE_EPSILON;
        }

        // Story-mode chrome window (cards + skip pill + legend).
        const storyUi = showStoryUi(prog, exploring);
        if (els.cardCol) els.cardCol.hidden = !storyUi;
        if (els.skipBtn) els.skipBtn.hidden = !storyUi;
        if (els.legend) {
            els.legend.hidden = !storyUi;
            if (storyUi) {
                const resolved = state.resolved[active];
                renderLegend(resolved ? resolved.colorMode : 'sentiment');
            }
        }

        // Docked chapter cards.
        if (storyUi) {
            for (let i = 0; i < state.cards.length; i++) {
                const card = state.cards[i].el;
                const offset = prog - i;
                const vis = cardVisibility(offset);
                if (vis <= CARD_HIDE_EPSILON) {
                    card.hidden = true;
                    continue;
                }
                card.hidden = false;
                card.style.opacity = String(vis);
                card.style.transform =
                    'translateY(' + cardTranslateY(offset) + 'px)';
            }
        }

        // Progress rail.
        if (els.railDots) {
            const railActive = exploring ? N - 1 : active;
            for (let i = 0; i < els.railDots.length; i++) {
                els.railDots[i].classList.toggle('on', i === railActive);
            }
        }

        // Globe: full beat state on beat change; centerX rides every frame.
        if (!exploring && active !== state.activeIndex) {
            state.activeIndex = active;
            applyBeatToGlobe(active);
        }
        if (globe) globe.setState({ centerX: centerXFor(prog) });
    }

    function onScroll() {
        state.prog = progressFromScroll(
            window.scrollY, window.innerHeight, N, GLOBE.pacingVhPerChapter);
        apply();
    }

    // ── Data lifecycle ──────────────────────────────────────────────────────

    function loadAndRender() {
        if (state.loading) return Promise.resolve();
        state.loading = true;
        return dataMod.loadCityData()
            .then(({ cities, isDemo }) => {
                // Snapshot-change gate (grumpy #9): an unchanged poll keeps
                // the OLD array identity and never re-sends cities to the
                // globe (citiesDirty stays false), so the land-heat memo and
                // adapted rows survive quiet polls. Cards / cadence-driven
                // consumers still refresh below.
                const changed = state.isDemo !== isDemo
                    || !snapshotsEqual(state.cities, cities);
                if (changed) {
                    state.cities = cities;
                    state.citiesDirty = true;
                }
                // Live → demo flip is never silent (principal #20).
                const flipWarning = demoFlipWarning(state.liveSeen, state.isDemo, isDemo);
                if (flipWarning) console.warn(flipWarning);
                if (!isDemo) state.liveSeen = true;
                state.isDemo = isDemo;
                const insights = computeInsights(state.cities);
                state.resolved = STORY.map(
                    (beat) => resolveChapter(beat, insights, state.cities,
                        { isDemo }));
                rebuildCards();
                state.legendMode = null;   // category list may have changed
                state.activeIndex = -1;    // force globe re-apply on new data
                if (state.exploring && globe && state.citiesDirty) {
                    // Refresh the interactive globe's data without yanking
                    // the camera away from the user.
                    globe.setState(citiesPartial());
                }
                apply();
                // C4 hand-off: ui.js re-renders its explore chrome from the
                // (possibly identical) snapshot on every (re)load — the
                // event also drives its timeseries refresh cadence, so it
                // fires even when nothing changed.
                dispatch('pulse:data', {
                    cities: state.cities,
                    isDemo: state.isDemo,
                });
                return Promise.all([loadThemes(), loadFeaturedPosts()]);
            })
            .catch((err) => {
                console.error('[pulse] story data load failed:', err);
            })
            .then(() => { state.loading = false; });
    }

    // ── Init ────────────────────────────────────────────────────────────────

    function buildRail() {
        els.railDots = [];
        if (!els.rail) return;
        while (els.rail.firstChild) els.rail.removeChild(els.rail.firstChild);
        for (let i = 0; i < N; i++) {
            const dot = el('button', 'rail-dot');
            dot.type = 'button';
            dot.title = STORY[i].kicker;
            dot.setAttribute('aria-label', 'Jump to ' + STORY[i].kicker);
            dot.addEventListener('click', () => jump(i));
            els.rail.appendChild(dot);
            els.railDots.push(dot);
        }
    }

    // init: idempotent — main.js calls this on DOMContentLoaded, after
    // PulseGlobe.init() (module order in its init list). The intro skip link
    // and the skip pill are already wired by main.js (scrollToExplore);
    // this module only toggles the pill's visibility window.
    function init() {
        if (state.initialized) return;
        if (typeof document === 'undefined') return;
        state.initialized = true;

        els = {
            intro: document.getElementById('intro'),
            cardCol: document.getElementById('card-col'),
            rail: document.getElementById('rail'),
            skipBtn: document.getElementById('skip-btn'),
            legend: document.getElementById('legend'),
            nextSlot: document.getElementById('next-card-slot'),
            explore: document.getElementById('explore'),
            strip: document.getElementById('strip'),
            railDots: [],
        };

        globe = globeMod.getInstance && globeMod.getInstance();
        if (!globe && typeof globeMod.init === 'function') {
            globe = globeMod.init();
        }
        if (!globe) {
            console.info('[pulse] PulseStory: globe unavailable — story UI only.');
        }

        buildRail();
        window.addEventListener('scroll', onScroll, { passive: true });
        window.addEventListener('resize', onScroll);

        loadAndRender();
        // Snapshot poll (FR: refresh cycle 2–3 min; api.config REFRESH_MS).
        state.refreshTimer = setInterval(loadAndRender, apiConfig.REFRESH_MS);
        onScroll();
    }

    // ── C4 surface ──────────────────────────────────────────────────────────

    function getState() {
        return {
            prog: state.prog,
            exploring: state.exploring,
            activeIndex: activeIndexFor(state.prog, N),
            isDemo: state.isDemo,
        };
    }

    // getCities: the current normalized city snapshot (copy — callers must
    // not mutate the shared rows). ui.js pulls this at init in case it
    // missed the pulse:data event.
    function getCities() {
        return state.cities.slice();
    }

    // consumePendingCity: the drill-chip selection, delivered exactly once.
    function consumePendingCity() {
        const id = state.pendingCityId;
        state.pendingCityId = null;
        return id;
    }

    // setExploreSelection: ui.js reports its selected city (or null) so the
    // next-steps card hides while a city panel is open.
    function setExploreSelection(cityId) {
        state.selectedId = cityId || null;
        renderNextCard();
    }

    return {
        pure,
        init,
        getState,
        getCities,
        consumePendingCity,
        setExploreSelection,
    };
}));
