> Approved design (2026-07-05) — source: ~/.claude/plans/more-modern-professional-ethereal-hopcroft.md

# Globe.gl Storytelling Migration — Pulse of AI Frontend

## Context

Pulse of AI's frontend currently renders a Mapbox GL globe ([public/js/map.js](../../public/js/map.js), 601 lines) with custom drag/wheel gestures and fill-extrusion 3D sentiment bars on demo data with an API fallback. The user wants a modern, professional storytelling experience in the style of the WebGL Globe election visualization (https://javisantana.com/lab/globe-elecciones/): dark sphere, glowing data bars, scroll-driven narrative, dynamically derived insights, global↔regional views. This migration is also the execution vehicle for the spec's Phase E (Scrollama narrative).

## Decisions (locked with user, 2026-07-05)

1. **Migrate to globe.gl** (Three.js UMD, self-hosted) — Mapbox layers, token use, and custom canvas gestures retired. `/api/config` route stays (tests cover it).
2. **Story model:** Scrollama scroll chapters (camera fly-to + data re-encode + insight card per step) ending in **free-explore** (auto-rotate, sentiment/source-category filters).
3. **Insights derived client-side** from `/api/posts/aggregated-by-location` data (identical on demo fallback); chapter templates interpolate computed numbers. No new backend endpoints.

## Constraints

- Write hook blocks `innerHTML` in client JS → all dynamic DOM via createElement/textContent. **Do not use globe.gl's `pointLabel`/`objectLabel` HTML-string accessors** (they inject via innerHTML internally); build a custom DOM tooltip instead.
- No frontend build step (project convention). Vendor libraries into `public/vendor/` with pinned versions + `README.md` (versions, URLs, licenses): `globe.gl@2.34.x` UMD (bundles three.js — verify `window.Globe` on load), `scrollama.min.js` copied from gitignored `scrollama-main/build/` (v3.2.0), optional `earth-night.jpg` texture (default: flat `#0d1117` sphere).
- TDD; ≥80% coverage gate. **Note: jest currently runs `tests/globalSetup.js` (test-DB migrate) on every invocation — Docker must be up for all jest steps** (or do the "DB-free unit loop" jest-config fix from the project plan first).
- Stop hook requires `preview_snapshot` + `preview_console_logs` after frontend edits. Dev server: `preview_start` name "Express API (dev)" (port 3000).
- Reuse: `esc()`, `SENTIMENT_COLORS`, `SOURCE_PALETTE`, `DEMO_DATA` (map.js:14-40, 217-293), tooltip information hierarchy (map.js:131-215), DOM legend builder (map.js:504-573, already hook-compliant), main.css CSS variables (dark Bloomberg: `#0d1117`/`#161b22`/`#f0f6fc`/`#1f6feb`).

## Design

### Module layout (vanilla JS, script tags with `defer`; load order as listed)

| File | Role | Jest-testable |
|---|---|---|
| `public/vendor/globe.gl/globe.gl.min.js`, `public/vendor/scrollama/scrollama.min.js`, `public/vendor/textures/`, `public/vendor/README.md` | Self-hosted libs | — |
| `public/js/utils.js` | `esc()`, palettes, `fmtPct`/`fmtCount` — extracted from map.js; dual export guard (`module.exports` + window global) | ✅ |
| `public/js/data.js` | `DEMO_DATA`, pure `normalizeCities(raw)` (validate lat/lng, coerce counts, compute shares, drop bad rows), browser-guarded `loadCityData()` (fetch + demo fallback) | ✅ (adapter) |
| `public/js/insights.js` | Pure derivations + `TEMPLATES` + `renderTemplate()` (throws on unknown token) | ✅ |
| `public/js/chapters.js` | 7-chapter config + pure `resolveChapter(chapter, insights, cities)` → concrete `{camera, encoding, cardTitle, cardBody, highlightCities, arcs}` | ✅ |
| `public/js/globe.js` | Globe init, `applyChapterState()`, encodings, DOM tooltip, chapter-aware legend, explore controls, WebGL feature-detect fallback | preview only |
| `public/js/story.js` | Scrollama wiring, step-enter handling, explore release/re-entry | preview only |
| `public/js/main.js` | Keep (health dot + refresh) — **must first be refactored off `innerHTML`** or the Write hook blocks edits | — |
| `public/js/map.js` | **Deleted** after extraction (git history preserves) | — |

Backend unchanged. `jest.config.js`: add ONLY the four pure modules to `collectCoverageFrom` (browser-only files would tank the gate).

### Page layout (index.html + main.css)

Nav unchanged → `#intro` section (hero + demographics/topics teasers — moved ABOVE the scrolly; `#scrolly` must stay the LAST section so the sticky globe remains pinned for free-explore; document this constraint in an HTML comment) → `#scrolly` containing `.globe-sticky` (`position: sticky; top: 0; height: 100vh; pointer-events: none` during story) and `.scrolly-steps` (each `.step` ~90vh with a `.step-card`: rgba(22,27,34,.92) bg, `#30363d` border, backdrop-blur, opacity keyed to scrollama's active class). Explore step toggles `.explore` on `.scrolly` → pointer-events flip to the globe, filter panel appears (top-right), auto-rotate on. Inline `<style>` block in index.html is absorbed into main.css.

### Globe encoding

- **Story view:** one `pointsData` cylinder per city; each chapter swaps accessors — `pointAltitude` = chapter metric (total, negative share, …), `pointColor` = mode (`dominant` | net-sentiment lerp | highlight-dim `#30363d`); `pointsTransitionDuration(800)` animates re-encoding as narrative motion; `pointsMerge(false)` (needed for hover; trivial at ≤50 cities). Arcs (`arcsData`, dashed, animated, positive→negative gradient) only in the "divide" chapter, cleared elsewhere; optional `ringsData` pulse on highlighted city.
- **Free-explore:** stacked bars via **pointsData stacking** (N points per city at cumulative altitudes, drawn tallest-first with slightly decreasing radius 0.55/0.54/0.53 to avoid z-fighting) — avoids needing a `THREE` global from the UMD bundle entirely. Sentiment mode (3 segments, SENTIMENT_COLORS) or source-category mode (≤8 segments, SOURCE_PALETTE with same category→color assignment as map.js). Filter chips recompute the array → `pointsData()` transition animates. Auto-rotate 0.35, paused on pointerdown, resumes after 8s idle.
- **Tooltip:** custom `div#globe-tooltip` + `buildTooltipNode(city)` DOM factory (createElement/textContent port of buildTooltip's hierarchy); positioned on container mousemove, clamped to viewport; wired via `globe.onPointHover`. Active in explore mode and on chapter-highlighted points.
- **Legend:** port existing DOM legend; chapter-aware (shows active encoding's swatches; full palette in explore).

### Chapter system

Schema: `{id, camera:{lat,lng,altitude}, cameraMs, encoding:{metric,colorMode,filter}, highlight:<insight key>, arcs, insight:{templateId,title}, autoRotate}`. Sequence: Overview → Volume leaders → Positivity leaders → Negativity hotspots → The divide (arc) → Who's driving the conversation (source categories) → explore. Scrollama `offset: 0.5`; step-enter applies `resolveChapter` output (idempotent; duplicate-id guard; mid-flight `pointOfView` calls interrupt cleanly — no queue). Step cards pre-populated at init so text exists before scrolling. Explore step-exit (upward) fully reverses release state.

### Insights engine

`computeInsights(cities)` with `MIN_TOTAL = 5` guard for share-based superlatives; deterministic tie-breaks (higher total → alphabetical). Derivations: globalTotals; highestVolumeCity; mostPositive/mostNegativeCity (by share); sentimentRatioExtremes (Laplace +1, no Infinity); dominantSourceCategory global + per-city; largestSourceConcentration (city, source, pct); regionalDominance via pure `regionOf(lat,lng)` longitude bands (Americas / Europe-Africa / Asia-Pacific — lat accepted for signature stability but unused); extremesDelta vs global average. `computeInsights([])` → null superlatives, no throw → `resolveChapter` substitutes fallback copy ("Data unavailable — showing demo view"). All card text lands via textContent (XSS-safe by construction — comment this so nobody "helpfully" switches to HTML).

## Implementation Steps (TDD; jest needs Docker up — see Constraints)

0. Save this design as `docs/plans/2026-07-05-globe-storytelling-design.md`; commit.
1. **Vendor assets** into `public/vendor/` (pinned versions, README with licenses). Verify files exist; `window.Globe`/`window.scrollama` confirmed at step 6.
2. **utils.js** — write `tests/unit/utils.test.js` (esc escapes `& < > " '`; palette key/length snapshot) → red → implement → green.
3. **data.js** — write `tests/unit/globeData.test.js` (valid rows pass + gain shares; bad lat/lng dropped; string counts coerced; negative clamped; total recomputed on mismatch; sources shape preserved/tolerated missing; DEMO_DATA normalizes losslessly) → red → implement → green.
4. **insights.js** — write `tests/unit/insights.test.js` (totals from 4-city fixture; volume max; share-not-count + MIN_TOTAL; deterministic tie-break; no Infinity/NaN ratios; category aggregation; concentration; regionOf buckets + boundaries; delta arithmetic; empty input; renderTemplate multi-token / throws unknown / no `{` residue; formatters) → red → implement → green. Add 4 pure modules to `collectCoverageFrom`; `npm run test:cov` must still pass the gate.
5. **chapters.js** — write `tests/unit/chapters.test.js` (every templateId exists; every highlight key on insights shape; DEMO_DATA resolution leaves no tokens; empty-data fallback; unique ids incl. exactly one `explore`) → red → implement → green.
6. **index.html + main.css restructure** (no globe yet): drop Mapbox tags + map.js tag; absorb inline styles; scrolly/sticky markup, empty step cards, hidden tooltip/legend/panel containers; stub globe.js/story.js; **refactor main.js off innerHTML** (createElement health dot). Verify: preview_snapshot + preview_console_logs clean; `preview_eval` confirms `window.Globe` & `window.scrollama`.
7. **globe.js static globe**: init (flat `#0d1117` sphere default, atmosphere `#1f6feb`), load data, render chapter-1 encoding; WebGL feature-detect → textContent fallback (ranked city list); `webglcontextlost` → reload prompt; `rendererConfig {antialias: dpr<2}`. Verify: snapshot + screenshot + console clean; `preview_eval` point count == normalized city count.
8. **Delete map.js**; grep for stragglers (`grep -rn "mapbox" public/ src/`). Verify: reload, no 404s/errors.
9. **applyChapterState + legend + tooltip** in globe.js. Verify: `preview_eval` applies each chapter id; screenshots of 2–3 chapters; console clean.
10. **story.js scrollama wiring** (cards, fling guard, resize). Verify: `preview_eval` scrollTo through steps; snapshot each; fast-scroll-to-bottom no errors.
11. **Explore mode** (release/re-entry, filter panel, stacked encoding, hover tooltips, auto-rotate + idle resume). Verify: preview_click chips; snapshot + inspect panel; scroll-up returns to story.
12. **Full pass**: `npm test`, `npm run test:cov` (confirms /api/config tests untouched + gate holds), final preview walkthrough desktop + `preview_resize` mobile 375px (cards must not fully cover globe; bottom-anchor cards on narrow viewports if needed). Update CLAUDE.md frontend notes + vendor mention. Commit per project gates.

## Risks

- **Perf**: pointsData stacking ≤ ~150 low-poly cylinders — trivial; if city count 10×s, switch explore to single bars + tooltip breakdown or hexBin density.
- **THREE global absent from UMD**: avoided by pointsData-stacking choice (no THREE access needed).
- **Scroll jank**: pointer-events none during story; camera moves only on discrete step-enter; transitions ≤800ms; idempotent state application.
- **WebGL unavailable**: feature-detect → informative static fallback from insights.
- **XSS/hook discipline**: no `*Label` HTML accessors; createElement/textContent everywhere; main.js refactor front-loaded (step 6) so the hook never blocks mid-feature.
- **Bundle weight** (~1.2MB): defer scripts; flat-color sphere default keeps texture optional.

## Verification (end-to-end)

Docker up → `npm run verify` green (unit incl. new insights/data/chapters/utils suites + integration + coverage ≥80%) → `preview_start` "Express API (dev)" → walkthrough: story scroll (6 chapters: camera flies, bars re-encode, insight cards show real derived numbers), explore release (filters work, tooltips on hover, auto-rotate), scroll-back re-enters story, mobile 375px usable, console error-free throughout.
