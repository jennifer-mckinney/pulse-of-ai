// PulseGlobe — Canvas-2D orthographic dot globe for the Pulse of AI frontend.
// Vanilla-JS port of the design handoff's globe.jsx (ZIP revision, including
// the user-zoom feature). Every rendering formula follows the handoff README
// "Globe rendering spec" section exactly; the pure math lives in the exported
// `math` namespace so it is unit-testable without a canvas
// (tests/unit/pure/globeMath.test.js).
//
// Deliberate changes vs the prototype (audit-mandated, nothing else):
//   - G7:  user zoom constants come from design.config GLOBE (clamp 0.5–3.5,
//          wheel factors, key step) instead of inline literals.
//   - G8:  Pointer Events (pointerdown/move/up/cancel + touch-action:none)
//          replace the prototype's mouse-only listeners, so drag/hover/tap
//          and two-finger pinch-zoom work on touch devices.
//   - G10: prefers-reduced-motion is honored at runtime — no auto-spin, no
//          focus drift, no pulse rings; the render loop still applies state
//          changes (drag, zoom, chapter focus) so nothing freezes.
//   - G11: category colors are looked up by API slug (CAT_COLORS keys), with
//          prototype display names mapped to slugs and a neutral fallback
//          for unknown slugs; city sentiment prefers net-from-counts.
//   - FR-25: land geometry is fetched from the VENDORED GeoJSON under
//          public/vendor/ (already `topojson.feature()`-converted) — no CDN.
//   - Leak fixes: the prototype's anonymous mouseleave listener is named and
//          removed in destroy(); the debug `window.__lam` global and the
//          no-op landListeners push are dropped.
//   - Dimmed (filtered-out) cities are excluded from hit-testing — the
//          prototype let invisible cities be hovered/clicked.
//   - Nearest-city land-heat assignment is re-memoized when the cities array
//          changes (the prototype computed it once, which is wrong once city
//          data loads asynchronously from the API).
//
// Dual export guard with dependency injection (same pattern as utils.js):
// CommonJS requires the design config + utils for jest; browser script tags
// read the window globals (load config/design.config.js and utils.js BEFORE
// this file).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory(
            require('./config/design.config'),
            require('./utils')
        );                                                       // Node / jest
    } else {
        /* istanbul ignore next -- Browser UMD global; unreachable in Node tests */
        root.PulseGlobe = factory(root.PulseDesignConfig, root.PulseUtils);
    }
}(typeof self !== 'undefined' ? self : this, function (designConfig, utils) {
    'use strict';

    const GLOBE = designConfig.GLOBE;
    const CAT_COLORS = designConfig.CAT_COLORS;
    const SENTIMENT_PALETTE = designConfig.SENTIMENT_PALETTE;

    const D2R = Math.PI / 180;
    const TWO_PI = Math.PI * 2;

    // ── Renderer constants ──────────────────────────────────────────────────
    // Geometry/easing values from the handoff README "Globe rendering spec".
    // They are renderer math, not design tokens, so they live here rather
    // than in design.config (which carries only the five+zoom GLOBE tokens).
    const DPR_CAP = 2;                 // devicePixelRatio capped at 2
    const RADIUS_FACTOR = 0.38;        // R = min(W,H) × 0.38 × zoom
    const EASE = 0.055;                // eased pursuit rate (rotation + zoom)
    const REST_LAM_RAD = 20 * D2R;     // initial view longitude
    const REST_PHI_RAD = 16 * D2R;     // initial / resting view latitude
    const FOCUS_DRIFT_DEG = 7;         // focused chapters drift ±7°…
    const FOCUS_DRIFT_MS = 9000;       // …on a sin(now / 9000) cycle
    const DRAG_RAD_PER_PX = 0.005;     // drag-to-rotate rate
    const PHI_CLAMP_RAD = 70 * D2R;    // drag latitude clamp ±70°
    const HIT_TOLERANCE_PX = 18;       // hover/click hit-test tolerance
    const CLICK_SUPPRESS_PX = 5;       // dragDist > 5 suppresses the click
    const LAND_STEP_DEG = 1.2;         // land raster grid step (latitude)
    const LAND_LAT_MIN = -58;          // raster band bottom…
    const LAND_LAT_MAX = 78;           // …and top (matches populated land)
    const LAND_MIN_DOTS = 500;         // fewer rasterized dots ⇒ bad data ⇒ fallback
    const FIB_COUNT = 2600;            // Fibonacci-sphere fallback dot count
    const HEAT_FALLOFF_RAD = 0.38;     // land-heat nearest-city falloff ≈ 22°
    const LAND_NEUTRAL = 'rgba(158,190,235,1)'; // untinted land dot color

    // FR-25: self-hosted land geometry only — the vendored file is the
    // world-atlas 110m land TopoJSON already converted to GeoJSON with
    // topojson-client `feature()` (see public/vendor/README.md), so no
    // topojson dependency is needed at runtime. Never a CDN URL.
    const LAND_URL = 'vendor/world-atlas/land-110m-geo.json';

    // Derived rates — config tokens expressed in the prototype's units:
    //   spin: full revolution per spinPeriodMs at speed 1
    //         (2π / 300 s = 0.0209 rad/s ≡ prototype 0.00035 rad·frame × 60)
    //   ring: pulse cycles per second (1000 / 2200 ≈ prototype's 0.45)
    const SPIN_RAD_PER_SEC = TWO_PI / (GLOBE.spinPeriodMs / 1000);
    const RING_RATE_PER_SEC = 1000 / GLOBE.ringPeriodMs;

    // Any category spelling (prototype display name or API slug, any case)
    // → the canonical API slug (design.config registry keys). Forums is a
    // first-class canonical slug ('forums'); the retired legacy 'tech' slug
    // maps to 'developer' (the same residual mapping the backend data
    // update applies — migration 007), and the display names 'Blogs' /
    // 'Non-profit' fold onto their slugs.
    const CATEGORY_SLUGS = {
        social: 'social',
        news: 'news',
        academic: 'academic',
        policy: 'policy',
        nonprofit: 'nonprofit',
        'non-profit': 'nonprofit',
        developer: 'developer',
        forums: 'forums',
        blogs: 'blog',
        blog: 'blog',
        tech: 'developer',
    };

    // ═══ Pure math (no canvas, no DOM — unit-tested in Node) ═══════════════

    // hexToRgb: '#RRGGBB' → [r, g, b] (prototype-verbatim bit unpacking).
    function hexToRgb(h) {
        const n = parseInt(h.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    // mix: channel-wise lerp between two [r,g,b] triples, rounded.
    function mix(a, b, t) {
        return a.map((v, i) => Math.round(v + (b[i] - v) * t));
    }

    // sentColor: sentiment −1…1 → 'rgb(r,g,b)' lerped across the palette
    // [neg, neu, pos] hex triple (score clamped to the range first).
    function sentColor(s, palette) {
        const neg = hexToRgb(palette[0]);
        const neu = hexToRgb(palette[1]);
        const pos = hexToRgb(palette[2]);
        const t = Math.max(-1, Math.min(1, s));
        const c = t < 0 ? mix(neu, neg, -t) : mix(neu, pos, t);
        return `rgb(${c[0]},${c[1]},${c[2]})`;
    }

    // normalizeCategorySlug: any category spelling (prototype display name
    // or API slug, any case) → the CAT_COLORS slug key; unknown strings pass
    // through lowercased (color lookup then falls back), null/empty → null.
    function normalizeCategorySlug(cat) {
        if (typeof cat !== 'string' || cat === '') return null;
        const key = cat.toLowerCase();
        return CATEGORY_SLUGS[key] || key;
    }

    // cityColor: marker color for one adapted city under a color mode.
    // Category mode tolerates unknown slugs with the neutral sentiment hue
    // (audit G11) instead of the prototype's undefined-color crash path.
    function cityColor(c, colorMode, palette) {
        if (colorMode === 'category') {
            return CAT_COLORS[c.top] || SENTIMENT_PALETTE.neutral;
        }
        if (colorMode === 'warm') return sentColor(0.7, palette);
        if (colorMode === 'cold') return sentColor(-0.7, palette);
        return sentColor(c.sentiment, palette);
    }

    // topCategoryFromSources: highest-volume source_category in a normalized
    // city's sources[] (ties alphabetical, like insights.catBreakdown).
    function topCategoryFromSources(sources) {
        if (!Array.isArray(sources)) return null;
        const totals = {};
        for (const s of sources) {
            if (!s || typeof s !== 'object' || typeof s.source_category !== 'string') continue;
            totals[s.source_category] =
                (totals[s.source_category] || 0) + (Number(s.total) || 0);
        }
        let best = null;
        for (const cat of Object.keys(totals)) {
            if (best === null || totals[cat] > totals[best]
                || (totals[cat] === totals[best] && cat < best)) {
                best = cat;
            }
        }
        return best;
    }

    // adaptCities: accept either shape the frontend produces —
    //   prototype demo shape: {id, name, lat, lon, sentiment, volume, top}
    //   normalized API shape: {city, lat, lng, positive, neutral, negative,
    //                          total, sources[]} (PulseData.normalizeCities)
    // — and emit the renderer's city shape {id, name, lat, lon, sentiment,
    // volume, top}. Sentiment prefers net-from-counts (audit G11); rows with
    // unusable coordinates are dropped (normalizeCities already drops them,
    // this is defense-in-depth for direct callers).
    function adaptCities(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        for (const c of list) {
            if (!c || typeof c !== 'object') continue;
            // Reject null/undefined BEFORE Number() — Number(null) is 0 and
            // would silently plant a missing-coordinate city on the equator.
            const rawLon = c.lon !== undefined ? c.lon : c.lng;
            if (c.lat === null || c.lat === undefined
                || rawLon === null || rawLon === undefined) continue;
            const lat = Number(c.lat);
            const lon = Number(rawLon);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            const hasCounts = c.total !== undefined && c.total !== null;
            out.push({
                id: c.id !== undefined && c.id !== null
                    ? c.id : (c.city !== undefined ? c.city : c.name),
                name: String(c.name !== undefined && c.name !== null
                    ? c.name : (c.city !== undefined && c.city !== null ? c.city : '')),
                lat,
                lon,
                sentiment: hasCounts
                    ? utils.netSentiment(c)
                    : (Number.isFinite(Number(c.sentiment)) ? Number(c.sentiment) : 0),
                volume: Number.isFinite(Number(c.volume))
                    ? Number(c.volume)
                    : (Number.isFinite(Number(c.total)) ? Number(c.total) : 0),
                top: normalizeCategorySlug(
                    c.top !== undefined && c.top !== null
                        ? c.top
                        : (c.topCategory !== undefined && c.topCategory !== null
                            ? c.topCategory
                            : topCategoryFromSources(c.sources))
                ),
            });
        }
        return out;
    }

    // sphereRadius: R = min(W,H) × 0.38 × zoom.
    function sphereRadius(w, h, zoom) {
        return Math.min(w, h) * RADIUS_FACTOR * zoom;
    }

    // project: orthographic projection of (latRad, lonRad) under a view
    // {lam, sinP0, cosP0, R, cx, cy} → [x, y, cosc] or null for the far
    // hemisphere (cosc < 0). cosc doubles as the depth term everywhere.
    function project(phi, lam, view) {
        const dl = lam - view.lam;
        const cosc = view.sinP0 * Math.sin(phi)
            + view.cosP0 * Math.cos(phi) * Math.cos(dl);
        if (cosc < 0) return null;
        const x = Math.cos(phi) * Math.sin(dl);
        const y = view.cosP0 * Math.sin(phi)
            - view.sinP0 * Math.cos(phi) * Math.cos(dl);
        return [view.cx + view.R * x, view.cy - view.R * y, cosc];
    }

    // angleDelta: shortest signed angular distance target − current, wrapped
    // to (−π, π] so pursuit never spins the long way round.
    function angleDelta(target, current) {
        const d = target - current;
        return Math.atan2(Math.sin(d), Math.cos(d));
    }

    // rotationTargets: the frame's target longitude/latitude and the
    // longitude easing rate, from the prototype's branch order:
    //   dragging → hold; focus → chapter target (+ drift); non-interactive
    //   or idle → auto-spin toward rest latitude; else hold under the user.
    // reducedMotion zeroes the decorative motion (drift + spin) only (G10).
    function rotationTargets(s) {
        if (s.dragging) return { tLam: s.lam, tPhi: s.phi, lamEase: 1 };
        if (s.focus) {
            const drift = s.reducedMotion
                ? 0
                : Math.sin(s.now / FOCUS_DRIFT_MS) * FOCUS_DRIFT_DEG * D2R;
            return {
                tLam: s.focus.lon * D2R + drift,
                tPhi: Math.max(-50, Math.min(50, s.focus.lat * 0.75)) * D2R,
                lamEase: EASE,
            };
        }
        if (!s.interactive || s.idle) {
            const spin = s.reducedMotion ? 0 : s.speed * SPIN_RAD_PER_SEC * s.dt;
            return {
                tLam: s.lam - spin,
                tPhi: s.interactive
                    ? s.phi + (REST_PHI_RAD - s.phi) * 0.02
                    : REST_PHI_RAD,
                lamEase: 1,
            };
        }
        return { tLam: s.lam, tPhi: s.phi, lamEase: 1 };
    }

    // clampPhi: drag latitude clamp ±70°.
    function clampPhi(phi) {
        return Math.max(-PHI_CLAMP_RAD, Math.min(PHI_CLAMP_RAD, phi));
    }

    // dragRotate: apply a pointer delta (px) to the view — 0.005 rad/px,
    // latitude clamped.
    function dragRotate(lam, phi, dx, dy) {
        return {
            lam: lam - dx * DRAG_RAD_PER_PX,
            phi: clampPhi(phi + dy * DRAG_RAD_PER_PX),
        };
    }

    // clampUserZoom: user-zoom multiplier clamp (config G7); non-finite → 1.
    function clampUserZoom(z) {
        if (!Number.isFinite(z)) return 1;
        return Math.max(GLOBE.userZoomMin, Math.min(GLOBE.userZoomMax, z));
    }

    // wheelZoomFactor: multiplicative zoom step for a wheel event —
    // exp(−deltaY × factor); ctrl-wheel (and trackpad pinch, which browsers
    // report as ctrl-wheel) uses the stronger factor.
    function wheelZoomFactor(deltaY, ctrlKey) {
        return Math.exp(-deltaY * (ctrlKey
            ? GLOBE.wheelZoomCtrlFactor
            : GLOBE.wheelZoomPlainFactor));
    }

    // keyZoomFactor: '+' / '=' zoom in, '-' / '_' zoom out, others null
    // ('0' is the reset key, handled by the caller).
    function keyZoomFactor(key) {
        if (key === '+' || key === '=') return GLOBE.keyZoomStep;
        if (key === '-' || key === '_') return 1 / GLOBE.keyZoomStep;
        return null;
    }

    // composeZoomStep: one eased frame of zoom pursuit — the applied zoom
    // chases (chapterZoom || 1) × userZoom exactly as the ZIP revision does.
    function composeZoomStep(zoom, propZoom, userZoom) {
        return zoom + ((propZoom || 1) * userZoom - zoom) * EASE;
    }

    // markerRadius: city dot radius — base 2.2 + √volume × 0.28, scaled by
    // zoom and depth.
    function markerRadius(volume, zoom, depth) {
        const base = 2.2 + Math.sqrt(volume) * 0.28;
        return base * (0.6 + zoom * 0.4) * (depth * 0.4 + 0.6);
    }

    // barHeight: per-chapter data bar (FR-17/18) — h = R × (0.015 + m × 0.13)
    // × depth, metric clamped to 0…1.
    function barHeight(R, metric, depth) {
        const m = Math.max(0, Math.min(1, metric));
        return R * (0.015 + m * 0.13) * depth;
    }

    // pillarHeight: three-pillar sentiment split — h = R × (0.04 + share ×
    // 0.18) × depth (the handoff's final post-reduction values).
    function pillarHeight(R, share, depth) {
        return R * (0.04 + share * 0.18) * depth;
    }

    // pulsePhase: 0…1 phase of a city's pulse ring at time t (seconds),
    // phase-staggered by longitude; rate = 1000 / ringPeriodMs per second
    // (≈ the prototype's 0.45).
    function pulsePhase(tSeconds, lon) {
        return ((tSeconds * RING_RATE_PER_SEC + (lon + 180) / 137) % 1);
    }

    // landDotSize: land square edge — R × 0.006 + cosc × R × 0.0025.
    function landDotSize(R, cosc) {
        return R * 0.006 + cosc * R * 0.0025;
    }

    // landDotAlpha: land square alpha — (0.14 + cosc × 0.5), boosted to
    // (0.45 + wt × 0.75) of itself when heat-tinted.
    function landDotAlpha(cosc, tinted, wt) {
        return (0.14 + cosc * 0.5) * (tinted ? (0.45 + wt * 0.75) : 1);
    }

    // hitTest: nearest city marker within tolerance of a canvas-space point.
    // screen rows are {id, x, y, r}; distance is discounted by 40% of the
    // marker radius so big markers are easier to hit (prototype-verbatim).
    function hitTest(screen, x, y) {
        let best = null;
        let bd = HIT_TOLERANCE_PX;
        for (const s of screen) {
            const d = Math.hypot(s.x - x, s.y - y) - s.r * 0.4;
            if (d < bd) { bd = d; best = s.id; }
        }
        return best;
    }

    // fibFallback: 2600-dot Fibonacci sphere — the last-resort land stand-in
    // when the vendored geometry cannot be loaded or rasterizes to nothing.
    function fibFallback() {
        const dots = [];
        const ga = Math.PI * (3 - Math.sqrt(5));
        for (let i = 0; i < FIB_COUNT; i++) {
            const y = 1 - (i / (FIB_COUNT - 1)) * 2;
            const phi = Math.asin(y);
            const lam = (i * ga) % TWO_PI;
            dots.push({ sinp: Math.sin(phi), cosp: Math.cos(phi), lam });
        }
        return dots;
    }

    // ringsFromLand: GeoJSON land → flat ring list with bounding boxes.
    // Handles Feature, FeatureCollection, or a bare geometry — the
    // FeatureCollection-vs-Feature guard is a regression fix the handoff
    // calls out explicitly (topojson.feature() may return either).
    function ringsFromLand(land) {
        const feats = land.features ? land.features : [land];
        const rings = [];
        for (const f of feats) {
            const g = f.geometry || f;
            const polys = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
            for (const poly of polys) {
                for (const ring of poly) {
                    let minX = 999, maxX = -999, minY = 999, maxY = -999;
                    for (const [x, y] of ring) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                    rings.push({ pts: ring, minX, maxX, minY, maxY });
                }
            }
        }
        return rings;
    }

    // pointInRings: even-odd point-in-polygon over the ring list, with the
    // bounding-box early-out (prototype-verbatim ray cast).
    function pointInRings(lon, lat, rings) {
        let inside = false;
        for (const r of rings) {
            if (lon < r.minX || lon > r.maxX || lat < r.minY || lat > r.maxY) continue;
            const p = r.pts;
            for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
                const xi = p[i][0], yi = p[i][1];
                const xj = p[j][0], yj = p[j][1];
                if (((yi > lat) !== (yj > lat))
                    && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
                    inside = !inside;
                }
            }
        }
        return inside;
    }

    // landDotsFromRings: rasterize land rings onto a 1.2° latitude grid
    // (longitude step widened by 1/cos lat, floored at 0.25) between −58°
    // and 78° — precomputed sin/cos per dot for the render loop.
    function landDotsFromRings(rings) {
        const dots = [];
        const step = LAND_STEP_DEG;
        for (let lat = LAND_LAT_MIN; lat <= LAND_LAT_MAX; lat += step) {
            const lonStep = step / Math.max(0.25, Math.cos(lat * D2R));
            for (let lon = -180; lon < 180; lon += lonStep) {
                if (pointInRings(lon, lat, rings)) {
                    const phi = lat * D2R;
                    dots.push({ sinp: Math.sin(phi), cosp: Math.cos(phi), lam: lon * D2R });
                }
            }
        }
        return dots;
    }

    // assignNearestCity: give each land dot its nearest city index (ci) and
    // a linear falloff weight (wt) within 0.38 rad ≈ 22°, for land-heat
    // tinting. Mutates and returns the dot array.
    function assignNearestCity(dots, cities) {
        const cs = cities.map((c) => {
            const phi = c.lat * D2R;
            return { sinp: Math.sin(phi), cosp: Math.cos(phi), lam: c.lon * D2R };
        });
        for (const d of dots) {
            let best = -1;
            let bd = HEAT_FALLOFF_RAD;
            for (let i = 0; i < cs.length; i++) {
                const c = cs[i];
                const cosd = d.sinp * c.sinp + d.cosp * c.cosp * Math.cos(d.lam - c.lam);
                const dist = Math.acos(Math.max(-1, Math.min(1, cosd)));
                if (dist < bd) { bd = dist; best = i; }
            }
            d.ci = best;
            d.wt = best >= 0 ? 1 - bd / HEAT_FALLOFF_RAD : 0;
        }
        return dots;
    }

    // rankedCityRows (P1-5): the canvas-unavailable fallback's rows — the
    // adapted cities ranked by volume (desc, name asc on ties), formatted as
    // plain strings. Pure: the DOM layer only ever assigns them via
    // textContent, so a city name can never become markup.
    function rankedCityRows(cities) {
        return (Array.isArray(cities) ? cities.slice() : [])
            .sort((a, b) => (b.volume - a.volume)
                || String(a.name).localeCompare(String(b.name)))
            .map((c, i) => ({
                rank: String(i + 1),
                name: String(c.name),
                volume: Math.round(c.volume) + (Math.round(c.volume) === 1 ? ' post' : ' posts'),
                sentiment: (c.sentiment >= 0 ? '+' : '−') + Math.abs(c.sentiment).toFixed(2),
            }));
    }

    // First-frame performance mark name (P1-6) — landing.spec reads it.
    const FIRST_FRAME_MARK = 'pulse:first-frame';

    const math = {
        D2R,
        SPIN_RAD_PER_SEC,
        RING_RATE_PER_SEC,
        hexToRgb,
        mix,
        sentColor,
        normalizeCategorySlug,
        cityColor,
        topCategoryFromSources,
        adaptCities,
        sphereRadius,
        project,
        angleDelta,
        rotationTargets,
        clampPhi,
        dragRotate,
        clampUserZoom,
        wheelZoomFactor,
        keyZoomFactor,
        composeZoomStep,
        markerRadius,
        barHeight,
        pillarHeight,
        pulsePhase,
        landDotSize,
        landDotAlpha,
        hitTest,
        fibFallback,
        ringsFromLand,
        pointInRings,
        landDotsFromRings,
        assignNearestCity,
        rankedCityRows,
    };

    // ═══ Shared land geometry (module-level, loaded once per page) ═════════

    let landDots = null;     // [{sinp, cosp, lam, ci?, wt?}] once loaded
    let landPromise = null;  // in-flight load (deduped across instances)
    let nearestFor = null;   // cities array the current ci/wt was computed for

    // loadLandDots: fetch the vendored GeoJSON and rasterize it; any failure
    // (network, parse, empty raster) falls back to the Fibonacci sphere.
    // The render loop polls the module `landDots` each frame, which replaces
    // the prototype's landListeners callback plumbing.
    function loadLandDots(url) {
        if (landDots) return Promise.resolve(landDots);
        if (!landPromise) {
            landPromise = fetch(url || LAND_URL)
                .then((res) => {
                    if (!res.ok) throw new Error('land fetch ' + res.status);
                    return res.json();
                })
                .then((land) => {
                    const dots = landDotsFromRings(ringsFromLand(land));
                    landDots = dots.length > LAND_MIN_DOTS ? dots : fibFallback();
                    return landDots;
                })
                .catch(() => {
                    landDots = fibFallback();
                    return landDots;
                });
        }
        return landPromise;
    }

    // ensureNearest: (re)compute the land-heat assignment when the adapted
    // cities array changes identity — the prototype's compute-once flag
    // breaks when city data arrives asynchronously from the API.
    function ensureNearest(cities) {
        if (!landDots || cities.length === 0 || nearestFor === cities) return;
        assignNearestCity(landDots, cities);
        nearestFor = cities;
    }

    // ═══ Instance factory ═══════════════════════════════════════════════════

    // create(mountOrCanvas, deps): build one globe renderer.
    //   mountOrCanvas — a <canvas>, or a container element to append one to.
    //   deps          — optional { landUrl } override (tests / offline).
    // Returns { canvas, setState, getState, destroy }. setState accepts any
    // subset of the prototype's props:
    //   cities, palette [neg,neu,pos], colorMode 'sentiment'|'category'|
    //   'warm'|'cold', barMetric(city)→0..1, splitFor(id)→{pos,neu,neg},
    //   focus {lat,lon}, zoom, speed, graticule, landHeat, highlight [ids],
    //   dimTest(city)→bool, interactive, labels, hoveredId, selectedId,
    //   centerX, onHover(id,x,y), onDrag(), onCityClick(id).
    function create(mountOrCanvas, deps) {
        const opts = deps || {};

        // Resolve or build the canvas (inline styles mirror the prototype's
        // JSX style; touch-action:none lets Pointer Events own the gestures).
        let canvas;
        let ownsCanvas = false;
        if (mountOrCanvas && mountOrCanvas.tagName === 'CANVAS') {
            canvas = mountOrCanvas;
        } else if (mountOrCanvas && typeof mountOrCanvas.appendChild === 'function') {
            canvas = document.createElement('canvas');
            mountOrCanvas.appendChild(canvas);
            ownsCanvas = true;
        } else {
            throw new Error('PulseGlobe.create: mount must be a canvas or container element');
        }
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        canvas.style.display = 'block';
        canvas.style.touchAction = 'none';

        const ctx = canvas.getContext && canvas.getContext('2d');

        // P1-5 (FR-25): when canvas 2D rendering is unavailable, the globe
        // degrades to a DOM ranked-city list (name, volume, sentiment) in the
        // mount, rebuilt from setState's cities. textContent only — no markup
        // is ever built from data. The dead canvas is hidden.
        const fallbackMount = ctx ? null
            : (ownsCanvas ? mountOrCanvas : canvas.parentNode || null);
        let fallbackEl = null;
        function renderFallback() {
            if (!fallbackMount || typeof document === 'undefined') return;
            if (!fallbackEl) {
                fallbackEl = document.createElement('div');
                fallbackEl.className = 'globe-fallback';
                fallbackEl.setAttribute('role', 'region');
                fallbackEl.setAttribute('aria-label', 'Cities ranked by post volume');
                fallbackMount.appendChild(fallbackEl);
            }
            while (fallbackEl.firstChild) fallbackEl.removeChild(fallbackEl.firstChild);
            const note = document.createElement('p');
            note.className = 'globe-fallback-note';
            note.textContent = 'Globe unavailable: canvas rendering is not supported here. '
                + 'Cities ranked by post volume:';
            fallbackEl.appendChild(note);
            const list = document.createElement('ol');
            list.className = 'globe-fallback-list';
            for (const row of rankedCityRows(p.cities)) {
                const li = document.createElement('li');
                for (const [cls, text] of [
                    ['gf-name', row.name],
                    ['gf-vol mono', row.volume],
                    ['gf-sent mono', row.sentiment],
                ]) {
                    const span = document.createElement('span');
                    span.className = cls;
                    span.textContent = text;
                    li.appendChild(span);
                }
                list.appendChild(li);
            }
            fallbackEl.appendChild(list);
        }

        // P1-6: the first painted frame is marked once for the perf budget
        // (landing.spec asserts it lands under 1000 ms after navigation).
        let firstFrameMarked = false;

        // Props — prototype defaults (app.jsx tweak defaults: speed 1,
        // graticule on, land heat on).
        const p = {
            cities: [],
            palette: [
                SENTIMENT_PALETTE.negative,
                SENTIMENT_PALETTE.neutral,
                SENTIMENT_PALETTE.positive,
            ],
            colorMode: 'sentiment',
            barMetric: null,
            splitFor: null,
            focus: null,
            zoom: 1,
            speed: 1,
            graticule: true,
            landHeat: true,
            highlight: null,
            dimTest: null,
            interactive: false,
            labels: false,
            hoveredId: null,
            selectedId: null,
            centerX: 0.5,
            onHover: null,
            onDrag: null,
            onCityClick: null,
        };

        // View state (prototype stateRef) + gesture bookkeeping.
        const st = {
            lam: REST_LAM_RAD,
            phi: REST_PHI_RAD,
            zoom: 1,
            userZoom: 1,
            userUntil: 0,
            screen: [],       // visible, hit-testable markers this frame
            dragging: false,
            dragDist: 0,
            dragX: 0,
            dragY: 0,
            pinching: false,
            pinchDist: 0,
        };
        const pointers = new Map(); // active pointerId → {x, y} (pinch)

        let dead = false;
        let raf = null;
        let last = (typeof performance !== 'undefined' ? performance.now() : 0);

        // Reduced-motion: tracked live so toggling the OS setting takes
        // effect without a reload (G10).
        let reducedMotion = false;
        let mql = null;
        const onMotionChange = (e) => { reducedMotion = e.matches; };
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
            mql = window.matchMedia('(prefers-reduced-motion: reduce)');
            reducedMotion = mql.matches;
            if (typeof mql.addEventListener === 'function') {
                mql.addEventListener('change', onMotionChange);
            }
        }

        function applyInteractive() {
            canvas.style.pointerEvents = p.interactive ? 'auto' : 'none';
            if (!p.interactive) canvas.style.cursor = '';
        }
        applyInteractive();

        // DPR-capped backing-store resize (prototype-verbatim).
        function resize() {
            const dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
            canvas.width = canvas.clientWidth * dpr;
            canvas.height = canvas.clientHeight * dpr;
            if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        let ro = null;
        if (ctx) {
            resize();
            ro = new ResizeObserver(resize);
            ro.observe(canvas);
            loadLandDots(opts.landUrl);
        }

        // ── Frame loop (formula-for-formula port of globe.jsx frame()) ──────
        function frame(now) {
            if (dead) return;
            const dt = Math.min(0.05, (now - last) / 1000);
            last = now;
            const W = canvas.clientWidth;
            const H = canvas.clientHeight;
            const cx = W * (p.centerX !== undefined && p.centerX !== null ? p.centerX : 0.5);
            const cy = H * 0.5;

            // Rotation pursuit.
            const idle = now > st.userUntil;
            const targets = rotationTargets({
                dragging: st.dragging,
                focus: p.focus,
                interactive: p.interactive,
                idle,
                speed: p.speed,
                lam: st.lam,
                phi: st.phi,
                dt,
                now,
                reducedMotion,
            });
            st.lam += angleDelta(targets.tLam, st.lam) * targets.lamEase;
            st.phi += (targets.tPhi - st.phi) * EASE;
            st.zoom = composeZoomStep(st.zoom, p.zoom, st.userZoom);

            const R = sphereRadius(W, H, st.zoom);
            const sinP0 = Math.sin(st.phi);
            const cosP0 = Math.cos(st.phi);
            const view = { lam: st.lam, sinP0, cosP0, R, cx, cy };

            ctx.clearRect(0, 0, W, H);

            // Sphere body + rim.
            const g = ctx.createRadialGradient(
                cx - R * 0.3, cy - R * 0.35, R * 0.1, cx, cy, R * 1.05);
            g.addColorStop(0, 'rgba(38,52,74,0.55)');
            g.addColorStop(0.7, 'rgba(16,24,38,0.65)');
            g.addColorStop(1, 'rgba(8,12,20,0.9)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(cx, cy, R, 0, TWO_PI); ctx.fill();
            ctx.strokeStyle = 'rgba(120,160,220,0.14)';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(cx, cy, R, 0, TWO_PI); ctx.stroke();

            // Graticule (every 30°).
            if (p.graticule) {
                ctx.strokeStyle = 'rgba(110,140,190,0.08)';
                ctx.lineWidth = 0.7;
                for (let latd = -60; latd <= 60; latd += 30) {
                    ctx.beginPath();
                    let pen = false;
                    for (let lond = -180; lond <= 180; lond += 4) {
                        const pt = project(latd * D2R, lond * D2R, view);
                        if (pt) {
                            if (pen) ctx.lineTo(pt[0], pt[1]);
                            else ctx.moveTo(pt[0], pt[1]);
                            pen = true;
                        } else pen = false;
                    }
                    ctx.stroke();
                }
                for (let lond = -180; lond < 180; lond += 30) {
                    ctx.beginPath();
                    let pen = false;
                    for (let latd = -85; latd <= 85; latd += 4) {
                        const pt = project(latd * D2R, lond * D2R, view);
                        if (pt) {
                            if (pen) ctx.lineTo(pt[0], pt[1]);
                            else ctx.moveTo(pt[0], pt[1]);
                            pen = true;
                        } else pen = false;
                    }
                    ctx.stroke();
                }
            }

            // Land dots (optionally heat-tinted by nearest city).
            if (landDots) {
                const heat = p.landHeat;
                if (heat) ensureNearest(p.cities);
                const cityCols = heat
                    ? p.cities.map((c) => cityColor(c, p.colorMode, p.palette))
                    : null;
                ctx.fillStyle = LAND_NEUTRAL;
                for (const dot of landDots) {
                    const dl = dot.lam - st.lam;
                    const cosc = sinP0 * dot.sinp + cosP0 * dot.cosp * Math.cos(dl);
                    if (cosc < 0.02) continue;
                    const x = cx + R * dot.cosp * Math.sin(dl);
                    const y = cy - R * (cosP0 * dot.sinp - sinP0 * dot.cosp * Math.cos(dl));
                    // Tint requires a computed assignment AND a city index
                    // that is still in range of the current cities array.
                    const tinted = heat && nearestFor === p.cities
                        && dot.ci >= 0 && dot.ci < cityCols.length && dot.wt > 0;
                    ctx.fillStyle = tinted ? cityCols[dot.ci] : LAND_NEUTRAL;
                    ctx.globalAlpha = landDotAlpha(cosc, tinted, dot.wt);
                    const r = landDotSize(R, cosc);
                    ctx.fillRect(x - r / 2, y - r / 2, r, r);
                }
                ctx.globalAlpha = 1;
            }

            // City markers, bars, rings, labels.
            st.screen = [];
            const t = now / 1000;
            const highlight = p.highlight;
            for (const c of p.cities) {
                const pt = project(c.lat * D2R, c.lon * D2R, view);
                if (!pt) continue;
                const dimmed = (highlight && !highlight.includes(c.id))
                    || (p.dimTest && !p.dimTest(c));
                const col = cityColor(c, p.colorMode, p.palette);

                // Per-city data bar (FR-17), re-encoded per chapter (FR-18);
                // the split city renders three pillars instead.
                if (p.barMetric && !dimmed) {
                    const dl2 = c.lon * D2R - st.lam;
                    const phi2 = c.lat * D2R;
                    const x3 = Math.cos(phi2) * Math.sin(dl2);
                    const y3 = cosP0 * Math.sin(phi2) - sinP0 * Math.cos(phi2) * Math.cos(dl2);
                    const norm = Math.hypot(x3, y3);
                    if (norm > 0.02) {
                        const dxu = x3 / norm;
                        const dyu = -y3 / norm; // screen-space outward direction
                        const split = p.splitFor && p.splitFor(c.id);
                        if (split) {
                            // Three pillars: pos / neu / neg, ±5.5px offsets.
                            const px = -dyu, py = dxu; // perpendicular
                            const parts = [
                                [split.pos, p.palette[2]],
                                [split.neu, p.palette[1]],
                                [split.neg, p.palette[0]],
                            ];
                            parts.forEach(([share, colr], k) => {
                                const off = (k - 1) * 5.5;
                                const bx = pt[0] + px * off;
                                const by = pt[1] + py * off;
                                const h = pillarHeight(R, share, pt[2]);
                                ctx.strokeStyle = colr;
                                ctx.lineWidth = 3;
                                ctx.globalAlpha = 0.9;
                                ctx.beginPath();
                                ctx.moveTo(bx, by);
                                ctx.lineTo(bx + dxu * h, by + dyu * h);
                                ctx.stroke();
                            });
                            ctx.globalAlpha = 1;
                        } else {
                            const h = barHeight(R, p.barMetric(c), pt[2]);
                            const grad = ctx.createLinearGradient(
                                pt[0], pt[1], pt[0] + dxu * h, pt[1] + dyu * h);
                            grad.addColorStop(0, col);
                            grad.addColorStop(1, 'rgba(0,0,0,0)');
                            ctx.strokeStyle = grad;
                            ctx.lineWidth = 2;
                            ctx.globalAlpha = 0.8 * pt[2];
                            ctx.beginPath();
                            ctx.moveTo(pt[0], pt[1]);
                            ctx.lineTo(pt[0] + dxu * h, pt[1] + dyu * h);
                            ctx.stroke();
                            ctx.globalAlpha = 1;
                        }
                    }
                }

                const r = markerRadius(c.volume, st.zoom, pt[2]);
                const isHot = c.id === p.hoveredId || c.id === p.selectedId;
                ctx.globalAlpha = dimmed ? 0.13 : (0.55 + pt[2] * 0.45);

                // Glow halo (×3 radius radial gradient).
                const gg = ctx.createRadialGradient(pt[0], pt[1], 0, pt[0], pt[1], r * 3);
                gg.addColorStop(0, col);
                gg.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.globalAlpha *= 0.35;
                ctx.fillStyle = gg;
                ctx.beginPath(); ctx.arc(pt[0], pt[1], r * 3, 0, TWO_PI); ctx.fill();
                ctx.globalAlpha = dimmed ? 0.2 : 0.95;
                ctx.fillStyle = col;
                ctx.beginPath(); ctx.arc(pt[0], pt[1], r, 0, TWO_PI); ctx.fill();

                // Pulse ring — phase-staggered by longitude; suppressed
                // entirely under prefers-reduced-motion (G10).
                if (!dimmed && !reducedMotion) {
                    const ph = pulsePhase(t, c.lon);
                    ctx.globalAlpha = (1 - ph) * 0.38;
                    ctx.strokeStyle = col;
                    ctx.lineWidth = 1.2;
                    ctx.beginPath();
                    ctx.arc(pt[0], pt[1], r + ph * r * (isHot ? 3.2 : 2.4), 0, TWO_PI);
                    ctx.stroke();
                }

                // Label: hovered/selected, chapter-highlighted, or (explore)
                // above the volume threshold.
                if (!dimmed && (isHot
                    || (p.labels && c.volume > GLOBE.labelVolumeMin)
                    || (highlight && highlight.includes(c.id)))) {
                    ctx.globalAlpha = 0.92;
                    ctx.font = '600 11px "IBM Plex Mono", monospace';
                    ctx.fillStyle = isHot ? '#EAF1FA' : 'rgba(210,224,240,0.75)';
                    ctx.fillText(c.name.toUpperCase(), pt[0] + r + 6, pt[1] + 3.5);
                    if (isHot) {
                        ctx.fillStyle = col;
                        const lbl = p.colorMode === 'category'
                            ? String(c.top || '').toUpperCase()
                            : (c.sentiment >= 0 ? '+' : '') + c.sentiment.toFixed(2);
                        ctx.fillText(lbl, pt[0] + r + 6, pt[1] + 17);
                    }
                }
                ctx.globalAlpha = 1;

                // Hit-testable markers: dimmed (filtered-out) cities are NOT
                // registered — the prototype let invisible cities be clicked.
                if (!dimmed) {
                    st.screen.push({ id: c.id, x: pt[0], y: pt[1], r: Math.max(r, 9) });
                }
            }

            if (!firstFrameMarked) {
                firstFrameMarked = true;
                if (typeof performance !== 'undefined'
                    && typeof performance.mark === 'function') {
                    performance.mark(FIRST_FRAME_MARK);
                }
            }

            raf = requestAnimationFrame(frame);
        }
        if (ctx) {
            raf = requestAnimationFrame(frame);
        } else {
            canvas.style.display = 'none';
            renderFallback();
        }

        // ── Input (Pointer Events port of the prototype's mouse handlers) ───

        function hitAt(e) {
            const rect = canvas.getBoundingClientRect();
            return hitTest(st.screen, e.clientX - rect.left, e.clientY - rect.top);
        }

        // zoomBy: multiply the user-zoom (clamped) and hold rotation for the
        // override window — shared by wheel, pinch, and keyboard paths.
        function zoomBy(f) {
            st.userZoom = clampUserZoom(st.userZoom * f);
            st.userUntil = performance.now() + GLOBE.idleResumeMs;
        }

        function pinchDistance() {
            const pts = Array.from(pointers.values());
            return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        }

        const onPointerDown = (e) => {
            if (!p.interactive) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 2) {
                // Second finger: switch from drag to pinch-zoom.
                st.dragging = false;
                st.pinching = true;
                st.pinchDist = pinchDistance();
                return;
            }
            st.dragging = true;
            st.dragDist = 0;
            st.dragX = e.clientX;
            st.dragY = e.clientY;
            canvas.style.cursor = 'grabbing';
            if (typeof canvas.setPointerCapture === 'function') {
                try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* detached */ }
            }
            if (p.onHover) p.onHover(null);
        };

        const onPointerMove = (e) => {
            if (pointers.has(e.pointerId)) {
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }
            if (st.pinching && pointers.size >= 2) {
                const d2 = pinchDistance();
                if (st.pinchDist > 0 && d2 > 0) zoomBy(d2 / st.pinchDist);
                st.pinchDist = d2;
                return;
            }
            if (st.dragging) {
                const dx = e.clientX - st.dragX;
                const dy = e.clientY - st.dragY;
                st.dragX = e.clientX;
                st.dragY = e.clientY;
                st.dragDist += Math.abs(dx) + Math.abs(dy);
                const next = dragRotate(st.lam, st.phi, dx, dy);
                st.lam = next.lam;
                st.phi = next.phi;
                st.userUntil = performance.now() + GLOBE.idleResumeMs;
                return;
            }
            if (!p.interactive) return;
            const id = hitAt(e);
            canvas.style.cursor = id ? 'pointer' : 'grab';
            if (p.onHover) p.onHover(id, e.clientX, e.clientY);
        };

        const onPointerUp = (e) => {
            pointers.delete(e.pointerId);
            if (pointers.size < 2) {
                st.pinching = false;
                st.pinchDist = 0;
            }
            if (st.dragging && pointers.size === 0) {
                if (st.dragDist > CLICK_SUPPRESS_PX && p.onDrag) p.onDrag();
                st.dragging = false;
                if (p.interactive) canvas.style.cursor = 'grab';
            }
        };

        // Named pointerleave handler — the prototype leaked an anonymous
        // mouseleave listener it never removed; this one is removed in
        // destroy().
        const onPointerLeave = () => {
            if (p.onHover) p.onHover(null);
        };

        const onClick = (e) => {
            if (!p.interactive) return;
            if (st.dragDist > CLICK_SUPPRESS_PX) return;
            const id = hitAt(e);
            if (id && p.onCityClick) p.onCityClick(id);
        };

        // Zoom: ctrl-wheel (or trackpad pinch) always; plain wheel only in
        // explore mode so story scrolling is never hijacked.
        const onWheel = (e) => {
            if (!p.interactive && !e.ctrlKey) return;
            e.preventDefault();
            zoomBy(wheelZoomFactor(e.deltaY, e.ctrlKey));
        };

        // Keyboard zoom: + / − step, 0 resets (skipped inside form fields).
        // Grumpy #2 guards: modifier chords (ctrl/cmd/alt +/−/0 are BROWSER
        // page-zoom and shortcuts — never eat them) and non-interactive mode
        // (story mode owns the page; the globe takes no keyboard input) both
        // bail before any handling.
        const onKey = (e) => {
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (!p.interactive) return;
            if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
            const f = keyZoomFactor(e.key);
            if (f !== null) {
                zoomBy(f);
                e.preventDefault();
            } else if (e.key === '0') {
                // Reset gets the same rotation hold as zoomBy — without it
                // the auto-spin snapped back the instant the zoom reset.
                st.userZoom = 1;
                st.userUntil = performance.now() + GLOBE.idleResumeMs;
            }
        };

        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerleave', onPointerLeave);
        canvas.addEventListener('click', onClick);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        window.addEventListener('keydown', onKey);

        // ── Public instance API ──────────────────────────────────────────────

        // setState: shallow-merge a prop subset; `cities` is adapted once
        // here so the render loop never re-derives shapes per frame.
        // Unknown keys warn loudly (a typo'd prop name must not fail
        // silently) and are ignored.
        function setState(partial) {
            if (!partial || typeof partial !== 'object') return;
            for (const key of Object.keys(partial)) {
                if (!Object.prototype.hasOwnProperty.call(p, key)) {
                    console.warn('[pulse] PulseGlobe.setState: unknown prop "'
                        + key + '" ignored');
                    continue;
                }
                p[key] = key === 'cities' ? adaptCities(partial.cities) : partial[key];
            }
            if ('interactive' in partial) applyInteractive();
            if (!ctx && 'cities' in partial) renderFallback();
        }

        // getState: snapshot of the current props (adapted cities included).
        function getState() {
            return Object.assign({}, p);
        }

        // destroy: cancel the loop and remove EVERY listener/observer this
        // instance attached (including the prototype's leaked mouseleave
        // equivalent), then detach the canvas if this instance created it.
        function destroy() {
            if (dead) return;
            dead = true;
            if (raf !== null) cancelAnimationFrame(raf);
            if (ro) ro.disconnect();
            canvas.removeEventListener('pointerdown', onPointerDown);
            canvas.removeEventListener('pointermove', onPointerMove);
            canvas.removeEventListener('pointerleave', onPointerLeave);
            canvas.removeEventListener('click', onClick);
            canvas.removeEventListener('wheel', onWheel);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
            window.removeEventListener('keydown', onKey);
            if (mql && typeof mql.removeEventListener === 'function') {
                mql.removeEventListener('change', onMotionChange);
            }
            pointers.clear();
            if (fallbackEl && fallbackEl.parentNode) fallbackEl.parentNode.removeChild(fallbackEl);
            if (ownsCanvas && canvas.parentNode) canvas.parentNode.removeChild(canvas);
        }

        return { canvas, setState, getState, destroy };
    }

    // ═══ Default page instance (main.js bootstrap contract) ════════════════

    let defaultInstance = null;

    // init: idempotent — mounts the shared page globe on #globe-wrap.
    // main.js calls this on DOMContentLoaded; story.js/ui.js (C3/C4) reach
    // the same instance via getInstance() and drive it with setState().
    function init() {
        if (defaultInstance) return defaultInstance;
        const mount = typeof document !== 'undefined'
            ? document.getElementById('globe-wrap') : null;
        if (!mount) return null;
        defaultInstance = create(mount);
        return defaultInstance;
    }

    function getInstance() {
        return defaultInstance;
    }

    return {
        create,
        init,
        getInstance,
        loadLandDots,
        LAND_URL,
        FIRST_FRAME_MARK,
        math,
    };
}));
