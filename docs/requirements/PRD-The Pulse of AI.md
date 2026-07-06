# The Pulse of AI — Product Requirements Document (PRD)

| | |
|---|---|
| **Document** | Product Requirements Document |
| **Product** | The Pulse of AI — global real-time AI discourse dashboard |
| **Version** | 1.0 |
| **Date** | 2026-07-05 |
| **Status** | Approved baseline, derived from Technical Specification v1.1.0 |
| **Related documents** | `docs/requirements/BRD.md`, `docs/TECHNICAL_SPEC.md` (v1.1.0), `docs/plans/2026-07-05-globe-storytelling-design.md` |

This document specifies WHAT the product must do and for WHOM. HOW it is built — schemas, algorithms, infrastructure — lives in the Technical Specification and is referenced inline by section number, e.g. (spec §9). The business case is in the BRD.

---

## 1. Product Summary

The Pulse of AI aggregates AI-related discourse from the top 50 global online sources across 7 categories (social platforms, news outlets, academic repositories, policy and political organizations, non-profits, developer communities, blogs and newsletters — spec §17), scores it with audited NLP inference (sentiment, AI relevance, discourse quality), and presents it two ways:

1. **A storytelling frontend:** an interactive 3D globe with a scroll-driven narrative of dynamically derived insights, ending in a free-explore mode with filters.
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


### 4.3 Storytelling Frontend (globe.gl — approved design, 2026-07-05)

The frontend is the primary experience for P1 and P2. Source: `docs/plans/2026-07-05-globe-storytelling-design.md`; it is also the execution vehicle for spec §11's scroll-driven narrative.

| ID | Requirement |
|---|---|
| FR-17 | The landing view shall render an interactive 3D globe (dark sphere, map, per-city data bars) that is visible and labeled within 1 second, with markers populating as soon as aggregated data arrives (spec §11 performance budget). |
| FR-18 | **Scroll chapters:** the page shall present a scroll-driven story of 7 chapters (Overview → Volume leaders → Positivity leaders → Negativity hotspots → The divide → Who's driving the conversation → Explore). Each chapter step shall fly the camera to a target view, re-encode the data bars for the chapter's metric, and display an insight card. |
| FR-19 | **Dynamic insights:** insight card content shall be computed client-side from the same aggregated-by-location data the globe renders (global totals, volume/positivity/negativity leaders, sentiment extremes, dominant source categories, regional dominance), interpolated into chapter templates. Insights shall degrade gracefully to fallback copy when data is unavailable. |
| FR-20 | **Free-explore:** the final chapter shall release the globe for direct interaction: auto-rotation with idle resume, hover tooltips with the per-city sentiment/source breakdown, and filter controls for sentiment mode and source-category mode (stacked bars). Scrolling back up shall re-enter the story cleanly. |
| FR-21 | **Filters:** explore-mode filter chips shall recompute the visualized data with animated transitions; source-category coloring shall use a consistent category-to-color assignment across views. |
| FR-22 | **Demo fallback:** when the API is unavailable, the frontend shall render an equivalent experience from bundled demo data, with insights derived identically. |
| FR-23 | **Explainability in the UI:** data points shall link to their audit trail so every rendered claim has a "why?" path (spec §11, persona P1). |
| FR-24 | **Health visibility:** the dashboard shall show a traffic-light status driven by health-endpoint alerts (green/yellow/red) (spec §3, §11). |
| FR-25 | The frontend shall run without a build step, with all libraries self-hosted (no external CDN calls), and shall provide an informative static fallback when WebGL is unavailable (design doc constraints). |



