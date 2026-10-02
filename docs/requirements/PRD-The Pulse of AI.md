# The Pulse of AI — Product Requirements Document (PRD)

| | |
|---|---|
| **Document** | Product Requirements Document |
| **Product** | The Pulse of AI — global real-time AI discourse dashboard |
| **Version** | 1.1 |
| **Date** | 2026-09-29 |
| **Status** | Handoff excerpt of `docs/requirements/PRD.md`, aligned with Technical Specification v1.2.1 |
| **Related documents** | `docs/requirements/PRD.md` (v1.1, the full PRD), `docs/requirements/BRD.md`, `docs/TECHNICAL_SPEC.md` (v1.2.1); superseded: `docs/plans/2026-07-05-globe-storytelling-design.md` |

**v1.1 changes (2026-09-29), aligned to code per independent audit, 2026-09-29:** §1 (52-source registry, 8 categories, Canvas-2D globe); §4.3 FR-17 to FR-25 rewritten to the shipped FuN.zip prototype design (11 beats, Canvas-2D globe, demo labelling, legal notices), identical in substance to PRD.md v1.1 §4.3. Persona numbering in this excerpt differs from PRD.md (here P1 = General Public, P2 = Journalist).

This document specifies WHAT the product must do and for WHOM. HOW it is built — schemas, algorithms, infrastructure — lives in the Technical Specification and is referenced inline by section number, e.g. (spec §9). The business case is in the BRD.

---

## 1. Product Summary

The Pulse of AI aggregates AI-related discourse from the 52-source registry of record across 8 categories (social platforms, news outlets, academic repositories, policy organizations, non-profits, developer communities, forums, blogs and newsletters — spec §17; ADR 0001), collected only through each source's official route, scores it with audited NLP inference (sentiment, AI relevance, discourse quality), and presents it two ways:

1. **A storytelling frontend:** an interactive Canvas-2D globe with an 11-beat scroll-driven narrative of dynamically derived insights, ending in a free-explore mode with filters (§4.3).
2. **A public read API:** health, aggregated sentiment, per-post audit trails, bias assessments, versioned methodology, and a structured query interface for custom slices.

Every score shown anywhere in the product is traceable to the model, version, parameters, and plain-English justification that produced it (spec §10).

## 2. Personas

Personas are taken from the MVP requirements as restated in spec §11.

### P1 — The General Public (secondary)
- **Goal:** understand how the world feels about AI without any technical background.
- **Flow:** the scroll story does the interpretive work — each chapter states one insight in plain language over an animated globe; free-explore afterwards invites self-directed discovery.

### P2 — The Journalist (primary)
- **Goal:** find story angles in under 2 minutes.
- **Entry point:** the globe, loaded immediately on page load with current sentiment.
- **Flow:** scroll through the guided narrative → notice an insight (a hotspot, a divide, a source pattern) → inspect a specific data point → follow its "why?" link to the audit trail → cite model, method, and numbers in a story.
- **Device:** desktop primarily, tablet secondary.

### P3 — The Policy Maker
- **Goal:** monitor for bias incidents and track sentiment over time.
- **Entry point:** the model health indicator (traffic-light status, top of dashboard).
- **Flow:** health status → latest bias assessment → specific violation with its evidence and threshold → remediation follow-up via alert history.

### P4 — The Researcher
- **Goal:** verify methodology, download data, reproduce findings.
- **Entry point:** the methodology API for algorithm documentation.
- **Flow:** API-first. Reads versioned methodology configs and justifications → spot-checks individual posts via the audit endpoint → runs structured queries for custom aggregates → uses monthly rollups for longitudinal analysis beyond the 3-month detail window (spec §19).





## 3. Jobs-to-be-Done and User Stories

| ID | As a… | I want to… | So that… | Source |
|---|---|---|---|---|
| US-1 | Journalist | get a story-ready insight in under 2 minutes of landing on the page | I can pitch or publish on deadline | spec §2, §3, §11 |
| US-2 | Journalist | ask "why does this city score negative?" and get a plain-English answer | my published claim survives scrutiny | spec §10 |
| US-3 | Researcher | read the exact algorithm version, parameters, and justification behind any score | I can reproduce or challenge the finding | spec §7, §10 |
| US-4 | Researcher | query custom slices (date range, source category, sentiment, location) without scraping the UI | I can run my own analysis | spec §7 (`POST /api/query`) |
| US-5 | Researcher | access aggregate trends older than 3 months | longitudinal studies remain possible after detail expiry | spec §19 |
| US-6 | Policy maker | see at a glance whether the system currently has bias violations | I can act on incidents, not anecdotes | spec §9, §11 |
| US-7 | Policy maker | drill from an alert into the metric, threshold, and evidence that triggered it | interventions are grounded in documented method | spec §9 |
| US-8 | General public user | be guided through what the data says, one insight at a time | I understand without knowing what "comparative score" means | design doc; spec §11 |
| US-9 | General public user | freely spin the globe, drill into the map locations to city level, visually see sentiment and source category and topics | I can explore my own questions after the guided story | design doc |
| US-10 | Operator | trigger an on-demand refresh and see job status | demos and breaking-news moments do not wait for the cron cycle | spec §7 (`POST /api/refresh`) |
| US-11 | Regulator (indirect) | confirm that every automated decision has documented provenance and legal basis | compliance review does not require source-code access | spec §8, §10 |


### 4.3 Storytelling Frontend (FuN.zip prototype — the requirement of record, revised 2026-09-29)

The frontend is the primary experience for the general public (P1) and the journalist (P2). **Authority:** Jennifer's direction-of-authority ruling of 2026-09-28, verbatim: "what is in the FuN.zip front end prototype needs to be supported in the backend". The FuN.zip design-handoff prototype is the master contract for this section, and the shipped frontend in `public/` implements it (spec §11). The globe.gl design of `docs/plans/2026-07-05-globe-storytelling-design.md` (3D globe, 7 chapters) is superseded.

| ID | Requirement |
|---|---|
| FR-17 | The landing view shall render an interactive **Canvas-2D orthographic dot globe** (land drawn from the self-hosted world-atlas GeoJSON, per-city sentiment markers) that is visible within 1 second, with city markers populating as soon as the aggregated-by-location snapshot arrives (spec §11 performance budget). |
| FR-18 | **Scroll beats:** the page shall present a scroll-driven story of **11 beats** — the Overview lede plus ten chapters: 01 Volume leaders → 02 The divide → 03 Negativity hotspots → 04 Positivity leaders → 05 Who's driving the conversation → 06 What runs warm → 07 What runs cold → 08 The messengers → 09 The hour in review → 10 Your turn / next steps (free-explore). Each beat shall move the globe to a target view, re-encode the city markers for the beat's colour mode and metric, and display a docked insight card with its stats; a progress rail, a skip pill and a legend accompany the story. Beat definitions live in `public/js/config/story.config.js`. *Revised 2026-09-28 (was 7 chapters) per the ruling above.* |
| FR-19 | **Dynamic insights:** insight card content shall be computed client-side from the loaded data (the city snapshot; `/api/themes` for the warm and cold beats; source and post data for the messengers and summary beats) and interpolated into beat templates; no insight value is hard-coded. Insights shall degrade gracefully to fallback copy when data is unavailable. |
| FR-20 | **Free-explore:** the final beat shall release the globe for direct interaction: drag to rotate, zoom (wheel, pinch, keys), hover tooltips with the per-city sentiment and source breakdown, a city list sorted most-positive to most-negative, a city-detail panel with the city's recent posts, and the source ribbon (hourly volume per category over the last 12 hours). Scrolling back up shall re-enter the story cleanly. |
| FR-21 | **Filters:** explore-mode filter chips (sentiment buckets and source categories) shall recompute the visualised data; source-category colouring shall use one category-to-colour assignment across globe, legend, chips and ribbon (`design.config.js`, the 8-category canon). |
| FR-22 | **Demo labelling and fallback:** demo numbers shall never be presented as live. The page shall derive a data mode from the served data (`live`, `demo`, `mixed`, `none`), and when the API is unavailable render an equivalent experience from a bundled deterministic demo set (`fallback`), with insights derived identically. Every mode that includes demo data shall show the "Demo data" markers, and the overview kicker shall state the mode. Fallback (bundled) posts and receipts shall be synthesised locally and never sent to the audit endpoint; a stored demo-feed post's receipt is served by the audit endpoint and labelled as demo. |
| FR-23 | **Explainability in the UI:** featured and city posts shall link to their audit receipt ("Why does it say that?"), rendered in four audience views (Public, Journalist, Regulator, Researcher), so every rendered claim has a "why?" path (spec §10, §11). |
| FR-24 | **Health visibility:** the header shall show a traffic-light status chip (green / yellow / red) driven by `/api/health` alerts and re-polled on the refresh cadence; it opens a health drawer with sources online, per-source status and the 12-hour alert history (spec §9, §11). |
| FR-25 | The frontend shall run without a build step, with every asset self-hosted (no external CDN calls) under a strict Content-Security-Policy (no inline script or style); shall provide an informative fallback when canvas rendering is unavailable — a ranked city list (name, volume, sentiment) rendered from the same data — plus a static no-JavaScript notice; and shall display the project's **Appropriate Legal Notices** (copyright, the AGPL section 7(b) attribution "Built on Pulse of AI by Jennifer McKinney" linked to the upstream repository, the AGPL-3.0-or-later licence, the additional terms, a source-code link and the no-warranty statement) in a header "about" panel and in the no-JavaScript notice (spec §21). *Legal notices added 2026-09-29 with the AGPL licence.* |
