# Prototype Wiring Audit — FUn.zip vs merged backend/config (origin/master)

Date: 2026-09-28
Auditor: prototype-audit agent
Scope: tasks C1c (page shell), C2 (globe.js), C3 (story.js), C4 (ui.js), C5 (legacy removal), city registry.
Method: FUn.zip extracted to `exported-assets/prototype-globe-artifact/` (gitignored — verified via `git check-ignore`); all merged content read via `git show origin/master:<path>` only. Nothing committed.

---

## 1. Inventory of the extracted artifact

`exported-assets/prototype-globe-artifact/design_handoff_pulse_of_ai/` (all files dated 2026-07-30 16:44 inside the zip):

| File | Bytes | Lines |
|---|---:|---:|
| BRD.md | 14,002 | 134 |
| CLAUDE.md | 3,169 | 40 |
| INTEGRATION.md | 4,452 | 73 |
| PRD.md | 7,763 | 87 |
| README.md | 17,448 | 147 |
| The Pulse of AI.html | 24,992 | 404 |
| app.jsx | 12,123 | 257 |
| data.js | 29,412 | 421 |
| globe.jsx | 17,352 | 411 |
| tweaks-panel.jsx | 24,657 | 541 |
| ui.jsx | 22,554 | 429 |
| **Total** | **~178 KB** | **2,944** |

## 2. Zip vs `~/Downloads/design_handoff_pulse_of_ai/` verdict

**The zip is the SAME bundle already deep-reviewed this session, plus a later revision pass.** It is a strict superset: every Downloads file is present, none removed, and the deltas are small and additive.

| File | Verdict | Delta summary |
|---|---|---|
| BRD.md, PRD.md, README.md, app.jsx, ui.jsx | **identical** | byte-identical |
| The Pulse of AI.html | differs | CSS overflow hardening only: `.chapter-card` gains `min-width:0; box-sizing:border-box`; `.ch-stat`/`.ch-stat-v`/`.ch-stat-k` gain `min-width:0` + ellipsis; `.theme-name`/`.theme-words` flex-shrink + ellipsis + `max-width:45%`; `.intro-kicker` `white-space:nowrap` |
| data.js | differs | CH08 title shortened to "Don't shoot the messenger." (both static and computed paths); explore chapter gains a 6th next-step bullet: "Zoom with + / − keys, pinch, or scroll on the globe — 0 resets" |
| globe.jsx | differs | NEW user-zoom feature: `st.userZoom` multiplier on chapter zoom, `zoomBy()` clamped 0.5–3.5, canvas `wheel` handler (ctrl-wheel always, plain wheel only in explore mode), keyboard `+`/`=`/`-`/`_` zoom and `0` reset, 3 s user-override window; listeners cleaned up on unmount |
| tweaks-panel.jsx | **only in zip** | design-review tweaks shell (541 lines) — marked "prototype-only; do not ship" |
| CLAUDE.md | **only in zip** | integration guidance: keep UI, replace `data.js` seam, `window.PULSE` shape contract, hard rules (4 audience views, FR-21/22/25, regression guards) |
| INTEGRATION.md | **only in zip** | proposed API contract (`/api/snapshot`, `/api/posts?city`, 4-audience `/api/audit`, `/api/bias?window=12h`) — NOTE: this is the prototype author's *wish* contract; the real merged API differs (Section 4) and the merged frontend config (`public/js/config/api.config.js`) already targets the real routes instead |
| .DS_Store | only in Downloads | noise |

Consequence: the earlier deep review remains valid; the NEW material to fold into the build is (a) the CSS overflow fixes, (b) the user-zoom interaction, (c) the CH08 title + 6th next-step copy change, (d) INTEGRATION.md's 4-audience audit expectation.

## 3. Design token comparison — prototype vs `origin/master:public/js/config/design.config.js`

| Token | Prototype (HTML `:root` / app.jsx / README) | Merged design.config.js | Verdict |
|---|---|---|---|
| Theme Midnight | bg #06090F · ink #E8EDF4 · inkDim #93A0B4 · line rgba(140,165,205,0.14) · panelRgb 13,19,30 · accent #3BDCB2 | identical | MATCH |
| Theme Void | #000000 / #EDEDF0 / #8E8E9A / rgba(180,180,200,0.13) / 10,10,13 / #4EA8FF | identical | MATCH |
| Theme Ember | #0C0806 / #F2EAE2 / #A89A8C / rgba(220,180,140,0.14) / 24,16,11 / #FFB454 | identical | MATCH |
| Default theme | Midnight | DEFAULT_THEME 'Midnight' | MATCH |
| `--panel-alpha` | 0.82 (`:root`; tweak `cardOpacity` default 0.82) | **absent** — THEMES carry panelRgb only, no panelAlpha token | **MISMATCH (missing token)** — C1c must hardcode 0.82 in CSS or extend config |
| Sentiment palette (default) | ["#FF6E5E","#7E8AA0","#3BDCB2"] neg/neu/pos | SENTIMENT_PALETTE negative #FF6E5E · neutral #7E8AA0 · positive #3BDCB2 | MATCH |
| Alternate palettes | app.jsx offers 3; README documents 6 | only the default carried | Acceptable (tweaks are do-not-ship) — noted for the record |
| Category colors | Social #FF9F5A · News #5AA9FF · Academic #C08BFF · Policy #FF6E9C · Developer #3BDCB2 · Forums #F5D95A · Blogs #7EE0FF (display-case keys) | CAT_COLORS keyed by API slugs: social/news/academic/policy/developer match hue-for-hue; blog #7EE0FF ← Blogs; tech #F5D95A reuses the Forums yellow; nonprofit #B8E986 is new | MATCH on values; **keys are API slugs, not display names** — UI must title-case slugs and must not expect "Forums" |
| Severity | alert #FF6E5E · watch #F5C36B · pass #3BDC7E (HTML health-light + drawer) | SEVERITY_COLORS identical | MATCH |
| Sentiment buckets | overlapping (bug: `(−0.10,−0.05]` double-classified) | SENTIMENT_BUCKETS positiveMin 0.1 / negativeMax −0.1 — partition, no overlap/gap, explicitly documented as the bug fix | **INTENTIONAL FIX** (prototype bug c) — all consumers must use the config buckets, never the prototype's inline comparisons |
| Spin period | 0.00035 rad/frame ≈ 5 min/rev (README-verified) | GLOBE.spinPeriodMs 300000 | MATCH |
| Pulse ring period | ~2.2 s | GLOBE.ringPeriodMs 2200 | MATCH |
| Idle resume | 3 s (`userUntil + 3000` in globe.jsx) | GLOBE.idleResumeMs 3000 | MATCH |
| Explore label threshold | `volume > 230` (globe.jsx:316) | GLOBE.labelVolumeMin 230 | MATCH |
| Scroll pacing | `VH_PER = 1.15` (app.jsx:20) | GLOBE.pacingVhPerChapter 1.15 | MATCH |
| User zoom (zip-only) | clamp 0.5–3.5, wheel factor exp(−ΔY·0.01 ctrl / 0.002), key step ×1.15, 3 s override, `0` reset | **absent** | **MISMATCH (missing)** — C2 needs these; add to GLOBE in design.config |

## 4. Backend contract — endpoint-by-endpoint

Merged route files (11, via `git show origin/master:src/routes`): audit.js, bias.js, config.js, health.js, methodology.js, posts.js, query.js, refresh.js, sentiment.js, sources.js, themes.js. `sources.js` serves two endpoints (registry + timeseries), giving the 12 endpoints below. Frontend endpoint map: `public/js/config/api.config.js` ENDPOINTS (aggregated, query, audit, health, bias, methodology, timeseries, themes, refresh — **no `sources` registry, no config, no sentiment**).

| # | Prototype need (demo structure → endpoint) | Merged route | Exists | Shape-complete for UI | Gaps (fields the frontend needs that the API doesn't serve) |
|---|---|---|---|---|---|
| 1 | City snapshot `{id,name,country,lat,lon,sentiment,volume,top}` + `catBreakdown` + `sentSplit` → aggregated-by-location | GET `/api/posts/aggregated-by-location` (posts.js) | YES | MOSTLY | Serves per-city pos/neu/neg/total, dominant, last_updated, per-source breakdown (`sources[]` with source_name + source_category + splits → catBreakdown/sentSplit/topSite all derivable; insights.js already does this). Gaps: (a) **no `country` code** — city detail header can't show "GB" etc.; (b) **lat/lng are null for any city not in the 33-entry hardcoded CITY_COORDS**, and `normalizeCities` silently drops null-coord rows → cities vanish from the globe (see gap G26); (c) no continuous −1…1 sentiment — by design, frontend derives net=(pos−neg)/total; (d) window defaults to all-time — caller must pass `from` (trailing hour) or "vol/hr" labels lie |
| 2 | Audit receipt `{postId, inputHash, steps[{stage,model,version,status,score,public,plain,config,researcher,layers}]}` → audit/:postId | GET `/api/audit/:post_id` (audit.js) | YES | **PARTIAL** | Serves post header (content_snippet 120, location, source_category, source_name, collected_at) + decisions (decision_type, model_name, methodology_version, config, justification, output, confidence, created_at, HMAC'd input_hash). Gaps: **no per-audience texts** — one `justification` string vs the prototype's four (public/plain/config/researcher); **no cue-phrase weight list**; **no researcher reproduce command**; **no per-post bias fairness `layers`** (parity/odds values, thresholds, citations) — bias data is job-level only; `input_hash` omitted entirely when AUDIT_HASH_KEY unset; **post_id must be a UUID** → demo-mode ids like `sf-p0` would 400, so demo mode must synthesize receipts locally, never fetch |
| 3 | BIAS_ALERTS `{id,time,severity alert/watch/pass,layer,detail,cite}` 12h history → bias | GET `/api/bias/latest` (bias.js) | YES | **PARTIAL** | Serves latest completed job only: violations + all_assessments `{assessment_type, group_field, group_value, metric_name, metric_value, threshold, is_violation, severity, evidence, created_at}`. Gaps: **no 12h alert history window** (single job snapshot); **no literature citation field**; severity vocabulary must be mapped to alert/watch/pass; no "auto-mitigated" status |
| 4 | Versioned methodology table (health drawer, `GET /api/methodology` framing) | GET `/api/methodology` (methodology.js) | YES | **COMPLETE** | component, version, model_name, config, justification, effective_from — covers the drawer table fully |
| 5 | THEMES `{id,label,words[],sent,split,cat,volume}` warm/cold rows → themes | GET `/api/themes` (themes.js) | YES | MOSTLY | keyword, volume, pos/neu/neg split, top_category (≥3 posts, cap 12). Gaps: **no multi-word cue list** (`words[]`) — the single keyword is the label; no curated display label; empty array when relevance_results absent → warm/cold beats fall back (insights.partitionThemes handles the split) |
| 6 | Source ribbon 12h sparkline series per category → sources/timeseries | GET `/api/sources/timeseries` (sources.js) | YES | MOSTLY | Exactly the 12h series: per-category hourly `{hour,positive,neutral,negative,total}`, zero-filled, oldest→newest, `?hours` clamped 1–48. Gaps: **categories with zero posts in the window are omitted** — marimekko must render from aggregated ribbonRows and tolerate a missing series; **no quoted cue words per category** (ribbon line 2) — omit or backend follow-up; topSite comes from endpoint #1's source breakdown, not here |
| 7 | Health chip + "sources online 48/50" stat → health | GET `/api/health` (health.js) | YES | **PARTIAL** | status, db_connected, last_job (id/status/posts_processed/timestamps), active_alerts (id, alert_type, severity, created_at) → chip color + alert count OK. Gap: **no sources-online count** — closest proxy is GET /api/sources active flags (registry, not liveness), and `sources` is missing from ENDPOINTS |
| 8 | Config (Mapbox token) → config | GET `/api/config` (config.js) | YES | n/a for new UI | Only the legacy map.js consumer uses it; the Canvas globe needs no token. After C5 the route has no frontend consumer (decide: keep or retire server-side) |
| 9 | Manual refresh trigger → refresh | POST `/api/refresh` (refresh.js) | YES | COMPLETE | Returns job_id immediately, collection in background; 1/min/IP in-memory rate limit — compatible with the 150 s poll (api.config REFRESH_MS) |
| 10 | Per-city posts `postsForCity` → query (POST, `{location, limit:3}`) | POST `/api/query` (query.js) | YES | **PARTIAL** | results: id, content_snippet(120), indicator, score, comparative, location, platform(=category), collected_at. Gaps: **no `source_name`** (site line shows category only); **no relevance score** → relevance pill has no data (and per prototype bug d it must not be colored with the sentiment palette anyway); **no cue phrases**; `comparative` is unbounded (sentiment-lib comparative) — clamp/format before display; minutesAgo derivable from collected_at; exact-match city string must equal `raw_posts.location` |
| 11 | (legacy) sentiment summary → sentiment | GET `/api/sentiment/latest` (sentiment.js) | YES | n/a for new UI | Consumed only by legacy main.js; the story frontend derives global stats from endpoint #1. Remove the frontend dependency in C5 (route itself can stay) |
| 12 | Source registry (names, categories, active) → sources | GET `/api/sources` (sources.js) | YES | COMPLETE (unused) | id, name, display_name, source_type, category, active (+`include_inactive`). **Not in api.config ENDPOINTS** — add it if the sources-online stat (#7 gap) is derived from active counts |

INTEGRATION.md's proposed `/api/snapshot` single-payload contract was NOT built; the merged frontend architecture (api.config + data.js normalizeCities + insights.js derivations) correctly re-maps the prototype needs onto the real per-resource routes. No work should target `/api/snapshot`.

## 5. Beat structure — merged story vs prototype chapters

Merged resolver: `public/js/chapters.js` (pure, 343 lines) over `public/js/config/story.config.js` STORY (11 beats) + `public/js/insights.js` (461 lines). Confirmed **11 beats, same order and same content intent** as the prototype's list:

| # | Merged beat id | Prototype chapter | Order/content match |
|---|---|---|---|
| 0 | overview | overview (LIVE) | MATCH |
| 1 | volume | CH01 volume leaders | MATCH (highlightRule volumeTop3, camera follows #1) |
| 2 | divide | CH02 the divide | MATCH (widestDivide, share ≥ 0.08 guard preserved) |
| 3 | negativity | CH03 "negative" | MATCH (id cosmetic; barMetric negativeNet, auditPick 'neg') |
| 4 | positivity | CH04 "positive" | MATCH (auditPick 'pos') |
| 5 | drivers | CH05 who's driving | MATCH (colorMode category, camera {15,10}, alt 2.42 ≡ zoom 1.05) |
| 6 | themes-warm | CH06 | MATCH (colorMode warm, camera {18,80}) |
| 7 | themes-cold | CH07 | MATCH (colorMode cold, camera {45,0}) |
| 8 | messengers | CH08 "sources" | ORDER MATCH; **title drift** — see below |
| 9 | summary | CH09 hour in review | MATCH (summaryTrio highlight; category count derived, not hardcoded "7") |
| 10 | explore | CH10 your turn | MATCH (explore:true, alt 2.26 ≡ zoom 1.15); **nextSteps drift** — see below |

Beat-content mismatches vs the NEWER zip revision:
1. **messengers title**: merged config keeps the old "Don't shoot the messenger — score them."; the zip shortened it to "Don't shoot the messenger." (in both computed and fallback paths). Update story.config or record the older title as intentional.
2. **explore nextSteps**: merged has 5 bullets; the zip adds a 6th — "Zoom with + / − keys, pinch, or scroll on the globe — 0 resets" (pairs with the zip's new zoom feature, gap G7).
3. **"Open Tweaks to change theme, palette, and spin"** bullet exists in both, but tweaks-panel.jsx is prototype-only ("do not ship" per README/INTEGRATION step 6). In production this bullet points at nothing — drop it or ship a minimal theme control in C4.
4. Camera semantics improved vs prototype: highlight-first camera precedence + zoom→altitude mapping documented in story.config — intentional, not a drift.
5. Resolver hardening vs prototype bugs: `resolveChapter` always carries `nextSteps` on the explore beat even when the token builder returns null (prototype bug a is fixed AT THE RESOLVER — consumer guard still required, G13, because non-explore beats carry `nextSteps: null`); fallback copy never promises demo data; isDemo title badge is resolver-level.

## 6. Known prototype bugs carried into the gap list

From this session's design review, with merged-state status:
- (a) fallback next-steps crash (`ec.nextSteps.map` unguarded; fallback explore chapter has no nextSteps) → resolver fixed; **consumer guard still required** (G13).
- (b) fallback audit chapter says Austin but `auditPostFor` defaults to `CITIES[0]` = San Francisco when auditCity missing → merged design keys the receipt to `highlightCities[0]`; **consumer must hide the block when highlights are empty, never default to cities[0]** (G14).
- (c) overlapping sentiment filter buckets for sentiment in (−0.10, −0.05] → **fixed** in design.config SENTIMENT_BUCKETS; all UI filters must use it (G21).
- (d) relevance pill colored with the sentiment palette → carried as UI rule (G21); compounded because /api/query serves no relevance score at all (G21).
- (e) no `prefers-reduced-motion` despite README promising it → C1c CSS + C2 runtime (G5/G10).
- (f) mouse-only canvas interaction → C2 Pointer Events (G8).

## 7. GAP LIST (numbered, ordered by owning task)

### C1c — page shell (index.html + CSS)
- **G1.** Legacy Mapbox shell still shipped: `origin/master:public/index.html` is the old navbar/#map/"Coming Soon" page with Mapbox CSS CDN link. Rebuild as the prototype shell: `:root` tokens, stage/header/card-col/intro/rail/ribbon/drawer CSS — **including the zip-only overflow fixes** (`.chapter-card min-width:0`, `.ch-stat*` ellipsis, `.theme-name/.theme-words` flex+ellipsis+max-width 45%, `.intro-kicker nowrap`).
- **G2.** `--panel-alpha` (0.82) has no source of truth: absent from design.config THEMES. Hardcode in CSS or add a token; `--panel: rgba(var(--panel-rgb), var(--panel-alpha))` must be wired for theme switching.
- **G3.** FR-25 self-hosting: prototype loads Space Grotesk + IBM Plex Mono from Google Fonts and React/Babel/topojson/world-atlas from CDNs. Production shell must self-host fonts and vendor files (`public/vendor/` exists) and uses no React/Babel.
- **G4.** Script order contract: config/*.js → utils.js → data.js → insights.js → chapters.js → globe.js/story.js/ui.js (chapters.js reads window globals; documented in its UMD header).
- **G5.** `prefers-reduced-motion` CSS: disable cue bob, header blink/ring, entrance slides (prototype bug e; README promises it).

### C2 — globe.js
- **G6.** Whole module missing (no globe.js on origin/master). Port the Canvas-2D orthographic renderer per README spec: land raster from self-hosted world-atlas 110m (keep the FeatureCollection guard and Fibonacci fallback), pulse rings (config ringPeriodMs), data bars/three-pillars, land-heat, drag + idle resume (idleResumeMs), labels (labelVolumeMin), DPR cap 2.
- **G7.** Zip-only user-zoom feature not represented anywhere in merged config: userZoom multiplier (clamp 0.5–3.5), ctrl-wheel always / plain wheel in explore, keyboard +/−/0, 3 s user-override. Add constants to design.config GLOBE and implement; pairs with the 6th nextSteps bullet (G15).
- **G8.** Touch/pointer support (prototype bug f): prototype registers mouse events only. Use Pointer Events (drag/hover/tap/pinch) so the globe works on touch devices; pinch-zoom feeds G7.
- **G9.** Camera consumer: apply resolved `{lat,lng,altitude}` + cameraMs from chapters.js (zoom→altitude mapping already documented in story.config).
- **G10.** Reduced-motion runtime: no auto-spin, no pulse rings when `prefers-reduced-motion` (README accessibility section).
- **G11.** Color modes keyed by API slugs: CAT_COLORS keys are lowercase slugs (incl. nonprofit/tech); renderer must tolerate an unknown slug with a fallback color, and sentiment lerp must use net-from-counts, not a raw sentiment field.

### C3 — story.js
- **G12.** Whole module missing. Scroll→progress with the NaN guard (`max > 0 ? … : 0`), pacing from GLOBE.pacingVhPerChapter, progress rail, skip pill, card transition math per README.
- **G13.** (bug a) Guard nextSteps: render the checklist only when `Array.isArray(ec.nextSteps) && ec.nextSteps.length` — resolver returns `null` for all non-explore beats by design.
- **G14.** (bug b) Embedded receipt city: use `resolved.highlightCities[0]` for auditPick beats; when highlights are empty (sparse-data fallback) hide the featured-post block entirely — never default to the first city in the list.
- **G15.** Beat copy sync decision: adopt or reject the zip's CH08 title ("Don't shoot the messenger.") and the 6th zoom next-step bullet; drop or re-point the "Open Tweaks" bullet (tweaks panel does not ship — G25).
- **G16.** Data loading semantics: fetch aggregated with `from` = trailing hour so "posts/hr" and "vol/hr" labels are honest (route defaults to all-time); poll at REFRESH_MS (150 s); demo fallback (normalizeCities(DEMO_DATA)) sets isDemo and **must not fetch `/api/audit/` for demo post ids** (route 400s on non-UUID) — synthesize demo receipts locally.

### C4 — ui.js
- **G17.** Four-audience audit views cannot be fully populated from `/api/audit/:post_id`: the API serves one `justification` + `config` + model/version/output/confidence per decision. Map Public and Journalist → justification, Regulator → config key/value table, Researcher → output + confidence + HMAC input fingerprint; handle the input_hash-omitted case (AUDIT_HASH_KEY unset). **Backend follow-up** if true per-audience texts, cue-phrase weights, and a reproduce command are required (they are the PRD differentiator).
- **G18.** Per-post bias fairness layers (parity/odds values, thresholds τ, citations, PASS/FAIL/N-A) are not served by the audit endpoint — bias data is job-level. Render the Bias step from the methodology `bias` component + a link into the health drawer, or extend the backend to log per-post assessments.
- **G19.** Health/bias drawer: `/api/bias/latest` is a single-job snapshot, not "ALERT HISTORY · LAST 12H"; there is no citation field and severity vocabulary needs mapping to alert/watch/pass. Client-side citation lookup by assessment_type, or backend follow-up for a windowed history endpoint.
- **G20.** "Sources online 48/50" (overview stat + header health area): not served by `/api/health`. Derive active/total from GET `/api/sources` — which first requires **adding `sources` to api.config ENDPOINTS** — and label honestly (registry-active, not liveness).
- **G21.** City detail + posts: POST `/api/query` lacks source_name (show category-derived site line only), lacks relevance (drop the relevance pill or extend the route; per bug d it must never use the sentiment palette), `comparative` needs clamping/formatting; sentiment pill/filters must use SENTIMENT_BUCKETS (bug c fix) everywhere; minutesAgo derived from collected_at.
- **G22.** Country code is not in any API response: drop it from the city-detail header or carry it in a frontend/backend city registry (see G26).
- **G23.** Ribbon: timeseries omits zero-post categories — build marimekko segments from insights.ribbonRows (aggregated snapshot) and attach series where available; quoted cue-words line has no data source (omit or backend follow-up); keep the inline "← 12h" axis label rule (regression guard).
- **G24.** Accessibility: buttons-not-divs, aria-labels, list-based equivalents for canvas interactions, numeric score always adjacent to sentiment color (FR/README guardrails).

### C5 — legacy removal
- **G25.** Remove: legacy `public/index.html` markup + Mapbox CSS link, `public/js/map.js` (Mapbox globe; DEMO_DATA already migrated to public/js/data.js), `public/js/main.js` (health + refresh consumer of `/api/sentiment/latest` + `/api/config`), legacy `public/styles/main.css` rules. Root `js/`/`styles/` are gitignored scratch — not shipped, nothing to do. Decide whether `/api/config` and `/api/sentiment/latest` routes stay (server-side keep is harmless; no frontend consumer remains). Tweaks panel is never ported (INTEGRATION step 6).

### City registry
- **G26.** `src/routes/posts.js` CITY_COORDS (33 hardcoded cities) is missing 6 of the prototype's 30 launch cities: **Mexico City, Brussels, Warsaw, Cape Town, Dubai, Melbourne**. Cities absent from the registry get `lat/lng: null` and `normalizeCities` then **silently drops them from the globe**. Extend CITY_COORDS (or promote to a registry table per the route's Phase E note) and add country codes there to close G22; add a test that every seeded source location resolves to coordinates.

## 8. Evidence pointers

- Extraction: `exported-assets/prototype-globe-artifact/design_handoff_pulse_of_ai/` (gitignored via `.gitignore:32 exported-assets/`)
- Downloads bundle: `~/Downloads/design_handoff_pulse_of_ai/`
- Merged files read via `git show origin/master:` — `public/js/config/{design,api,story}.config.js`, `public/js/{chapters,insights,data}.js`, `public/index.html`, `src/routes/{posts,audit,bias,methodology,themes,sources,health,config,sentiment,refresh,query}.js`
