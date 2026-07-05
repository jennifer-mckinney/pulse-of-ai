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

### P1 — The Journalist (primary)
- **Goal:** find story angles in under 2 minutes.
- **Entry point:** the globe, loaded immediately on page load with current sentiment.
- **Flow:** scroll through the guided narrative → notice an insight (a hotspot, a divide, a source pattern) → inspect a specific data point → follow its "why?" link to the audit trail → cite model, method, and numbers in a story.
- **Device:** desktop primarily, tablet secondary.

### P2 — The Researcher
- **Goal:** verify methodology, download data, reproduce findings.
- **Entry point:** the methodology API for algorithm documentation.
- **Flow:** API-first. Reads versioned methodology configs and justifications → spot-checks individual posts via the audit endpoint → runs structured queries for custom aggregates → uses monthly rollups for longitudinal analysis beyond the 3-month detail window (spec §19).

### P3 — The Policy Maker
- **Goal:** monitor for bias incidents and track sentiment over time.
- **Entry point:** the model health indicator (traffic-light status, top of dashboard).
- **Flow:** health status → latest bias assessment → specific violation with its evidence and threshold → remediation follow-up via alert history.

### P4 — The General Public (secondary)
- **Goal:** understand how the world feels about AI without any technical background.
- **Flow:** the scroll story does the interpretive work — each chapter states one insight in plain language over an animated globe; free-explore afterwards invites self-directed discovery.

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
| US-9 | General public user | freely spin the globe and filter by sentiment or source category | I can explore my own questions after the guided story | design doc |
| US-10 | Operator | trigger an on-demand refresh and see job status | demos and breaking-news moments do not wait for the cron cycle | spec §7 (`POST /api/refresh`) |
| US-11 | Regulator (indirect) | confirm that every automated decision has documented provenance and legal basis | compliance review does not require source-code access | spec §8, §10 |

## 4. Functional Requirements

Requirement IDs (FR-x) are referenced by the traceability table in Section 8.

### 4.1 Data Collection and Processing

| ID | Requirement |
|---|---|
| FR-1 | The system shall collect AI-related posts from 50 registered sources across 7 categories on a staggered schedule achieving a 2–3 minute effective refresh window (spec §13 Phase C, §17). |
| FR-2 | The system shall strip all PII (usernames, handles, author fields) at ingest, deduplicate by content hash, store raw posts immutably, and log each collection action with its legal basis (spec §8). |
| FR-3 | The system shall score every ingested post for sentiment, AI relevance, and (Phase 2) discourse quality, writing every inference to an immutable audit log linked to a versioned methodology (spec §10, §18). |
| FR-4 | The system shall run the three-layer bias detection stack (demographic parity, equalized odds, counterfactual fairness sampling) at the end of every processing job and raise alert events on threshold violations (spec §9). |
| FR-5 | The system shall compact post-level detail older than 3 months into permanent monthly topic and source rollups, nulling content and deleting embeddings while preserving the audit skeleton (spec §19). |

### 4.2 API Surface

The public API is the product for P2 and the data layer for the frontend. All endpoints exist today except where marked. Full request/response contracts: spec §7.

| ID | Endpoint | Requirement |
|---|---|---|
| FR-6 | `GET /api/health` | Report system status, last job summary, and active unresolved alerts; degrade gracefully (503) when the database is unreachable. |
| FR-7 | `GET /api/posts/aggregated-by-location` | Return per-city sentiment breakdowns (positive/neutral/negative counts, dominant indicator, coordinates) with optional platform and date filters; this feeds the globe. |
| FR-8 | `GET /api/sentiment/latest` | Return an aggregate summary plus recent scored posts for the dashboard refresh panel. |
| FR-9 | `POST /api/refresh` | Trigger an on-demand collection and processing run; rate limited to 1 request/minute/IP. |
| FR-10 | `GET /api/audit/:post_id` | Return the complete decision trail for any post: each decision's type, model, methodology version, plain-English justification, full output, and confidence. This is the explainability endpoint (spec §10). |
| FR-11 | `GET /api/bias/latest` | Return the most recent bias assessment: overall status, violations with metric/threshold/evidence, and all computed metrics. |
| FR-12 | `GET /api/methodology` | Return all versioned methodology configurations with justifications, ordered by component and effective date. |
| FR-13 | `GET /api/sources` | Return all registered data sources with category, active status, and last collection info. |
| FR-14 | `POST /api/query` | Accept structured filters (source categories, dates, sentiment, locations, minimum relevance) with grouping; return aggregates; rate limited to 10 requests/minute/IP; annotate results drawn from rollups rather than detail data (spec §19). |
| FR-15 | `GET /api/config` | Serve non-secret frontend configuration (retained; covered by tests). |
| FR-16 | Error handling: all endpoints validate inputs (UUID, ISO dates, clamped limits, allowlisted enums) and never leak stack traces, SQL errors, or file paths (spec §8). |

### 4.3 Storytelling Frontend (globe.gl — approved design, 2026-07-05)

The frontend is the primary experience for P1 and P4. Source: `docs/plans/2026-07-05-globe-storytelling-design.md`; it is also the execution vehicle for spec §11's scroll-driven narrative.

| ID | Requirement |
|---|---|
| FR-17 | The landing view shall render an interactive 3D globe (dark sphere, glowing per-city data bars) that is visible and labeled within 1 second, with markers populating as soon as aggregated data arrives (spec §11 performance budget). |
| FR-18 | **Scroll chapters:** the page shall present a scroll-driven story of 7 chapters (Overview → Volume leaders → Positivity leaders → Negativity hotspots → The divide → Who's driving the conversation → Explore). Each chapter step shall fly the camera to a target view, re-encode the data bars for the chapter's metric, and display an insight card. |
| FR-19 | **Dynamic insights:** insight card content shall be computed client-side from the same aggregated-by-location data the globe renders (global totals, volume/positivity/negativity leaders, sentiment extremes, dominant source categories, regional dominance), interpolated into chapter templates. Insights shall degrade gracefully to fallback copy when data is unavailable. |
| FR-20 | **Free-explore:** the final chapter shall release the globe for direct interaction: auto-rotation with idle resume, hover tooltips with the per-city sentiment/source breakdown, and filter controls for sentiment mode and source-category mode (stacked bars). Scrolling back up shall re-enter the story cleanly. |
| FR-21 | **Filters:** explore-mode filter chips shall recompute the visualized data with animated transitions; source-category coloring shall use a consistent category-to-color assignment across views. |
| FR-22 | **Demo fallback:** when the API is unavailable, the frontend shall render an equivalent experience from bundled demo data, with insights derived identically. |
| FR-23 | **Explainability in the UI:** data points shall link to their audit trail so every rendered claim has a "why?" path (spec §11, persona P1). |
| FR-24 | **Health visibility:** the dashboard shall show a traffic-light status driven by health-endpoint alerts (green/yellow/red) (spec §3, §11). |
| FR-25 | The frontend shall run without a build step, with all libraries self-hosted (no external CDN calls), and shall provide an informative static fallback when WebGL is unavailable (design doc constraints). |

### 4.4 Governance and Privacy Features

| ID | Requirement |
|---|---|
| FR-26 | Every algorithm change shall be registered as a new methodology version — with model name, config, and plain-English justification — before it produces any decision (spec §10). |
| FR-27 | The audit chain shall be navigable from any post ID to its decisions, methodology versions, parameters, and justification, serving journalist, regulator, internal-audit, and researcher question patterns (spec §10). |
| FR-28 | Cross-platform correlation (Phase 2) shall assign only pseudonymous verb-noun IDs at correlation confidence ≥ 0.85, store only hashed non-reversible signals, and require a completed DPIA before shipping (spec §20). |
| FR-29 | Historical queries spanning the compaction boundary shall disclose which portion of results comes from rollups versus post-level detail (spec §19). |

## 5. Non-Functional Requirements

| ID | Category | Requirement | Source |
|---|---|---|---|
| NFR-1 | Performance | Page load under 3 seconds (Lighthouse); globe visible within 1 second | spec §11, §14 |
| NFR-2 | Performance | Location-aggregation query under 500 ms | spec §14 |
| NFR-3 | Freshness | Data refresh interval 2–3 minutes across all 50 sources | spec §14, §17 |
| NFR-4 | Availability | 99% system uptime | spec §2, §14 |
| NFR-5 | Accuracy | 99% inference accuracy target for all components (sentiment, relevance, demographic inference, cross-platform correlation), validated on labeled benchmarks; the Phase 1 lexicon model is explicitly an audit-pattern foundation that will not meet this bar — the Phase 2 transformer upgrade is the accuracy vehicle | spec §14 |
| NFR-6 | Accuracy governance | Sentiment benchmark re-run monthly on a hand-labeled 500-post set; relevance precision verified by monthly manual review of 200 random posts | spec §14 |
| NFR-7 | Quality | Test coverage ≥ 80% enforced as a commit gate; all tests pass before any commit; TDD (test-first) for every component | spec §13, §14 |
| NFR-8 | Ethics gates | Before release: every threshold documented with justification; every processed post has an audit row; no PII detectable in stored content; bias assessment populated after every job | spec §14 |
| NFR-9 | Accessibility | WCAG 2.1 AA: colorblind-safe palettes, color never the sole indicator, contrast ratio ≥ 4.5:1, keyboard navigation, aria-labels on markers, screen-reader-compatible structure | spec §11 |
| NFR-10 | Security | Secrets only in environment configuration; parameterized queries only; input validation on all routes; no information leakage in errors; dynamic DOM built without HTML injection | spec §8; design doc |
| NFR-11 | Privacy | No usernames, user IDs, emails, IPs, profile data, or sub-city location ever stored; GDPR lifecycle logging with legal basis on every data action | spec §8 |
| NFR-12 | Scalability of ops | Correlation batch latency under 30 seconds per batch; retention compaction bounds storage growth | spec §14, §19 |

## 6. Acceptance Criteria by Major Feature

### 6.1 Real-time monitoring (FR-1..FR-3)
- A processing run collects from active sources, and newly ingested posts appear in `GET /api/sentiment/latest` within one refresh cycle (2–3 min).
- Every processed post has at least sentiment and relevance decisions in its audit trail.
- Ingesting the same content twice creates no duplicate post (hash deduplication).
- A sample of stored content contains no @-mentions, usernames, or email patterns (spec §14 ethical gates).

### 6.2 Explainability (FR-10, FR-26, FR-27)
- For any valid post ID, the audit endpoint returns the post snippet plus every decision with model name, methodology version, justification text, full output, and timestamp.
- Invalid UUIDs return 400; unknown posts return 404; no internal details leak.
- Changing an algorithm parameter without registering a new methodology version is impossible by process: decisions always reference the version row active at execution time.

### 6.3 Bias monitoring (FR-4, FR-11, FR-24)
- After every processing job, bias assessments exist for location concentration, platform parity, and demographic parity metrics.
- Crossing a documented threshold (e.g., one location exceeding 60% of posts) creates a violation record and an alert event, surfaces in `GET /api/health` active alerts, and flips the dashboard status dot to yellow (warning) or red (critical).
- Each violation exposes metric value, threshold, severity, and supporting evidence.

### 6.4 Globe storytelling (FR-17..FR-23)
- On load, the globe renders within 1 second and city bars appear once data arrives; total page load under 3 seconds.
- Scrolling advances through all 7 chapters: each step moves the camera, re-encodes bars, and shows an insight card whose numbers are derived from the currently loaded data (no hardcoded insight values); no residual template tokens appear in any card.
- **The 2-minute journalist test:** starting from a cold page load, a user can reach a concrete, sourced insight (e.g., most-negative city with its share) via the scroll story within 2 minutes without any interaction other than scrolling.
- The final chapter releases the globe: drag/rotate works, hover shows a tooltip with the city's breakdown, filter chips re-encode the bars with animation, auto-rotate resumes after idle; scrolling back up restores the story state.
- With the API stopped, the same walkthrough succeeds on demo data with fallback-aware copy.
- Console remains error-free through a full desktop and 375px-mobile walkthrough; on mobile, insight cards do not fully obscure the globe.

### 6.5 Researcher query (FR-12, FR-14, FR-29)
- `GET /api/methodology` lists every component's versions in effective-date order, each with a non-empty justification.
- `POST /api/query` with valid filters returns grouped aggregates and echoes the applied filters; invalid filter values return 400; the 11th request within a minute returns 429.
- A query whose date range predates the detail window returns results annotated as rollup-derived.

### 6.6 Compliance and retention (FR-2, FR-5, FR-28)
- Every collected post has a retention-log entry citing its legal basis.
- After a compaction run, affected posts have nulled content and no embeddings, while their audit rows, rollup aggregates, and methodology references remain intact and the compaction is itself logged.
- Cross-platform correlation does not ship until the privacy audit checklist (no identity stored, salt never logged, signals non-reversible, DPIA completed) passes in full (spec §20).

## 7. Phase Roadmap

Status reflects the repository on branch `feature/globe-storytelling` as of 2026-07-05.

| Phase | Content | Status |
|---|---|---|
| **Phase 1 (A–D): Foundation** | Infrastructure (Docker, migrations 001–006, seed, test harness); TDD pipeline (sentiment, relevance, discourse, ingest, bias, correlation modules); full API route surface (health, posts, sentiment, refresh, audit, bias, methodology, sources, query, config); embeddings service and vector storage (spec §13) | **Done** — all migrations, pipeline modules, and routes exist with the 80% coverage gate in force |
| **Phase E: Storytelling frontend** | globe.gl migration replacing the Mapbox map: scroll-driven 7-chapter narrative, client-side insight derivation, free-explore with filters, custom tooltips and chapter-aware legend, WCAG-conscious dark theme (design doc; spec §11, §13 Phase E) | **In flight** — approved design committed; utility extraction started; vendor, story, and globe modules in progress |
| **Phase 2: Accuracy and depth** (spec §16) | Transformer sentiment upgrade to the 99% target; demographic inference (99% target); topic clustering; similar-post retrieval endpoint; full DQI discourse scoring; full cross-platform correlation; automated monthly compaction; D3 demographics/topics/discourse charts | Planned — prerequisites: Phase 1 baselines, labeled benchmark sets, 3+ months of data for compaction |
| **Phase 3: Reach and hardening** (spec §16) | Topic relationship graph; semantic free-text search; TV/kiosk display mode; full counterfactual fairness; differential privacy on aggregates | Planned — prerequisites: Phase 2 topic and model upgrades, regulatory assessment for differential privacy |

## 8. Traceability: PRD Requirements → Technical Specification

| PRD requirement | Technical Specification section |
|---|---|
| FR-1 (50-source collection, 2–3 min refresh) | §13 Phase C, §17 |
| FR-2 (PII stripping, immutable ingest, retention log) | §8 |
| FR-3 (audited inference pipeline) | §10, §18 |
| FR-4 (three-layer bias stack, alerts) | §9 |
| FR-5 (layered retention, compaction) | §19 |
| FR-6..FR-16 (API surface and validation) | §7, §8 |
| FR-17 (globe load priority) | §11 |
| FR-18..FR-22 (scroll chapters, insights, explore, filters, demo fallback) | §11, §13 Phase E; design doc `docs/plans/2026-07-05-globe-storytelling-design.md` |
| FR-23 ("why?" links to audit) | §10, §11 |
| FR-24 (traffic-light health) | §3, §9, §11 |
| FR-25 (no build step, self-hosted vendor libs, WebGL fallback) | design doc constraints; §5 |
| FR-26, FR-27 (methodology versioning, explainability chain) | §6, §10 |
| FR-28 (pseudonymous correlation, DPIA) | §20 |
| FR-29 (rollup disclosure in queries) | §19 |
| NFR-1, NFR-2 (load and query performance) | §11, §14 |
| NFR-3, NFR-4 (freshness, uptime) | §14, §17 |
| NFR-5, NFR-6 (99% accuracy targets and validation cadence) | §14 |
| NFR-7 (TDD, 80% coverage gate) | §13, §14 |
| NFR-8 (ethical quality gates) | §14 |
| NFR-9 (WCAG 2.1 AA) | §11 |
| NFR-10 (security controls) | §8 |
| NFR-11 (privacy guarantees) | §8, §17, §20 |
| NFR-12 (correlation latency, storage bounds) | §14, §19 |

## 9. Out of Scope (product level)

- Any storage or display of personal identity (see BRD §6.2 and spec §8 for the full exclusion list)
- Content moderation or platform intervention
- Editorializing on the discourse being measured
- External push notifications (alerts are surfaced via dashboard and API only in current phases)

## 10. Open Product Questions

Carried from spec §16 (must be resolved before the affected work begins):

1. **Location inference** for platforms without location metadata — recommended GDPR-safe combination is community-geography mapping plus content NLP.
2. **Commercial platform API cost** (~$100/month) — include in the initial 50 sources or substitute free federated platforms.
3. **Academic API rate limits** — whether the free tier of the citation-graph source suffices for the polling cadence.
4. **Correlation cold start** — single-platform authors receive no pseudonymous ID and are counted as unlinked (resolved position, restated for visibility).
