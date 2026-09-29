// PulseData — city sentiment data for the Pulse of AI frontend.
//
// Exports:
//   - DEMO_DATA:            demo fallback set for the 30 launch cities, built
//                           deterministically from the canonical city registry
//                           (cities.config.js) by buildDemoData — demo and
//                           live render the SAME 30 cities by construction.
//   - buildDemoData(cities): deterministic generator (seeded pseudo-random,
//                           region-keyed source templates) — a registry edit
//                           changes the demo set, never a code edit.
//   - normalizeCities(raw): pure adapter — validates lat/lng, coerces counts,
//                           recomputes total/dominant, computes sentiment
//                           shares, drops rows with unusable coordinates.
//   - mergeWithBaseline(rows): overlays live rows onto the zero-count launch-
//                           city baseline so every registry launch city
//                           renders (zeros are honest, not hidden).
//   - loadCityData():       fetch the aggregation WINDOWED to the trailing
//                           hour (so "posts/hr" labels are truthful — G16),
//                           returns { cities, isDemo, dataMode }. Demo fallback only
//                           when the UNWINDOWED probe is also empty: an empty
//                           hour over a non-empty DB renders honest zeros
//                           instead of flipping to fictional demo numbers.
//   - dataModeOf(rows):     'demo' | 'live' | 'mixed' | 'none' from the
//                           served rows' demo_posts counts (posts from the
//                           backend's demo feed — src/config/data-mode.js
//                           classifies the same way).
//   - labelsAsDemo(mode):   true for 'demo', 'mixed' and 'fallback' — every
//                           mode whose numbers include demo posts, so the
//                           existing "Demo data" markers are shown.
//
// Dual export guard: CommonJS (module.exports) for jest, window.PulseData
// for browser script tags. The registry dependency is injected the same way
// (require in Node, window.PulseCityRegistry in the browser — index.html
// loads cities.config.js before this file).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(require('./config/cities.config.js')); // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseData = factory(root.PulseCityRegistry);                // browser global
    }
}(typeof self !== 'undefined' ? self : this, function (cityRegistry) {
    'use strict';

    // Trailing aggregation window (G16): the story's volume labels say
    // "posts/hr", so the snapshot request asks for exactly the last hour.
    const TRAILING_WINDOW_MS = 3600000;

    const AGGREGATED_ENDPOINT = '/api/posts/aggregated-by-location';

    // Launch cities from the canonical registry (tier 1 — the prototype's
    // 30). Tolerate a missing registry (broken script order) as [] so the
    // module never throws at load time; the demo set is then empty and the
    // live path renders served rows only.
    const LAUNCH_CITIES = (cityRegistry
        && typeof cityRegistry.launchCities === 'function')
        ? cityRegistry.launchCities() : [];
    const findCity = (cityRegistry && typeof cityRegistry.findCity === 'function')
        ? cityRegistry.findCity : function () { return null; };

    // ── Deterministic demo generator ────────────────────────────────────────

    // Seeded pseudo-random from string (FNV-1a walk — same algorithm the C4
    // ui.js demo synthesis uses, so all demo surfaces are reproducible).
    function seededRandom(str) {
        let h = 2166136261;
        for (let i = 0; i < str.length; i++) {
            h ^= str.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return () => {
            h = Math.imul(h ^ (h >>> 15), 2246822507);
            h = Math.imul(h ^ (h >>> 13), 3266489909);
            return ((h ^= h >>> 16) >>> 0) / 4294967296;
        };
    }

    // Region-keyed source templates: which sources plausibly appear per
    // region (names match the seeded data_sources registry where one
    // exists; forums has NO seeded source, so its demo source keeps the
    // prototype's boards.example hostname). The union of source_category
    // values across regions covers the FULL canonical 8-category taxonomy
    // (design.config CATEGORIES — prototype master contract ∪ BRD §17) so
    // demo mode puts volume behind every category the chips / legend /
    // ribbon enumerate — no zero segments in demo. Forums appears in the
    // regions whose prototype launch cities were Forums-topped (Buenos
    // Aires, Warsaw, Melbourne — south_america / europe / oceania). Template LENGTHS are
    // load-bearing: the seeded random walk in buildDemoData draws offsets
    // from templates.length, so changing a region's length reshuffles that
    // region's deterministic demo numbers (tests pin them).
    const REGION_SOURCES = {
        north_america: [
            { source_name: 'reddit',          source_category: 'social' },
            { source_name: 'lesswrong',       source_category: 'blog' },
            { source_name: 'nytimes_tech',    source_category: 'news' },
            { source_name: 'arxiv',           source_category: 'academic' },
            { source_name: 'github_blog',     source_category: 'developer' },
        ],
        south_america: [
            { source_name: 'reddit',          source_category: 'social' },
            { source_name: 'folha_tech',      source_category: 'news' },
            { source_name: 'arxiv',           source_category: 'academic' },
            { source_name: 'boards.example',  source_category: 'forums' },
            { source_name: 'access_now',      source_category: 'nonprofit' },
        ],
        europe: [
            { source_name: 'guardian_tech',   source_category: 'news' },
            { source_name: 'eu_commission',   source_category: 'policy' },
            { source_name: 'reddit',          source_category: 'social' },
            { source_name: 'arxiv',           source_category: 'academic' },
            { source_name: 'boards.example',  source_category: 'forums' },
            { source_name: 'algorithm_watch', source_category: 'nonprofit' },
        ],
        africa: [
            { source_name: 'reddit',          source_category: 'social' },
            { source_name: 'techcabal',       source_category: 'news' },
            { source_name: 'arxiv',           source_category: 'academic' },
            { source_name: 'github_blog',     source_category: 'developer' },
        ],
        middle_east: [
            { source_name: 'reddit',          source_category: 'social' },
            { source_name: 'haaretz_tech',    source_category: 'news' },
            { source_name: 'substack_ai',     source_category: 'blog' },
            { source_name: 'arxiv',           source_category: 'academic' },
        ],
        asia: [
            { source_name: 'weibo',           source_category: 'social' },
            { source_name: 'nikkei_tech',     source_category: 'news' },
            { source_name: 'arxiv',           source_category: 'academic' },
            { source_name: 'mozilla_ai',      source_category: 'nonprofit' },
            { source_name: 'gov_policy',      source_category: 'policy' },
        ],
        oceania: [
            { source_name: 'reddit',          source_category: 'social' },
            { source_name: 'abc_tech',        source_category: 'news' },
            { source_name: 'boards.example',  source_category: 'forums' },
            { source_name: 'arxiv',           source_category: 'academic' },
            { source_name: 'github_blog',     source_category: 'developer' },
        ],
    };

    // buildDemoData: registry entries → demo rows in the exact shape the
    // aggregation endpoint serves. Deterministic (seeded by city id): the
    // same registry always yields the same demo globe, so tests can assert
    // exact values and reloads don't reshuffle the story.
    function buildDemoData(cities) {
        const list = Array.isArray(cities) ? cities : [];
        const now = new Date().toISOString();
        return list.map((entry) => {
            const r = seededRandom('pulse-demo-' + entry.id);
            const templates = REGION_SOURCES[entry.region]
                || REGION_SOURCES.north_america;

            // City personality: net sentiment in [-0.35, +0.50] and a
            // 3–4-source mix — enough spread for positive/neutral/negative
            // dominants and every chapter's leaders/hotspots to exist.
            const net = -0.35 + r() * 0.85;
            const sourceCount = 3 + (r() < 0.5 ? 1 : 0);
            const offset = Math.floor(r() * templates.length);

            let positive = 0, neutral = 0, negative = 0;
            const sources = [];
            for (let i = 0; i < sourceCount; i++) {
                const tpl = templates[(offset + i) % templates.length];
                const srcTotal = 15 + Math.floor(r() * 110);
                // Per-source sentiment split around the city net, jittered.
                const srcNet = Math.max(-0.9, Math.min(0.9, net + (r() - 0.5) * 0.3));
                const neuShare = 0.25 + r() * 0.2;
                let srcPos = Math.round(srcTotal * ((1 - neuShare) + srcNet) / 2);
                srcPos = Math.max(0, Math.min(srcTotal, srcPos));
                let srcNeu = Math.round(srcTotal * neuShare);
                srcNeu = Math.min(srcNeu, srcTotal - srcPos);
                const srcNeg = srcTotal - srcPos - srcNeu;
                sources.push({
                    source_name:     tpl.source_name,
                    source_category: tpl.source_category,
                    positive:        srcPos,
                    neutral:         srcNeu,
                    negative:        srcNeg,
                    total:           srcTotal,
                });
                positive += srcPos;
                neutral  += srcNeu;
                negative += srcNeg;
            }

            const total = positive + neutral + negative;
            const dominant = (positive >= neutral && positive >= negative)
                ? 'positive' : (neutral >= negative ? 'neutral' : 'negative');
            return {
                city:         entry.name,
                lat:          entry.lat,
                lng:          entry.lng,
                country:      entry.country,
                positive:     positive,
                neutral:      neutral,
                negative:     negative,
                total:        total,
                dominant:     dominant,
                last_updated: now,
                sources:      sources,
            };
        });
    }

    // The demo fallback set: the registry's 30 launch cities, generated once
    // at module load (DB not yet seeded / backend unreachable — FR-22).
    const DEMO_DATA = buildDemoData(LAUNCH_CITIES);

    // ── Internal coercion helpers ───────────────────────────────────────────────

    // Coerce a coordinate: accept numbers or numeric strings (pg NUMERIC columns
    // serialize as strings over JSON); reject null/undefined, NaN, and values
    // outside ±limit. Returns a finite number or null (null → row is dropped).
    // Note: Number(null) === 0, so the explicit null check must come first.
    function toCoord(value, limit) {
        if (value === null || value === undefined) return null;
        const n = Number(value);
        if (!Number.isFinite(n)) return null;
        if (n < -limit || n > limit) return null;
        return n;
    }

    // Coerce a sentiment count: numbers or numeric strings pass through;
    // anything non-finite becomes 0; negative counts are clamped to 0
    // (counts of things cannot be negative — treat as bad upstream data).
    function toCount(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) return 0;
        return n < 0 ? 0 : n;
    }

    // Dominant sentiment from coerced counts. Preference order on ties:
    // positive → neutral → negative (matches the optimistic demo authoring).
    function dominantOf(positive, neutral, negative) {
        if (positive >= neutral && positive >= negative) return 'positive';
        if (neutral >= negative) return 'neutral';
        return 'negative';
    }

    // Normalize one raw sources array: coerce/clamp per-source counts and
    // recompute each source total from them. Non-array input tolerated as [].
    function normalizeSources(rawSources) {
        if (!Array.isArray(rawSources)) return [];
        const out = [];
        for (const s of rawSources) {
            if (!s || typeof s !== 'object') continue;
            const positive = toCount(s.positive);
            const neutral  = toCount(s.neutral);
            const negative = toCount(s.negative);
            out.push({
                source_name:     s.source_name,
                source_category: s.source_category,
                positive,
                neutral,
                negative,
                total: positive + neutral + negative,
            });
        }
        return out;
    }

    // ── Public API ──────────────────────────────────────────────────────────────

    // Pure adapter from raw API/demo rows to the shape the globe modules consume.
    //   - drops rows whose lat/lng are missing, non-numeric, or out of range
    //     (lat ±90, lng ±180 — boundary values are kept)
    //   - coerces string counts, clamps negatives to 0
    //   - ALWAYS recomputes total from the coerced counts (the served total is
    //     advisory; disagreement means bad upstream aggregation)
    //   - recomputes dominant sentiment
    //   - adds shares {positive, neutral, negative} summing to 1 (all-zero when
    //     total is 0, so no NaN from 0/0)
    //   - normalizes sources (missing/non-array tolerated as [])
    function normalizeCities(raw) {
        if (!Array.isArray(raw)) return [];
        const out = [];
        // Loud-drop accounting (backend-flagged): rows with unusable
        // coordinates are still dropped (they cannot be plotted), but the
        // drop is no longer SILENT — cities missing from the registry
        // (audit G26) used to just vanish from the globe with no trace.
        // The console.warn below names every dropped city so the registry
        // hole is visible in the devtools the moment it happens.
        const dropped = [];
        for (const row of raw) {
            if (!row || typeof row !== 'object') continue;
            const lat = toCoord(row.lat, 90);
            const lng = toCoord(row.lng, 180);
            if (lat === null || lng === null) {
                dropped.push(typeof row.city === 'string' && row.city !== ''
                    ? row.city : '<unnamed row>');
                continue;
            }

            const positive = toCount(row.positive);
            const neutral  = toCount(row.neutral);
            const negative = toCount(row.negative);
            const total    = positive + neutral + negative;

            out.push({
                city: row.city,
                lat,
                lng,
                // ISO country code from the city registry (C4: the explore
                // city-detail header shows it). Optional — absent or
                // non-string values become null, never rendered.
                country: typeof row.country === 'string' && row.country !== ''
                    ? row.country : null,
                positive,
                neutral,
                negative,
                total,
                // A zero-count city has no dominant sentiment — 'neutral' is
                // the honest label (the positive-preferring tie-break is for
                // real ties, not for "no data this hour").
                dominant: total > 0
                    ? dominantOf(positive, neutral, negative) : 'neutral',
                shares: total > 0
                    ? { positive: positive / total, neutral: neutral / total, negative: negative / total }
                    : { positive: 0, neutral: 0, negative: 0 },
                sources: normalizeSources(row.sources),
                last_updated: row.last_updated,
            });
        }
        if (dropped.length > 0 && typeof console !== 'undefined'
            && typeof console.warn === 'function') {
            console.warn(
                '[pulse] normalizeCities: dropped ' + dropped.length
                + ' row(s) with unusable coordinates (missing from the city'
                + ' registry? — see public/js/config/cities.config.js): '
                + dropped.join(', '));
        }
        return out;
    }

    // mergeWithBaseline: overlay served rows onto a zero-count baseline of
    // every registry launch city, so live mode renders all 30 launch cities
    // — cities with no posts in the window show honest zero/low bars instead
    // of silently disappearing. Served rows for registry cities replace the
    // baseline row (matched via findCity: case-insensitive + aliases);
    // served rows for non-registry locations are appended unchanged.
    //
    // Alias collisions: when a SECOND served row resolves to a registry id
    // another row already claimed (e.g. 'New York' and 'NYC' both served),
    // its counts are SUMMED into the claimed row and the collision is
    // console.warn'd (the loud-drop pattern) — the old behavior appended it
    // as a duplicate marker at the same coordinates.
    function combineAliasRows(prev, row) {
        return Object.assign({}, prev, {
            positive: (Number(prev.positive) || 0) + (Number(row.positive) || 0),
            neutral:  (Number(prev.neutral)  || 0) + (Number(row.neutral)  || 0),
            negative: (Number(prev.negative) || 0) + (Number(row.negative) || 0),
            // total/dominant/shares are recomputed by normalizeCities from
            // the summed counts — the served values are advisory anyway.
            total: (Number(prev.total) || 0) + (Number(row.total) || 0),
            sources: (Array.isArray(prev.sources) ? prev.sources : [])
                .concat(Array.isArray(row.sources) ? row.sources : []),
            last_updated: (Date.parse(row.last_updated) || 0)
                > (Date.parse(prev.last_updated) || 0)
                ? row.last_updated : prev.last_updated,
        });
    }

    function mergeWithBaseline(rows) {
        const list = Array.isArray(rows) ? rows : [];
        const byId = new Map();   // registry id → served row
        const extras = [];
        for (const row of list) {
            const entry = row && typeof row === 'object'
                ? findCity(row.city) : null;
            if (!entry) {
                extras.push(row);
            } else if (!byId.has(entry.id)) {
                byId.set(entry.id, row);
            } else {
                const prev = byId.get(entry.id);
                if (typeof console !== 'undefined'
                    && typeof console.warn === 'function') {
                    console.warn('[pulse] mergeWithBaseline: served rows "'
                        + prev.city + '" and "' + row.city
                        + '" both resolve to registry city "' + entry.name
                        + '" — summing their counts (upstream should '
                        + 'normalize location names before aggregation).');
                }
                byId.set(entry.id, combineAliasRows(prev, row));
            }
        }
        const merged = LAUNCH_CITIES.map((entry) => byId.get(entry.id) || {
            city:         entry.name,
            lat:          entry.lat,
            lng:          entry.lng,
            country:      entry.country,
            positive:     0,
            neutral:      0,
            negative:     0,
            total:        0,
            dominant:     'neutral',
            last_updated: null,
            sources:      [],
        });
        // Served rows for tier-2 / unknown locations still render (or warn
        // loudly in normalizeCities when their coordinates are unusable).
        for (const id of byId.keys()) {
            if (!LAUNCH_CITIES.some((entry) => entry.id === id)) {
                merged.push(byId.get(id));
            }
        }
        return merged.concat(extras);
    }

    // Fetch live city data windowed to the trailing hour (G16 — the UI labels
    // volumes "posts/hr", so the window must actually be an hour), overlay it
    // on the launch-city baseline, and fall back to normalized DEMO_DATA ONLY
    // when the backend genuinely has nothing:
    //   windowed rows present            → live data (merged, isDemo false)
    //   windowed empty, unwindowed rows  → honest zeros (merged, isDemo false)
    //     — a quiet hour over a seeded DB must NOT flip the page to fictional
    //       demo numbers (the demo-flip risk from the C4 review)
    //   both empty / error / non-OK / no fetch → demo (isDemo true)
    //
    // Returns { cities, isDemo }: isDemo is TRUE whenever the demo fallback
    // was used, so consumers (resolveChapter → insight cards) can visibly
    // mark the numbers as demo data instead of passing them off as live.
    // dataModeOf: where the served rows' posts came from. Sums demo_posts
    // (posts from the backend's demo feed) against total across the rows the
    // globe renders — the same table as src/config/data-mode.js
    // deriveDataMode (pinned by tests/unit/pure/dataMode.test.js). A row
    // without demo_posts (an older API) counts as live: absence of a demo
    // signal is never read as demo.
    function dataModeOf(rows) {
        if (!Array.isArray(rows)) return 'none';
        let total = 0;
        let demo = 0;
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const t = toCount(row.total);
            total += t;
            demo += Math.min(toCount(row.demo_posts), t);
        }
        if (total === 0) return 'none';
        if (demo === total) return 'demo';
        if (demo === 0) return 'live';
        return 'mixed';
    }

    // labelsAsDemo: every mode whose numbers include demo posts carries the
    // visible demo markers — the bundled fallback ('fallback') and backend
    // demo-feed data ('demo', 'mixed') are labeled the same way.
    function labelsAsDemo(dataMode) {
        return dataMode === 'demo' || dataMode === 'mixed' || dataMode === 'fallback';
    }

    async function loadCityData() {
        if (typeof fetch !== 'undefined') {
            try {
                const from = new Date(Date.now() - TRAILING_WINDOW_MS).toISOString();
                const res = await fetch(
                    AGGREGATED_ENDPOINT + '?from=' + encodeURIComponent(from));
                if (res && res.ok) {
                    const windowed = await res.json();
                    if (Array.isArray(windowed) && windowed.length > 0) {
                        return {
                            cities: normalizeCities(mergeWithBaseline(windowed)),
                            isDemo: false,
                            dataMode: dataModeOf(windowed),
                        };
                    }
                    // Empty hour — probe UNWINDOWED before concluding the DB
                    // is empty (demo-flip guard).
                    const probe = await fetch(AGGREGATED_ENDPOINT);
                    if (probe && probe.ok) {
                        const total = await probe.json();
                        if (Array.isArray(total) && total.length > 0) {
                            return {
                                cities: normalizeCities(mergeWithBaseline([])),
                                isDemo: false,
                                dataMode: 'none',
                            };
                        }
                    }
                }
            } catch (_) { /* network error — fall through to demo data */ }
        }
        return { cities: normalizeCities(DEMO_DATA), isDemo: true, dataMode: 'fallback' };
    }

    return {
        DEMO_DATA, buildDemoData, normalizeCities, mergeWithBaseline, loadCityData,
        dataModeOf, labelsAsDemo,
    };
}));
