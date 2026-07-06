# Configurable city/location layer — research

**Question:** How do comparable geo-visualization products structure a configurable city/location layer (registry vs hardcoded, join mechanics, dataset licensing, sizing), and what should pulse-of-ai adopt to replace the duplicated hardcoded city coordinates in `src/routes/posts.js` (CITY_COORDS) and `public/js/data.js` (12-city DEMO_DATA)?

**Dispatched by:** Orchestrator, per Jennifer's directive "cities are a layer to support; research what similar solutions implement — do what is right, not what is easiest."
**Date:** 2026-07-06

---

## Current state (this codebase)

- `src/routes/posts.js` lines 25–45+: `CITY_COORDS` — hardcoded map of ~20 city names → `{lat, lng}`, used at line 158–159 to enrich `raw_posts.location` aggregates. Unknown city → `lat: null` (row later dropped by the frontend normalizer).
- `public/js/data.js`: `DEMO_DATA` — 12 hand-written city objects (coords + fabricated sentiment counts + per-source breakdowns), UMD dual-export (CommonJS for jest, `window.PulseData` for browser).
- No build step: frontend is plain `<script>` tags (`public/index.html` lines 71–73); backend is CommonJS Node.
- DB schema (`001_core_schema.sql` line 34): `raw_posts.location TEXT` is city-level only by design ("GDPR: max granularity") — there is **no cities table**; geography lives only in code.

Two independent hardcoded registries is the anti-pattern every surveyed product avoids.

---

## Findings

### (a) Grafana geomap panel — the closest analog

Grafana's geomap panel has a **"Lookup" location mode**: the query returns location *names*, and a **gazetteer** (a data file, not code) maps names → coordinates. Built-in gazetteers: countries, US states, airports; users can point the panel at a **custom gazetteer by URL**.

Grafana's gazetteer loader (`public/app/features/geo/gazetteer/gazetteer.ts`) accepts three formats: GeoJSON FeatureCollections, a legacy array-of-objects with `key`/`keys` + `latitude`/`longitude`, or any generic DataFrame with detectable `lat`/`lng` fields. Lookup keys are indexed **both case-sensitively and uppercased** so name matching is case-insensitive, and multiple `keys` per entry act as aliases.

Takeaway: **registry-as-data with alias-tolerant, case-insensitive lookup** is a first-class, named pattern ("gazetteer") in monitoring tooling. The layer declares *which field joins* to the gazetteer; the gazetteer is swappable config.

### (b) kepler.gl / deck.gl — config/data separation and accessors

kepler.gl's `addDataToMap` takes **datasets** (fields + rows) and a **separate serializable JSON config**; each layer references its dataset via `dataId` and names the lat/lng columns in config. Config can be saved/loaded independently of data (`KeplerGlSchema.getConfigToSave`).

deck.gl layers are "descriptor objects": a `data` prop (array, URL, or promise — hardcoded, preloaded, and runtime-fetched are interchangeable) plus **accessors** (`getPosition`, `getFillColor`, …) that map each data object to visuals. The docs' own example polls a server and recreates layers with a fresh `data` prop.

Takeaway: layers never own coordinates. They own *bindings* — "position comes from these fields of that dataset." Data source is swappable without touching layer code.

### (c) Observable/D3 news-graphics globes

The canonical D3 globe stack loads geography as **external TopoJSON at runtime** from `world-atlas` — a pre-built redistribution of Natural Earth vectors — and populated-places examples convert the Natural Earth `populated places` FeatureCollection and render via `d3.geoPath`, sizing/coloring by the dataset's population/rank attributes. Cities are never inline in notebook code; they come from the gazetteer file, pruned by rank.

Takeaway: even one-off news graphics treat the city list as a **pruned slice of a public gazetteer** (top-N by `scalerank`/`pop_max`), not hand-typed coordinates.

### (d) Mapbox / MapLibre GL — sources vs layers

MapLibre's style spec (open-source successor to the Mapbox spec; Mapbox docs returned HTTP 403 to automated fetch, MapLibre spec verified instead): a **geojson source** holds data (inline object *or* URL), **layers reference sources by id**, and data-driven styling reads feature properties via expressions like `["get", "propertyName"]`. Same source, multiple styled layers.

Takeaway: strict source/layer split; styling is a pure function of feature properties. Mirrors what `normalizeCities()` in `public/js/data.js` already does — that adapter is the right seam.

### (e) City gazetteer datasets — size and licensing

| Dataset | Size / pruning | License | Attributes | URL | Accessed |
|---|---|---|---|---|---|
| GeoNames `cities15000` | ~25,000 (pop > 15k or capitals); also cities500/1000/5000 tiers | **CC BY 4.0** (attribution required) | 19 fields: geonameId, name, asciiname, lat/lng, country, admin codes, **population**, timezone | https://download.geonames.org/export/dump/readme.txt , https://www.geonames.org/export/ | 2026-07-06 |
| simplemaps World Cities (Basic) | ~50,000 cities; paid tiers to 4.4M | **CC BY 4.0** free tier; paid tiers commercial license | city, lat, lng, country, iso codes, population; CSV/Excel/SQL | https://simplemaps.com/data/world-cities , https://simplemaps.com/data/license (page blocks automated fetch; values via search result summaries — spot-check before shipping attribution text) | 2026-07-06 |
| Natural Earth Populated Places | ~7,300 points; built-in pruning via `scalerank`/`rank_max` (14 population tiers); "simple" subset available | **Public domain** — "No permission is needed… Crediting the authors is unnecessary" | name, lat/lng, pop_max (UN metro estimates for top ~500), rank | https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/ , https://www.naturalearthdata.com/about/terms-of-use/ | 2026-07-06 |
| world-atlas (TopoJSON redistribution of Natural Earth) | pre-built 110m/50m/10m TopoJSON | Public domain (inherits Natural Earth) | country/land geometry (companion for basemaps) | https://github.com/topojson/world-atlas | 2026-06 (npm) |

Pruning norm: every surveyed dataset ships a **top-N-by-population/rank** mechanism (GeoNames population thresholds in the filename; Natural Earth `scalerank`). Hand-curating ~30 entries *from* such a dataset is squarely within industry practice.

---

## Synthesis

Across all five surveys the same three-part structure recurs, with zero counterexamples:

1. **Registry as data, not code.** Grafana calls it a gazetteer; kepler.gl a dataset; MapLibre a source; D3 graphics load TopoJSON/GeoJSON. Coordinates live in one swappable data artifact.
2. **Layers declare joins, not coordinates.** Grafana: lookup-field → gazetteer key (case-insensitive, alias-aware). kepler.gl: `dataId` + column names. MapLibre: source id + `["get", prop]`. deck.gl: accessors.
3. **Pruned public gazetteers, top-N by population/rank.** Nobody hand-types lat/lngs; they slice GeoNames or Natural Earth.

Outlier: Grafana's *custom* gazetteer must be URL-hosted (no easy local-file path in their docker image, per the community forum https://community.grafana.com/t/custom-gazetteer-file/106274) — a deployment constraint pulse-of-ai doesn't share, since it serves its own static files.

Licensing median: CC BY 4.0 with attribution. Outlier (in the good direction): **Natural Earth is public domain** — the only option with zero attribution obligation.

---

## Recommendation

**Create one city registry file — `public/js/config/cities.config.js`, UMD dual-export (the exact pattern `public/js/data.js` and `public/js/utils.js` already use) — and make it the single source of truth for both the backend route and the frontend demo generator.**

### Registry shape

```js
// public/js/config/cities.config.js  (UMD wrapper omitted)
const CITY_REGISTRY = [
    // Coordinates sourced from Natural Earth Populated Places (public domain).
    { name: 'San Francisco', aliases: ['SF', 'San Francisco Bay Area'],
      lat: 37.7749, lng: -122.4194, country: 'US', region: 'north_america',
      population: 3300000, tier: 1 },
    // ... ~30 entries
];
```

- `aliases` + case-insensitive matching: adopt Grafana's gazetteer lookup semantics — build a lookup `Map` keyed on `name.toUpperCase()` and every `alias.toUpperCase()`, exposed as `findCity(name)`. This directly fixes the current silent-null failure mode when `raw_posts.location` says "NYC" or "new york".
- `region`/`tier`/`population`: feature properties for data-driven styling (MapLibre pattern) and for the demo generator's plausibility templates (which news/social sources appear per region).

### Consumers

1. **Backend** (`src/routes/posts.js`): delete `CITY_COORDS`; `const { findCity } = require('../../public/js/config/cities.config.js');`. The UMD guard makes this a plain CommonJS require — **no sync test needed because there is nothing to sync**; it is literally the same file the browser loads. Add one unit test asserting registry invariants instead: ≥30 entries, unique uppercase name+alias keys, lat ∈ [-90, 90], lng ∈ [-180, 180], required fields present.
2. **Frontend demo** (`public/js/data.js`): replace the 12 hand-written blocks with a **deterministic generator** — `buildDemoData(CITY_REGISTRY)` producing seeded pseudo-random sentiment counts and per-source breakdowns from region-keyed source templates. Demo and live data thereby share one registry; expanding to 30 cities (or 50) becomes a registry edit, not a code edit. `normalizeCities()` stays as-is — it is already the correct source/layer adapter seam.
3. **`public/index.html`**: add `<script src="js/config/cities.config.js"></script>` before `data.js`.

### 30-city selection criterion

Take the top ~40 cities by `pop_max` from Natural Earth Populated Places, then curate to 30 with two constraints: (a) **every continent represented** (the demo is a globe — visual coverage matters more than strict population order), and (b) **prefer cities the pipeline's sources actually geotag** (AI-discourse hubs: SF, Seattle, Austin, London, Berlin, Paris, Tel Aviv, Bangalore, Beijing, Shanghai, Seoul, Tokyo, Singapore, Toronto, São Paulo, Lagos, Nairobi, Sydney, …). Record the criterion in a comment at the top of the registry so future additions follow the same rule. Source coordinates from **Natural Earth (public domain — no attribution clause to carry in a self-hosted product)**; GeoNames CC BY 4.0 is the fallback if finer population data is ever needed, at the cost of a visible attribution.

### Explicitly considered and rejected

- **DB `cities` seed table now:** wrong first step — DEMO_DATA exists precisely for the DB-not-seeded case, so the demo path can never depend on the DB; a table would still need a file-of-record to seed from. The registry file *is* that file. Migration path (per "design for migration"): if city metadata grows (timezones, admin regions, per-city source weights), add a `cities` table seeded from this same registry via `npm run seed`, and have `posts.js` prefer the DB with registry fallback. Nothing in the recommended shape blocks this.
- **JSON file instead of UMD JS:** backend `require()` of JSON is trivial, but the no-build frontend would need an async `fetch` before first render, adding ordering complexity to `map.js` init for zero benefit. UMD JS loads synchronously via script tag and requires cleanly in jest/Node — the codebase already standardized on this pattern twice.
- **Shipping a full gazetteer (25k–50k rows) and filtering at runtime:** ~5–8 MB payload to render 30 dots, and city-level-only GDPR granularity means precision beyond the curated hub list adds risk surface, not value.

**Trade-off:** the backend importing from `public/` slightly bends layering convention (server code depending on a client-served file). The alternatives — duplication with a sync test, or a shared `src/config/` file that a build step would have to copy into `public/` — are worse for a no-build project. Mitigate with a header comment declaring the file the canonical registry with two consumers.

**Confidence:** HIGH on the pattern (registry-as-data + declarative join + pruned public gazetteer — unanimous across Grafana, kepler.gl, deck.gl, MapLibre, and D3 practice, all primary-source verified). MEDIUM on simplemaps specifics (site blocks automated fetch; CC BY 4.0 / ~50k figures corroborated by search summaries only — irrelevant to the recommendation since Natural Earth is preferred).

---

## Sources

- Grafana geomap docs: https://grafana.com/docs/grafana/latest/panels-visualizations/visualizations/geomap/ (2026-07-06)
- Grafana gazetteer loader source: https://raw.githubusercontent.com/grafana/grafana/main/public/app/features/geo/gazetteer/gazetteer.ts (2026-07-06)
- Grafana custom-gazetteer forum thread: https://community.grafana.com/t/custom-gazetteer-file/106274 (2026-07-06)
- kepler.gl actions API (`addDataToMap`): https://docs.kepler.gl/docs/api-reference/actions/actions (2026-07-06)
- deck.gl using-layers guide: https://deck.gl/docs/developer-guide/using-layers (2026-07-06)
- MapLibre style spec, sources: https://maplibre.org/maplibre-style-spec/sources/ (2026-07-06)
- Natural Earth populated places: https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-populated-places/ (2026-07-06)
- Natural Earth terms of use: https://www.naturalearthdata.com/about/terms-of-use/ (2026-07-06)
- GeoNames dump readme (cities500/1000/5000/15000, CC BY 4.0): https://download.geonames.org/export/dump/readme.txt (2026-07-06)
- GeoNames export overview: https://www.geonames.org/export/ (2026-07-06)
- simplemaps World Cities: https://simplemaps.com/data/world-cities and https://simplemaps.com/data/license (403 to automated fetch; values via search summaries, 2026-07-06)
- world-atlas TopoJSON (Natural Earth redistribution): https://github.com/topojson/world-atlas (2026-07-06)
- D3 populated-places globe example: https://blog.maptheclouds.com/learning/3d-globe-map-in-d3-js-populated-places-on-earth-%F0%9F%8C%8D (2026-07-06)
