# The Pulse of AI — Product Requirements Document (PRD)

| | |
|---|---|
| **Document** | Product Requirements Document |
| **Product** | The Pulse of AI — global real-time AI discourse dashboard |
| **Version** | 1.1 |
| **Date** | 2026-09-29 |
| **Status** | Approved baseline, aligned with Technical Specification v1.2.0 |
| **Related documents** | `docs/requirements/BRD.md`, `docs/TECHNICAL_SPEC.md` (v1.2.0), `docs/adr/0001-source-registry-and-collection.md`; superseded: `docs/plans/2026-07-05-globe-storytelling-design.md` |

**v1.1 changes (2026-09-29), aligned to code per independent audit, 2026-09-29:** §1 (52-source registry, 8 categories, Canvas-2D globe); FR-1, FR-2, FR-4, FR-5, FR-6, FR-9, FR-14, FR-15, FR-28 (implementation status noted; unbuilt parts marked PLANNED); §4.3 FR-17 to FR-25 rewritten to the shipped FuN.zip prototype design (11 beats, Canvas-2D globe, demo labelling, legal notices), per Jennifer's ruling of 2026-09-28; §6.3 to §6.6 acceptance criteria; §7 roadmap status; §8 traceability; NFR-3; §10 question 2. Requirements not yet built stay as requirements and are marked **PLANNED — not implemented as of spec v1.2.0**.

This document specifies WHAT the product must do and for WHOM. HOW it is built — schemas, algorithms, infrastructure — lives in the Technical Specification and is referenced inline by section number, e.g. (spec §9). The business case is in the BRD.

---

## 1. Product Summary

The Pulse of AI aggregates AI-related discourse from the 52-source registry of record across 8 categories (social platforms, news outlets, academic repositories, policy organizations, non-profits, developer communities, forums, blogs and newsletters — spec §17; ADR 0001), collected only through each source's official route, scores it with audited NLP inference (sentiment, AI relevance, discourse quality), and presents it two ways:

1. **A storytelling frontend:** an interactive Canvas-2D globe with an 11-beat scroll-driven narrative of dynamically derived insights, ending in a free-explore mode with filters (§4.3).
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
| FR-1 | The system shall collect AI-related posts from the 52 registry sources across 8 categories, each only through its official route and only while its gate is open, on a staggered schedule achieving a 2–3 minute effective refresh window (spec §13 Phase C, §17; ADR 0001). |
| FR-2 | The system shall strip all PII (usernames, handles, author fields) at ingest, deduplicate, store raw posts immutably, and log each collection action with its legal basis (spec §8). *Status: identity fields dropped and identities redacted in text (`ingest@1.5.0`); deduplication is per source and upstream id; the per-post `collected` retention-log row is PLANNED — not implemented as of spec v1.2.0 (the legal basis is registered per ingest version).* |
| FR-3 | The system shall score every ingested post for sentiment, AI relevance, and (Phase 2) discourse quality, writing every inference to an immutable audit log linked to a versioned methodology (spec §10, §18). |
| FR-4 | The system shall run the three-layer bias detection stack (demographic parity, equalized odds, counterfactual fairness sampling) at the end of every processing job and raise alert events on threshold violations (spec §9). *Status: three aggregate checks run (location concentration > 0.35, critical > 0.80; platform sentiment parity > 0.30; negative dominance > 0.60), once per collection cycle or per refresh / standup job; equalized odds, counterfactual fairness and demographic parity over user demographics are PLANNED — not implemented as of spec v1.2.0.* |
| FR-5 | The system shall compact post-level detail older than 3 months into permanent monthly topic and source rollups, nulling content and deleting embeddings while preserving the audit skeleton (spec §19). *Status: `npm run compact` runs by hand (scheduling is in flight); on months with real posts it currently rolls back (known defect, fix pending, spec §19).* |

### 4.2 API Surface

The public API is the product for P2 and the data layer for the frontend. All endpoints exist on `master` except where marked. Full request/response contracts: spec §7, which also documents three endpoints the page uses that this table does not list: `GET /api/bias/history`, `GET /api/sources/timeseries` and `GET /api/themes`.

| ID | Endpoint | Requirement |
|---|---|---|
| FR-6 | `GET /api/health` | Report system status, last job summary, and active unresolved alerts; degrade gracefully when the database is unreachable. *Status: reports `degraded` with `db_connected: false`, or 500 when a query fails; no 503 (spec §7).* |
| FR-7 | `GET /api/posts/aggregated-by-location` | Return per-city sentiment breakdowns (positive/neutral/negative counts, dominant indicator, coordinates) with optional platform and date filters; this feeds the globe. |
| FR-8 | `GET /api/sentiment/latest` | Return an aggregate summary plus recent scored posts for the dashboard refresh panel. |
| FR-9 | `POST /api/refresh` | Trigger an on-demand collection and processing run; rate limited to 1 accepted refresh per minute (global, not per IP), one refresh in flight, same-origin only, token required beyond loopback. |
| FR-10 | `GET /api/audit/:post_id` | Return the complete decision trail for any post: each decision's type, model, methodology version, plain-English justification, full output, and confidence. This is the explainability endpoint (spec §10). |
| FR-11 | `GET /api/bias/latest` | Return the most recent bias assessment: overall status, violations with metric/threshold/evidence, and all computed metrics. |
| FR-12 | `GET /api/methodology` | Return all versioned methodology configurations with justifications, ordered by component and effective date. |
| FR-13 | `GET /api/sources` | Return all registered data sources with category, active status, and last collection info. |
| FR-14 | `POST /api/query` | Accept structured filters (source categories, dates, sentiment, locations, minimum relevance) with grouping; return aggregates; rate limited to 10 requests/minute/IP; annotate results drawn from rollups rather than detail data (spec §19). *Status: the shipped query takes flat `platform`, `location`, `from`, `to`, `limit` and returns scored posts with a total; grouping, the rate limit and the rollup note are PLANNED — not implemented as of spec v1.2.0.* |
| FR-15 | `GET /api/config` | Serve non-secret frontend configuration. *Status: retired — removed with the Mapbox map; not mounted on `master`. The frontend reads its configuration from self-hosted `public/js/config/*.js`.* |
| FR-16 | Error handling: all endpoints validate inputs (UUID, ISO dates, clamped limits, allowlisted enums) and never leak stack traces, SQL errors, or file paths (spec §8). |

### 4.3 Storytelling Frontend (FuN.zip prototype — the requirement of record, revised 2026-09-29)

The frontend is the primary experience for the journalist (P1) and the general public (P4). **Authority:** Jennifer's direction-of-authority ruling of 2026-09-28, verbatim: "what is in the FuN.zip front end prototype needs to be supported in the backend". The FuN.zip design-handoff prototype is the master contract for this section, and the shipped frontend in `public/` implements it (spec §11). The globe.gl design of `docs/plans/2026-07-05-globe-storytelling-design.md` (3D globe, 7 chapters) is superseded.

| ID | Requirement |
|---|---|
| FR-17 | The landing view shall render an interactive **Canvas-2D orthographic dot globe** (land drawn from the self-hosted world-atlas GeoJSON, per-city sentiment markers) that is visible within 1 second, with city markers populating as soon as the aggregated-by-location snapshot arrives (spec §11 performance budget). |
| FR-18 | **Scroll beats:** the page shall present a scroll-driven story of **11 beats** — the Overview lede plus ten chapters: 01 Volume leaders → 02 The divide → 03 Negativity hotspots → 04 Positivity leaders → 05 Who's driving the conversation → 06 What runs warm → 07 What runs cold → 08 The messengers → 09 The hour in review → 10 Your turn / next steps (free-explore). Each beat shall move the globe to a target view, re-encode the city markers for the beat's colour mode and metric, and display a docked insight card with its stats; a progress rail, a skip pill and a legend accompany the story. Beat definitions live in `public/js/config/story.config.js`. *Revised 2026-09-28 (was 7 chapters) per the ruling above.* |
| FR-19 | **Dynamic insights:** insight card content shall be computed client-side from the loaded data (the city snapshot; `/api/themes` for the warm and cold beats; source and post data for the messengers and summary beats) and interpolated into beat templates; no insight value is hard-coded. Insights shall degrade gracefully to fallback copy when data is unavailable. |
| FR-20 | **Free-explore:** the final beat shall release the globe for direct interaction: drag to rotate, zoom (wheel, pinch, keys), hover tooltips with the per-city sentiment and source breakdown, a city list sorted most-positive to most-negative, a city-detail panel with the city's recent posts, and the source ribbon (hourly volume per category over the last 12 hours). Scrolling back up shall re-enter the story cleanly. |
| FR-21 | **Filters:** explore-mode filter chips (sentiment buckets and source categories) shall recompute the visualised data; source-category colouring shall use one category-to-colour assignment across globe, legend, chips and ribbon (`design.config.js`, the 8-category canon). |
| FR-22 | **Demo labelling and fallback:** demo numbers shall never be presented as live. The page shall derive a data mode from the served data (`live`, `demo`, `mixed`, `none`), and when the API is unavailable render an equivalent experience from a bundled deterministic demo set (`fallback`), with insights derived identically. Every mode that includes demo data shall show the "Demo data" markers, and the overview kicker shall state the mode. Demo posts and receipts shall be synthesised locally, never sent to the audit endpoint as if live. |
| FR-23 | **Explainability in the UI:** featured and city posts shall link to their audit receipt ("Why does it say that?"), rendered in four audience views (Public, Journalist, Regulator, Researcher), so every rendered claim has a "why?" path (spec §10, §11). |
| FR-24 | **Health visibility:** the header shall show a traffic-light status chip (green / yellow / red) driven by `/api/health` alerts and re-polled on the refresh cadence; it opens a health drawer with sources online, per-source status and the 12-hour alert history (spec §9, §11). |
| FR-25 | The frontend shall run without a build step, with every asset self-hosted (no external CDN calls) under a strict Content-Security-Policy (no inline script or style); shall provide an informative fallback when canvas rendering is unavailable — a ranked city list (name, volume, sentiment) rendered from the same data — plus a static no-JavaScript notice; and shall display the project's **Appropriate Legal Notices** (copyright, the AGPL section 7(b) attribution "Built on Pulse of AI by Jennifer McKinney" linked to the upstream repository, the AGPL-3.0-or-later licence, the additional terms, a source-code link and the no-warranty statement) in a header "about" panel and in the no-JavaScript notice (spec §21). *Legal notices added 2026-09-29 with the AGPL licence.* |

### 4.4 Governance and Privacy Features

| ID | Requirement |
|---|---|
| FR-26 | Every algorithm change shall be registered as a new methodology version — with model name, config, and plain-English justification — before it produces any decision (spec §10). |
| FR-27 | The audit chain shall be navigable from any post ID to its decisions, methodology versions, parameters, and justification, serving journalist, regulator, internal-audit, and researcher question patterns (spec §10). |
| FR-28 | Cross-platform correlation (Phase 2) shall assign only pseudonymous IDs at correlation confidence ≥ 0.85, store only hashed non-reversible signals, and require a completed DPIA before shipping (spec §20). *Status: IDs are adjective-animal (the verb-noun format is superseded); correlation is reserved — nothing enqueues it (pending).* |
| FR-29 | Historical queries spanning the compaction boundary shall disclose which portion of results comes from rollups versus post-level detail (spec §19). |

## 5. Non-Functional Requirements

| ID | Category | Requirement | Source |
|---|---|---|---|
| NFR-1 | Performance | Page load under 3 seconds (Lighthouse); globe visible within 1 second | spec §11, §14 |
| NFR-2 | Performance | Location-aggregation query under 500 ms | spec §14 |
| NFR-3 | Freshness | Data refresh interval 2–3 minutes across every collecting registry source (52 in the registry) | spec §14, §17 |
| NFR-4 | Availability | 99% system uptime | spec §2, §14 |
| NFR-5 | Accuracy | 99% inference accuracy target for all components (sentiment, relevance, demographic inference, cross-platform correlation), validated on labeled benchmarks; the Phase 1 lexicon model is explicitly an audit-pattern foundation that will not meet this bar — the Phase 2 transformer upgrade is the accuracy vehicle | spec §14 |
| NFR-6 | Accuracy governance | Sentiment benchmark re-run monthly on a hand-labeled 500-post set; relevance precision verified by monthly manual review of 200 random posts | spec §14 |
| NFR-7 | Quality | Test coverage ≥ 80% enforced as a commit gate; all tests pass before any commit; TDD (test-first) for every component | spec §13, §14 |
| NFR-8 | Ethics gates | Before release: every threshold documented with justification; every processed post has an audit row; no PII detectable in stored content; bias assessment populated after every job | spec §14 |
| NFR-9 | Accessibility | WCAG 2.1 AA: colorblind-safe palettes, color never the sole indicator, contrast ratio ≥ 4.5:1, keyboard navigation, aria-labels on markers, screen-reader-compatible structure | spec §11 |
| NFR-10 | Security | Secrets only in environment configuration (collector credentials in the worker only); parameterized queries only; input validation on all routes; no information leakage in errors; dynamic DOM built without HTML injection under a strict CSP. *Status: implemented and tested; known defects (fix pending): a malformed JSON body gets a default HTML error page with a stack trace outside production, and route handlers log database error messages unscrubbed (spec §7, §8).* | spec §8 |
| NFR-11 | Privacy | Target posture (planned — verified when the full GDPR lifecycle logging ships): no usernames, user IDs, emails, IPs, profile data, or sub-city location ever stored; GDPR lifecycle logging with legal basis on every data action | spec §8 |
| NFR-12 | Scalability of ops | Correlation batch latency under 30 seconds per batch; retention compaction bounds storage growth | spec §14, §19 |

## 6. Acceptance Criteria by Major Feature

### 6.1 Real-time monitoring (FR-1..FR-3)
- A processing run collects from active sources, and newly ingested posts appear in `GET /api/sentiment/latest` within one refresh cycle (2–3 min).
- Every processed post has at least sentiment and relevance decisions in its audit trail.
- Ingesting the same upstream item twice creates no duplicate post (deduplication per source and upstream id; content-hash deduplication across sources is PLANNED — not implemented as of spec v1.2.0).
- A sample of stored content contains no @-mentions, usernames, or email patterns (spec §14 ethical gates).

### 6.2 Explainability (FR-10, FR-26, FR-27)
- For any valid post ID, the audit endpoint returns the post snippet plus every decision with model name, methodology version, justification text, full output, and timestamp.
- Invalid UUIDs return 400; unknown posts return 404; no internal details leak.
- Changing an algorithm parameter without registering a new methodology version is impossible by process: decisions always reference the version row active at execution time.

### 6.3 Bias monitoring (FR-4, FR-11, FR-24)
- After every processing job that scored posts (once per collection cycle for scheduled runs), bias assessments exist for location concentration, platform sentiment parity (shown as "Demographic parity") and negative dominance.
- Crossing a documented threshold (e.g., one location exceeding 35% of located posts; above 80% is critical) creates a violation record and an alert event, surfaces in `GET /api/health` active alerts, and flips the dashboard status chip to yellow (warning) or red (critical).
- Each violation exposes metric value, threshold, severity, and supporting evidence.

### 6.4 Globe storytelling (FR-17..FR-25)
- On load, the globe renders within 1 second and city markers appear once data arrives; total page load under 3 seconds.
- Scrolling advances through all 11 beats: each beat moves the globe, re-encodes the markers, and shows an insight card whose numbers are derived from the currently loaded data (no hardcoded insight values); no residual template tokens appear in any card.
- **The 2-minute journalist test:** starting from a cold page load, a user can reach a concrete, sourced insight (e.g., most-negative city with its share) via the scroll story within 2 minutes without any interaction other than scrolling.
- The final beat releases the globe: drag/rotate and zoom work, hover shows a tooltip with the city's breakdown, filter chips re-encode the markers, a city opens its detail panel; scrolling back up restores the story state.
- With the API stopped, the same walkthrough succeeds on bundled demo data, and every insight card is visibly marked as demo data (data mode `fallback` → "Demo data" marker) — demo numbers are never presented as live. Server-side demo data (mode `demo` or `mixed`) is marked the same way. If even the demo data cannot support a beat, the card shows the no-data fallback copy instead.
- The about chip opens the legal-notices panel with all six notice lines; the `<noscript>` block shows the same lines; the console stays free of CSP violations.
- Console remains error-free through a full desktop and 375px-mobile walkthrough; on mobile, insight cards do not fully obscure the globe.

### 6.5 Researcher query (FR-12, FR-14, FR-29)
- `GET /api/methodology` lists every component's versions in effective-date order, each with a non-empty justification.
- `POST /api/query` with valid filters returns scored posts with the total match count and echoes the applied filters; invalid filter values return 400.
- PLANNED — not implemented as of spec v1.2.0: grouped aggregates; the 11th request within a minute returns 429; a query whose date range predates the detail window returns results annotated as rollup-derived.

### 6.6 Compliance and retention (FR-2, FR-5, FR-28)
- Every collected post has a retention-log entry citing its legal basis. (PLANNED — not implemented as of spec v1.2.0; the retention log records compaction, demo purges and Reddit blanking today.)
- After a compaction run, affected posts have nulled content and no embeddings, while their audit rows, rollup aggregates, and methodology references remain intact and the compaction is itself logged. (Blocked on real months by the known compaction defect, spec §19.)
- Reddit post text is blanked 48 hours after collection, or sooner when the 6-hourly re-check finds it deleted upstream, while its scores and audit rows are kept (ADR 0001 ruling 9).
- Cross-platform correlation does not ship until the privacy audit checklist (no identity stored, salt never logged, signals non-reversible, DPIA completed) passes in full (spec §20).

## 7. Phase Roadmap

Status reflects `master` @ `20de9e2` (PRs #8, #9 and #10) as of 2026-09-29; PR #10 Part 2 is in flight.

| Phase | Content | Status |
|---|---|---|
| **Phase 1 (A–D): Foundation** | Infrastructure (Docker, migrations, seed, test harness); TDD pipeline (sentiment, relevance, discourse, ingest, bias, correlation modules); API route surface (health, posts, sentiment, refresh, audit, bias, methodology, sources, query); embeddings service and vector storage; real source collection over the 52-source registry (ADR 0001) (spec §13) | **Done** — 26 migrations, pipeline modules, collectors, worker and 12 routes exist with the 80% coverage gate in force; correlation is reserved (not enqueued) |
| **Phase E: Storytelling frontend** | The FuN.zip prototype frontend: Canvas-2D globe, 11-beat scroll story, client-side insight derivation, free-explore with filters, audit and health drawers, demo labelling (spec §11, §13 Phase E) | **Done** on `master`; the legal-notices panel is added with the AGPL licence on `docs/diagrams-and-readme` |
| **Phase 2: Accuracy and depth** (spec §16) | Transformer sentiment upgrade to the 99% target; demographic inference (99% target); topic clustering; similar-post retrieval endpoint; full DQI discourse scoring; full cross-platform correlation; automated monthly compaction; D3 demographics/topics/discourse charts | Planned — prerequisites: Phase 1 baselines, labeled benchmark sets, 3+ months of data for compaction |
| **Phase 3: Reach and hardening** (spec §16) | Topic relationship graph; semantic free-text search; TV/kiosk display mode; full counterfactual fairness; differential privacy on aggregates | Planned — prerequisites: Phase 2 topic and model upgrades, regulatory assessment for differential privacy |

## 8. Traceability: PRD Requirements → Technical Specification

| PRD requirement | Technical Specification section |
|---|---|
| FR-1 (52-source collection, 2–3 min refresh) | §13 Phase C, §17 |
| FR-2 (PII stripping, immutable ingest, retention log) | §8 |
| FR-3 (audited inference pipeline) | §10, §18 |
| FR-4 (three-layer bias stack, alerts) | §9 |
| FR-5 (layered retention, compaction) | §19 |
| FR-6..FR-16 (API surface and validation) | §7, §8 |
| FR-17 (globe load priority) | §11 |
| FR-18..FR-22 (11 beats, insights, explore, filters, demo labelling) | §11, §13 Phase E; the FuN.zip design-handoff prototype (ruling of 2026-09-28) |
| FR-23 ("why?" links to audit) | §10, §11 |
| FR-24 (traffic-light health) | §3, §9, §11 |
| FR-25 (no build step, self-hosted assets, canvas fallback, legal notices) | §8, §11, §21 |
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
2. **Commercial platform API cost** (~$100/month) — resolved by the registry: X stays a registry source on its paid route, closed until its key is set (spec §16, §17).
3. **Academic source access** — resolved by the registry: arXiv and PubMed are open; SpringerLink needs a free key; ScienceDirect and JSTOR need approval; IEEE Xplore needs a licence; ResearchGate is blocked. No citation-graph source (Semantic Scholar, ACM Digital Library) is in the registry (spec §16, §17).
4. **Correlation cold start** — single-platform authors receive no pseudonymous ID and are counted as unlinked (resolved position, restated for visibility).
