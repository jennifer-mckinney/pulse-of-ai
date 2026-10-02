# The Pulse of AI — Technical Specification
**Version:** 1.2.1
**Date:** 2026-10-01
**Status:** Implemented through PR #44 (`master` @ `a17020f`; PRs #85 and #87 are recorded in the changelog below and not yet in this header or the §13 PR list, which the next reconciliation pass updates). PR #10 Part 2 landed as PR #22; nothing described here is in flight.
**Maps to:** `pulse-of-ai-mvp-v1-final-requirements.pdf`, `pulse-of-ai-evidence-based-thresholds.pdf`, `pulse-of-ai-model-health-dashboard.pdf`

**Authority.** The code on `master` is the authority for what exists; this specification is the source of truth for names and intent. Legal and product decisions belong to `docs/adr/0001-source-registry-and-collection.md` (ADR 0001); this document references them and does not restate them differently.

**Status markers used in this document:**
- **PLANNED — not implemented as of v1.2.0**: designed intent that is kept on purpose. Nothing on `master` implements it (still true at v1.2.1; the marker keeps its v1.2.0 wording).
- Anything without a marker describes `master` @ `a17020f`. The v1.2.0 draft also used **IN FLIGHT (PR #10 Part 2)** and **KNOWN DEFECT (fix pending)**; PR #22 merged that work and fixed those defects, so neither marker is used any more.

### v1.2.0 changelog (2026-09-29): aligned to code per independent audit, 2026-09-29
Every section below changed because the independent diagram-accuracy audit (round 1) confirmed drift between v1.1.0 and the code on `master`. Section-by-section:
- **Header and TOC**: version, status and authority line; status markers added; TOC entry 21 (Licence and Legal Notices) added.
- **§1, §2, §3**: 52-source registry across 8 categories (not "top 50 across 7"); adjective-animal pseudonyms (not verb-noun); bias thresholds and the Canvas-2D globe; unbuilt thresholds and layers marked PLANNED.
- **§4**: architecture redrawn from the code: collectors, BullMQ on Redis, the worker, the FastAPI embeddings service, 12 mounted endpoints, the Canvas-2D browser.
- **§5**: Node 22, Redis 7 + BullMQ adopted, FastAPI + sentence-transformers embeddings; Infinity and RoBERTa marked PLANNED.
- **§6**: 22 tables across 26 migrations with the real DDL and the value vocabularies actually written.
- **§7**: all 12 mounted endpoints with their real request and response shapes (health's degraded 200, the three endpoints v1.1 did not document, the audit receipt, the flat `/api/query` body); relevance@1.1.0's 20 keywords; the `sentiment@1.0.0` example's `accuracy_target` 0.99 (was 0.80); the grouped query, its rate limit and the rollup note marked PLANNED; the malformed-JSON defect stated.
- **§8**: data handling as implemented (dedup on source and external id, no `collected` retention rows, `ingest@1.5.0`, route validation as coded, no mock-data fallback); security controls v1.1 did not cover (CSP, CORS scoping, collector network guard, loopback binding, credential split); two logging and error defects stated.
- **§9**: the three implemented checks with their real thresholds (0.35 / 0.60 / 0.30), the critical level above 0.80, when they run, per-check alert types, `source_refused` alerts, the drawer's `/api/bias/history`; the v1.1 three-layer stack marked PLANNED.
- **§10**: the four audience views (Public, Journalist, Regulator, Researcher); the methodology registry and seeding as coded (`accuracy_target` 0.99); provenance and lineage in the explainability chain.
- **§11**: the shipped FuN.zip prototype frontend (11 beats, Canvas-2D globe, demo labelling, legal notices) replaces the Scrollama / D3 / Mapbox plan.
- **§12**: FastAPI embeddings service with a pinned model revision; the 1/20 embed gate; Infinity and `/api/similar` marked PLANNED.
- **§13, §14, §16**: phase status, the retry policy as coded, the 52-source counts; unbuilt items marked PLANNED or IN FLIGHT.
- **§17**: runtime gate statuses including `blocked_by_source`, status precedence, the env and database kill switches, the refused state, decisions D1 to D4.
- **§18**: DQI as implemented (5 dimensions at `1.1.0-DQI`); the 6-dimension weighted design marked PLANNED.
- **§19**: retention as implemented (manual compaction over whole calendar months, step order, reason text, Reddit blanking); the compaction rollback defect stated; `monthly_discourse_rollups`, the rollups endpoint and scheduled compaction marked PLANNED or IN FLIGHT.
- **§20**: adjective-animal pseudonyms as implemented; correlation reserved (nothing enqueues it); signal weighting and `/api/users/:pseudo_id` marked PLANNED.
- **§21 (new)**: licence (AGPL-3.0-or-later with one §7(b) attribution term) and the legal-notices UI.

### v1.2.0 reconciliation with PR #22 (2026-09-29)
PR #22 (PR #10 Part 2, `973cad8`) merged after the v1.2.0 draft. Every IN FLIGHT item and every KNOWN DEFECT of the draft is now on `master`, and the sections below describe it as done:
- **§1–§4**: status line; scoring through the `ingest` queue for scheduled and refresh runs; Valkey 8; the maintenance queue; the watchdog; the correlation DPIA gate; relevance@1.2.0, bias@1.5.0, ingest@1.7.0, admission_filter@1.0.0.
- **§5**: Valkey 8.1.10 replaces Redis 7 (new `valkey_data` volume); the `watchdog` compose service.
- **§6**: 34 tables across 46 migrations (001–060, with gaps); the schema additions of migrations 027–060; the append-only tables.
- **§7**: `/api/health` operational fields (`maintenance`, `watchdog`, `bias_sample`, `correlation`, `alerts_closed`, `jobs`) and its 5 s cache; the malformed-JSON defect fixed (400 JSON); the refresh stale rule and token rules; `/api/methodology` errata; `publisher_posts` on the location aggregate; the insufficient-sample counts of `/api/bias/latest` and `/api/bias/history`; the receipt's `provenance.admission`.
- **§8**: route and pool log scrubbing (defect fixed); the dev server binds 127.0.0.1; ingest@1.7.0 and its privacy claim; the `collected` retention rows (written since ingest@1.6.0).
- **§9**: bias@1.2.0 to 1.5.0 (publisher-location exclusion, minimum samples, the rolling 24 h window) and the insufficient-sample share.
- **§10**: the admission filter as methodology; methodology errata; the 24 registered methodology rows.
- **§11, §12**: the publisher-location globe layer and the SYSTEM ALERT / SYSTEM WATCHDOG UI; the 1/21 embed gate applied by the `ingest` worker; embed jobs of removed posts.
- **§13, §14, §16, §17**: phase status, the watchdog, decisions D3, D4 and G1–G6 as implemented; the gate rule with `GATE_APPROVED_BY` (G5) and the append-only `source_gate_events`; the 23 / 31 collecting counts.
- **§19**: the maintenance schedule (text retention every 5 min, compaction, run rollups and the rolling bias window daily, terms snapshots weekly); retention by blanking for every source; `processing_jobs` kept permanently.
- **§20**: the correlation DPIA gate; `correlateUser()` throws and the correlate worker refuses every job; the salt is required.
- **§21**: the licence scope names `master` @ `973cad8`.

### v1.2.1 changelog (2026-09-30): reconciliation with PRs #24–#34 and documentation audit round 3
PRs #24–#28 and #31–#34 merged after v1.2.0 (`master` @ `7291490`; #29 and #30 were closed without merging); PRs #13–#21, #23, #27, #28 and #31 are dependency bumps with no effect on this text. A patch version: the sections below are brought back in line with the code, and no design intent changes. Section by section:
- **§3, §6, §7, §9, §10**: bias@1.6.0 (migration 061: the platform-parity "insufficient sample" row states its value; errata for bias 1.4.0 and 1.5.0); a refresh, standup or manual job that ends with no scoring outstanding is finalized by the runner (posts counted from `decision_audit_log`, bias checks when any); `scripts/seed-demo.js` removed.
- **§5, §6, §12**: sentence-transformers 6.1.0 as `embedding@1.1.0` (migration 065); 49 migrations (001–065).
- **§6, §7, §17**: refusal probation (migration 062: `probation_until`, `access_denied_headers`, `last_refused_at`, `source_runs.response_headers`; `/api/sources` serves `probation_until`).
- **Header, §11, §13, §21**: the master SHA 7291490 (header, §11, §21); the status line names PR #34; §13 lists the PRs merged after #22.
- **Audit round 3 corrections (no code change behind them):** §2 text retention also blanks on the Reddit deletion re-check; §5 compose profiles per service and the model's disk size; §6 the migration index, the schema sketch's foreign keys, the provenance id format, the migration gaps (063–064), DDL comments (`decision_audit_log`, `alert_events`, `data_retention_log`, `source_type`, `source_runs.job_id`) and the index note; §7 the health queue list, the proxy headers of the refresh token rule, the bias layer status `n-a`, the served error fields and `retired_note` of `/api/sources`; §8 the SSRF refusal list, the safe-id rule and the `verify-provenance` exit codes; §9 the window-run alert and lineage columns; §12 the embedding code comments; §13 the PRs after #22; §17 the cadence band (120–180 s) and the Stack Overflow / GitLab cadences; §19 the retention tiers, the Reddit re-check's refusal condition and the rollup coverage example; §20 the pseudonym history and the HMAC signal hash.
- **Audit round 4 corrections (2026-09-30; no code change behind them):** this changelog's PR list (#29 and #30 were closed unmerged); §1 provenance fingerprints need a key and demo posts carry none; §3 the per-source `online` rule; §5 the watchdog shares the app image, and the MongoDB, `all-mpnet-base-v2`, IVFFlat and Infinity rows; §6 `processing_jobs` row creation, `content_hash` (stored and indexed, joined by nothing) and the `alert_resolution_approvals` foreign key; §8 `.env.example` holds defaults and placeholders, `content_hash`, and the error-response rule (environment variable names may be served where they tell the operator what to set; secrets never are; owner ruling, no code change); §9 source health runs on every cycle-timer tick; §12 and §15 every external benchmark figure is now cited to its primary source (sbert.net pretrained-models table, the Tembo pgvector benchmark, the e5-large model card, the `sentiment` README) or corrected, and the unsourced ones (CPU throughput, STS-B 84-85%, 3-4%, Infinity's 30-40% and 2-4x, e5-large 8GB+ RAM, RoBERTa 6GB RAM, "comparable to VADER") are withdrawn; §15 MongoDB has multi-document ACID transactions (since 4.0) and a vector search feature; §16 Discourse forums are collected (four routes); §17 refusal headers stay on the state row only while the refused state lasts; §20 the pseudonym upsert was removed in PR #22.
- **Reconciliation with PRs #35, #37, #38 and #39 (2026-09-30; #36 is an issue, not a PR):** header, §11, §13, §21 the master SHA 0356a00 and the status line names PR #39; §3, §10 ingest@1.8.0 and audit_narration@1.4.0 (migration 066, wording only: the content hash is an integrity check, not a join key; errata on ingest 1.0.0–1.7.0); §6 50 migrations (001–066); §8, §12 python/start.sh binds 127.0.0.1 (`EMBEDDINGS_HOST`, PR #35); ADR 0001 `CORRELATION_MIN_CONFIDENCE` (PRs #37, #39).
- **Audit round 5 corrections, §12–§16 (2026-09-30; no code change behind them):** §12 the model's 22.7M parameters (Hugging Face metadata), the `populate` role's `GET /health` readiness check, the Infinity CLI (`infinity_emb v2 --model-id`); §13 a comma in the PR list; §14 the refresh-interval row (collecting sources only, D4 exceptions), correlation latency **PLANNED**, the per-queue backlog limit, the accuracy targets marked not yet measured; §15 MySQL's native `JSON` type, a RoBERTa upgrade needs a registry entry, migration and inference code; §16 X needs `X_BEARER_TOKEN` and `GATE_APPROVED_BY`, the cold-start rule is ≥ 0.85 confidence only.
- **Reconciliation with PRs #41 and #43 (2026-10-01; #42 and #44 are still open):** header, §11 and §21 the master SHA 2b5e6c3 and the status line names PR #43; §13 adds PRs #41 and #43 to its PR list; §7 `/api/bias/history` pass summaries carry `latest_insufficient` and word an insufficient-sample latest value as not compared with τ; §11 the health drawer shows such a summary as N/A; §12 the `embed` worker reads the service's `GET /health` before it stamps a vector (registered model, revision and library, else NULL; an unreadable `/health` fails the job), and `python/requirements.txt` pins the registered library stack, torch per platform included; §17 a `SOURCE_<SLUG>_RESET` date in the future is ignored, its accepted forms, and the `last_refused_at` carry for a refusal recorded before migration 062. No methodology version or migration changes.
- **Reconciliation with PR #44 (2026-10-01; #42 is still open):** header, §11 and §21 the master SHA a17020f and the status line names PR #44; §13 adds PR #44 to its PR list; §3, §4, §6, §16, §17 the HTTP client waits out a `Retry-After` of at most 10 s in a run and holds the host up to 24 h for a longer one (or 5 min for a 429 without one), persisted in `source_collection_state.http_cache`; TLDR polls every 180 s (HTTP 429 at 150 s); §6, §8, §19 the retention-log action `source_reattributed` of the manual `scripts/correct-legacy-seed-attribution.js --apply`. No methodology version or migration changes.
- **K1 attribution, PR #87 (2026-10-01):** §4 and §7 thirteen endpoints, the new `GET /api/credits`, the `credit`, `source_url`, `published_at` and `data_origin` fields of `/api/query`, `/api/sentiment/latest` and `/api/audit/:post_id`, and the stricter `provenance.permalink`; §11 the credit line, the header "credits" chip and the credits page; §17 the registry's credit fields; §21 how the credits page and the About panel divide the notices. No schema change, no migration, no methodology version change.
- **Relevance Stage 0a (PR #85, migrations 067-068; 2026-10-01):** §3, §10, §10 "Why?" by audience: `audit_narration@1.5.0` (migration 067, wording only; errata on audit_narration 1.1.0–1.4.0): the relevance step's public sentences say every stored post counts toward the totals whatever its relevance score, and that only-AI-relevant counting arrives with the next relevance version (decision D1); the page's bundled demo receipt states the same sentence conditionally (a fictional post is never stored, so it counts toward nothing), consistent across its audience views; §6 tables 35–36 (`admission_rule_hits`, 068; `source_route_state`, 073, PR #42) and the migration counts (54 files, 001–074), migration 068's dropped-count columns; §7 `/api/health` `admission` and `/api/sources` per-source `admission` (7-day counts); §19 the daily maintenance step that expires `admission_rule_hits` (`ADMISSION_RULE_HITS_DAYS`). Admission decisions are unchanged: the counters are measurement only.

**v1.1.0 Amendments (historical record; v1.2.0 supersedes the source count and categories, the pseudonym format and the retention schedule where the sections below say so):**
- Scope: Global (not US-only)
- Refresh interval: 2–3 minutes (was 5 min)
- Inference accuracy target: 99% for all components (was 80%/75%)
- Source coverage: Top 50 global online sources across 7 categories
- Cross-platform user correlation with verb-noun pseudonymous ID (PII-obfuscated)
- Discourse algorithm: Deliberative Quality Index (DQI) + semantic improvements
- Layered retention: 3-month detail → monthly compaction → permanent topic rollups
- User interaction + query-driven insight delivery (not passive-only)

**PR #22 amendments (collection hardening; described in the sections they change):** the collection admission filter is versioned methodology (`admission_filter@1.0.0`, §10); bias@1.4.0 minimum samples and the bias@1.5.0 rolling 24 h window (§9, decision G2); the maintenance schedule (retention every 5 min, compaction and rollups daily, terms snapshots weekly), `processing_jobs` kept permanently and the new audit and state tables (§6, §19); the correlation DPIA gate (§20); Valkey 8 as the queue store (§5); the external watchdog (§14). This v1.2.0 text is reconciled with them (changelog above).

---

## Table of Contents
1. [Executive Summary](#1-executive-summary)
2. [Problem Statement & Objectives](#2-problem-statement--objectives)
3. [Requirements Mapping](#3-requirements-mapping)
4. [Architecture Overview](#4-architecture-overview)
5. [Technology Stack](#5-technology-stack)
6. [Database Design](#6-database-design)
7. [API Specification](#7-api-specification)
8. [Security & Privacy Design](#8-security--privacy-design)
9. [Bias Monitoring System](#9-bias-monitoring-system)
10. [Governance & Audit Architecture](#10-governance--audit-architecture)
11. [End User Experience Design](#11-end-user-experience-design)
12. [Embedding & Vector Search](#12-embedding--vector-search)
13. [Implementation Phases (TDD)](#13-implementation-phases-tdd)
14. [Quality Gates & Success Metrics](#14-quality-gates--success-metrics)
15. [Alternatives Considered](#15-alternatives-considered)
16. [Open Questions & Future Phases](#16-open-questions--future-phases)
17. [Source Taxonomy — the registry of record (52 sources)](#17-source-taxonomy--the-registry-of-record-52-sources)
18. [Discourse Algorithm](#18-discourse-algorithm)
19. [Layered Retention Architecture](#19-layered-retention-architecture)
20. [Cross-Platform User Correlation](#20-cross-platform-user-correlation)
21. [Licence and Legal Notices](#21-licence-and-legal-notices)

---

## 1. Executive Summary

The Pulse of AI is a global, real-time AI discourse monitoring dashboard designed for journalists, researchers, policy makers, and the general public. It aggregates AI-related discourse from the 52-source registry of record (§17) across 8 categories (social, news, academic, policy, non-profit, developer, forums, blogs), collecting each source only through its official route, applies audited NLP analysis, and presents findings through an 11-beat scroll story over a Canvas-2D globe (§11) with free exploration and query-driven insight delivery.

**What makes this system responsible AI, not just a dashboard:**

Every inferred decision the pipeline makes today — sentiment score, relevance rating, discourse quality score — is captured in an immutable audit log with full provenance: which model, which version, which parameters, what the input was, what the output was, and what the plain-English justification for the methodology is. Topic classification and demographic inference are Phase 2 (not built; §16); when built they will be audited the same way. Anyone asking "why does this say that?" gets a traceable, defensible answer.

**Key architectural principles:**
- Global coverage — the 52 registry sources across 8 categories, all geographies
- Raw data kept as collected — a stored post is not edited, with documented exceptions only: `raw_posts.content`, `raw_payload` and `text_removed_*` change under text retention, and `raw_posts.source_id` changes once, under a named approval, in the manual legacy-seed correction (`scripts/correct-legacy-seed-attribution.js --apply`), which logs a `source_reattributed` row per post (the decision audit log, by contrast, is immutable). Text retention, which replaces a post's text with a removal notice when its source's window ends (Reddit 48 h under ADR 0001 ruling 9, YouTube and TikTok 30 days, every other source the detail window), when the 6-hourly Reddit re-check finds a post removed upstream, and at compaction (§19); the daily demo purge also deletes fictional demo posts with their dependent rows after the detail window
- Auditable inferences — every score is traceable to its methodology version
- Versioned methodology — algorithms change over time; we track which version produced which decision
- Privacy-first collection — identity fields are never stored and identities in text are redacted (§8); every post collected while `PROVENANCE_KEY` or `AUDIT_HASH_KEY` is set (standup generates it) carries a keyed provenance fingerprint instead of an identity; without a key, and for fictional demo posts, none is recorded and the receipt says why
- Cross-platform correlation — adjective-animal pseudonymous IDs without re-identification (§20). Not implemented: the signal design is pending a DPIA, `correlateUser()` throws and the correlate worker refuses every job
- Layered retention — detail window (`RETENTION_DETAIL_DAYS`, default 90 days), then monthly rollups; the worker's maintenance queue removes text every 5 minutes and compacts daily (§19)
- TDD throughout — tests are written before implementation

---

## 2. Problem Statement & Objectives

### Problem
Public discourse about AI is happening at scale across platforms, but:
- There is no neutral monitoring system tracking how sentiment evolves across demographics and geographies
- When bias in AI coverage is identified, there is no mechanism to explain which algorithm flagged it and why
- Journalists have no tool to get "story-ready insights in under 2 minutes" (requirement from MVP spec)
- Researchers cannot verify methodology or reproduce findings

### Objectives
| # | Objective | Success Criteria |
|---|---|---|
| O1 | Monitor AI discourse globally in near-real-time | 2–3 minute refresh, 99% uptime |
| O2 | Surface geographic sentiment patterns worldwide | Map renders with real data in <3 seconds |
| O3 | Detect and report bias across sources and demographics | Automated alerts for demographic parity violations |
| O4 | Be explainable to any audience | `GET /api/audit/:post_id` returns human-readable decision trail |
| O5 | Be compliant by design | GDPR data minimization, AI Act documentation, layered retention built in |
| O6 | Be testable and reproducible | 80%+ test coverage, 99% inference accuracy, all thresholds documented |
| O7 | Surface cross-platform discourse patterns | Cross-platform user correlation with PII-obfuscated pseudonymous IDs (adjective-animal, §20). Not implemented on `master`: the signal design is pending a DPIA (correlation gate, §20) |
| O8 | Support user interaction + queries | Insights delivered via interactive frontend AND on-demand queries |
| O9 | Maintain research-grade historical access | Monthly compacted rollups preserve trends beyond the detail window (daily maintenance check, §19). No endpoint reads the rollups yet (PLANNED) |

---

## 3. Requirements Mapping

### From `pulse-of-ai-mvp-v1-final-requirements.pdf`

| Requirement | Technical Implementation | Spec Section |
|---|---|---|
| Global real-time data pipeline | BullMQ job schedulers per collecting registry source, staggered across the 2–3 min collection window (`COLLECT_WINDOW_MS`, default 150 s), longer where a source's documented quota needs it, and 180 s for TLDR, whose host rate-limited the 150 s poll, + `POST /api/refresh` on demand | §13 Phase C, §17 |
| Sentiment analysis with 99% accuracy | `sentiment@1.0.0` (AFINN) with every result audited; `accuracy_target` 0.99 registered. RoBERTa v2: **PLANNED — not implemented as of v1.2.0** | §10, §14 |
| Demographic inference 99% accuracy | **PLANNED — not implemented as of v1.2.0** (Phase 2; methodology version to be registered before it runs) | §10 |
| AI relevance filtering 99% | `relevance@1.2.0`: 21-term lexicon matched as whole words, score = matched fraction; the collection admission filter (`admission_filter@1.0.0`) decides what is stored. Embedding hybrid: **PLANNED — not implemented as of v1.2.0** | §7, §10 |
| Discourse quality scoring | `discourse@1.1.0-DQI`: 5 heuristic dimensions. Semantic cluster improvements: **PLANNED** | §18 |
| Geographic visualization (global) | Canvas-2D dot globe (`public/js/globe.js`) fed by real GROUP BY queries from PostgreSQL; ranked city list when canvas is unavailable | §7, §11 |
| Bias & harm monitoring | 3 aggregate checks (location concentration, platform sentiment parity, negative dominance) per job or cycle and over a rolling 24 h window (`bias@1.6.0`), with minimum samples; `bias_assessments` and `bias_window_assessments`, alerts | §9 |
| <3s page load | No framework, no build step, self-hosted static assets, indexed queries, 10 s response cache on the hot read endpoints | §14 |
| Story-ready in <2min | Globe and overview beat render on page load; the page re-polls on the refresh cycle | §11 |
| WCAG 2.1 compliance | Colour never the only cue, keyboard and pointer events, reduced-motion honoured | §11 |
| Cross-platform user correlation | Adjective-animal pseudonymous IDs (§20). Not implemented: gated off pending a DPIA (`correlateUser()` throws). Style + temporal signal correlation: **PLANNED** | §20 |
| User interaction + queries | Explore mode filters + flat `POST /api/query` (platform, location, date range, limit) | §11, §7 |
| Layered retention | Text retention per source (Reddit 48 h, YouTube and TikTok 30 days, otherwise the 90-day detail window) every 5 min; monthly compaction checked daily | §19 |

### From `pulse-of-ai-evidence-based-thresholds.pdf`

Every implemented threshold is stored in the `methodology_versions` table with a plain-English `justification`, except the one code constant the **Stored As** column names (the 0.80 critical level for location concentration, `src/pipeline/bias.js`). The **Status** column says which ones are implemented on `master`.

| Metric | Threshold | Stored As | Status |
|---|---|---|---|
| Sentiment accuracy target | ≥ 99% (validated against labeled set) | `sentiment@1.0.0` config `accuracy_target: 0.99` | Registered; benchmark validation PLANNED |
| Demographic inference accuracy | ≥ 99% (Phase 2, labeled test set required) | — | **PLANNED — not implemented as of v1.2.0** |
| AI relevance | at least one of 21 lexicon terms (score > 0); embed gate score ≥ 1/21 | `relevance@1.2.0` config | Implemented. The v1.1 "≥ 99% precision" target is not registered: the superseded `relevance@1.0.0` row registers `ai_relevance_threshold` 0.99, a score threshold, not a precision target, and no later relevance row carries either. **What counts:** every stored post counts toward the totals whatever its relevance score (no aggregate query filters on `relevance_results`; the score only gates embedding). Only-AI-relevant counting (decision D1) arrives with the next relevance version, after its gold-set gate; `audit_narration@1.5.0` words the receipt that way |
| Discourse quality score (DQI) | 0.0–1.0, unweighted mean of 5 dimensions | `discourse@1.1.0-DQI` config | Implemented |
| Location concentration alert | > 35% of content-located posts in one city (warning); > 80% critical; at least 30 content-located posts | `bias@1.6.0` config `location_concentration_max: 0.35`, `location_min_sample: 30`; critical level in code | Implemented |
| Source concentration alert | > 40% from single source | — | **PLANNED — not implemented as of v1.2.0** |
| Negative sentiment dominance | > 60%; at least 30 posts | `bias@1.6.0` config `negative_dominance_max: 0.60`, `negative_min_sample: 30` | Implemented |
| Platform sentiment parity | max pairwise difference of mean comparative across source categories > 0.30; only categories with at least 10 posts | `bias@1.6.0` config `platform_parity_max_diff: 0.30`, `parity_min_per_category: 10` | Implemented |
| Demographic parity difference (user demographics) | > 0.10 | — | **PLANNED — not implemented as of v1.2.0** |
| Equalized odds difference | > 0.08 | — (name and citation listed in `bias@1.6.0` `planned_layers` for display, as in every bias version since 1.1.0; no threshold stored) | **PLANNED — not implemented as of v1.2.0** |
| Counterfactual fairness | > 0.05 | — (name and citation listed in `bias@1.6.0` `planned_layers` for display, as in every bias version since 1.1.0; no threshold stored) | **PLANNED — not implemented as of v1.2.0** |
| Cross-platform correlation confidence | ≥ 0.85 before assigning a pseudonymous ID | — (PR #22 removed the `CORRELATION_MIN_CONFIDENCE` constant with the scoring code) | **PLANNED — not implemented as of v1.2.0**: `correlateUser()` throws until a DPIA approves a signal design (§20) |

### From `pulse-of-ai-model-health-dashboard.pdf`

| Health Indicator | Implementation |
|---|---|
| Traffic light status | `GET /api/health` → `active_alerts` array (unresolved `alert_events`); a watchdog alert (`source_table 'watchdog'`) turns the header chip into a red SYSTEM ALERT |
| Bias alerts | a violating check writes `bias_assessments.is_violation = true` (or a `bias_window_assessments` row for the rolling window) and an `alert_events` row whose `alert_type` is the check name; `bias_sample` reports how often each check stayed below its minimum sample |
| Source refusals and staleness | one critical `source_refused` alert per refusal episode (§17); `source_stale` and `source_failing` alerts opened and resolved by the worker as each condition starts and clears |
| Model health | `last_job` (latest `processing_jobs` row), `redis.reachable`, `worker.alive` and per-queue counts from the worker heartbeat, `maintenance` (last run and success per task), `watchdog` (is it reporting, e-mail status) |
| Data freshness | `data_mode` and `data_window` over the trailing hour; per-source `online` = collecting and a success within the last hour that is not older than the source's last error; `retention_overdue` when text is held past its window |

---

## 4. Architecture Overview

The diagram set in `docs/diagrams/` (entry point `docs/diagrams/architecture.*`) draws this in detail. In summary:

```
┌─────────────────────────────────────────────────────────────────┐
│  DATA SOURCES — the 52-source registry of record (§17)           │
│  src/config/source-registry.js = workbook Rev. 4, 8 categories   │
│  Social · News · Academic · Policy · Non-profit · Developer ·    │
│  Forums · Blogs — each collected only through its official route │
└───────────────────────┬─────────────────────────────────────────┘
                        │ gate status per source (env + DB kill switch,
                        │ named approval G5, refused state) — only
                        │ 'collecting' sources run
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  WORKER PROCESS (src/workers/start.js)                          │
│  collector.scheduler.js → BullMQ collect.rss | collect.api |    │
│    collect.bulk (one job per source run); collect.refresh       │
│  src/collectors/runner.js, per source run:                      │
│   1. fetch  — one collector per open route, through the guarded │
│               HttpClient (UA + contact URL, robots.txt, spacing,│
│               ≤ 2 retries, Retry-After holds, SSRF guard)       │
│   2. store  — admission filter (admission_filter@1.0.0),        │
│               allowlisted payload, identity fields dropped,     │
│               in-text redaction (ingest@1.8.0), city-level      │
│               location, provenance fingerprint, dedup on        │
│               (source_id, external_id) → raw_posts              │
│   3. score  — scheduled and refresh runs: one `ingest` job per  │
│               new post; npm run collect / standup: inline.      │
│               sentiment, relevance, discourse, each with a      │
│               decision_audit_log row                            │
│   4. bias   — per job (refresh, standup, manual) or once per    │
│               collection cycle close (scheduled runs); daily    │
│               over a rolling 24 h window (bias@1.6.0) — §9      │
│   5. embed  — one `embed` job per post with relevance ≥ 1/21    │
│  embed queue · correlate queue (refuses every job: DPIA gate)   │
│  maintenance queue: retention every 5 min; compaction, run      │
│  rollups and the bias window daily; terms snapshots weekly      │
│  cycle timer: cycle close, source health and retention-overdue  │
│  alerts, unscored sweep · Reddit maintenance timer (re-check,   │
│  discovery) · heartbeat                                         │
└──────┬────────────────────────┬─────────────────────────────────┘
       │                        │ POST /embeddings (compose network only)
       │                        ▼
       │     ┌──────────────────────────────────────────────┐
       │     │ EMBEDDINGS SERVICE (python/embeddings_service │
       │     │ .py) — FastAPI + sentence-transformers,       │
       │     │ all-MiniLM-L6-v2 at a pinned revision, 384-d  │
       │     └──────────────────────────────────────────────┘
       ▼
┌─────────────────────────────────────────────────────────────────┐
│  VALKEY 8 — BullMQ queues, job schedulers, worker heartbeat     │
│  POSTGRESQL 16 + pgvector — 36 tables from 54 migrations (§6)   │
│   raw_posts · decision_audit_log · *_results · post_embeddings  │
│   (VECTOR(384), HNSW) · methodology_versions · bias_assessments │
│   · bias_window_* · alert_events · alert_resolutions ·          │
│   source_collection_state · source_runs · source_gate_events ·  │
│   maintenance_state · watchdog_* · reddit_* · rollup and        │
│   correlation tables                                            │
└──────┬────────────────┬─────────────────────────────────────────┘
       │                ▲ GET /api/health, SELECT 1 (every 120 s)
       │     ┌──────────┴───────────────────────────────────┐
       │     │ WATCHDOG (scripts/watchdog.js, src/watchdog)  │
       │     │ own container; critical alerts on the         │
       │     │ dashboard, optional SMTP e-mail (§14)          │
       │     └──────────────────────────────────────────────┘
       ▼
┌─────────────────────────────────────────────────────────────────┐
│  WEB PROCESS — EXPRESS API (src/server.js), 13 endpoints (§7)   │
│  GET  /api/health              GET  /api/bias/latest            │
│  GET  /api/posts/aggregated-   GET  /api/bias/history           │
│       by-location              GET  /api/methodology            │
│  GET  /api/sentiment/latest    GET  /api/sources                │
│  GET  /api/audit/:post_id      GET  /api/sources/timeseries     │
│  POST /api/query               GET  /api/themes                 │
│  GET  /api/credits             (source credits, K1; §7, §11)    │
│  POST /api/refresh (same-origin, token, 409, 60 s debounce;     │
│       enqueues collect.refresh — the worker collects)           │
│  Strict CSP; CORS on the read-only routers only; JSON errors    │
└───────────────────────┬─────────────────────────────────────────┘
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│  BROWSER (public/) — no build step, everything self-hosted      │
│  UMD modules: config/*, attribution, utils, data, insights,     │
│  chapters, globe (Canvas-2D dot globe), story (11 beats), ui,   │
│  main                                                           │
│  Demo data always labelled; legal notices in the header panel;  │
│  a credit and link back under every excerpt (credits.html)      │
└─────────────────────────────────────────────────────────────────┘
```

**Processes.** `web` (`node src/server.js`) serves the page and the API and never collects. `worker` (`node src/workers/start.js`) runs every queue, the scheduler, the maintenance schedules and the Reddit maintenance timer. `watchdog` (`node scripts/watchdog.js`, compose profile `full`) watches the others from its own container. `embeddings` serves vectors on the compose network only (no published port). `migrate` runs once; `populate` (compose profile `demo`) keeps the labelled demo fallback alive only while the trailing hour has no live posts.

**Superseded in v1.2.0:** the v1.1 source box (Reddit, Twitter/X, Mastodon, Bluesky, TechCrunch, LessWrong and others), the Infinity embed service and the "Mapbox GL JS + D3.js v7 + Vanilla JS + Scrollama" browser. None of them exists on `master`.

**Landed with PR #22 (formerly IN FLIGHT as PR #10 Part 2):** collect enqueuing `ingest` for scheduled and refresh runs, staleness alerts, scheduled compaction, generalised per-source retention, the `source_gate_events` and terms-snapshot tables, the bias minimum samples and publisher-location exclusion (D3), `relevance@1.2.0`, compose `env_file`, and binding the dev server to 127.0.0.1. PR #22 also added the rolling bias window, the admission filter version, the watchdog, Valkey and the named gate approval (G5).

---

## 5. Technology Stack

### Primary Stack

| Layer | Technology | Version | Reason |
|---|---|---|---|
| Runtime | Node.js | 22 (`node:22.23.3-bookworm-slim`, pinned by digest in `Dockerfile`) | LTS; one image for web, worker, migrate, watchdog and populate |
| Web framework | Express.js | 4.x | Minimal, existing |
| Primary DB | PostgreSQL | 16 (`pgvector/pgvector:pg16`, pinned by digest) | JSONB, partial and expression indexes, extensions |
| Vector search | pgvector | bundled in the image | Integrated with PostgreSQL, no separate service |
| Queues | BullMQ on Valkey 8 | `valkey/valkey:8.1.10-alpine` (pinned by digest) | Redis-protocol queue store under BSD-3-Clause: producer/consumer separation, per-source job schedulers, independent retries, worker heartbeat. It replaced Redis 7 in PR #22 on a new `valkey_data` volume (Redis 7.4 RDB files do not load in Valkey 8); the compose service and the `REDIS_*` variables keep the Redis name |
| Embeddings | sentence-transformers `all-MiniLM-L6-v2` | 6.1.0 (transformers 5.18.0, torch 2.12.1+cpu), pinned Hugging Face revision `1110a243…` (`embedding@1.1.0`; 2.7.0 was `embedding@1.0.0`, bit-identical vectors) | Local, 384-dim, 22M params |
| Embed service | FastAPI + sentence-transformers (`python/embeddings_service.py`) | — | Simple, testable (pytest), OpenAI-compatible `POST /embeddings` |
| Embed service (production option) | Infinity (`infinity-emb`) | — | **PLANNED — not implemented as of v1.2.0.** Dynamic batching; same request shape, so it can replace the FastAPI service without Node changes |
| Sentiment v1 | `sentiment` npm (AFINN) | 5.0.2 | Synchronous, no API calls |
| Sentiment v2 | RoBERTa (Python, Phase 2) | — | **PLANNED — not implemented as of v1.2.0.** 99% accuracy target; v1 establishes the audit pattern first |
| Infrastructure | Docker Compose 2.39+, project name `pulse-of-ai` | — | postgres, postgres_test, redis (Valkey) by default; migrate, web, worker, embeddings and watchdog under profile `full`; populate under profile `demo` |
| Node testing | Jest + supertest; Playwright for e2e | — | Unit + integration, 80%+ coverage required |
| Python testing | pytest | — | Embedding service tests |

### Alternatives Considered — Why Not

| Alternative | Considered For | Why Rejected |
|---|---|---|
| SQLite | Primary DB | No pgvector support; no row-level security; single-writer bottleneck; not production-grade |
| MongoDB | Primary DB | Schema flexibility not needed; poor JOIN performance for audit queries; vector search is a separate MongoDB Vector Search feature, not part of one relational store with the audit tables (§15) |
| Chroma / Weaviate | Vector store | Separate service adds ops complexity; pgvector integrates vector + relational in one transaction |
| Redis | Caching / rate limit | Rejected for the MVP in v1.1 (an in-memory counter was enough for the 1 req/min refresh limit). **Adopted since, then replaced:** a Redis-protocol store backs the BullMQ queues, the per-source job schedulers and the worker heartbeat; PR #22 moved it from Redis 7 to Valkey 8 (BSD-3-Clause). The refresh debounce is still in-process |
| React / Vue | Frontend framework | Original design decision: Vanilla JS avoids build tooling, keeps deployment simple |
| OpenAI Embeddings API | Embeddings | API cost at scale; data leaves your infrastructure (GDPR risk); offline not possible |
| larger sentence-transformers | Embeddings | `all-mpnet-base-v2` encodes about 5x slower (2,800 vs 14,200 sentences/s on a V100 GPU) for 1.51 points on sentence-embedding tasks (69.57 vs 68.06) and 7.48 on semantic search (57.02 vs 49.54) ([sbert.net pretrained models](https://www.sbert.net/docs/sentence_transformer/pretrained_models.html)) — not worth it for trend monitoring |
| IVFFlat | pgvector index | In a published pgvector benchmark HNSW was about 15.6x faster at query time (40.5 vs 2.6 QPS at 0.998 recall, about 1M vectors of 50 dimensions; [Tembo, 2023-11-14](https://web.archive.org/web/20241206165814/https://tembo.io/blog/vector-indexes-in-pgvector)); higher build cost is acceptable |
| Flask/FastAPI | Embedding service | v1.1 preferred Infinity for dynamic batching and a ctranslate2 backend. **Shipped instead:** FastAPI + sentence-transformers, which is what `master` runs; Infinity stays PLANNED as a drop-in production option |

---

## 6. Database Design

### Schema Overview (36 tables across 54 migrations)

`scripts/migrate.js` applies the 54 files of `src/db/migrations/` (001–074; the numbering has gaps) in file-name order and records each in `schema_migrations` (its own bookkeeping table, not counted below). No migration drops a table or a column (056 replaces the event CHECK constraint of `source_gate_events` and adds a named-approval CHECK, NOT VALID). The ERDs in `docs/diagrams/data/` draw every column.

| # | Table | Created by | Purpose |
|---|---|---|---|
| 1 | `data_sources` | 001 (+013, +020) | One row per registry source (52) plus demo feeds and retired pre-registry rows |
| 2 | `raw_posts` | 001 (+006, +017, +022, +025, +031, +042) | Collected posts: redacted text (blanked at the end of its window), allowlisted payload, content hash, provenance fingerprint, ingest and admission versions |
| 3 | `processing_jobs` | 001 (+019, +021, +034, +040) | One row per accepted refresh request (created up front, even when it stores nothing), per demo batch, and per collection cycle, standup or manual job once it stores its first new post; never removed (G4) |
| 4 | `methodology_versions` | 001 | Every algorithm version, registered before it runs |
| 5 | `decision_audit_log` | 002 | Immutable per-decision audit record |
| 6 | `sentiment_results` | 002 | Derived sentiment per post |
| 7 | `relevance_results` | 002 | Derived relevance per post |
| 8 | `discourse_results` | 002 | Derived DQI per post |
| 9 | `data_retention_log` | 002 | Retention actions with legal basis |
| 10 | `bias_assessments` | 003 (+010) | Every per-job bias check run, violation or not |
| 11 | `alert_events` | 003 (+033, +038, +050) | Alerts surfaced on `/api/health`: bias, source health, retention, terms and watchdog alerts |
| 12 | `post_embeddings` | 004 (+012) | `VECTOR(384)` per post, HNSW index |
| 13 | `monthly_topic_rollups` | 005 | Tier 2 topic aggregates (§19) |
| 14 | `monthly_source_rollups` | 005 | Tier 2 source aggregates (§19) |
| 15 | `compaction_log` | 005 | One row per compacted month (§19) |
| 16 | `pseudonymous_users` | 006 | Correlation profiles (§20; never written: not implemented) |
| 17 | `user_platform_sightings` | 006 | Correlation sightings (§20; never written: not implemented) |
| 18 | `source_collection_state` | 013 (+016, +018, +023, +033, +037, +062) | Per-source cursor, HTTP cache, last run, refusal state and probation, freshness |
| 19 | `source_runs` | 013 (+016, +034, +062) | One row per source run that did something; raw rows kept 30 days (034) |
| 20 | `reddit_subreddit_rankings` | 025 | Daily top-7 subreddit selection snapshots (§17) |
| 21 | `reddit_api_budget` | 025 | The single shared Reddit request budget |
| 22 | `reddit_maintenance` | 025 | Last run of the Reddit discovery and re-check jobs |
| 23 | `alert_resolutions` | 028 (+032) | Every alert closure: who, why, evidence (append-only) |
| 24 | `methodology_errata` | 030 | Errata of released methodology rows (append-only) |
| 25 | `source_run_daily` | 034 | Daily per-source rollups of `source_runs` older than 30 days |
| 26 | `source_gate_events` | 035 (+056) | Gate changes and operator actions with the named approver (append-only) |
| 27 | `source_terms_snapshots` | 035 (+041) | Weekly terms-page snapshots with normalised text and hash (append-only) |
| 28 | `alert_resolution_approvals` | 036 | Named approvers of methodology supersessions (append-only); view `alert_status` |
| 29 | `maintenance_state` | 039 | Last run, success and error per maintenance task |
| 30 | `watchdog_state` | 050 | The watchdog's last poll and e-mail status (one row) |
| 31 | `watchdog_notifications` | 050 | Every watchdog e-mail decision (append-only) |
| 32 | `correlation_gate_events` | 056 | Every change of the correlation DPIA gate (append-only) |
| 33 | `bias_window_runs` | 060 | One row per rolling 24 h bias run (introduced by bias@1.5.0; runs the current bias version) |
| 34 | `bias_window_assessments` | 060 | The rolling window's assessments (append-only) |
| 35 | `admission_rule_hits` | 068 | Admission counts per UTC day, source, route, admission-filter version and rule: counts only, no text or ids (relevance-accuracy R1) |
| 36 | `source_route_state` | 073 (+074) | The per-route kill switch (one row per source and route ever switched; PR #42) |

**Migration index.** DDL: 001 core, 002 audit, 003 bias, 004 vectors, 005 retention, 006 correlation, 010 bias lineage column, 012 `post_embeddings.methodology_version` (+ `embedding@1.0.0`), 013 source collection, 016 classified collector errors, 017 provenance fingerprint (+ `ingest@1.3.0`, `audit_narration@1.3.0`), 018 refused state, 019 one refresh in flight (partial unique index), 020 database kill switch, 021 cycle in-flight runs, 022 `raw_posts.ingest_mv_id`, 023 unchanged-run counter, 025 Reddit. Data only: 007 canonical category taxonomy, 008 bias vocabulary conformance, 009 `bias@1.1.0` / `ingest@1.0.0` / `audit_narration@1.1.0`, 011 `audit_narration@1.2.0`, 014 `relevance@1.1.0` / `discourse@1.1.0-DQI` / `ingest@1.1.0` (and the released `sentiment@1.0.0`, `relevance@1.0.0`, `discourse@1.0.0-DQI` rows, ON CONFLICT DO NOTHING, so each 1.0.0 row predates its successor on a fresh database), 015 `ingest@1.2.0`, 024 `ingest@1.4.0`, 026 `ingest@1.5.0`. PR #22 (027–060; DDL and data together unless noted): 027 `bias@1.2.0` (data), 028 `alert_resolutions` + `bias@1.3.0`, 029 `relevance@1.2.0` (data), 030 `methodology_errata` (+ the `relevance@1.0.0` erratum), 031 live-text index + `ingest@1.6.0`, 032 `bias@1.4.0` (+ an idempotent re-add of `alert_resolutions.methodology_version_id`, which 028 creates), 033 source freshness, 034 run retention, 035 source governance, 036 alert supersession and append-only triggers, 037 freshness anchor, 038 one open alert per source and type, 039 `maintenance_state`, 040 job progress, 041 terms text, 042 `raw_posts.admission_mv_id` + `admission_filter@1.0.0`, 050 watchdog, 055 `ingest@1.7.0` (data), 056 named gate approval + `correlation_gate_events`, 060 rolling bias window + `bias@1.5.0`. After PR #22: 061 `bias@1.6.0` + the bias 1.4.0 / 1.5.0 errata (data, PR #24), 062 refusal probation columns (PR #33), 065 `embedding@1.1.0` (data, PR #34), 066 `ingest@1.8.0` / `audit_narration@1.4.0` + the ingest 1.0.0–1.7.0 content-hash errata (data, PR #38), 067 `audit_narration@1.5.0` + the audit_narration 1.1.0–1.4.0 relevance-wording errata (data), 068 admission rejection counters (`source_runs.dropped_*`, `source_run_daily.dropped_*`, `admission_rule_hits`), 073 and 074 the per-route kill switch (`source_route_state`) and its hardening (PR #42). Released migrations are never edited; a new methodology version ships as a new migration, field-for-field equal to `src/config/methodology-registry.js` (`tests/unit/pure/methodologyRegistry.test.js`).

```
data_sources ─┬─ raw_posts ─┬─ decision_audit_log ── methodology_versions
              │             │     ├─ sentiment_results (audit_id)
              │             │     ├─ relevance_results (audit_id)
              │             │     └─ discourse_results (audit_id)
              │             ├─ post_embeddings (VECTOR(384))
              │             └─ pseudonymous_users (pseudo_user_id, nullable)
              ├─ source_collection_state (1:1) · source_runs ── processing_jobs
              ├─ monthly_source_rollups · user_platform_sightings ── pseudonymous_users
processing_jobs ─┬─ decision_audit_log.job_id
                 └─ bias_assessments ── methodology_versions (lineage, 010)
bias_window_runs ── bias_window_assessments ── methodology_versions
alert_events ── alert_resolutions ── alert_resolution_approvals; alert_events ── watchdog_notifications
data_sources ── source_gate_events · source_run_daily · source_terms_snapshots
methodology_versions ── methodology_errata; raw_posts.admission_mv_id · raw_posts.ingest_mv_id · alert_resolutions.methodology_version_id · alert_resolution_approvals.methodology_version_id
data_retention_log · compaction_log · monthly_topic_rollups
maintenance_state · watchdog_state
correlation_gate_events · reddit_subreddit_rankings · reddit_api_budget · reddit_maintenance
```

### Schema additions of PRs #10 and #22 (migrations 025–060)

Tables 23–36 above, and the columns and indexes later migrations added to earlier tables:

| Table / column | Migration | Purpose |
|---|---|---|
| `alert_resolutions` | 028 (+032) | Append-only record of every alert closure: who, why, evidence (`basis`), optional methodology version |
| `alert_resolution_approvals`, view `alert_status` | 036 | The named approver of methodology supersessions (G1); `alert_status` tells `superseded` from `resolved` |
| `methodology_errata` | 030 | Errata attached to released methodology rows, which are never edited; served with their version by `GET /api/methodology` |
| `raw_posts.text_removed_at`, `text_removed_reason`; index `idx_raw_posts_text_live` | 025, 031 | Text retention by blanking; live-text lookups |
| `source_collection_state.last_new_post_at`, `freshness_anchor_at` | 033, 037 | Source freshness (`source_stale`) from a fixed anchor |
| `source_runs` (30 days raw) → `source_run_daily` | 034 | Run-table retention: daily rollups, raw rows removed after `SOURCE_RUNS_RAW_DAYS` |
| `source_gate_events`, `source_terms_snapshots` | 035, 041 | Governance: gate changes with who and when; terms snapshots with normalised text and its hash |
| unique partial index `uq_alerts_open_source` | 038 | At most one open alert per (type, source) |
| `maintenance_state` | 039 | Last run, last success and last error per maintenance task (`/api/health`) |
| `processing_jobs.last_progress_at` | 040 | Progress heartbeat of one-shot jobs (the stale-job sweeper uses it, not age) |
| `raw_posts.admission_mv_id` | 042 | The admission-filter version a post was stored under |
| `watchdog_state`, `watchdog_notifications`; unique partial index `uq_alerts_open_watchdog` | 050 | The watchdog (§14): its last poll and e-mail status (one row), every e-mail decision (append-only), at most one open alert per watchdog condition |
| `source_gate_events.approved_by`, `routes`, event `refusal_reset`; `correlation_gate_events` | 056 | Decision G5: the named approval (`GATE_APPROVED_BY`, "Name YYYY-MM-DD") behind each gate opening and operator change (a CHECK requires it as the actor of `enabled` / `disabled` / `refusal_reset`); every change of the correlation DPIA gate (principal #19) |
| `source_runs.dropped_*`, `source_run_daily.dropped_*`, `admission_rule_hits` | 068 | Admission rejection counters (relevance-accuracy R1; Jennifer McKinney 2026-09-30, "Counters only"): per run, the collector's dropped counts (invalid, old, out of scope, in-batch duplicate); per UTC day, source, route, admission_filter version and rule, admitted and rejected counts. Counts only: a CHECK restricts `rule_id` to a closed vocabulary and `route` to a route-id shape, and the collector writes a route only if it is an exact registered route of the source (checked in code, as the registry is code), so no text or item id is stored. `src/collectors/admission-counters.js` |
| `bias_window_runs`, `bias_window_assessments` | 060 | The rolling 24 h bias checks (introduced by bias@1.5.0, G2; they run the current bias version): one run row per window, its assessments append-only |

`alert_resolutions`, `alert_resolution_approvals`, `source_gate_events`, `source_terms_snapshots` and `methodology_errata` are append-only: a trigger rejects UPDATE and DELETE (migration 036); so are `watchdog_notifications` (050), `correlation_gate_events` (056) and `bias_window_assessments` (060). Migrations are numbered uniquely and applied in file-name order; gaps in the numbering are allowed (043–049, 051–054, 057–059 and 063–064 are unused).

### Migrations 001–004 — core, audit, bias and vector tables (final shape)

Columns added by later migrations are shown in place with the migration number. Comments list the values the code actually writes; where a migration comment lists more, the extra values are noted as never written.

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE data_sources (                                  -- 001
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL UNIQUE,     -- registry slug, e.g. 'bbc_news', 'reddit'
    display_name    TEXT NOT NULL,            -- workbook name, e.g. 'BBC News'
    source_type     TEXT NOT NULL,            -- 'rss' | 'api' | 'bulk' (the collect.<type> queue) | 'demo';
                                              -- retired pre-registry rows keep 001's 'reddit' / 'scrape'
    category        TEXT NOT NULL,            -- 8-slug canon (007): social | news | academic | policy |
                                              -- nonprofit | developer | forums | blog
    config          JSONB,                    -- non-secret route settings only
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    retired_at      TIMESTAMPTZ,              -- 013: pre-registry seed rows retired, never deleted
    retired_note    TEXT,                     -- 013
    collection_disabled_at     TIMESTAMPTZ,   -- 020: database kill switch
    collection_disabled_reason TEXT,          -- 020
    collection_disabled_by     TEXT           -- 020
);

CREATE TABLE raw_posts (                                     -- 001
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id       UUID NOT NULL REFERENCES data_sources(id),
    external_id     TEXT NOT NULL,            -- '<route>:<upstream id>' for a safe id, else '<route>:fp:<hmac>'
                                              -- ('<route>:<sha256>' when no provenance key is set; §8)
    content         TEXT NOT NULL,            -- redacted text; replaced by a removal notice at the end of its window (§19)
    raw_payload     JSONB,                    -- allowlisted content fields only
    content_hash    TEXT NOT NULL,            -- SHA-256(normalized content), indexed (idx_raw_posts_hash); an integrity hash, not a join key and not the dedup key: no query joins, reads or deduplicates on it; the scoring steps record the same digest as decision_audit_log.input_hash (ingest@1.8.0)
    location        TEXT DEFAULT '',          -- city-level only
    language        TEXT DEFAULT 'en',
    collected_at    TIMESTAMPTZ DEFAULT NOW(),
    pseudo_user_id  UUID REFERENCES pseudonymous_users(id),  -- FK added by 006; nullable
    provenance_fingerprint TEXT,              -- 017: HMAC (§8); NULL when neither PROVENANCE_KEY nor AUDIT_HASH_KEY is set
    ingest_mv_id    UUID REFERENCES methodology_versions(id), -- 022: ingest version the post was stored under
    text_removed_at     TIMESTAMPTZ,          -- 025: text retention (§19), every source since 031
    text_removed_reason TEXT,                 -- 025
    admission_mv_id UUID REFERENCES methodology_versions(id), -- 042: admission_filter version the post was stored under
    UNIQUE(source_id, external_id)            -- the deduplication key
);
-- 031: live-text lookups for retention
CREATE INDEX idx_raw_posts_text_live ON raw_posts (source_id, collected_at) WHERE text_removed_at IS NULL;

CREATE TABLE processing_jobs (                               -- 001
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    triggered_by    TEXT NOT NULL,            -- written: 'cron' (collection cycle), 'api' (refresh),
                                              -- 'standup', 'manual', 'demo';
                                              -- 'startup' (001 comment) is never written
    status          TEXT NOT NULL DEFAULT 'running',
                                              -- 'running' | 'closing' | 'awaiting_retries' |
                                              -- 'completed' | 'failed'
    posts_collected INTEGER DEFAULT 0,
    posts_processed INTEGER DEFAULT 0,
    sources_queried INTEGER DEFAULT 0,
    error_details   TEXT,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    inflight_runs   INTEGER NOT NULL DEFAULT 0, -- 021: runs still scoring into a cycle
    last_progress_at TIMESTAMPTZ               -- 040: progress heartbeat of one-shot jobs (stale sweeper)
);
-- 019: at most one refresh job running, across processes
CREATE UNIQUE INDEX uq_processing_jobs_api_running
    ON processing_jobs ((triggered_by)) WHERE triggered_by = 'api' AND status = 'running';

CREATE TABLE methodology_versions (                          -- 001
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    component       TEXT NOT NULL,            -- sentiment | relevance | discourse | bias | ingest |
                                              -- audit_narration | embedding | admission_filter
                                              -- ('demographic': PLANNED)
    version         TEXT NOT NULL,
    model_name      TEXT NOT NULL,
    config          JSONB NOT NULL,
    justification   TEXT NOT NULL,            -- plain English, defensible to regulators
    effective_from  TIMESTAMPTZ DEFAULT NOW(),
    deprecated_at   TIMESTAMPTZ,
    UNIQUE(component, version)
);

CREATE TABLE decision_audit_log (                            -- 002; INSERT only (the demo purge deletes demo rows, §19)
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id             UUID NOT NULL REFERENCES raw_posts(id),
    job_id                  UUID NOT NULL REFERENCES processing_jobs(id),
    methodology_version_id  UUID NOT NULL REFERENCES methodology_versions(id),
    decision_type           TEXT NOT NULL,    -- written: 'sentiment' | 'relevance' | 'discourse'
    model_name              TEXT NOT NULL,
    input_hash              TEXT NOT NULL,    -- SHA-256(input text); the API exposes only an HMAC of it (§10)
    output                  JSONB NOT NULL,
    confidence              REAL,
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sentiment_results (                             -- 002
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id     UUID NOT NULL REFERENCES raw_posts(id),
    audit_id        UUID NOT NULL REFERENCES decision_audit_log(id),
    score           REAL NOT NULL,            -- AFINN raw sum
    comparative     REAL NOT NULL,            -- score / token_count
    indicator       TEXT NOT NULL,            -- 'positive' | 'neutral' | 'negative'
    positive_words  TEXT[],
    negative_words  TEXT[],
    token_count     INTEGER,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE relevance_results (                             -- 002
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id      UUID NOT NULL REFERENCES raw_posts(id),
    audit_id         UUID NOT NULL REFERENCES decision_audit_log(id),
    score            REAL NOT NULL,           -- matched terms / 21 (relevance@1.2.0; / 20 under 1.1.0)
    matched_keywords TEXT[],
    is_relevant      BOOLEAN NOT NULL,        -- score > 0 (relevance@1.1.0 and 1.2.0)
    created_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE discourse_results (                             -- 002
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id         UUID NOT NULL REFERENCES raw_posts(id),
    audit_id            UUID NOT NULL REFERENCES decision_audit_log(id),
    dqi_total           REAL NOT NULL,        -- mean of the 5 dimensions (§18)
    dimensions          JSONB NOT NULL,
    argument_cluster_id TEXT,                 -- PLANNED (never written)
    novelty_score       REAL,                 -- PLANNED (never written)
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE data_retention_log (                            -- 002
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id     UUID,                     -- no FK (survives deletion)
    action          TEXT NOT NULL,            -- written: 'collected' (every post stored through src/pipeline/ingest.js; the populate demo batch writes none), 'blanked_platform_terms',
                                              -- 'text_removed_detail_window', 'compacted', 'purged_demo',
                                              -- 'rolled_up_source_runs', 'source_reattributed' (manual scripts/correct-legacy-seed-attribution.js --apply); 'anonymized', 'deleted',
                                              -- 'erasure_requested' (002 comment) are never written — see §8
    reason          TEXT,
    legal_basis     TEXT,
    performed_at    TIMESTAMPTZ DEFAULT NOW(),
    performed_by    TEXT DEFAULT 'system'
);

CREATE TABLE bias_assessments (                              -- 003
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id          UUID NOT NULL REFERENCES processing_jobs(id),
    assessment_type TEXT NOT NULL,            -- 'location_concentration' | 'platform_sentiment_parity' |
                                              -- 'negative_dominance' (008 folds the legacy synonym
                                              -- 'demographic_parity' onto 'platform_sentiment_parity')
    group_field     TEXT NOT NULL,            -- 'location' | 'platform' | 'global'
    group_value     TEXT NOT NULL,            -- the dominant city / 'category vs category' pair ('unknown' when no pair differs) / 'all';
                                              -- 'insufficient sample' below a minimum (bias@1.3.0+); 'none' or the single category under older versions
    metric_name     TEXT NOT NULL,            -- 'share_of_total' | 'max_comparative_diff' | 'negative_share'
                                              -- (pipeline values; the e2e fixture scripts/test/seed-e2e.js also writes
                                              -- assessment_type 'source_concentration', group_field 'source_category',
                                              -- metric_name 'share_of_total_posts' / 'sentiment_parity_diff')
    metric_value    REAL NOT NULL,
    threshold       REAL NOT NULL,
    is_violation    BOOLEAN NOT NULL DEFAULT FALSE,
    severity        TEXT,                     -- 'warning' | 'critical'; NULL when not a violation
    evidence        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    methodology_version_id UUID REFERENCES methodology_versions(id)  -- 010: lineage
);

CREATE TABLE alert_events (                                  -- 003
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_type      TEXT NOT NULL,            -- written: the bias check name ('location_concentration',
                                              -- 'platform_sentiment_parity', 'negative_dominance');
                                              -- per source: 'source_refused', 'source_stale', 'source_failing',
                                              -- 'retention_overdue', 'terms_changed'; watchdog: 'watchdog_<condition>'
                                              -- (§14); 'bias_violation' only in the e2e fixture
    severity        TEXT NOT NULL,            -- 'warning' | 'critical' ('info' is never written)
    source_table    TEXT,                     -- written: 'bias_assessments' | 'bias_window_assessments' (bias),
                                              -- 'data_sources' (per-source alerts) | 'watchdog'
    source_id       UUID,                     -- not enforced (cross-table); the source's id for per-source alerts
    details         JSONB,
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    resolved_at     TIMESTAMPTZ,              -- set, with an alert_resolutions row (028), when the condition clears
                                              -- or a methodology version supersedes it (036); 038 also closed duplicate open alerts once
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- 038: at most one open alert per (type, source); 050: one open alert per watchdog condition
CREATE UNIQUE INDEX uq_alerts_open_source ON alert_events (alert_type, source_id)
    WHERE resolved_at IS NULL AND source_table = 'data_sources' AND source_id IS NOT NULL;
CREATE UNIQUE INDEX uq_alerts_open_watchdog ON alert_events (alert_type)
    WHERE resolved_at IS NULL AND source_table = 'watchdog';

CREATE EXTENSION IF NOT EXISTS vector;                       -- 004
CREATE TABLE post_embeddings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id     UUID NOT NULL REFERENCES raw_posts(id) UNIQUE,
    embedding       VECTOR(384),
    model_name      TEXT NOT NULL DEFAULT 'sentence-transformers/all-MiniLM-L6-v2',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    methodology_version TEXT                  -- 012: the embedding@ version that produced the vector; NULL under a model/revision override or an unverified service (§12)
);
-- HNSW (cosine), m = 16, ef_construction = 400 — rationale in §12
CREATE INDEX idx_embeddings_hnsw ON post_embeddings
    USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 400);
```

Indexes not shown above are listed in the migrations (`src/db/migrations/`); the ERDs draw columns and keys, not indexes.

### Migrations 013–062 — source collection tables (final shape)

```sql
CREATE TABLE source_collection_state (                       -- 013
    source_id            UUID PRIMARY KEY REFERENCES data_sources(id),
    cursor               JSONB NOT NULL DEFAULT '{}'::jsonb,   -- per-route since-ids / timestamps
    http_cache           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- url → { etag, last_modified }; 'retry-after:<host>' → { until, status } (Retry-After hold)
    last_attempt_at      TIMESTAMPTZ,
    last_success_at      TIMESTAMPTZ,
    last_item_count      INTEGER,
    last_new_posts       INTEGER,
    last_error           TEXT,                -- scrubbed; never served by the API
    last_error_at        TIMESTAMPTZ,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error_kind      TEXT,                -- 016: served by /api/sources with last_http_status and last_error_at (classification only, never error text)
    last_http_status     INTEGER,             -- 016
    access_denied_at     TIMESTAMPTZ,         -- 018: refused state (§17)
    access_denied_status INTEGER,             -- 018
    access_denied_kind   TEXT,                -- 018
    refused_until        TIMESTAMPTZ,         -- 018
    refusal_count        INTEGER NOT NULL DEFAULT 0,  -- 018
    unchanged_runs       BIGINT NOT NULL DEFAULT 0,   -- 023: runs that changed nothing are counted, not inserted
    last_unchanged_at    TIMESTAMPTZ,         -- 023
    last_new_post_at     TIMESTAMPTZ,         -- 033: freshness (source_stale)
    freshness_anchor_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- 037: fixed anchor when no new post yet
    probation_until      TIMESTAMPTZ,         -- 062: 24 h after a successful probe; refusal_count is kept until it passes
    access_denied_headers JSONB,              -- 062: allow-listed, scrubbed headers of the latest refusal
    last_refused_at      TIMESTAMPTZ          -- 062: survives probation (a pre-062 refusal gets it from access_denied_at at its successful probe); cleared when the count decays or is reset
);

CREATE TABLE source_runs (                                   -- 013
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id     UUID NOT NULL REFERENCES data_sources(id),
    job_id        UUID REFERENCES processing_jobs(id),  -- NULL until the invocation stores its first new post (scheduled, manual and standup runs create or join their job then); a refresh run records its pre-created job
    gate_status   TEXT NOT NULL,              -- written: 'collecting' (only collecting sources are fetched); awaiting_* | blocked | disabled (013 comment) are never written
    outcome       TEXT NOT NULL,              -- written: 'ok' | 'error'; 'skipped' (013 comment) is never written
    items_fetched INTEGER NOT NULL DEFAULT 0,
    posts_new     INTEGER NOT NULL DEFAULT 0,
    requests      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at   TIMESTAMPTZ,
    error_kind    TEXT,                       -- 016
    http_status   INTEGER,                    -- 016
    response_headers JSONB                    -- 062: allow-listed refusal headers; NULL on every other run
);
```

### Migration 025 — Reddit tables

```sql
CREATE TABLE reddit_subreddit_rankings (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    ranked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    window_start TIMESTAMPTZ NOT NULL,
    window_end   TIMESTAMPTZ NOT NULL,
    min_ai_posts INTEGER NOT NULL CHECK (min_ai_posts >= 1),
    top_n        INTEGER NOT NULL CHECK (top_n >= 1),
    applied      BOOLEAN NOT NULL,
    selected     TEXT[] NOT NULL,
    ranking      JSONB NOT NULL,
    exclusions   JSONB NOT NULL,
    stats        JSONB NOT NULL
);

CREATE TABLE reddit_api_budget (             -- exactly one row (id = 1)
    id                 SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    window_start       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used               INTEGER NOT NULL DEFAULT 0 CHECK (used >= 0),
    blocked_until      TIMESTAMPTZ,
    upstream_remaining REAL,
    upstream_reset_at  TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE reddit_maintenance (
    job               TEXT PRIMARY KEY CHECK (job IN ('discovery', 'recheck')),
    last_started_at   TIMESTAMPTZ,
    last_completed_at TIMESTAMPTZ,
    last_outcome      TEXT,
    last_error_kind   TEXT,
    last_stats        JSONB,
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Migrations 005 and 006 are shown in §19 and §20. The tables of migrations 028–060 are listed in the schema additions above and drawn column by column in `docs/diagrams/data/`; their DDL is in `src/db/migrations/`.

---


## 7. API Specification

Thirteen endpoints are mounted (`src/server.js`). `POST /api/refresh` is mounted first and without CORS; every other endpoint sits on a read-only router with `cors()`. Every response carries the security headers of §8.

**Errors.** Route handlers answer `Content-Type: application/json` with `{ "error": "descriptive message" }` and never return stack traces, SQL errors or file paths: a caught failure is a `500 { "error": "Internal server error" }`.
- A JSON error handler after the routers (`jsonErrorHandler`, `src/server.js`) answers every error that reaches it as JSON in every environment: a malformed JSON body on `POST /api/query` or `POST /api/refresh` → `400 { "error": "invalid JSON body" }`, an oversized one → `413 { "error": "request body too large" }`, another client error → `{ "error": "bad request" }`, anything else → `500 { "error": "Internal server error" }`. The error is logged server-side, scrubbed (`src/middleware/log-error.js`). (The v1.2.0 draft recorded Express's HTML stack page here as a KNOWN DEFECT; PR #22 fixed it.)

**Response cache.** `GET /api/posts/aggregated-by-location`, `GET /api/sources/timeseries` and `GET /api/themes` are served from a 10 s in-process cache keyed per query string, and `GET /api/credits` from a 60 s one (`src/middleware/response-cache.js`).

### `GET /api/health`
System status for the header chip and the health drawer (`src/routes/health.js`). The response is cached in process for 5 s, keyed on the path alone (it fans out to the queue store and the database; PR #22 security L2). The response is cached in process for 5 s, keyed on the path alone (it fans out to the queue store and the database; PR #22 security L2). It also carries `bias_sample` (the insufficient-sample share per bias check, §9), `correlation` (§20) and `admission` (migration 068): over the last 7 UTC days and all sources together, items evaluated, admitted (and admitted on AI-specific feeds although no admission pattern matched) and rejected by reason (out of scope, too old, invalid, duplicate), plus admissions per admission-filter pattern. Counts are per evaluation: an item a feed serves again is counted again; a route whose store failed is counted only by the run that completes it. `admission` is `null` (the endpoint still answers) if its query fails, and `retention_invalid` is true when `ADMISSION_RULE_HITS_DAYS` is malformed.

**Response 200:**
```json
{
  "status": "healthy",
  "db_connected": true,
  "last_job": {
    "id": "uuid",
    "status": "completed",
    "triggered_by": "cron",
    "posts_processed": 42,
    "started_at": "2026-09-29T10:00:00Z",
    "completed_at": "2026-09-29T10:00:08Z"
  },
  "active_alerts": [
    { "id": "uuid", "alert_type": "location_concentration", "severity": "warning", "created_at": "2026-09-29T10:00:08Z",
      "title": null, "summary": null, "system": false }
  ],
  "alerts_closed": { "resolved": 12, "superseded": 31 },
  "data_mode": "live",
  "data_window": { "hours": 1, "posts": 180, "demo_posts": 0, "stored_posts": 240, "stored_demo_posts": 0 },
  "active_sources": 52,
  "demo_feeds": 3,
  "redis":  { "reachable": true },
  "worker": { "alive": true, "last_heartbeat": "2026-09-29T10:04:55Z",
              "queues": { "ingest": { "waiting": 0, "active": 1, "delayed": 0, "failed": 0 }, "…": "the same counts for collect.rss, collect.api, collect.bulk, collect.refresh, embed, correlate and maintenance" } },
  "sources": {
    "registry": 52, "seeded": 52, "collecting": 31, "online": 27,
    "by_status": { "collecting": 31, "awaiting_key": 4, "awaiting_approval": 8, "awaiting_licence": 5,
                   "blocked": 4, "disabled": 0, "blocked_by_source": 0 }
  },
  "maintenance": { "tasks": { "retention": { "last_run_at": "…", "last_ok_at": "…", "last_failed_at": null, "last_error": null },
                              "daily": { "…": "…" }, "terms": { "…": "…" } },
                   "retention_overdue": { "posts": 0, "sources": [] } },
  "jobs": { "failed_last_hour": 0 },
  "watchdog": { "reporting": true, "last_poll_at": "…", "poll_interval_s": 120, "open": [],
                "email": { "configured": false, "status": "email alerting not configured", "last_sent_at": null, "last_error": null },
                "config_errors": [] },
  "bias_sample": { "generated_at": "…",
                   "per_cycle": { "last_24h": { "location_concentration": { "assessments": 480, "insufficient": 470, "share": 0.98 }, "…": "…" },
                                  "last_7d": { "…": "…" } },
                   "rolling_window": { "latest_run": { "id": "uuid", "status": "completed", "version": "1.5.0", "checks": { "…": "…" }, "…": "…" },
                                       "last_7d": { "…": "…" } } },
  "correlation": { "enabled": false, "status": "awaiting_dpia", "reason": "…", "checked_by": "worker", "checked_at": "…" }
}
```
- `status` is `"healthy"`, or `"degraded"` with `db_connected: false` when the connection probe fails. There is no 503 and no `timestamp` field.
- `active_alerts` are the unresolved `alert_events` rows (§9, §14, §17, §19), newest first. A watchdog alert carries `system: true` with its `title` and `summary`; the page shows it as a red SYSTEM ALERT on the header chip.
- `alerts_closed` counts closed alerts by kind (`alert_status` view, migration 036): genuinely `resolved`, or `superseded` by a later methodology version with a named approver (G1).
- `data_mode` (`live` | `demo` | `mixed` | `none`) classifies the posts the globe shows for the trailing hour by the globe's own rule (scored posts at a city the registry resolves); `data_window` reports those counts and every stored post in the hour.
- `active_sources` counts active registry sources and excludes demo feeds; `demo_feeds` counts the demo feeds.
- `redis` and `worker` come from a bounded authenticated PING of the queue store (Valkey) and the worker heartbeat; `worker.queues` gives waiting / active / delayed / failed per BullMQ queue (null when unreadable). A down queue store reports `reachable: false` and never fails the endpoint.
- `sources` summarises the per-source runtime statuses of §17. `online` = `collecting` and a successful run within the last hour that is not older than the last error. The example counts are the ones with the contact URL, the acknowledgement and the named approval set (§17).
- `maintenance` is the last run, success and error of each maintenance task (`maintenance_state`, §19) and `retention_overdue`, the posts still holding text past their window. `jobs.failed_last_hour` counts failed processing jobs in the last hour.
- `watchdog` is what the external watchdog last reported (§14): whether it is `reporting` (polled within 3 poll intervals), the conditions it holds `open`, and its e-mail status. Web never holds the SMTP settings.
- `bias_sample` is the share of "insufficient sample" assessments per bias check (§9).
- `correlation` is the DPIA gate (§20); `enabled` is always false on `master`.

**Response 500:** `{ "error": "Internal server error" }` when a query fails. With the database down, the queries after the probe fail, so a database outage is in practice a 500.

---

### `GET /api/posts/aggregated-by-location`
Sentiment counts per city for the globe (`src/routes/posts.js`). Coordinates come from the canonical city registry `public/js/config/cities.config.js`, the same file the browser loads.

**Query params:** `?platform=` a canonical category slug (optional), `?from=ISO8601`, `?to=ISO8601` (optional).

**Validation:** `platform` outside the 8-slug canon → `400 { "error": "platform must be a canonical source category: social, news, …" }`; an unparseable `from` / `to` → `400 { "error": "Invalid from date" }` / `"Invalid to date"`.

**Response 200** (a plain array, ordered by `total` descending):
```json
[
  {
    "city": "London",
    "lat": 51.5074, "lng": -0.1278, "country": "GB",
    "positive": 145, "neutral": 88, "negative": 32, "total": 265,
    "dominant": "positive",
    "demo_posts": 0,
    "data_mode": "live",
    "publisher_posts": 12,
    "last_updated": "2026-09-29T10:00:08Z",
    "sources": [
      { "source_name": "bbc_news", "source_category": "news", "positive": 60, "neutral": 30, "negative": 10, "total": 100 }
    ]
  }
]
```
`publisher_posts` counts the row's posts placed at their publisher's home city (`raw_payload.location_basis = 'publisher'`, decision D3): the globe draws them as a separate, labelled publisher-location layer, and the location bias check excludes them (§9). A location the registry cannot resolve is served with `lat`/`lng`/`country` null (and logged once per process); the frontend drops those rows.

---

### `GET /api/sentiment/latest`
Aggregate summary + recent posts, for API consumers. The page does not call it.

**Query params:** `?limit=` (parsed as an integer and clamped to 1–100, default 20), `?platform=` a category slug (not validated: an unknown value returns empty results).

**Response 200:**
```json
{
  "summary": { "total": 1240, "positive": 612, "neutral": 445, "negative": 183, "avg_comparative": 0.12, "last_updated": "2026-09-29T10:00:08Z" },
  "recent_posts": [
    {
      "id": "uuid",
      "content_snippet": "first 120 characters of the stored (redacted) text",
      "sentiment_indicator": "negative",
      "score": -3,
      "comparative": -0.21,
      "location": "London",
      "source_category": "news",
      "source_name": "bbc_news",
      "collected_at": "2026-09-29T09:58:12Z",
      "audit_id": "uuid",
      "attribution": null, "data_origin": "live",
      "source_url": "https://www.bbc.co.uk/news/articles/…", "published_at": "2026-09-29T09:40:00Z",
      "credit": { "text": "BBC News", "required": false, "license": null, "license_url": null, "modified": false, "cite_date": false, "notice": null, "notice_url": null }
    }
  ],
  "refreshed_at": "2026-09-29T10:05:00Z"
}
```
The summary covers every scored post (all time). Each recent post also carries `source_name` and the K1 fields (`attribution`, `credit`, `source_url`, `published_at`, `data_origin`), described under `GET /api/credits` below.

---

### `POST /api/refresh`
Requests a collection + processing run over the source registry (an operator action; `api.config.js` lists it, but no page module calls it). The web process only creates the `processing_jobs` row and enqueues one `collect-all` job on the `collect.refresh` queue; the worker runs the collection (F10-3, F10-8). Guards in order: same-origin (403), `REFRESH_TOKEN` (403), one refresh in flight (409), a global 60 s debounce (429).

**Response 202:**
```json
{ "job_id": "uuid", "status": "queued", "triggered_by": "api" }
```
**Response 409:** `{ "error": "A refresh collection is already running", "job_id": "uuid" }` while a refresh job is running (migration 019's partial unique index holds this across processes; a row that made no progress (`processing_jobs.last_progress_at`, else `started_at`) for `REFRESH_STALE_MINUTES`, default 30, is marked failed as stale; the refresh run itself has a deadline of 80 % of that bound).

**Response 403 (token):** when `REFRESH_TOKEN` is set, the request must carry it as `X-Refresh-Token`; when the site is bound beyond loopback (`PULSE_BIND_ADDR` or `HOST` not a loopback address, or the actual bound address a wildcard) or the request came through a reverse proxy (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host` or `X-Real-IP` present), a token is required and refresh is refused without one. The compose-published address (`PULSE_CONTAINER_PUBLISHED_ADDR`) can only make this stricter; it excuses the wildcard listen only inside the compose web container (`PULSE_IN_CONTAINER=1` and `/.dockerenv`; PR #22 security M4).

**Response 429:** `{ "error": "Rate limit exceeded: 1 refresh per minute (global)", "retry_after_seconds": n }` with `Retry-After`.

**Response 503:** `{ "error": "Collection queue unavailable", "job_id": "uuid" }` — the job row is marked failed and the debounce budget is not spent.

**Response 403:** `{ "error": "Cross-site request rejected" }`. The endpoint is unauthenticated and changes state, and a cross-site "simple" POST needs no CORS preflight, so the server checks where each request came from. It allows `Sec-Fetch-Site: same-origin | none`. When that header is absent, it allows the request only if `Origin` (or, failing that, `Referer`) names the server's own host. Every other request is rejected before the rate limiter runs. The endpoint never serves CORS headers, and its `OPTIONS` preflight gets a 403.

---

### `GET /api/audit/:post_id`
The explainability endpoint (`src/routes/audit.js`): the receipt for one post. The four audience representations of every step are rendered at read time by the versioned templates of `audit_narration@1.5.0` (`src/config/audit-narration.js`); no per-post prose is stored.

**Path param:** `post_id`, checked against the strict 8-4-4-4-12 UUID pattern before any query.

**Response 200:**
```json
{
  "provenance": {
    "source": "bbc_news",
    "published_at": "2026-09-29T09:40:00Z",
    "permalink": "https://www.bbc.co.uk/news/articles/…",
    "external_id": "rss:…",
    "fingerprint": "hex HMAC",
    "verifiable": "verifiable: provide the original URL or id to reproduce the fingerprint: npm run verify-provenance -- --post <id> --url <original URL> [--id <original id>]",
    "admission": { "component": "admission_filter", "version": "1.0.0", "lineage": "recorded" }
  },
  "post": {
    "id": "uuid",
    "content_snippet": "first 120 characters of the stored (redacted) text",
    "location": "London",
    "source_category": "news",
    "source_name": "bbc_news",
    "attribution": null,
    "credit": { "text": "BBC News", "required": false, "license": null, "license_url": null, "modified": false, "cite_date": false, "notice": null, "notice_url": null },
    "source_url": "https://www.bbc.co.uk/news/articles/…",
    "published_at": "2026-09-29T09:40:00Z",
    "data_origin": "live",
    "collected_at": "2026-09-29T09:58:12Z"
  },
  "narration": { "component": "audit_narration", "version": "1.5.0" },
  "ingest": { "…": "the synthetic ingestion step rendered from the ingest methodology row", "lineage": "recorded" },
  "decisions": [
    {
      "decision_type": "relevance",
      "model_name": "keyword-relevance-v1",
      "methodology_version": "1.1.0",
      "config": { "keywords": ["…20 terms…"], "score_rule": "unique matched keywords / number of keywords, capped at 1.0", "embed_gate_min_score": 0.05 },
      "justification": "Registers the relevance scorer exactly as the code runs it …",
      "output": { "score": 0.1, "matchedKeywords": ["machine learning", "llm"] },
      "confidence": null,
      "created_at": "2026-09-29T09:58:14Z",
      "status": "pass",
      "score": 0.1,
      "audiences": { "public": "…", "plain": "…", "config": "…", "researcher": "…" },
      "input_hash": "HMAC-SHA256(AUDIT_HASH_KEY, stored SHA-256)"
    }
  ],
  "bias": {
    "job_id": "uuid",
    "assessed_at": "2026-09-29T10:00:08Z",
    "model_name": "pulse-bias-monitor-v1",
    "version": "1.5.0",
    "lineage": "recorded",
    "lineage_fallback": false,
    "layers": ["…one entry per fairness layer: value, τ, citation, status pass | fail | n-a (n-a, with the reason in its note, for an insufficient sample or a planned layer)…"]
  }
}
```
- `decisions` has one entry per `decision_audit_log` row (`sentiment`, `relevance`, `discourse`), oldest first. `input_hash` is `HMAC-SHA256(AUDIT_HASH_KEY, stored hash)` and is **omitted** when the key is unset, never returned raw.
- `provenance.permalink` and `provenance.published_at` are the same validated values as `post.source_url` and `post.published_at` (K1, `src/config/attribution.js`): the permalink is null unless it passes the link rule under `GET /api/credits` (a public http(s) address on one of the source's own domains, not a link to a person's profile), and both are null for a demo post; `published_at` is an ISO-8601 UTC string or null. `provenance.retention` (§19) is `{ status: "text_removed", removed_at, reason, notice }` for any post whose text was removed, and `{ status: "live", removes_at, notice }` for a live post of a platform-terms source (Reddit 48 h, YouTube and TikTok 30 days); a live post of any other source has none. `provenance.admission` names the `admission_filter` version the post was stored under (`raw_posts.admission_mv_id`, lineage `recorded`), or says why there is none (demo content; stored before migration 042). For a demo post `verifiable` says the content is fictional; for a post with no fingerprint it says why.
- `post.attribution` is the credit a source's terms require (e.g. NPR), else null. `post.credit`, `post.source_url` and `post.published_at` are the K1 fields (see `GET /api/credits`). `post.data_origin` is `demo` for demo-feed posts, which have no credit and no link.
- `ingest.lineage` is `recorded` (from `raw_posts.ingest_mv_id`) or `inferred` (the ingest version effective at `collected_at`, for rows stored before migration 022). `bias.lineage` is `recorded`, `inferred` or `current` (§10).

**Response 400:** `{ "error": "Invalid post ID: must be a UUID" }`
**Response 404:** `{ "error": "Post not found" }`

---

### `GET /api/bias/latest`
The latest completed job that processed posts, with every assessment it produced. For API consumers; the page does not call it.

**Response 200:**
```json
{
  "job_id": "uuid",
  "assessed_at": "2026-09-29T10:00:08Z",
  "violations": [
    {
      "id": "uuid",
      "assessment_type": "location_concentration",
      "group_field": "location",
      "group_value": "London",
      "metric_name": "share_of_total",
      "metric_value": 0.41,
      "threshold": 0.35,
      "is_violation": true,
      "severity": "warning",
      "evidence": { "rows": [ { "location": "London", "post_count": 74 } ], "total": 180, "dominantLocation": "London" },
      "created_at": "2026-09-29T10:00:08Z",
      "methodology_version_id": "uuid"
    }
  ],
  "all_assessments": [ "…every assessment of the job, same shape…" ],
  "insufficient_sample": { "per_cycle": { "last_24h": { "…": "…" }, "last_7d": { "…": "…" } },
                           "rolling_window": { "latest_run": { "…": "…" }, "last_7d": { "…": "…" } } }
}
```
With no qualifying job: `{ "job_id": null, "assessed_at": null, "violations": [], "all_assessments": [], "insufficient_sample": { … } }`. `insufficient_sample` is the report `/api/health` serves as `bias_sample` (§9): per check `{ assessments, insufficient, share }`. The rolling-window assessments (`bias_window_assessments`) are not listed here or in `/api/bias/history`; their violations appear as alerts.

---

### `GET /api/bias/history`
The health drawer's "alert history · last 12 h" (`src/routes/bias.js`). Every query shares one database timestamp (`src/db/clock.js`).

**Query params:** `?hours=` digits only (default 12, clamped to 1–48); anything else → `400 { "error": "hours must be an integer" }`.

**Response 200:**
```json
{
  "window_hours": 12,
  "window_start": "2026-09-28T22:05:00Z",
  "generated_at": "2026-09-29T10:05:00Z",
  "total_count": 900, "alert_count": 3, "pass_count": 897, "insufficient_count": 590,
  "truncated": false, "alert_cap": 500,
  "alerts": [
    { "id": "uuid", "time": "…", "severity": "watch", "layer": "Location concentration",
      "assessment_type": "location_concentration", "group_value": "London", "metric_name": "share_of_total",
      "value": 0.41, "threshold": 0.35, "detail": "…", "citation": "Suresh & Guttag (2021)",
      "model_name": "pulse-bias-monitor-v1", "version": "1.5.0", "lineage": "recorded" }
  ],
  "pass_summary": [
    { "severity": "pass", "layer": "Negative dominance", "assessment_type": "negative_dominance", "count": 299, "insufficient": 0,
      "first_time": "…", "last_time": "…", "metric_name": "negative_share", "latest_value": 0.21, "threshold": 0.6, "latest_insufficient": false,
      "detail": "299 passing checks in the window · latest negative_share 0.210 (τ = 0.6).",
      "citation": "Suresh & Guttag (2021)", "model_name": "pulse-bias-monitor-v1", "version": "1.5.0", "lineage": "recorded" }
  ]
}
```
`alerts` lists every flagged row in the window (severity mapped to the frontend vocabulary `alert` | `watch`), capped at 500 with `truncated` set when the cap bites; passing rows are folded into one summary per layer. A non-alerting row below its check's minimum sample (`group_value` 'insufficient sample', §9) is not a pass: `insufficient_count` and each summary's `insufficient` count those rows, and the summary's `detail` then reads "N passing checks and M with an insufficient sample in the window · …". When the summary's latest row is one of them, `latest_insufficient` is true and the tail reads "latest <metric> <value> (insufficient sample, not compared with τ = <τ>)." instead of "(τ = <τ>)": since bias@1.6.0 such a row states a value that was never compared with τ. The health drawer shows that summary as N/A in the neutral colour, not as a pass, and a summary holding any insufficient-sample row names its first time "First check" instead of "First pass" (`public/js/ui.js`). Each row's `version` is resolved from its own stored lineage, so rows assessed under an earlier bias version keep that version. The rolling-window assessments (`bias_window_assessments`) are not listed here.

---

### `GET /api/methodology`
Every non-deprecated methodology version, ordered by `component` and then `effective_from` descending (`src/routes/methodology.js`). The rows are those of `src/config/methodology-registry.js`; the version each pipeline stage runs is `CURRENT_VERSIONS` there (sentiment 1.0.0, relevance 1.2.0, discourse 1.1.0-DQI, bias 1.6.0, ingest 1.8.0, audit_narration 1.5.0, embedding 1.1.0, admission_filter 1.0.0), never "latest by timestamp". Each row carries its `errata` (`methodology_errata`, migration 030: `[{ erratum, corrected_by, recorded_at }]`, empty for most rows).

**Response 200** (two of the rows):
```json
[
  {
    "component": "relevance",
    "version": "1.1.0",
    "model_name": "keyword-relevance-v1",
    "config": {
      "keywords": ["artificial intelligence", "machine learning", "deep learning", "neural network",
                   "large language model", "llm", "natural language processing", "nlp", "transformer",
                   "reinforcement learning", "generative ai", "computer vision", "foundation model",
                   "fine-tuning", "embeddings", "gpt", "bert", "diffusion model", "autonomous agent", "ai safety"],
      "matching": "case-insensitive substring match; each keyword counted once",
      "score_rule": "unique matched keywords / number of keywords, capped at 1.0",
      "score_per_match": 0.05,
      "max_score": 1,
      "is_relevant_rule": "score > 0 (at least one keyword matched)",
      "embed_gate_min_score": 0.05,
      "embed_gate_rule": "a post is embedded when its relevance score is at least 1/20 (one lexicon match); replaces the unreachable 0.40 gate, which needed 8 of the 20 keywords"
    },
    "justification": "Registers the relevance scorer exactly as the code runs it …",
    "effective_from": "…",
    "deprecated_at": null,
    "errata": []
  },
  {
    "component": "sentiment",
    "version": "1.0.0",
    "model_name": "afinn-sentiment-npm-v5.0.2",
    "config": {
      "positive_threshold": 0.05,
      "negative_threshold": -0.05,
      "accuracy_target": 0.99,
      "accuracy_note": "Phase 1 baseline — validates audit pattern. RoBERTa v2.0.0 targets 99% on benchmark."
    },
    "justification": "AFINN-165 English word list (Nielsen 2011). …",
    "effective_from": "…",
    "deprecated_at": null,
    "errata": []
  }
]
```
The first example is the released `relevance@1.1.0` row, still served next to the current `relevance@1.2.0` (21 terms matched as whole words, embed gate 1/21). The superseded `relevance@1.0.0` row (18 keywords, 0.1 per match) and `discourse@1.0.0-DQI` row are kept and still served: released rows are never edited (ADR 0001, "Methodology alignment"); `relevance@1.0.0` carries the erratum of migration 030. The rows carry no `id`.

---

### `GET /api/sources`
The source registry of record with each source's runtime status (`src/routes/sources.js`, `src/collectors/status.js`), in registry-rank order. Each registry source also carries `admission` (migration 068): its 7-day admission counts, `{ window_days, evaluated, admitted, admitted_without_pattern, rejected: { total, out_of_scope, old, invalid, duplicate } }`, or `null` when it has none in the window.

**Query params:** `?include_inactive=true` also returns demo feeds (`registry: false`) and retired pre-registry rows (`retired: true`).

**Response 200** (one registry row):
```json
[
  {
    "id": "uuid", "name": "npr", "display_name": "NPR", "source_type": "rss", "category": "news",
    "active": true, "retired": false, "registry": true,
    "slug": "npr", "rank": 19, "region": "…", "auth_kind": "none", "program": "…", "signup_url": "…",
    "status": "collecting", "status_reason": "collecting via technology-rss",
    "collection_disabled_at": null,
    "missing_env": [], "open_routes": ["technology-rss"], "licence_refs_on_file": {},
    "kill_switch_env": "SOURCE_NPR_ENABLED",
    "online": true,
    "access_denied_at": null, "refused_until": null, "refusal_count": 0, "probation_until": null, "reset_env": "SOURCE_NPR_RESET",
    "last_attempt_at": "…", "last_success_at": "…", "last_item_count": 20,
    "last_error_kind": null, "last_http_status": null, "last_error_at": null, "consecutive_failures": 0,
    "terms_url": "…", "terms_note": "…", "attribution": "NPR", "license": null, "blocked": null, "ruling": null,
    "retention": null
  }
]
```
- `status` is one of the runtime statuses of §17 (`collecting`, `awaiting_key`, `awaiting_approval`, `awaiting_licence`, `blocked`, `disabled`, `blocked_by_source`).
- `missing_env` holds env var **names** only, never values. Errors are served only as a classification (`last_error_kind`, `last_http_status`, `last_error_at`, `consecutive_failures`, and the refused state `access_denied_at`, `refused_until`, `refusal_count`, `probation_until`), never as text.
- The Reddit row adds `retention` (`{ max_age_hours: 48, recheck_hours: 6, notice }`) and `selection` (the subreddit selection rule, the current list with basis `provisional` | `ranking`, and the latest ranking snapshot).
- Non-registry rows carry only the first block plus `registry: false`; a retired row also carries `retired_note`.

---

### `GET /api/sources/timeseries`
Hourly sentiment volume per source category for the ribbon sparklines.

**Query params:** `?hours=` digits only (default 12, clamped to 1–48); anything else, a negative number included → `400 { "error": "hours must be an integer" }`.

**Response 200:** one row per canonical category, always all 8, in canon order:
```json
[
  { "category": "news", "top_site": "BBC News", "words": ["llm", "ai safety"],
    "series": [ { "hour": "2026-09-29T09:00:00Z", "positive": 12, "neutral": 20, "negative": 5, "total": 37 } ] }
]
```
`series` has exactly `hours` zero-filled buckets, oldest first; a category with no posts is served as an all-zero series with `top_site` null and `words` `[]`.

---

### `GET /api/themes`
Keyword themes for the warm and cold story beats: `relevance_results.matched_keywords` aggregated over every scored post (`src/routes/themes.js`).

**Response 200** (at most 12 themes, volume descending; keywords matched by fewer than 3 posts are excluded; `[]` when none):
```json
[ { "keyword": "llm", "words": ["llm", "generative ai", "gpt"], "volume": 84,
    "positive": 40, "neutral": 30, "negative": 14, "top_category": "developer" } ]
```

---

### `GET /api/credits`
The credits page's data and the home of the K1 attribution rules (`src/routes/credits.js`, `src/config/attribution.js`; design: `docs/research/k1-attribution-design.md`). Read-only; mounted on the CORS router; cached for 60 s.

**Response 200:** `{ "sources": [...], "notices": { "excerpts": "…", "links": "…", "demo": "…" } }`. `sources` has one entry per registry source that has at least one stored post and is not a demo feed, in registry order (a source with no stored post, a demo feed, and a retired slug with no registry entry are not listed):
```json
{ "slug": "npr", "name": "NPR", "category": "news", "terms_url": "https://…",
  "credit": { "text": "NPR", "required": true, "license": null, "license_url": null,
              "modified": false, "cite_date": false, "notice": null, "notice_url": null } }
```
- `credit` is derived at read time from the registry (§17); no column stores it, so a registry fix applies to every stored post. Every real registry source has one, not only the sources whose terms require it (`required` says whether the terms do). `license` and `license_url` are set only for a source that publishes a licence, `modified` is true for Creative Commons "BY" licences (the excerpt is shortened and redacted), `cite_date` asks the page to show the publication date (Pew), and `notice` and `notice_url` carry a notice the terms require on the product (the arXiv acknowledgement, the NCBI disclaimer).
- **Fields added to every post row** of `POST /api/query`, `GET /api/sentiment/latest` (`recent_posts`) and `GET /api/audit/:post_id` (`post`): `credit` (the object above, or null), `source_url`, `published_at` and `data_origin` (`live` or `demo`), next to the unchanged `attribution`. `source_url` is the stored permalink and is non-null only when it passes one rule, shared by the server and the browser: a public http(s) address with no credentials and no control or bidirectional characters, with tracking and credential query keys removed, whose host is on (or under) one of the source's own link domains (the registrable domains of its routes' feed or forum URLs plus the registry's `linkHosts`), and which is not an identity link or a profile page. An off-source feed link therefore never appears under a trusted source's name. `published_at` is an ISO-8601 UTC string or null.
- **Conditions.** A demo post (`data_sources.source_type = 'demo'`) has `credit`, `source_url` and `published_at` null and `data_origin: "demo"`: it is fictional and is never credited to a real source. A stored row whose slug has no registry entry has `credit` and `source_url` null. Where retention has removed a post's text (§19) the credit is still served, and the link is served only if the stored URL was kept (Reddit's is; every other source's is dropped). The credit does not read the kill switches: the stored excerpts of a switched-off source stay displayed and credited, and whether to hide them is a separate display decision (design decision D4).
- **Not claimed.** Stack Exchange's terms ask for the author's name or an advance exception; author names are stripped on ingest (§8), so that exception still has to be requested. No licence is claimed for a source whose licence has not been verified (Mozilla's blog).

**Response 500:** `{ "error": "Internal server error" }`.

---

### `POST /api/query`
Filtered scored posts for journalists and researchers (`src/routes/query.js`). Read-only; mounted on the CORS router. The page's city drill-down uses it.

**Request body** (every field optional):
```json
{ "platform": "news", "location": "London", "from": "2026-09-01T00:00:00Z", "to": "2026-09-29T00:00:00Z", "limit": 20 }
```
**Validation:** `platform` outside the 8-slug canon → 400; `location` not a string, or an empty or whitespace-only string → 400; `limit` not an integer or < 1 → `400 { "error": "limit must be a positive integer" }`, > 100 → `400 { "error": "limit must be <= 100" }`; unparseable `from` / `to` → 400.

**Response 200:**
```json
{
  "results": [
    { "id": "uuid", "content_snippet": "…", "indicator": "negative", "score": -3, "comparative": -0.21,
      "positive_words": [], "negative_words": ["concerns"], "relevance": 0.1,
      "location": "London", "source_name": "bbc_news", "platform": "news",
      "collected_at": "2026-09-29T09:58:12Z", "attribution": null,
      "data_origin": "live", "source_url": "https://www.bbc.co.uk/news/articles/…", "published_at": "2026-09-29T09:40:00Z",
      "credit": { "text": "BBC News", "required": false, "license": null, "license_url": null, "modified": false, "cite_date": false, "notice": null, "notice_url": null } }
  ],
  "total": 834,
  "query": { "platform": "news", "location": "London", "from": "…", "to": "…", "limit": 20 }
}
```
The newest `limit` matching posts (by `collected_at`), with `total` = the number of matches; there is no offset or cursor. `comparative` is clamped to [−1, 1]; `relevance` is null for a post never relevance-scored; `attribution` is the credit the source's terms require, or null; `credit`, `source_url`, `published_at` and `data_origin` are the K1 fields (see `GET /api/credits`). There is no rate limit (§8).

**PLANNED — not implemented as of v1.2.0 (the v1.1 design, kept as intent):** a grouped-aggregate form of the query. A `filters` object (`source_categories`, `date_from`, `date_to`, `sentiment_indicators`, `locations`, `min_relevance_score`), `group_by` and `limit`; a response with `query_id`, `executed_at`, `filters_applied`, `total_matched` and per-group `positive` / `neutral` / `negative` / `total` / `dominant` / `avg_comparative`; a `note` (and `detail_coverage` / `rollup_coverage`) when the date range reaches back past the detail window into the monthly rollups (§19); and a rate limit of 10 requests per minute per IP with a `429` response.

---

### PLANNED endpoints — not implemented as of v1.2.0
Kept as intent; none is mounted on `master`:
- `POST /api/similar/:post_id` — similar-post retrieval over `post_embeddings` (§12).
- `GET /api/rollups/:year/:month` — Tier 2 monthly rollups (§19).
- `GET /api/users/:pseudo_id` — a pseudonymous cross-platform profile (§20).

---

## 8. Security & Privacy Design

### Secrets Management
- All credentials in `.env` only — never in code, comments, or git history
- `.env.example` committed: every variable with its default or a placeholder (`replace_with_random_64_hex_chars`, `changeme_before_production`), never a real secret
- `.env` in `.gitignore`
- `process.env` is the only access point — values are never returned in API responses. `GET /api/sources` serves env var **names** (`missing_env`) and presence booleans only
- Every error the collectors and the worker store or log is scrubbed of credential-shaped URL parameters and of every non-empty secret env value (`src/collectors/redact.js`, `src/workers/logging.js`). Every API route handler logs its errors through `logRouteError` (`src/middleware/log-error.js`: the same scrubber, plus control characters escaped so one error is one log line), and the database pool logs through `src/workers/logging.js` (PR #22 security L3/L4)
- A source whose key or approval is absent is not collected: it reports `awaiting_key`, `awaiting_approval` or `awaiting_licence` (§17). There is no mock-data fallback. Labelled demo data is written only by the standup / `populate` fallback, and only while the trailing hour holds no live posts (§11)
- **Credential split (compose):** collector credentials are merged into the `worker` container only. `web` receives presence markers (the literal `set` or empty) so it can report gate statuses without holding a secret; `scripts/test/check-compose.sh` fails if a credential value reaches another role

### PII Handling on Ingest (GDPR Data Minimization)

```
Collected item (a collector builds it from an allowlist of content fields;
identity fields are never requested)
        │
        ▼
Strip: any identity field that still arrives (PII_FIELDS: author, username,
       user_id, screen_name, creator, uploader, owner, email, …)
Redact in text: e-mails, @handles, Reddit u/ names, phones, profile links,
                cc names, sign-offs, Wikipedia unsigned notes (ingest@1.8.0)
Fingerprint: provenance HMAC; identity-bearing upstream ids stored only as
             '<route>:fp:<hmac>' ('<route>:<sha256>' without a key)
Location: city level only (content-level city, else the publisher's home
          city for editorial sources; basis recorded)
        │
        ▼
content_hash = SHA-256(normalized content)   ← stored and indexed; not the dedup key;
               an integrity hash (recorded again as input_hash), not a join key (ingest@1.8.0)
        │
        ▼
INSERT INTO raw_posts … ON CONFLICT (source_id, external_id) DO NOTHING
  (deduplication per source and upstream id; the post records
   ingest_mv_id and admission_mv_id, the versions it was stored under;
   the text is stored once, in content: raw_payload keeps metadata only)
  + in the same statement, a data_retention_log row, action 'collected'
```

**Collected log (ingest@1.6.0 and later):** every post stored through `src/pipeline/ingest.js` writes a `data_retention_log` row (`action = 'collected'`, legal basis GDPR Article 6(1)(f); a demo post stored there records the demo basis) in the same statement as the insert, with the source's text-retention window in `reason`. The demo batch of `scripts/populate.js` inserts its fictional posts directly and writes no `collected` row. The retention log also records `blanked_platform_terms`, `text_removed_detail_window`, `compacted`, `purged_demo`, `rolled_up_source_runs` (§19) and `source_reattributed` (one row per legacy seed post moved to its category's demo feed by the manual, approval-gated `scripts/correct-legacy-seed-attribution.js --apply`; its legal basis is NULL, the row records the diagnosis, evidence and named approver). The legal basis is also registered in each `ingest@` methodology row and restated on the receipt's ingestion step.

**The claim (`ingest@1.8.0` `privacy_claim`, decision D2 of ADR 0001), exactly:** identity fields are never stored; e-mail addresses, handles (including Reddit u/ names), phone numbers, sign-offs and profile links in text are redacted; free text may still contain names mentioned in content. (ingest@1.5.0, 1.6.0 and 1.7.0 register the same sentence; 1.3.0 and 1.4.0 register it without "(including Reddit u/ names)".)

**What is NEVER stored:**
- Identity fields: author, username, user id, screen name, creator, uploader, owner, e-mail (`src/pipeline/ingest.js` PII_FIELDS; collectors never request them)
- IP addresses or location beyond city-level metadata
- Profile information of any kind, including profile or user-namespace links as a post's link (`src/collectors/identity.js` isIdentityUrl)
- Post metadata that enables user re-identification (karma score, account age, etc.)
- An upstream id that could identify a person or that is not a plain id (anything outside letters, digits and `_ . : / ~ + -`, or longer than 200 characters: so a URL with a query string, an id with `@`, `%`, `&`, `=`, `#` or a space), a profile link, or the Telegram chat id: only its keyed fingerprint is stored (without `PROVENANCE_KEY` / `AUDIT_HASH_KEY`, an unkeyed SHA-256)

**What is redacted in the text before storage** (`src/collectors/identity.js` redactText): e-mail addresses → `[email]`; @handles of one or more characters → `@[user]` (ingest@1.4.0); Reddit `u/<name>` and `/u/<name>` → `u/[user]` and a scheme-less `reddit.com/u/` or `/user/` link → `[profile link]` (ingest@1.5.0, migration 026); phone numbers (E.164 and NANP) → `[phone]`; profile and identity links → `[profile link]`; `cc <Name>` → `cc [name]`; a trailing sign-off (`— Jane Doe`) and Wikipedia's "Preceding unsigned comment added by …" note are removed. All patterns are bounded and linear.

**What free text may still contain:** names of people mentioned in the content itself (for example "Sam Altman said…", or a name inside a GitHub issue body). The text is not otherwise de-identified.

**Provenance without identity (D2):** each collected post stores `raw_posts.provenance_fingerprint` = HMAC-SHA256(`PROVENANCE_KEY` or `AUDIT_HASH_KEY`, `source_slug + ":" + raw upstream id + ":" + canonical source URL`), next to `source_id`, the content hash and the identity-free external id; the canonical permalink is kept when it is not an identity link. The audit receipt (`GET /api/audit/:post_id` → `provenance`) shows the source, the published time, the permalink or the fingerprint, and "verifiable: provide the original URL or id to reproduce the fingerprint". `npm run verify-provenance -- --post <id> --url <original> [--id <original id>]` recomputes the fingerprint and prints `RESULT: MATCH` (exit 0) or `NO MATCH` (exit 1); exit 2 is a usage error, an unknown post or a database failure; exit 3 means the post has no fingerprint or no key is set. Without `PROVENANCE_KEY` or `AUDIT_HASH_KEY`, an identity-bearing upstream id is stored as `<route>:<unkeyed sha256>` and no fingerprint is recorded.

### Input Sanitization (Route Layer)
All route inputs are validated before reaching the DB layer:

| Input | Where | Validation | Rejection |
|---|---|---|---|
| `:post_id` path param | `/api/audit` | strict UUID `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` | 400 `Invalid post ID: must be a UUID` |
| `from`, `to` | `/api/posts/aggregated-by-location` (query), `/api/query` (body) | `new Date()` must parse | 400 `Invalid from date` / `Invalid to date` |
| `platform` | `/api/posts/aggregated-by-location`, `/api/query` | one of the 8 canonical category slugs (`src/config/categories.js`) | 400, listing the slugs |
| `platform` | `/api/sentiment/latest` | none | an unknown value returns empty results |
| `limit` | `/api/query` (body) | integer, 1–100 | 400 |
| `limit` | `/api/sentiment/latest` (query) | parseInt, clamped to 1–100 | default 20 when absent or not a number |
| `location` | `/api/query` | non-empty string, exact match | 400 |
| `hours` | `/api/bias/history`, `/api/sources/timeseries` | digits only (`/^\d+$/`), clamped to 1–48 | 400 `hours must be an integer` |

Every query is parameterised; table names are never taken from input.

### Rate Limiting
- `POST /api/refresh`: one accepted refresh per minute globally (in-process debounce), one refresh job in flight at a time (409), and a shared-secret `X-Refresh-Token` required when the site is bound beyond loopback. The collection itself runs in the worker.
- Every other endpoint, including `POST /api/query`: no rate limit (public read-only surface). The hot read endpoints are cached for 10 s (§7). The v1.1 limit of 10 requests per minute on `/api/query` is **PLANNED — not implemented as of v1.2.0** (§7).

### Error Responses — No Information Leakage
```javascript
// Good — generic message only
res.status(500).json({ error: 'Internal server error' });

// Never — do not return:
// - Stack traces
// - SQL error messages (contain table/column names)
// - File paths
// - Secrets, including the value of any secret environment variable
```
Environment variable **names** may appear where they tell the operator what to set: the refresh 403 names `REFRESH_TOKEN` (§7), `/api/sources` serves `missing_env`, `kill_switch_env` and `reset_env` and names variables in `status_reason` (§17), and `/api/health`'s `correlation.reason` names the correlation switches and serves the non-secret DPIA reference (§20). No secret value is ever served; future review of this rule is tracked in [issue #36](https://github.com/jennifer-mckinney/pulse-of-ai/issues/36). Every route follows this, and so does the JSON error handler after the routers (`jsonErrorHandler`, `src/server.js`): a malformed or oversized body gets a JSON 400 or 413, never Express's HTML stack page (§7).

### HTTP security headers and CORS
Every response, static assets included, carries `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` (`src/server.js`). No inline script or `style=` attribute is allowed in `index.html`, and client code builds the DOM with `createElement` + `textContent` (no `innerHTML`). CORS (`cors()`) is applied to the read-only routers only; `POST /api/refresh` serves no CORS headers, answers its `OPTIONS` preflight with 403 and checks `Sec-Fetch-Site` / `Origin` / `Referer` itself (§7).

### Network exposure
- **Compose:** `web` publishes its port on `${PULSE_BIND_ADDR:-127.0.0.1}` only; `embeddings` publishes no port (the unauthenticated API is reachable on the compose network only); PostgreSQL, the test database and the Valkey queue store (password-authenticated; compose service `redis`) publish on the same `${PULSE_BIND_ADDR:-127.0.0.1}` address. The `watchdog` (profile `full`) publishes no port.
- **Dev server:** `npm run dev` listens on 127.0.0.1 unless `HOST` or `PULSE_BIND_ADDR` names another address (`listenHost`, `src/server.js`); bound beyond loopback, `POST /api/refresh` requires a token (§7). `python/start.sh` runs the embeddings service on 127.0.0.1 on the host unless `EMBEDDINGS_HOST` names another address, and it warns when that address is not loopback (PR #35). The compose `embeddings` container listens on 0.0.0.0 inside the compose network and publishes no host port.

### Collector network guard (SSRF)
Every collector request and every redirect hop goes through `src/collectors/netguard.js`: https only (no downgrade), no single-label host (the compose service names), no `*.localhost` / `*.local` / `*.internal` / `*.localdomain` / `*.home.arpa`, and every resolved address must be public (loopback, link-local, RFC 1918, CGNAT, ULA, 0.0.0.0/8, 192.0.0.0/24, 198.18.0.0/15 benchmarking, multicast, 240.0.0.0/4 reserved and broadcast, and their IPv4-mapped / NAT64 forms are refused; a host that is not an IP after resolution is refused too). The socket connects to the address the guard resolved, so DNS cannot change between check and connect. A request that carries a credential header or a body is refused any cross-origin redirect.

---

## 9. Bias Monitoring System

### What Runs (`bias@1.6.0`, `src/pipeline/bias.js`, `src/pipeline/bias-window.js`)

Three aggregate checks. None of them infers a trait of a person; they measure the shape of the collected discourse. Thresholds and minimum samples are read from the `bias` methodology row the job resolved (`CURRENT_VERSIONS.bias` = 1.6.0), and every run records that row's id: a job or cycle in `bias_assessments.methodology_version_id` (lineage, migration 010), a rolling-window run in `bias_window_runs` and `bias_window_assessments.methodology_version_id` (migration 060). The version history (1.2.0 to 1.6.0) is at the end of this section.

| Check (`assessment_type` = alert type) | Field | Formula over the job's sentiment-scored posts | Violation | Severity | Citation (config) |
|---|---|---|---|---|---|
| `location_concentration` | `location` | posts in the busiest city / all content-located posts (`share_of_total`); publisher-located posts excluded (D3); at least 30 content-located posts (`location_min_sample`) | > 0.35 (`location_concentration_max`) | `critical` above 0.80, else `warning` | Suresh & Guttag (2021) |
| `platform_sentiment_parity` (displayed as "Demographic parity") | `platform` (source category) | largest pairwise difference of mean `comparative` across the source categories with at least 10 posts (`max_comparative_diff`, `parity_min_per_category`); at least two such categories | > 0.30 (`platform_parity_max_diff`) | `warning` | Barocas & Selbst (2016) |
| `negative_dominance` | `global` | negative posts / all posts (`negative_share`); at least 30 posts (`negative_min_sample`) | > 0.60 (`negative_dominance_max`) | `warning` | Suresh & Guttag (2021) |

- Every check writes one `bias_assessments` row on every run, violation or not, with its evidence. Below its minimum sample the row is recorded with `group_value` 'insufficient sample', the value stated, no violation and no alert: an "insufficient sample" is never a pass.
- A violation also writes an `alert_events` row: `alert_type` = the check name, `severity` as above, `source_table = 'bias_assessments'` (`'bias_window_assessments'` with `details.windowRunId` for a rolling-window run). There is no `bias_violation` alert type in the pipeline (only the e2e fixture writes one).
- "Demographic parity" here is the outcome gap across **source categories**, not across user demographics (`layer_notes` in the config). The critical level (0.80) is a code constant, not a config value.

### When It Runs
- **Scheduled collection:** every source runs on its own schedule, so scheduled runs share one `processing_jobs` row per collection window (`triggered_by 'cron'`). When the window has passed plus a 60 s grace and no run is still in flight (`inflight_runs = 0`), or past the hard age cap, one worker claims the cycle (`status 'closing'`) and runs the three checks **once** over all of the cycle's posts, then completes it (`src/collectors/cycle.js`). A job left `awaiting_retries` is checked once its scoring retries are done.
- **The standup's collection and `npm run collect`** run every source in one job, score inline and run the checks at the end of that job when it scored new posts (`src/collectors/runner.js`). **The demo population** runs them at the end of its batch job, always (`scripts/populate.js`).
- **`POST /api/refresh`** runs every source in one job but scores through the `ingest` queue. When the collection ends with scoring jobs still outstanding, the job waits as `awaiting_retries` and the cycle closer runs the checks once they have scored (`src/collectors/cycle.js`). When every scoring job has already finished, the runner finalizes the job itself the same way: `posts_processed` is counted from `decision_audit_log` and the checks run once when it is above 0 (PR #24, `cycle.jobPostsProcessed`).
- A scheduled cycle that scored no posts, and an inline collection job that scored no new post, run no checks.
- **Rolling 24 h window (introduced by bias@1.5.0; runs the current bias version):** the same three checks over every post whose sentiment decision was recorded in the previous 24 hours, daily (the maintenance `daily` task, §19) and on demand (`npm run bias:window`), whatever the cycles did (`src/pipeline/bias-window.js`). Details at the end of this section.

### Source health alerts (`source_refused`, `source_stale`, `source_failing`)
Not bias checks, but they share the alert path (`src/collectors/source-health.js`, run on every 30 s tick of the worker's cycle timer, after the cycle-close pass). A source that refuses access puts itself in the refused state (§17) and opens one **critical** `source_refused` alert per refusal episode (`src/collectors/state.js`). A collecting source with no new post for longer than its registry's `expectedNewWithinHours` (measured from `last_new_post_at`, else the fixed `freshness_anchor_at`, migrations 033 and 037) opens a `source_stale` **warning**; three or more consecutive failed runs open a `source_failing` **warning**. Each has `source_table = 'data_sources'` and `source_id` = the source, at most one open per type and source (migration 038), and is resolved with an `alert_resolutions` row as soon as its condition clears or the source stops collecting.

### Alert Flow
```
bias check violation ──┐    per-source alert ──┐    watchdog ──┐
(per job or 24 h window)│  (refused, stale,     │  (§14)        │
                       │   failing, retention  │               │
                       │   overdue, terms)     │               │
                       ▼                       ▼               ▼
        alert_events INSERT (alert_type = check name | source_* |
                             retention_overdue | terms_changed | watchdog_*,
                             severity 'warning' | 'critical')
                       │
                       ▼
GET /api/health → active_alerts (every unresolved alert_events row)
                       │
                       ▼
Header status chip → yellow (warning) or red (critical); a watchdog alert
                      shows as a red SYSTEM ALERT
                       │
                       ▼
Health drawer → GET /api/bias/history (12 h window, lineage-resolved layer
                names and citations) + GET /api/sources (per-source status)
```
An alert is closed by writing an `alert_resolutions` row (who, why, evidence; append-only, migration 028) when its condition clears, or as `superseded` by a later methodology version with a named approver (migration 036, decision G1); it is never deleted. `GET /api/bias/latest` remains for API consumers; the page does not call it. The audit receipt shows the fairness layers of the post's own job (`bias` block, §7).

### Not yet implemented
- **PLANNED — not implemented as of v1.2.0:** the v1.1 three-layer stack below. Every bias version from 1.1.0 to 1.6.0 lists equalized odds and counterfactual fairness as `planned_layers` ("Phase 3 — not yet enforced"), which the receipt shows as not applicable. (The minimum samples, audited alert resolution and decision D3, listed here as in flight in the v1.2.0 draft, landed with PR #22 as bias@1.2.0 to 1.4.0; see below.)

#### v1.1 three-layer stack (PLANNED — not implemented as of v1.2.0)

**Layer 1: Demographic Parity (fast, runs every job)**
```
P(indicator='positive' | group=A) vs P(indicator='positive' | group=B)

Threshold: difference > 0.10 → warning
           difference > 0.20 → critical

Applied to: location, platform, source_type
```

**Layer 2: Equalized Odds (medium complexity, runs every job)**
```
TPR: P(predicted_positive | true_positive, group=A) vs group=B
FPR: P(predicted_positive | true_negative, group=A) vs group=B

Threshold: |TPR_A - TPR_B| > 0.08 → warning
           |FPR_A - FPR_B| > 0.08 → warning

Note: Requires labeled ground truth. Phase 1 approximates using
confidence score as proxy. Full implementation in Phase 2 with
RoBERTa confidence scores.
```

**Layer 3: Counterfactual Fairness (expensive, runs on 5% sample daily)**
```
Take sentence: "Discussion about AI X"
Swap demographic marker in content
Re-score with same model
Measure confidence difference

Threshold: |confidence_A - confidence_B| > 0.05 → flag for review
```

#### v1.1 bias metrics table, with status

| Metric | Field | Formula | v1.1 threshold | Severity | Source | Status on `master` |
|---|---|---|---|---|---|---|
| Location concentration | location | max(posts_per_loc / total) | > 0.60 | warning | Evidence-based thresholds doc | **Superseded:** implemented at > 0.35, critical above 0.80 (`bias@1.1.0` to `bias@1.6.0`) |
| Negative dominance | global | negative / total | > 0.70 | warning | Evidence-based thresholds doc | **Superseded:** implemented at > 0.60 (`bias@1.1.0` to `bias@1.6.0`) |
| Platform parity | platform | \|avg_comp_A − avg_comp_B\| | > 0.30 | warning | Research literature | Implemented as specified (max pairwise, across source categories) |
| Demographic parity diff | group | \|P(pos\|A) − P(pos\|B)\| | > 0.10 | warning, > 0.20 critical | AI Act fairness guidance | **PLANNED — not implemented as of v1.2.0** |
| Equalized odds | group | \|TPR_A − TPR_B\| | > 0.08 | warning | Hardt et al. 2016 | **PLANNED — not implemented as of v1.2.0** |
| Counterfactual fairness | sample | \|conf_A − conf_B\| | > 0.05 | review flag | Russell et al. 2017 (config cites Kusner et al. 2017) | **PLANNED — not implemented as of v1.2.0** |
| Source concentration | source | max(posts_per_source / total) | > 0.40 | — | Evidence-based thresholds doc | **PLANNED — not implemented as of v1.2.0** |

**Location basis (bias@1.2.0, migration 027; ADR 0001 decision D3 — "Separate layer, excluded from bias.").** Location concentration counts only posts located by their content (or with no recorded basis). Posts placed at the publisher's home city (`raw_payload.location_basis = 'publisher'`) are excluded, and the assessment's evidence records `excluded_location_bases` and `excluded_posts`. The globe shows them as a separate, labelled publisher-location layer (a dashed ring), with a legend key and tooltip wording.

**Minimum sample (bias@1.3.0, migration 028; P10-5).** Location concentration needs at least 30 content-located posts in the job; below that the assessment is recorded as "insufficient sample" (share stated, no violation, no alert) and the receipt shows the layer as n-a. Stale alerts are resolved through `alert_resolutions` (migration 028), never deleted.

**A minimum sample for every check (bias@1.4.0, migration 032).** Platform sentiment parity compares only source categories with at least 10 posts in the job (fewer than two such categories: "insufficient sample"); negative dominance needs at least 30 posts; location concentration keeps bias@1.3.0's 30 content-located posts. Below a minimum the value is recorded with no violation and no alert. Open alerts this version would not raise were closed as `superseded` with Jennifer McKinney as the named approver (ADR 0001, decision G1), separate from genuinely `resolved` alerts. A job with no content-located posts, a single source category or no posts at all is below these minimums too, so it is recorded as "insufficient sample", never as a pass (PR #22 grumpy M5).

**A rolling 24 h window (bias@1.5.0, migration 060; decision G2, Jennifer McKinney 2026-09-29).** A 2–3 minute cycle rarely reaches the minimums, so the same three checks, with the same thresholds and minimums, ALSO run over every post whose sentiment decision was recorded in the previous 24 hours: daily (the `bias_window` step of the maintenance `daily` task, §19) and on demand (`npm run bias:window`). Each run is a `bias_window_runs` row (window, trigger, version, status, posts assessed, violations); its assessments are append-only `bias_window_assessments` rows; a violation opens an alert naming the window run (`details.windowRunId`). The per-cycle checks are unchanged. The share of "insufficient sample" assessments per check (per cycle over 24 h and 7 days; for the rolling window, the latest run and 7 days) is served as `insufficient_sample` by `GET /api/bias/latest` and as `bias_sample` by `GET /api/health`, so a monitor that never reaches its minimum is visible.

**The parity value below its minimum (bias@1.6.0, migration 061; PR #24).** An "insufficient sample" platform-parity row now records the largest pairwise gap in mean comparative sentiment across all the job's categories (0 with fewer than two), still with no violation and no alert (`parity_insufficient_value`). bias@1.4.0 and 1.5.0 recorded 0 there; each carries an erratum (`methodology_errata`). Everything else is bias@1.5.0.

---

## 10. Governance & Audit Architecture

### The Explainability Chain

Every inference follows this chain. All links are navigable from a single post ID:

```
raw_posts.id
    → raw_posts.provenance_fingerprint, source_id, external_id (provenance, D2)
    → raw_posts.ingest_mv_id → methodology_versions (ingest version it was stored under)
    → raw_posts.admission_mv_id → methodology_versions (admission_filter version, 042)
    → decision_audit_log.raw_post_id
        → decision_audit_log.methodology_version_id
            → methodology_versions.justification (plain English)
            → methodology_versions.config (exact parameters used)
        → decision_audit_log.output (full scored result)
        → decision_audit_log.input_hash (SHA-256 of what was analyzed; exposed only as an HMAC)
        → decision_audit_log.job_id
            → bias_assessments.job_id → bias_assessments.methodology_version_id (bias lineage)
    → sentiment_results / relevance_results / discourse_results .audit_id (derived display data)
```

**Lineage.** The pipeline records the version it ran (`CURRENT_VERSIONS` in `src/config/methodology-registry.js`), never "latest by effective_from". A receipt names the version that **produced** each fact: bias rows carry `methodology_version_id` (lineage `recorded`); rows from before migration 010 are resolved from `effective_from` at read time (`inferred`, `src/config/bias-lineage.js`); a post whose job produced no assessment shows the `current` version. The ingestion step works the same way from `raw_posts.ingest_mv_id` (migration 022).

**Reproduce.** `npm run replay -- --post <id>` re-runs the stored decisions through `src/pipeline` and prints PASS / DIVERGENCE / NOT RE-RUNNABLE per stage (`src/audit/replay.js`). A post whose text was removed by retention (§19) is NOT RE-RUNNABLE (its content hash no longer matches). `npm run verify-provenance` proves where a post came from (§8).

### Responding to "Why?" by Audience

The receipt renders every step in four audience views (`audit_narration@1.5.0`, `src/config/audit-narration.js`; the drawer's segmented control in `public/js/ui.js`):

| View (payload key) | Who | What they get from `GET /api/audit/:post_id` |
|---|---|---|
| Public (`public`) | General public | A jargon-free sentence per step. The relevance step says what counts today: a post that matched the AI topic list "counts toward the AI-discourse totals"; one that did not "still counts toward the AI-discourse totals" today, and from the next relevance version only AI-relevant posts will count (`audit_narration@1.5.0`, `RELEVANCE_PUBLIC`). The page's bundled demo receipt states the same step conditionally: a fictional post is never stored, so it counts toward nothing |
| Journalist (`plain`) | Journalist: "Why does this city score negative?" | A plain-English explanation with the cue phrases and scores |
| Regulator (`config`) | Regulator: "What algorithm made this decision?" | A key/value table: thresholds, versions, legal basis |
| Researcher (`researcher`) | Researcher: "Can I reproduce this score?" | Cue weights and the reproduce command (`npm run replay -- --post <id>`), next to the keyed input fingerprint, model_name, config and output. The API exposes `input_hash` as HMAC-SHA256(`AUDIT_HASH_KEY`, stored hash), never the raw content hash (prevents offline hash-confirmation of post content); consumers verify content in their own systems. The ingestion step states that the content hash is an integrity check recorded as `input_hash`, not a join key (`audit_narration@1.4.0`) |

The v1.1 "Internal audit" question ("Did methodology change between runs?") is answered by lineage, not by a view: each step names its `model@version`, `GET /api/methodology` lists every non-deprecated version (`deprecated_at IS NULL`; no migration or script on `master` sets `deprecated_at`, so today that is every version) with its `effective_from` and its errata (`methodology_errata`, migration 030), and `decision_audit_log.job_id` ties each decision to its run.

### Admission filter as methodology (PR #22, decision G6)

The collection admission filter (`src/collectors/ai-filter.js`) decides which items of a site-wide or technology feed are stored at all, so it is the versioned component `admission_filter` (1.0.0, migration 042). Its registered config is exactly the code's patterns, search terms and scope rule (a unit test fails on any difference); a change is a new version. Every collected post records the version it was admitted under (`raw_posts.admission_mv_id`), shown on the audit receipt as `provenance.admission`.

### Methodology Registration and Seeding
`src/config/methodology-registry.js` is the single source of truth for every `methodology_versions` row. `scripts/seed.js` inserts every row (`ON CONFLICT (component, version) DO NOTHING`); migrations 009, 011, 012, 014, 015, 017, 024, 026, 027, 028, 029, 031, 032, 042, 055, 060, 061, 065, 066 and 067 insert the same rows so a database that is only migrated serves identical receipts, and `tests/unit/pure/methodologyRegistry.test.js` asserts field-for-field equality. A released row is never edited: a config or wording change ships as a new version row and a new migration, and a correction to a released row is recorded as an erratum (`methodology_errata`, migration 030).

```javascript
// src/config/methodology-registry.js — the first row
{
    component: 'sentiment',
    version: '1.0.0',
    model_name: 'afinn-sentiment-npm-v5.0.2',
    config: {
        positive_threshold: 0.05,
        negative_threshold: -0.05,
        accuracy_target: 0.99,
        accuracy_note: 'Phase 1 baseline — validates audit pattern. RoBERTa v2.0.0 targets 99% on benchmark.',
    },
    justification: 'AFINN-165 English word list (Nielsen 2011). …' // full text
}
```

Registered components on `master` (29 rows): sentiment (**1.0.0**), relevance (1.0.0, 1.1.0, **1.2.0**), discourse (1.0.0-DQI, **1.1.0-DQI**), bias (1.1.0 to **1.6.0**), ingest (1.0.0 to **1.8.0**), audit_narration (1.1.0 to **1.5.0**), embedding (1.0.0, **1.1.0**), admission_filter (**1.0.0**); bold = the version the code runs (`CURRENT_VERSIONS`). 15 errata (`METHODOLOGY_ERRATA`): relevance 1.0.0; bias 1.4.0, 1.5.0; ingest 1.0.0–1.7.0 (corrected by ingest@1.8.0); audit_narration 1.1.0–1.4.0 (relevance wording, corrected by audit_narration@1.5.0, migration 067). A `demographic` component is **PLANNED — not implemented as of v1.2.0**.

---

## 11. End User Experience Design

The shipped frontend follows the FuN.zip design-handoff prototype, which Jennifer ruled the master contract on 2026-09-28: "what is in the FuN.zip front end prototype needs to be supported in the backend". PRD §4.3 (FR-17 to FR-25) is the requirement of record. The globe.gl / Mapbox design of `docs/plans/2026-07-05-globe-storytelling-design.md` and the Scrollama / D3 plan of v1.1 are superseded.

### Primary Personas (from MVP requirements doc)

**Persona 1: The Journalist (primary)**
- Goal: Find story angles in <2 minutes
- Entry point: the globe and the overview beat, rendered on page load; the header "time to insight" timer freezes at the first opened receipt
- Flow: scroll the 11 beats → drill into a city → open a post's receipt ("Why does it say that?") → cite model, version and numbers
- Key feature: every featured post and city post has a "why?" path to `GET /api/audit/:post_id`
- Device: Desktop primarily, tablet and 375 px mobile supported

**Persona 2: The Researcher**
- Goal: Verify methodology, reproduce findings
- Entry point: `GET /api/methodology` and the receipt's Researcher view
- Flow: API-first; `GET /api/audit/:post_id` for spot checks, `npm run replay` to reproduce, `POST /api/query` for slices
- Key feature: lineage-resolved methodology versions on every step (§10)

**Persona 3: The Policy Maker**
- Goal: Monitor for bias incidents, track sentiment over time
- Entry point: the header health chip (green / yellow / red)
- Flow: chip → health drawer (sources online, per-source status, 12 h alert history; a pass summary whose latest row had an insufficient sample shows N/A, not PASS, §7) → a flagged layer's value, threshold and citation
- Key feature: traffic-light status re-polled on the refresh cadence

**Persona 4: The General Public**
- Goal: Understand how the world feels about AI without technical background
- Flow: the scroll story states one insight per beat; explore mode afterwards; the receipt's Public view

### Page Structure and Modules
`public/index.html` loads UMD modules in contract order, with no build step and every asset self-hosted (fonts and the world-atlas land GeoJSON under `public/vendor/`):
- `js/config/` — `design.config.js` (themes, sentiment palette, the 8-category canon, buckets), `api.config.js` (endpoints, refresh cadence), `story.config.js` (the 11 beats, data only), `cities.config.js` (the city registry, shared with the server), `legal.config.js` (the legal notice, §21; added by the `docs/diagrams-and-readme` branch)
- `js/attribution.js` (K1: the link-safety rule and the credit model and builder, shared with the server; loaded before `utils.js`, which re-exports it), `js/utils.js`, `js/data.js` (fetch, normalise, demo fallback, data mode), `js/insights.js`, `js/chapters.js` (beat copy resolver)
- `js/globe.js` — Canvas-2D orthographic dot globe; posts placed at their publisher's home city (`publisher_posts`, decision D3) are drawn as a separate, dashed-ring publisher-location layer with a legend key and tooltip; a ranked city list (name, volume, sentiment) replaces the globe when canvas is unavailable
- `js/story.js` — scroll story, progress rail, skip pill, legend; `js/ui.js` — explore filters and city list, city detail, tooltip, source ribbon, audit drawer, health drawer (with a SYSTEM WATCHDOG section, §14); `js/main.js` — shell bootstrap, health chip (a red SYSTEM ALERT while a watchdog alert is open), timer, legal-notice panel; `credits.html` with `js/credits.js` and `styles/credits.css` — the credits page (K1), a second page that reads `GET /api/credits`

Modules talk through `pulse:*` DOM events (`pulse:data`, `pulse:exploring-changed`, `pulse:drill`, `pulse:trace`).

### The 11 Beats (`public/js/config/story.config.js`)

| # | id | Kicker | Colour / bars |
|---|---|---|---|
| 0 | `overview` | REFRESH CYCLE 2–3 MIN (by data mode: LIVE · / DEMO · / LIVE + DEMO / NO POSTS IN THE LAST HOUR / DEMO · BUNDLED SAMPLE DATA) | sentiment / volume |
| 1 | `volume` | CHAPTER 01 · VOLUME LEADERS | sentiment / volume |
| 2 | `divide` | CHAPTER 02 · THE DIVIDE | sentiment / volume |
| 3 | `negativity` | CHAPTER 03 · NEGATIVITY HOTSPOTS | sentiment / negativeNet |
| 4 | `positivity` | CHAPTER 04 · POSITIVITY LEADERS | sentiment / positiveNet |
| 5 | `drivers` | CHAPTER 05 · WHO’S DRIVING | category / volume |
| 6 | `themes-warm` | CHAPTER 06 · WHAT RUNS WARM | warm / volume (warm half of `/api/themes`) |
| 7 | `themes-cold` | CHAPTER 07 · WHAT RUNS COLD | cold / volume (cold half of `/api/themes`) |
| 8 | `messengers` | CHAPTER 08 · THE MESSENGERS | category / volume |
| 9 | `summary` | CHAPTER 09 · THE HOUR IN REVIEW | sentiment / volume |
| 10 | `explore` | CHAPTER 10 · YOUR TURN · NEXT STEPS | sentiment / volume (free exploration) |

Each beat sets a camera intent, a colour mode (`sentiment` | `category` | `warm` | `cold`), a bar metric, a highlight rule, an audit pick and declarative stats; `js/chapters.js` resolves the `{token}` copy from the loaded data, so no insight value is hard-coded. The exact per-beat encodings are in `story.config.js` and are locked by `tests/unit/pure/config.test.js`.

### Data Sources of the Page
`GET /api/posts/aggregated-by-location` (the snapshot), `/api/query` (city drill-down posts), `/api/audit/:post_id` (receipts), `/api/health` (chip, re-polled every 150 s), `/api/health` + `/api/bias/history` + `/api/methodology` + `/api/sources?include_inactive=true` (health drawer), `/api/sources` (story stats), `/api/sources/timeseries` (ribbon), `/api/themes` (beats 6 and 7); `credits.html` alone calls `/api/credits`, with its own constant rather than `api.config.js`. `api.config.js` also lists `/api/bias/latest` and `/api/refresh`, but no module calls them.

### Demo Labelling
Demo numbers are never presented as live. `data.js` derives a data mode from the snapshot's `demo_posts` counts (`live` | `demo` | `mixed` | `none`), or `fallback` when the API is unreachable or holds no posts, and the bundled deterministic demo set is rendered. Every mode that includes demo posts (`demo`, `mixed`, `fallback`) shows the "Demo data" markers, and the overview kicker states the mode. In `fallback` mode, posts and receipts are synthesised locally (fictional, nothing stored) and their ids are never sent to `/api/audit`; a demo-feed post stored in the database (`demo` / `mixed` mode) is fetched from `/api/audit` like a live post and labelled DEMO DATA from its `data_origin`. Server-side demo posts come only from demo feeds (`data_sources.source_type = 'demo'`, text prefixed `[Demo]`) and are reported with `data_origin: "demo"`.

### Source credits and links back (K1)
Every excerpt names its source and links to the original, so a reader can check it and the source is credited. `js/attribution.js` builds one credit line from a post row and the city list, the chapter 3 and 4 mini-post, the audit drawer (its error state too) and the receipt all use it: "via NPR · npr.org ↗", then where they apply the licence link where the registry has a `licenseUrl` (Wikipedia, Stack Overflow, Our World in Data, arXiv), "excerpt shortened and redacted" (a CC BY licence needs changes indicated), the publication date (Pew), and the notice a source's terms require (arXiv, PubMed). The link text is the destination's host; the element is built with `createElement` and `textContent` only, `href` is set only after the browser re-validates the address with the same function the server uses, and the link opens in a new tab with `rel="noopener noreferrer"`. Without a validated link the credit shows alone. A demo post, a stored demo-feed post and a local fallback post show "fictional demo post · no real source" instead, with no credit and no link, consistent with the "Demo data" markers below; a row labelled with a slug the registry does not know shows no credit. The header "credits" chip opens `credits.html`, which lists each source that has stored posts with its credit, licence, terms link and notice, and the three site notices of `GET /api/credits`.

The credits are about the third-party content shown. They are separate from the Appropriate Legal Notices (below and §21), which are about the software and sit in the About panel; `credits.html` also carries those six lines at its foot as static markup, because it is a second page of the UI.

### Legal Notices
The header "about" chip opens a panel with the Appropriate Legal Notices of §21; `index.html` repeats them in `<noscript>`. The UI and the licence arrived with PR #40.

### Page Load Priority (Performance Budget: <3s)

```
Priority 1 (immediate): header, scroll spacer, globe canvas with land geometry
Priority 2 (on data):   city markers from /api/posts/aggregated-by-location; overview beat copy; then /api/themes and the beats' featured posts (/api/query)
Priority 3 (on demand): /api/sources/timeseries (explore ribbon), city drill-down, receipts and drawers
```

### Color System (`public/js/config/design.config.js`)
| Purpose | Hex |
|---|---|
| Positive sentiment | #3BDCB2 |
| Neutral sentiment | #7E8AA0 |
| Negative sentiment | #FF6E5E |

Themes (default "Midnight") and the 8 category colours are defined in the same file, which is shared by the globe, legend, chips and ribbon. The v1.1 Seaborn palette is superseded.

### Accessibility Requirements
- Colour is never the only indicator: a numeric score sits next to every sentiment colour
- Pointer Events for drag, hover, tap and pinch; keyboard zoom step; `prefers-reduced-motion` stops auto-spin, drift and pulse rings
- The health chip and the about chip expose `aria-expanded` (the about chip also `aria-disabled="true"` while a drawer is open); the about panel closes on Escape or a chip click, and focus that was inside it returns to the chip
- A ranked city list replaces the globe when canvas is unavailable
- Font contrast ratio ≥ 4.5:1 (AA standard) and screen-reader-compatible structure remain targets; no automated contrast audit runs today

**PLANNED — not implemented as of v1.2.0:** D3 demographics, topic-tree and discourse-quality charts (v1.1 Phase E); aria-labels on individual globe markers (the globe is a single canvas).

---

## 12. Embedding & Vector Search

### Model: `sentence-transformers/all-MiniLM-L6-v2`

| Property | Value |
|---|---|
| Dimensions | 384 |
| Parameters | 22.7M (22,713,728, [Hugging Face model metadata at the pinned revision](https://huggingface.co/api/models/sentence-transformers/all-MiniLM-L6-v2/revision/1110a243fdf4706b3f48f1d95db1a4f5529b4d41)) |
| Disk size | ~91 MB (float32 weights, `model.safetensors` 90,868,376 bytes at the pinned revision) |
| Encoding speed | 14,200 sentences/s on a V100 GPU ([sbert.net pretrained models](https://www.sbert.net/docs/sentence_transformer/pretrained_models.html)); no CPU figure is published by that source or measured by this project |
| Benchmark quality | 68.06 average over 14 sentence-embedding tasks, 49.54 over 6 semantic-search tasks ([sbert.net pretrained models](https://www.sbert.net/docs/sentence_transformer/pretrained_models.html)); the Hugging Face model card at the pinned revision publishes no benchmark score |
| Chosen over `all-mpnet-base-v2` | About 5x faster (14,200 vs 2,800 sentences/s, V100) for 1.51 points on sentence embeddings (68.06 vs 69.57) and 7.48 on semantic search (49.54 vs 57.02), same source — acceptable for trend monitoring |

### Deployment: the embeddings service (`python/embeddings_service.py`)

A FastAPI app over sentence-transformers, built as the compose service `embeddings`. It publishes no port: only the worker (`POST /embeddings`, then `GET /health` to verify the service before it stamps the vector) and the demo `populate` role (`GET /health`, its readiness check) reach it, on the compose network.
- `POST /embeddings` — OpenAI-compatible: `{ "input": [text], "model": "…" }` → `{ "data": [ { "index": 0, "embedding": [384 floats] } ] }`; vectors are L2-normalised.
- `GET /health` — `{ status, model, revision, library, … }`; `library` is `sentence-transformers==<installed version>`, in the form of the embedding methodology row's `config.library`.
- The model is loaded at a pinned Hugging Face commit (`EMBED_MODEL_REVISION`, default `1110a243fdf4706b3f48f1d95db1a4f5529b4d41`) with sentence-transformers 6.1.0 (transformers 5.18.0, huggingface_hub 1.33.0, tokenizers 0.23.2, torch 2.12.1+cpu; hash-locked in `python/requirements-service.txt`), registered as `embedding@1.1.0` (migration 065; it supersedes `embedding@1.0.0` of migration 012, sentence-transformers 2.7.0, whose vectors were bit-identical on the comparison set and are not re-embedded). Every new vector records `1.1.0` in `post_embeddings.methodology_version` only when the worker's `EMBED_MODEL` / `EMBED_MODEL_REVISION` are the registered ones and the service's `GET /health` reports the registered model, revision and library (NULL otherwise, see the `embed` worker below); vectors stored earlier keep `1.0.0`.
- Host development: `python/start.sh` runs uvicorn on port 8000 (on 127.0.0.1 unless `EMBEDDINGS_HOST` is set, see §8). `python/requirements.txt` pins sentence-transformers 6.1.0 and the registered library dependencies exactly (transformers 5.18.0, huggingface_hub 1.33.0, tokenizers 0.23.2), reads the PyTorch CPU index and pins torch 2.12.1+cpu (plain 2.12.1 on macOS, which has no `+cpu` wheel: the same release, not the registered build); `tests/unit/pure/embeddingLibraryPins.test.js` fails when it, `python/requirements-service.in`, the lock and the registry drift apart.

**PLANNED — not implemented as of v1.2.0: Infinity (`infinity-emb`) as the production server.** v1.1 chose it for dynamic batching, a ctranslate2 backend ([Infinity README](https://github.com/michaelfeil/infinity)) and the same OpenAI-compatible API, so it can replace the FastAPI service without Node changes:
```bash
pip install "infinity-emb[all]"
infinity_emb v2 \
  --model-id sentence-transformers/all-MiniLM-L6-v2 \
  --revision 1110a243fdf4706b3f48f1d95db1a4f5529b4d41 \
  --batch-size 64
```
(Infinity CLI `v2`, [Infinity README](https://github.com/michaelfeil/infinity); model warm-up is on by default, [`infinity_emb/env.py`](https://github.com/michaelfeil/infinity/blob/main/libs/infinity_emb/infinity_emb/env.py) `model_warmup` default `true`.)
The code comments name the FastAPI service that runs and describe Infinity as the planned alternative (`src/pipeline/embeddings.js`, `python/embeddings_service.py`, `python/requirements.txt`); only the header comment of migration `004_vector_support.sql` still says the embeddings are generated by "the Infinity service".

### Node.js Integration (`src/pipeline/embeddings.js`, `src/workers/embed.worker.js`)
- One `embed` job is queued per new post whose relevance score is at least 1/21 (one lexicon match; `relevance@1.2.0` `embed_gate_min_score`): by the `ingest` worker after scoring for scheduled and refresh runs (job id `embed-<post id>`, so at most once), and by the runner for inline runs (`npm run collect`, the standup). The demo population (`scripts/populate.js`) queues the demo posts it writes without the relevance gate, but only when the run has embeddings enabled and the service is ready (`GET /health` reports `model_loaded: true`): when the standup finds the service not ready it passes `--no-embed`, and that run stores and scores its posts (live and demo) with no embed jobs. A later `populate --once` with the service ready backfills every trailing-hour demo post that still has no embedding.
- The `embed` worker (concurrency 4) calls `POST ${EMBEDDINGS_SERVICE_URL}/embeddings` with the model name (the revision is fixed on the service by `EMBED_MODEL_REVISION`) and upserts `post_embeddings`, recording the registered embedding version (`embedding@1.1.0`, the last `embedding` row of `src/config/methodology-registry.js`) only when its own `EMBED_MODEL` / `EMBED_MODEL_REVISION` are the registered ones AND, read right after the service produced the vector, `GET ${EMBEDDINGS_SERVICE_URL}/health` reports the registered model, revision and library (`verifiedMethodologyVersion` in `src/pipeline/embeddings.js`, one GET per job so a service replaced while the worker runs is noticed at once). On a mismatch, or a `/health` that answers without those fields (for example HTTP 404), the vector is stored with `methodology_version` NULL and each distinct mismatch is logged once per process; a `/health` that cannot be read (network error, timeout, HTTP 5xx) fails the job, so it is retried and no unverified stamp is stored. A failure is retried by BullMQ with exponential back-off (5 attempts). A job whose post was purged (a demo post at the retention boundary) or whose text was removed by retention completes as a no-op with the reason recorded, and never embeds a removal notice; the demo purge also removes the pending embed jobs of the posts it deletes (`src/queues/embed-cleanup.js`).
- There is no in-process embedding cache; the v1.1 `content_hash → vector` cache is not implemented (duplicates are dropped per source by `(source_id, external_id)`; the content hash plays no part).

### Vector Index: HNSW

```sql
-- HNSW chosen over IVFFlat (external benchmark, source below; not measured here)
-- Benchmark: HNSW achieves 40.5 QPS vs IVFFlat's 2.6 QPS at 0.998 recall (about 15.6x faster)
-- Build time trade-off: HNSW ~4065s vs IVFFlat ~128s (acceptable: one-time cost)
-- Storage trade-off: HNSW ~729MB vs IVFFlat ~257MB (on the benchmark's 1M 50-dimension vectors)
CREATE INDEX idx_embeddings_hnsw ON post_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 400);
```
Source of the benchmark figures: [Tembo, "Vector Indexes in Postgres using pgvector: IVFFlat vs HNSW", 2023-11-14](https://web.archive.org/web/20241206165814/https://tembo.io/blog/vector-indexes-in-pgvector) (archived copy; the original tembo.io URL no longer serves the post): about 1M vectors of 50 dimensions, 10K queries for the 10 nearest neighbours, one query thread; IVFFlat `lists = 200`, `probes = 100`; HNSW `m = 24`, `ef_construction = 200`, `ef_search = 800`. The post rounds 40.5 / 2.6 to "15.5X"; the quotient is 15.6. The times and sizes hold for that dataset and those parameters, not for this table's 384-dimension vectors or its `m = 16`, `ef_construction = 400`. Migration `004_vector_support.sql` repeats the QPS and build-time figures in its header comment without the source (released migrations are not edited).

### Use Cases for Vector Search
Nothing on `master` queries the vectors yet; they are stored for the uses below.
1. **Deduplication**: implemented without vectors, on `(source_id, external_id)` at insert (§8)
2. **Similar post retrieval**: `POST /api/similar/:post_id` — **PLANNED — not implemented as of v1.2.0** (Phase 2)
3. **Topic clustering**: Group semantically similar posts — replaces BERTopic — **PLANNED** (Phase 2)
4. **Semantic search**: Free-text search across discourse — **PLANNED** (Phase 3)
5. **DQI novelty and argument clusters** (§18) — **PLANNED**

---

## 13. Implementation Phases (TDD)

**Status (v1.2.1):** Phases A to E are done on `master`; the lists below are the original plan, kept for traceability, with the deviations marked. Later work landed as PR #8 (story frontend), PR #9 (one-command standup), PR #10 (source collectors, ADR 0001) and PR #22 (PR #10 Part 2: collection hardening, maintenance schedule, rolling bias window, watchdog, Valkey); then PR #24 (refresh-job finalization and bias attribution, `bias@1.6.0`, `scripts/seed-demo.js` removed), PRs #25, #26 and #32 (Dependabot, black target, CPU-only torch in CI), PR #33 (refusal probation and refusal headers, the Internet Archive 304 fix), PR #34 (`embedding@1.1.0`, sentence-transformers 6.1.0), PR #35 (`python/start.sh` binds 127.0.0.1, `EMBEDDINGS_HOST`), PRs #37 and #39 (compose web gets the retention grace and pool settings; `CORRELATION_MIN_CONFIDENCE` dropped and blanked on the worker), PR #38 (`ingest@1.8.0` / `audit_narration@1.4.0`, content-hash wording, migration 066), PR #41 (the embedding library stack and torch pinned in `python/requirements.txt`; the image lock moved to fastapi 0.141.1 / uvicorn 0.54.0 to match its floors), PR #43 (a future `SOURCE_<SLUG>_RESET` is ignored, the pre-062 `last_refused_at` carry, the insufficient-sample N/A, the embeddings service's library verified before a vector is stamped, deterministic bias evidence order) and PR #44 (Retry-After holds of the host persisted in `http_cache`, TLDR at 180 s, the fixture scripts refuse a non-e2e database, the manual legacy seed re-attribution script); PRs #13–#21, #23, #27, #28 and #31 are dependency bumps.

### TDD Rule: Every component follows Red → Green → Refactor
Write the failing test first. Write only enough code to make it pass. Refactor. Never write production code without a failing test.

### Phase A: Infrastructure (Pre-coding Setup)

All of these must be complete before writing a single feature:

1. `docker-compose.yml` — `pgvector/pgvector:pg16` (pinned by digest) + postgres_test (now also redis (Valkey 8), migrate, web, worker, embeddings, watchdog, populate)
2. `.env.example` + `.env` + `.gitignore` entries
3. `package.json` — add `pg`, `pgvector` (the plan named `@pgvector/pg`), `jest`, `supertest`; remove `sqlite3`
4. `jest.config.js` + `tests/setup.js` (test DB connection + migration + truncate)
5. `src/db/migrations/001–004.sql` — the first four migration files (54 today, 001–074, §6)
6. `scripts/migrate.js` — runs migrations in order, idempotent
7. `scripts/seed.js` — inserts data_sources rows + initial methodology_versions
8. `src/db/connection.js` — pg Pool, `dbAll()`, `dbGet()`, `dbRun()` Promise helpers
9. `python/requirements.txt` + `python/embeddings_service.py` skeleton (health endpoint only)

### Phase B: Pipeline (TDD)

**Order of test-then-implement:**

```
tests/unit/db.test.js           → src/db/connection.js
tests/unit/sentiment.test.js    → src/pipeline/sentiment.js
tests/unit/relevance.test.js    → src/pipeline/relevance.js
tests/unit/ingest.test.js       → src/pipeline/ingest.js
tests/unit/bias.test.js         → src/pipeline/bias.js
```

### Phase C: API Routes (TDD)

```
tests/integration/api.health.test.js    → src/routes/health.js
tests/integration/api.posts.test.js     → src/routes/posts.js
tests/integration/api.sentiment.test.js → src/routes/sentiment.js
tests/integration/api.refresh.test.js   → src/routes/refresh.js
tests/integration/api.audit.test.js     → src/routes/audit.js
tests/integration/api.bias.test.js      → src/routes/bias.js
tests/integration/api.methodology.test.js → src/routes/methodology.js
```

### Phase D: Embeddings

```
python/tests/test_embeddings.py         → python/embeddings_service.py (full)
tests/unit/embeddings.test.js           → src/pipeline/embeddings.js
tests/integration/api.similar.test.js  → src/routes/similar.js (PLANNED — not implemented as of v1.2.0)
```

### Phase E: Frontend (back to front, last)
Only after all backend tests pass. **As built:** the FuN.zip prototype frontend (§11): Canvas-2D globe, 11-beat story, explore mode, audit and health drawers, demo labelling; `map.js` was removed; the health chip is driven by `/api/health`. The v1.1 items "wire `main.js` to `/api/sentiment/latest`", "integrate Scrollama" and "D3.js demographics and topics charts" were not built: the first two are superseded by the prototype, the D3 charts stay **PLANNED — not implemented as of v1.2.0**.

---

## 14. Quality Gates & Success Metrics

### Must Pass Before Commit
- All tests pass (`npm test`)
- Coverage ≥ 80% (`npm run test:cov`)
- No hardcoded secrets or file paths in code
- No SQL interpolation (parameterized queries only)

### Performance Targets
| Metric | Target | How to Measure |
|---|---|---|
| Page load | < 3s | Chrome DevTools Lighthouse |
| DB query (aggregated-by-location) | < 500ms | EXPLAIN ANALYZE |
| Data refresh interval | 2–3 min | one BullMQ job scheduler per collecting registry source (none on a fresh clone; 23 of the 52 with `COLLECTOR_CONTACT_URL`, 31 with `GATE_APPROVED_BY` and `PERMISSION_GATED_FEEDS_ACCEPTED_BY` as well, all 52 once every key is also set), staggered across the 150 s collection window and run every max(window, the source's poll interval), so the D4 quota exceptions such as keyless Stack Overflow (900 s) run slower (§16 item 1) |
| System uptime | 99% | Process health check |
| Cross-platform correlation latency (**PLANNED**; gated off on `master` pending a DPIA, §20) | < 30s per batch | processing_jobs.completed_at - started_at |

### System watchdog (`scripts/watchdog.js`, `src/watchdog/`, PR #22)
The "99% uptime" target is watched from outside the processes it watches. The `watchdog` compose service (profile `full`, the same image, its own container) reads `GET /api/health` and runs its own `SELECT 1` against PostgreSQL every `WATCHDOG_POLL_INTERVAL_S` (default 120 s; first poll after `WATCHDOG_INITIAL_DELAY_S`, default 60 s). It holds one **critical** `alert_events` row per condition (`alert_type` `watchdog_<condition>`, `source_table 'watchdog'`, at most one open per condition, migration 050): web API unreachable, database unreachable, Valkey unreachable, worker down (heartbeat older than its 90 s TTL), maintenance failing or overdue (retention 30 min, daily 26 h, terms 8 days), text retention overdue, collection failing (sources collecting but none online in the last hour), queue backlog (a queue holding more than 5,000 waiting + delayed jobs) and failed jobs abnormal (more than 25 queue failures or 3 failed cycles in an hour). A condition that cannot be evaluated (health unreadable, Valkey down) is unknown, never a problem or a recovery. A cleared condition is resolved with an `alert_resolutions` row.
- **Dashboard:** the alert appears in `active_alerts` with `system: true`; the header chip turns into a red SYSTEM ALERT and the health drawer shows a SYSTEM WATCHDOG section (`/api/health` `watchdog`, §7).
- **E-mail (optional):** when `SMTP_HOST`, `SMTP_FROM` and `SMTP_TO` are set, one message when a condition opens and one when it clears, at most `WATCHDOG_EMAIL_MAX_PER_HOUR` (12); TLS is required unless `SMTP_REQUIRE_TLS=false`. Without them the status is "email alerting not configured". Every send decision is an append-only `watchdog_notifications` row, and `watchdog_state` holds the last poll and e-mail status. The watchdog is the only role that receives `SMTP_PASSWORD`.

### Accuracy Targets (v1.1.0 — 99% target across all components)
**Status:** targets, not yet measured. No benchmark set, labelled sample, monthly review or DQI calibration exists on `master`; the "How to Measure" column is the **PLANNED** method, not a running process.

| Component | Target | How to Measure |
|---|---|---|
| Sentiment v1 (AFINN) | ≥ 99% on validated sample | Hand-labeled 500-post benchmark set, re-run monthly |
| Sentiment v2 (RoBERTa, Phase 2; **PLANNED — not implemented as of v1.2.0**) | ≥ 99% | Standard SemEval sentiment benchmark |
| AI relevance filter | ≥ 99% precision | Manual review of 200 random posts per month |
| Discourse quality (DQI) | Calibrated to labeled deliberation corpus | Academic DQI benchmark from Steenbergen et al. |
| Demographic inference (Phase 2; **PLANNED**) | ≥ 99% | Labeled test set with known demographics |
| Cross-platform correlation (**PLANNED**; gated off on `master` pending a DPIA, §20) | ≥ 99% precision (low false-positive tolerance) | Labeled test set of known cross-platform accounts |

**Rationale for 99% target:** Inferences appear in a public-facing dashboard read by journalists and policy makers. A false negative or false positive at 80% confidence can produce a misleading headline. All models must be validated on labeled benchmarks before production. AFINN v1 will not meet 99% — it is the audit pattern foundation only. RoBERTa (Phase 2) targets 99% on the validated benchmark.

### Ethical Quality Gates
| Check | Pass Criteria |
|---|---|
| All thresholds documented | methodology_versions table has justification for every component |
| All decisions auditable | decision_audit_log has a row for every processed post |
| No PII in DB | grep for @, username, email patterns in raw_posts.content sample; `tests/unit/pure/collectorIdentity.test.js` covers the redaction |
| Bias assessment runs | bias_assessments populated for every job that scored posts (once per collection cycle for scheduled runs, §9) |

---

## 15. Alternatives Considered

### Database

| Alternative | Why Considered | Why Not Chosen |
|---|---|---|
| SQLite | Existing in project, zero setup | No pgvector; no row-level security; no concurrent writes; not production-grade |
| MongoDB | Flexible JSONB-like documents | Poor JOIN performance for audit queries; vector search is a separate MongoDB Vector Search feature ([MongoDB Vector Search overview](https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-overview/)), not an extension inside one relational store with the audit tables. (v1.1 also said "no ACID transactions across collections"; that was wrong: MongoDB supports multi-document ACID transactions across collections and databases, on replica sets since 4.0 and sharded clusters since 4.2, [MongoDB transactions](https://www.mongodb.com/docs/manual/core/transactions/).) |
| MySQL + separate Pinecone | Familiar + managed vector | Pinecone sends data to external API (GDPR risk); vectors would live in a second, external store apart from the audit tables (MySQL's native binary `JSON` type, [MySQL JSON data type](https://dev.mysql.com/doc/refman/8.4/en/json.html), would serve the JSON columns); additional infrastructure |
| Neo4j | Graph relationships between topics | Excellent for Phase 2 topic graphs; too complex for Phase 1 foundation; add later |

### Vector Index

| Alternative | Why Considered | Why Not Chosen |
|---|---|---|
| IVFFlat | Faster to build (~128s vs ~4065s) | About 15.6x slower at query time (2.6 vs 40.5 QPS at 0.998 recall); HNSW's build cost is acceptable. Figures from [Tembo, 2023-11-14](https://web.archive.org/web/20241206165814/https://tembo.io/blog/vector-indexes-in-pgvector), about 1M 50-dimension vectors (§12) |
| Chroma | Popular open-source vector DB | Separate service adds ops complexity; pgvector puts vector + relational in one transaction boundary |
| Weaviate | Production-grade vector search | Significant ops overhead; overkill for MVP data volumes |

### Embedding Model

| Alternative | Why Considered | Why Not Chosen |
|---|---|---|
| `all-mpnet-base-v2` (768-dim) | Better quality: 69.57 vs 68.06 on sentence embeddings, 57.02 vs 49.54 on semantic search ([sbert.net pretrained models](https://www.sbert.net/docs/sentence_transformer/pretrained_models.html)) | About 5x slower inference (2,800 vs 14,200 sentences/s on a V100 GPU, same source); 2x the vector storage (768 vs 384 dimensions); marginal gain for trend monitoring |
| OpenAI `text-embedding-3-small` | High quality, easy API | Data leaves infrastructure (GDPR risk); API cost at scale; offline impossible |
| `e5-large` (1024-dim) | Strong retrieval model | 24 layers, 1024-dim embeddings ([model card](https://huggingface.co/intfloat/e5-large)); 335M parameters in a 1.34 GB float32 `model.safetensors`, about 15x the 22.7M parameters of `all-MiniLM-L6-v2` (Hugging Face model metadata), so slower and larger than discourse-trend monitoring needs |

### Sentiment Analysis

| Alternative | Why Considered | Why Not Chosen |
|---|---|---|
| VADER (Python) | Designed for social media | Requires Python subprocess call; `sentiment` npm runs synchronously in Node. No VADER comparison has been run for this project; `sentiment` publishes its own accuracy on the UCI labelled sentences: Amazon 0.726, IMDB 0.765, Yelp 0.696 ([sentiment README, Validation](https://github.com/thisandagain/sentiment#validation)) |
| RoBERTa (Phase 1) | The pre-v1.1 80% accuracy target (v1.1 raised every target to 99%) | Deferred to Phase 2: it needs a Python inference service, and no RoBERTa model has been chosen or measured for this project, so no speed or memory figure is claimed; an upgrade ships as a new `methodology_versions` row (registry entry in `src/config/methodology-registry.js` plus a migration from `scripts/generate-methodology-migration.js`) beside the new inference code, so earlier scores keep their version |
| AWS Comprehend | Managed, accurate | Data leaves infrastructure; per-request cost at scale |
| TextBlob | Simple Python NLP | Requires Python service for Phase 1; not worth the overhead vs `sentiment` npm |

---

## 16. Open Questions & Future Phases

### Resolved (v1.1.0)
1. **Refresh interval**: ✅ Resolved — 2–3 minutes. Each source is polled on its own BullMQ schedule, staggered across the collection window, and a source's poll interval is honoured across processes. As implemented: the HTTP client retries at most twice on 429, 5xx or a network error, waiting out a `Retry-After` of at most 10 s (`MAX_IN_RUN_WAIT_MS`; else 1 s, then 2 s); a 429 / 503 whose `Retry-After` is longer, or a 429 still answered after the retries (5 min when it sends none), ends the request with its real status and holds the host until then (capped at 24 h): nothing, robots.txt included, is sent to it, the hold is kept in-process and in the source's `source_collection_state.http_cache`, and a success clears it. It never retries a refusal (401 / 403 / 451, bot challenge, robots disallow), which puts the source in the refused state with a 1 h to 24 h cooldown (§17); a collect job itself has one attempt. Keyless Stack Overflow runs every 15 min (its anonymous quota of 300 requests a day cannot sustain 150 s; with `STACKEXCHANGE_KEY` it runs at 150 s); GitLab, which ran every 5 min before D4, runs keyless at 150 s. Decision D4 ("Keep 2–3 minutes for all") is implemented: every source runs in the 2–3 minute band (`CADENCE_BAND_SEC`, 120–180 s; 150 s by default, 180 s where a route's quota needs it or, for TLDR, where the source rate-limited the 150 s poll (HTTP 429)) except the routes whose documented quota cannot sustain it, each a reported exception (`pollIntervalSec` and `quotaAudit()` in `src/config/source-registry.js`; ADR 0001 D4). See §17.
2. **Retention policy**: ✅ Resolved — Layered 3-tier architecture. See §19 for full design.
3. **Accuracy target**: ✅ Resolved — 99% for all inference components. Phase 1 (AFINN) is the audit pattern foundation; Phase 2 (RoBERTa) must validate ≥ 99% before serving as primary signal.
4. **Scope**: ✅ Resolved — Global. No geographic restriction. The 52-source registry of record (workbook Rev. 4, ADR 0001). See §17.
5. **Discourse algorithm**: ✅ Resolved — Deliberative Quality Index (DQI) with semantic embedding improvements. See §18.

### Open Questions (to resolve before Phase B)
1. **Location inference**: Reddit posts don't include location metadata. Inference approach options: (a) user flair text extraction, (b) subreddit geography mapping (r/unitedkingdom → UK), (c) content NLP for mentioned locations, (d) IP geolocation at collection time (GDPR risk). Recommended: (b) + (c) as GDPR-safe combination.
2. **Discourse API vs "discourse"**: Resolved. The legacy `discourse.db` (`scripts/init-database.js`, `scripts/load-data-to-db.js`) refers to the project name, not the Discourse platform. Discourse forums are collected: the registry has four keyless `discourse` routes (`DiscourseCollector`, `src/collectors/adapters/developer.js`) on OpenStreetMap (`community.openstreetmap.org`, tag `ai`), GitLab (`forum.gitlab.com`), Docker Hub (`forums.docker.com`) and Hugging Face (`discuss.huggingface.co`); usernames and avatars are dropped. All sources defined in §17.
3. **Academic source access**: ✅ Resolved by the registry (§17): arXiv and PubMed are open; SpringerLink needs a free key; ScienceDirect and JSTOR need approval; IEEE Xplore needs a licence; ResearchGate is blocked. Semantic Scholar and the ACM Digital Library are not in the workbook.
4. **Twitter/X API cost**: ✅ Resolved by the registry (§17): X (#8) stays in the registry, built on the paid recent-search route and closed (`awaiting_licence`) until its key (`X_BEARER_TOKEN`) and a named approval (`GATE_APPROVED_BY`, decision G5) are both set. Mastodon and Bluesky are not in the workbook.
5. **Cross-platform correlation cold start**: intended position: single-platform authors receive no pseudonymous ID and are counted as unlinked in analytics (the ≥ 0.85 confidence rule of §20). Not implemented: correlation is gated off pending a DPIA of the signal design, `correlateUser()` throws and no profile is ever created (§20).

### Future Phases (not in scope for Phase 1)
Every row below is **PLANNED — not implemented as of v1.2.0** unless it says otherwise.
| Feature | Phase | Prerequisite |
|---|---|---|
| RoBERTa sentiment upgrade (99% target) | 2 | Phase A/B/C complete, AFINN baseline established, labeled benchmark set |
| BERTopic / pgvector topic clustering | 2 | Embeddings pipeline (Phase D) complete |
| Demographic inference (99% target) | 2 | Labeled training data, bias framework established |
| Similar post retrieval (`/api/similar/:post_id`) | 2 | Embeddings in DB |
| Full DQI discourse scoring | 2 | Embeddings + topic pipeline complete |
| Cross-platform correlation (full) | 2 | Phase D complete, 2+ source coverage |
| Neo4j topic relationship graph | 3 | Topic classification working |
| D3 demographics charts | E (Phase E shipped without them) | Backend complete |
| D3 topic evolution tree | E (Phase E shipped without them) | Topics pipeline complete |
| D3 discourse quality timeline | E (Phase E shipped without them) | DQI pipeline complete |
| TV display / kiosk mode | 3 | Full dashboard working |
| Counterfactual fairness (full) | 3 | Labeled dataset, RoBERTa in place |
| Differential privacy on aggregates | 3 | Regulatory requirement assessment |
| Monthly compaction job automation | 2 | **Done (PR #22):** the worker's maintenance `daily` task runs compaction; `npm run compact` still runs it by hand (§19) |

---

## 17. Source Taxonomy — the registry of record (52 sources)

The source list is the workbook `docs/requirements/Top_50_Global_Online_Sources.xlsx` (Rev. 4, 52 rows; CSV export `docs/requirements/Top_52_Global_Online_Sources.rev4.csv`), held in code by `src/config/source-registry.js` (ADR 0001). `tests/unit/pure/sourceRegistry.test.js` parses the workbook and asserts a 1:1 match on rank, name and category; every count in code is `SOURCES.length`. The earlier planning list that stood here (Mastodon, Bluesky, LinkedIn scraping and so on) is superseded: no source is scraped against its terms, and each is collected only through the official route recorded in the registry (`docs/research/2026-09-29-source-access.md`, `docs/research/2026-09-29-reddit-access.md`).

Eight categories (ADR 0001 ruling 7). Each source has a gate status at runtime (collecting, awaiting key / approval / licence, blocked, disabled, and the runtime-only `blocked_by_source`; see "Gate status, kill switches and the refused state" below); the scheduler runs every collecting source on the 2–3 minute cycle, stretched where a documented rate limit needs it, or (TLDR, 180 s) where the source answered the 150 s poll with HTTP 429. The **Gate (auth kind)** column below is the source's registry auth kind, not its runtime status. `#` is the workbook rank; Reddit is #52 in Forums (Rev. 4, ruling 8), so the Forums block reads 45, 46, 52.

### Social (8)
| # | Source | Gate (auth kind) | Route(s) |
|---|---|---|---|
| 1 | WhatsApp (Meta) | approval | mcl-export (`meta-content-library`) |
| 2 | Instagram (Meta) | approval | mcl-export (`meta-content-library`) |
| 3 | YouTube (Alphabet) | key | data-api (`youtube`) |
| 4 | Facebook (Meta) | approval | mcl-export (`meta-content-library`) |
| 5 | TikTok (ByteDance) | approval | research-api (`tiktok-research`) |
| 6 | WeChat / Weixin (Tencent) | blocked | tencent-authorized-feed (`blocked-wechat`) |
| 7 | Telegram | blocked | bot-api-with-permission (`blocked-telegram`) |
| 8 | X (formerly Twitter) | paid | recent-search (`x-recent-search`) |

### News (11)
| # | Source | Gate (auth kind) | Route(s) |
|---|---|---|---|
| 9 | BBC News | permission | technology-rss (`rss`) |
| 10 | The New York Times | permission | technology-rss (`rss`), article-search (`nyt-article-search`) |
| 11 | CNN | paid | wire-store (`licensed-feed`) |
| 12 | The Guardian | permission | ai-tag-rss (`rss`), content-api (`guardian-content-api`) |
| 13 | Al Jazeera | permission | all-news-rss (`rss`) |
| 14 | The Wall Street Journal | permission | technology-rss (`rss`), dow-jones-feed (`licensed-feed`) |
| 15 | Associated Press | paid | media-api (`ap-media`) |
| 16 | Reuters | paid | reuters-connect (`reuters-connect`) |
| 17 | NBC News | permission | tech-rss (`rss`) |
| 18 | The Washington Post | permission | technology-rss (`rss`) |
| 19 | NPR | none | technology-rss (`rss`) |

### Academic (8)
| # | Source | Gate (auth kind) | Route(s) |
|---|---|---|---|
| 20 | SpringerLink (Springer Nature) | key | meta-api (`springer`) |
| 21 | arXiv | none | export-api (`arxiv`) |
| 22 | PubMed / PMC (NCBI) | none | e-utilities (`pubmed`) |
| 23 | ScienceDirect (Elsevier) | approval | search-api (`elsevier`) |
| 24 | Google Scholar | key | alert-mailbox (`scholar-imap`) |
| 25 | ResearchGate | blocked | granted-dataset (`blocked-researchgate`) |
| 26 | IEEE Xplore | paid | metadata-api (`ieee`) |
| 27 | JSTOR (ITHAKA) | approval | tas-dataset (`jstor-dataset`) |

### Policy (7)
| # | Source | Gate (auth kind) | Route(s) |
|---|---|---|---|
| 28 | GovInfo (US GPO) | key | collection-rss (`rss`), search-api (`govinfo-search`) |
| 29 | Congress.gov (Library of Congress) | key | bill-api (`congress`) |
| 30 | Council on Foreign Relations | permission | site-feed (`rss`) |
| 31 | Cato Institute | blocked | allowlisted-rss (`blocked-cato`) |
| 32 | RAND Corporation | none | publication-feeds (`rss`) |
| 33 | Urban Institute | none | research-rss (`rss`) |
| 34 | Pew Research Center | none | wp-rest-ai (`pew`) |

### Non-profit (6)
| # | Source | Gate (auth kind) | Route(s) |
|---|---|---|---|
| 35 | Wikipedia / Wikimedia Foundation | none | ai-talk-pages (`wikipedia-talk`) |
| 36 | Mozilla (Firefox) | none | ai-category-rss (`rss`) |
| 37 | Khan Academy | none | blog-rss (`rss`) |
| 38 | Our World in Data | none | atom-feeds (`rss`) |
| 39 | OpenStreetMap | none | diary-rss (`rss`), forum-ai-tag (`discourse`), blog-rss (`rss`) |
| 40 | Internet Archive | none | advanced-search (`internet-archive`), blog-rss (`rss`) |

### Developer (4)
| # | Source | Gate (auth kind) | Route(s) |
|---|---|---|---|
| 41 | GitHub | none | repo-search (`github-search`), issue-search (`github-search`), ai-ml-blog-rss (`rss`) |
| 42 | GitLab | none | topic-projects (`gitlab-projects`), forum-latest (`discourse`) |
| 43 | Docker Hub | none | ai-namespace (`dockerhub-namespace`), blog-rss (`rss`), forum-latest (`discourse`) |
| 44 | Hugging Face | none | daily-papers (`hf-daily-papers`), blog-rss (`rss`), forum-latest (`discourse`) |

### Forums (3)
| # | Source | Gate (auth kind) | Route(s) |
|---|---|---|---|
| 45 | Stack Overflow | none | questions (`stackexchange`) |
| 46 | Hacker News (Y Combinator) | none | algolia-search (`hn-algolia`) |
| 52 | Reddit | approval | data-api (`reddit`) |

### Blogs and newsletters (5)
| # | Source | Gate (auth kind) | Route(s) |
|---|---|---|---|
| 47 | TLDR (13 newsletters) | none | tldr-ai-rss (`rss`) |
| 48 | Substack (platform-level) | none | publication-feeds (`rss`) |
| 49 | Ars Technica | permission | ai-rss (`rss`) |
| 50 | One Useful Thing (Ethan Mollick) | none | feed (`rss`) |
| 51 | Platformer (Casey Newton) | none | feed (`rss`) |

**Reddit (#52).** Approval-gated Reddit Data API only (client-credentials OAuth; `oauth.reddit.com`; Reddit's User-Agent format), closed until `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` and `REDDIT_API_APPROVAL_REF` are all set and `GATE_APPROVED_BY` names the approver (G5). Subreddits: the 7 with the most subscribers among those with at least `REDDIT_MIN_AI_POSTS_7D` (default 20) AI-mentioning posts in 7 days, re-ranked daily and stored in `reddit_subreddit_rankings`; a documented provisional list until the first ranking. One shared request budget (100 QPM averaged over 10 minutes). Post text is blanked 48 h after collection or on upstream deletion (6-hourly `/api/info` re-check); scores and audit rows are kept (ADR 0001 ruling 9). Only allowlisted submission fields are stored; `u/<name>` handles are redacted (since `ingest@1.5.0`).

### Gate status, kill switches and the refused state
Legal and product decisions here are ADR 0001's (rulings 1 to 9, decisions D1 and D2); this section describes how the code applies them.

**Runtime status.** `sourceStatus()` (`src/config/source-registry.js`) resolves each source under the process's env, and `src/collectors/status.js` adds the database and refusal state. The first rule that matches wins:

| Order | Condition | Status |
|---|---|---|
| 1 | Database kill switch set (`data_sources.collection_disabled_at`, migration 020) | `disabled` |
| 2 | Env kill switch: `COLLECTORS_ENABLED=false`, the slug listed in `COLLECTORS_DISABLED`, or `SOURCE_<SLUG>_ENABLED=false` | `disabled` |
| 3 | Auth kind `blocked`, no official-permission route open and none configured awaiting approval | `blocked` ("blocked: no compliant access", with the terms citation) |
| 4 | `COLLECTOR_CONTACT_URL` empty | `disabled` (every other source) |
| 5 | At least one route open and the source is in the refused state | `blocked_by_source` |
| 6 | At least one route open | `collecting` |
| 7 | A gated route is configured but `GATE_APPROVED_BY` is missing or invalid (decision G5) | the source's closed status, reason "awaiting named approval" |
| 8 | Otherwise | the source's closed status: `awaiting_key`, `awaiting_approval`, `awaiting_licence` (or `blocked` for the 4 blocked sources) |

**Credit fields (K1).** Beside `termsUrl`, `attribution` and `license`, a registry entry may carry the fields from which `src/config/attribution.js` derives the credit shown with its excerpts: `licenseUrl` (the https licence text), `creditText` (overrides the credit; the default is `attribution` without a trailing "(LICENCE)", else the source name without a trailing parenthetical), `linkHosts` (the domains the source's permalinks live on where the route's own URLs do not name them: API-only routes and feeds that link elsewhere), `linkOnly` (`linkHosts` is the complete list), `citeDate` (also show the publication date), and `notice` with `noticeUrl` (a notice the terms require on the product). API hosts are never derived as link domains. Every entry must resolve to a credit and a non-empty link-domain set; `tests/unit/pure/attribution.test.js` pins it for all 52 sources and the exact set whose terms require a credit.

A route is **open** when every env var it `requires` is set and, if it requires any (a key, an approval or licence reference, or the acknowledgement `PERMISSION_GATED_FEEDS_ACCEPTED_BY`: a **gated** route), `GATE_APPROVED_BY` holds a valid named approval, "Name YYYY-MM-DD" (PR #22 decision G5); a paid tier `replaces` the free feed it upgrades. Keyless routes need no approval.

- The registry gate statuses are the six of ADR 0001 (`collecting`, `awaiting_key`, `awaiting_approval`, `awaiting_licence`, `blocked`, `disabled`); `blocked_by_source` is the seventh, runtime-only status (F10-5), served by `/api/sources`, `/api/health` `sources.by_status`, the health drawer and the smoke check. It never counts as online.
- The 4 blocked sources (WeChat, Telegram, ResearchGate, Cato) therefore report `blocked` whether or not `COLLECTOR_CONTACT_URL` is set; only a kill switch reports them `disabled`. Recording their official permission in env with the contact URL set still leaves them `blocked` ("awaiting named approval") until `GATE_APPROVED_BY` is set; with all three they collect. With the permission recorded but no contact URL they report `disabled`. ADR 0001 states the fresh-clone result: 48 `disabled` and 4 `blocked`.
- Only `collecting` sources are scheduled or fetched. `source_runs.gate_status` records the status each run saw (always `collecting`).
- **Gate governance (migrations 035, 056).** The worker's scheduler compares every source's status with the last recorded one and appends `gate_opened` / `gate_closed` to the append-only `source_gate_events` (actor, reason, the routes, and for an opening of a gated route its named approver `approved_by`); the database kill switch counts. The operator commands `npm run source:disable | source:enable | source:reset` refuse to run without `GATE_APPROVED_BY` and record their event with that approver (`src/collectors/governance.js`, `scripts/source-admin.js`). The weekly `terms` maintenance task snapshots each source's terms page into the append-only `source_terms_snapshots` (normalised text and hash, migration 041); a changed hash opens a `terms_changed` warning.

**Decision D1 ("Off for others, on for you").** `COLLECTOR_CONTACT_URL` ships empty, so a fresh clone collects nothing and the standup populates labelled demo data only. The 8 permission-gated feeds of ruling 4 (BBC, NYT, Guardian, Al Jazeera, WSJ, NBC News, Washington Post, Ars Technica) also require the operator's acknowledgement `PERMISSION_GATED_FEEDS_ACCEPTED_BY`, and, being gated routes, the named approval `GATE_APPROVED_BY` (G5). With the contact URL alone (with or without either of the other two), 23 of 52 sources collect without keys (11 `awaiting_approval`, 10 `awaiting_licence`, 4 `awaiting_key`, 4 `blocked`); with the contact URL, the acknowledgement and the named approval all set, 31 collect (8 / 5 / 4 / 4). A fresh clone reports 48 `disabled` and 4 `blocked` (ADR 0001, Consequences).

**Kill switches.** Env switches apply when the containers are recreated (`docker compose up -d worker web`). The database switch applies at once in every process: `npm run source:disable -- <slug> --reason "<why>"` sets it and `npm run source:enable -- <slug>` clears it; the runner checks it before every run.

**The refused state (ruling 5, F10-5).** A run refused by the source (401 / 403 / 451, a bot challenge, or a robots.txt disallow) records `access_denied_*` and `refused_until` on `source_collection_state` (migration 018). The source is skipped for a cooldown of 1 h, doubling per refusal up to 24 h; after it, one probe run is allowed. A successful probe ends the refused state (the source collects again) but keeps the refusal count: the source is on probation for 24 h (`probation_until`, migration 062), a refusal during probation continues the count so the cooldown keeps escalating to 24 h, and only 24 h without a refusal decays the count to 0 (ADR 0001 dated note of 2026-09-30). Each refusal episode opens one critical `source_refused` alert; a further refusal while it is open updates it to the current count, and it is resolved when the refused state ends (§9). The allow-listed, scrubbed response headers of the latest refusal are kept in `source_collection_state.access_denied_headers` while the refused state lasts (a successful probe or a reset clears them) and, permanently, on the refused run's `source_runs.response_headers` (migration 062). `SOURCE_<SLUG>_RESET=<date>` (dated at or after the last refusal and not in the future, with the named approval `GATE_APPROVED_BY`) or `npm run source:reset -- <slug> --note "<why>"` clears it by hand, count and probation included. The date is `YYYY-MM-DD` (read as 00:00 UTC) or an ISO 8601 date-time with `Z` or an offset; an invalid value is ignored with a reason, and a future one is ignored until it passes (the cooldown reason says so; `src/collectors/refusal.js` `resetDate`). A refusal recorded before migration 062 has no `last_refused_at`; a successful probe copies `access_denied_at` into it, so the reset still applies during that probation. Nothing ever retries around a refusal.

**Politeness.** Every request goes through one HTTP client: User-Agent `PulseOfAI/<version> (+<COLLECTOR_CONTACT_URL>; non-commercial AI discourse research)`, robots.txt checked before every request to publisher-site routes (redirects included, conservative matching), per-host spacing, conditional GET, at most 2 retries on 429 / 5xx waiting out a `Retry-After` of up to 10 s, a longer `Retry-After` on 429 / 503 (or a 429 still answered after the retries: 5 min) honoured as a hold of the host of up to 24 h during which nothing is sent to it, robots.txt included (persisted in `source_collection_state.http_cache`), and the network guard of §8. Bulk-file routes read operator-supplied files and Google Scholar reads its alert mailbox over IMAP.

**Decisions D3 and D4 (2026-09-29, PR #10 review; implemented by PR #22).** D3, location: "Separate layer, excluded from bias." Publisher-located posts are a separate, labelled globe layer (`publisher_posts`, §7, §11) and are excluded from the location-concentration check since `bias@1.2.0` (§9). D4, cadence: "Keep 2–3 minutes for all." Every source runs in the 120–180 s band (150 s by default) unless a documented quota cannot sustain it, and each such route is a reported exception (Stack Overflow every 15 min, YouTube and others; `pollIntervalSec`, `quotaAudit()`), never silently slowed (§16). Both decisions, and G1 to G6, are recorded verbatim in ADR 0001.

### Source registry seed data (`scripts/seed.js`)
Every registry source is upserted into `data_sources` on setup: `name` = the registry slug, `display_name` = the workbook name, `source_type` = `rss | api | bulk` (the `collect.<type>` queue), `category` = one of the 8 canonical slugs, `config` JSONB = non-secret route settings (never a credential value).

### Demographic Hierarchy
Demographic signals are inferred at collection time from metadata and content. Stored in `raw_posts.location` (city-level only) and extended in Phase 2:

```
Global
  └── Region (continent/major region: Europe, Asia-Pacific, North America, etc.)
       └── Country
            └── City (stored in raw_posts.location — max granularity for GDPR compliance)

Source category dimension:
  Social → Platform → Subreddit/Community → Thread

Temporal dimension:
  Year → Month → Week → Day (for rollup aggregation in §19)
```

---

## 18. Discourse Algorithm

### Implemented: `discourse@1.1.0-DQI` (`src/pipeline/discourse.js`, model `dqi-heuristic-v1`)

A keyword-heuristic adaptation of the Deliberative Quality Index (Steenbergen et al. 2003). Five dimensions, each in [0, 1]; the total is their **unweighted mean** (every dimension weighs 0.2). No source-category weighting, embeddings or argument clustering are used.

| Dimension | Rule |
|---|---|
| `participation` | 1.0 at 50+ words, 0.5 at 15–49 words, else 0 |
| `justification` | 1.0 for 2+ reasoning connectors ("because", "therefore", "since", …), 0.5 for 1, else 0 |
| `respectfulness` | 1.0 minus 0.25 per hostile marker, floor 0 |
| `constructiveness` | 1.0 for 3+ solution markers ("should", "propose", "improve", …), 0.5 for 1–2, else 0 |
| `evidence` | 1.0 for 2+ evidence markers ("according to", "study", "data", …), 0.5 for 1, else 0 |

The registry row `discourse@1.1.0-DQI` states exactly these rules; it was added after `npm run replay` found the 1.0.0-DQI row describing dimensions the code does not compute (ADR 0001, "Methodology alignment"; migration 014).

**Output** — `decision_audit_log.output` (decision type `discourse`, `confidence` = the total):
```json
{
  "total": 0.6,
  "dimensions": { "participation": 1.0, "justification": 0.5, "respectfulness": 1.0, "constructiveness": 0.5, "evidence": 0.0 }
}
```
`discourse_results` stores `dqi_total` and `dimensions`; its `argument_cluster_id` and `novelty_score` columns stay NULL until the planned improvements land.

### Target design (v1.1): full DQI with four improvements — PLANNED — not implemented as of v1.2.0

This design is registered as the superseded row `discourse@1.0.0-DQI` (six weighted dimensions and source-category weights) and is kept as the target. Nothing below runs on `master`.

#### Industry Standard Foundation: Deliberative Quality Index (DQI)

The DQI was developed by Steenbergen et al. (2003) and is the dominant academic standard for measuring the quality of political and social discourse. It operationalizes Habermasian deliberative democracy theory into measurable dimensions.

**Original DQI components:**
| Dimension | Description | Weight |
|---|---|---|
| Participation | Who gets to speak — source diversity | 0.15 |
| Level of justification | Claims backed by reasons (none / weak / qualified / sophisticated) | 0.30 |
| Content of justification | Common good vs. narrow self-interest | 0.15 |
| Respect for counterarguments | Engagement with opposing views | 0.20 |
| Constructiveness | Constructive vs. positional framing | 0.10 |
| Respect for other groups | Absence of denigration | 0.10 |

**Registered in `methodology_versions` as:** component = `'discourse'`, version = `'1.0.0-DQI'` (superseded; not what the code runs)

#### Pulse of AI Improvements Over Baseline DQI

The baseline DQI was designed for parliamentary transcripts, not social media. The following improvements adapt it for AI discourse at scale:

**Improvement 1: Semantic Argument Deduplication**
Standard DQI counts unique claims. Our improvement uses embeddings to cluster semantically similar arguments across posts and sources. A high DQI score requires argument *diversity*, not repetition.

```
Score boost: posts that introduce novel argument clusters (cosine distance > 0.4 from existing centroids)
Score reduction: posts that are near-duplicates of dominant narrative (cosine distance < 0.15)
```

**Improvement 2: Echo Chamber Detection**
Standard DQI measures a single forum. Our improvement measures cross-platform argument spread. An argument that only circulates within one source category (all social, or all academic) gets a lower constructiveness score than one that crosses categories.

```
cross_platform_spread = unique source_categories mentioning argument cluster / 8   (8 canonical categories; v1.1 divided by 7)
high_spread (> 0.6 categories) → constructiveness multiplier: 1.2x
low_spread (< 0.2 categories) → constructiveness multiplier: 0.7x
```

**Improvement 3: Source Authority Weighting**
Standard DQI weights all participants equally. We apply a credibility weight based on source category:
```
academic   → weight 1.5   (peer-reviewed, evidence-based)
policy     → weight 1.3   (institutional accountability)
news       → weight 1.2   (editorial standards)
developer  → weight 1.1   (technical expertise domain)
nonprofit  → weight 1.0   (baseline)
social     → weight 0.8   (highest volume, lowest filter)
blog       → weight 0.9   (author-accountable)
forums     → not yet assigned (category added by ADR 0001 ruling 7)
```
Weights stored in `methodology_versions.config` and adjustable without code changes.

**Improvement 4: Claim-Evidence Linkage (NLP)**
Standard DQI uses human coding for justification quality. We use NLP to detect:
- Presence of citation markers (links, DOI references, "according to", "study shows")
- Hedge language vs. assertion language (epistemic modality)
- Logical connectives indicating reasoned argument ("because", "therefore", "however")

Score mapping:
```
sophisticated justification (citation + logical connective) → level 3
qualified justification (hedge + evidence marker)           → level 2
simple justification (assertion only)                      → level 1
none                                                       → level 0
```

#### Target DQI Score Output Format (PLANNED)
```json
{
  "dqi_total": 0.74,
  "dimensions": {
    "participation": { "score": 0.80, "source_count": 12, "category_count": 5 },
    "justification_level": { "score": 0.70, "avg_level": 1.8, "distribution": {"0": 0.1, "1": 0.3, "2": 0.4, "3": 0.2} },
    "justification_content": { "score": 0.65, "common_good_ratio": 0.55 },
    "counterargument_respect": { "score": 0.72, "cross_category_engagement_rate": 0.38 },
    "constructiveness": { "score": 0.80, "cross_platform_spread": 0.71 },
    "respect_for_groups": { "score": 0.90, "denigration_detected": false }
  },
  "improvements_applied": ["semantic_dedup", "echo_chamber", "authority_weighting", "claim_evidence"],
  "argument_cluster_id": "uuid",
  "novelty_score": 0.63
}
```

---

## 19. Layered Retention Architecture

### Three-Tier Model

```
TIER 1: Detail Window (RETENTION_DETAIL_DAYS, default 90 days)
  Tables: raw_posts, sentiment_results, relevance_results, discourse_results,
          decision_audit_log, post_embeddings
  Granularity: Post-level (every individual post stored)
  Purpose: Dashboard display, audit trail, explainability, spot-checks
  Access: All API endpoints, full resolution
  Text: replaced by a removal notice when its source's window ends: Reddit
        48 h, YouTube and TikTok 30 days (platform terms), every other
        source the detail window (the Guardian included); checked every
        5 minutes (maintenance schedule, below)

TIER 2: Monthly Compaction (after the detail window → indefinite)
  Tables: monthly_topic_rollups, monthly_source_rollups
          (monthly_discourse_rollups: PLANNED — not implemented as of v1.2.0)
  Granularity: Monthly aggregate per topic keyword / category / location / language,
               and per source
  Purpose: Trend research, historical journalism, policy analysis
  Access: PLANNED — GET /api/rollups/:year/:month and the rollup note on
          POST /api/query are not implemented as of v1.2.0; no endpoint reads
          the rollup tables today
  Raw posts: text replaced by a removal notice (content is NOT NULL;
             text_removed_at set), embeddings deleted, audit skeleton kept

TIER 3: Permanent Archival (automatic — no expiry)
  Tables: methodology_versions, methodology_errata,
          processing_jobs (metadata only; EVERY row, failed ones
          included — ADR 0001 decision G4), bias_assessments,
          bias_window_runs, bias_window_assessments, alert_events,
          alert_resolutions, alert_resolution_approvals,
          source_gate_events, correlation_gate_events,
          source_terms_snapshots, source_run_daily,
          watchdog_notifications, data_retention_log, compaction_log
  Granularity: Run-level and methodology-level
  Purpose: Audit compliance, reproducibility, GDPR accountability
  Access: GET /api/methodology, GET /api/audit/:post_id (audit skeleton),
          GET /api/bias/history
```

**Admission counters (migration 068).** `source_runs.dropped_*` is NULL for a run that evaluated no item (gate closed, skipped, failed, or every route returned nothing; not a fake 0) and for rows from before the migration; `dropped_*` describe that run, like `items_fetched`: a route retried after a store failure appears in both runs (`admission_rule_hits` counts it once). The `source_run_daily` roll-up sums the recorded runs only, so a day that mixes both is a partial total. `admission_rule_hits` holds counts only (no text, no ids, no personal data). It is kept `ADMISSION_RULE_HITS_DAYS` days, default 400 (a year plus a month, so a month can be compared with the same month a year earlier), then removed by the `daily` maintenance task with a `data_retention_log` summary row (`expired_admission_rule_hits`). A bad value (not a whole number of days from 35 to 3650) fails that step and removes nothing. The per-source daily rejection totals are not lost with it: they are rolled up from `source_runs` into `source_run_daily` (Tier 3, kept permanently).

### Migration 005 — Retention & Compaction Tables (as migrated)

```sql
CREATE TABLE monthly_topic_rollups (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rollup_month    DATE NOT NULL,              -- first day of month
    topic_label     TEXT NOT NULL,              -- first matched relevance keyword, else 'general'
                                                -- (BERTopic label: PLANNED)
    source_category TEXT,                       -- null = all categories combined
    location        TEXT,                       -- null = global
    language        TEXT,                       -- null = all languages
    post_count      INTEGER NOT NULL,
    positive_count  INTEGER NOT NULL DEFAULT 0,
    neutral_count   INTEGER NOT NULL DEFAULT 0,
    negative_count  INTEGER NOT NULL DEFAULT 0,
    avg_comparative REAL,
    avg_dqi_score   REAL,                       -- not written by compaction yet
    top_keywords    TEXT[],                     -- not written by compaction yet
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
-- Expression unique index (nullable dimensions compare as '')
CREATE UNIQUE INDEX idx_monthly_topic_rollups_uniq ON monthly_topic_rollups(
    rollup_month, topic_label,
    COALESCE(source_category, ''), COALESCE(location, ''), COALESCE(language, ''));
CREATE INDEX idx_rollup_month    ON monthly_topic_rollups(rollup_month DESC);
CREATE INDEX idx_rollup_topic    ON monthly_topic_rollups(topic_label);
CREATE INDEX idx_rollup_category ON monthly_topic_rollups(source_category) WHERE source_category IS NOT NULL;
CREATE INDEX idx_rollup_location ON monthly_topic_rollups(location) WHERE location IS NOT NULL;

CREATE TABLE monthly_source_rollups (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rollup_month    DATE NOT NULL,
    source_id       UUID REFERENCES data_sources(id),
    source_category TEXT NOT NULL,
    post_count      INTEGER NOT NULL,
    positive_count  INTEGER NOT NULL DEFAULT 0,
    neutral_count   INTEGER NOT NULL DEFAULT 0,
    negative_count  INTEGER NOT NULL DEFAULT 0,
    avg_comparative REAL,
    avg_dqi_score   REAL,                       -- not written by compaction yet
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(rollup_month, source_id)
);
CREATE INDEX idx_src_rollup_month  ON monthly_source_rollups(rollup_month DESC);
CREATE INDEX idx_src_rollup_source ON monthly_source_rollups(source_id);

CREATE TABLE compaction_log (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    compacted_month    DATE NOT NULL UNIQUE,
    posts_compacted    INTEGER NOT NULL,
    rollups_created    INTEGER NOT NULL,
    embeddings_deleted INTEGER NOT NULL DEFAULT 0,
    content_nulled     INTEGER NOT NULL DEFAULT 0,
    completed_at       TIMESTAMPTZ DEFAULT NOW()
);
```

**PLANNED — not implemented as of v1.2.0:** `monthly_discourse_rollups` (monthly DQI aggregates per topic / category), which v1.1 listed in Tier 2. No migration creates it.

### Maintenance schedule (`src/workers/maintenance.worker.js`, PR #22)

The worker registers three BullMQ job schedulers on the `maintenance` queue (shared across worker processes; concurrency 1):

| Scheduler | Cadence | Steps |
|---|---|---|
| `retention` | `MAINTENANCE_EVERY_MS`, default 5 min | text retention for every source (below); stale one-shot jobs (no progress for `STALE_JOB_MINUTES`) marked failed |
| `daily` | `MAINTENANCE_DAILY_EVERY_MS`, default 24 h | compaction (below); `source_runs` older than `SOURCE_RUNS_RAW_DAYS` (30) rolled into `source_run_daily`, dropped counts included; `admission_rule_hits` older than `ADMISSION_RULE_HITS_DAYS` (400) removed; the rolling 24 h bias checks (introduced by bias@1.5.0; they run under the current bias version, bias@1.6.0, §9) |
| `terms` | `MAINTENANCE_TERMS_EVERY_MS`, default 7 days | a polite snapshot of every source's terms page; a changed normalised-text hash opens a `terms_changed` alert (skipped, and recorded, while `COLLECTOR_CONTACT_URL` is unset) |

`processing_jobs` rows are never removed (Tier 3, decision G4). A failing step does not stop the others, but it fails the job (BullMQ failed count) and is logged at error level. Every run writes its outcome to `maintenance_state`; `GET /api/health` reports `maintenance.tasks` (last run, last success, last error per task) and `maintenance.retention_overdue` (posts still holding text past their window), and the watchdog (§14) alerts when a task is failing or overdue. While any post of a source holds text more than `RETENTION_OVERDUE_GRACE_MINUTES` (60) past its window, the worker keeps one critical `retention_overdue` alert open for that source. The schedulers are re-registered on every reschedule, so a queue-store outage at boot is retried. A bad `RETENTION_DETAIL_DAYS` (not a whole number of days from 30 to 3650) fails the retention and compaction steps and changes nothing.

### Compaction Job Logic (`scripts/compact.js`)
Runs in the daily maintenance task, and by hand: `npm run compact` (or `node scripts/compact.js [YYYY-MM]` for one month). The v1.1 "runs on the 1st of each month" is replaced by the daily check: a month becomes due at most once a month.

1. **Demo purge first** (below): demo posts past the detail window are deleted outright, in their own batched transactions. Demo data is never rolled up.
2. **Select months**: every calendar month that **ended** before the detail-window cutoff (`RETENTION_DETAIL_DAYS`, default 90) and has real posts not yet compacted (not in `compaction_log`). The month holding the cutoff waits until it is whole. Months are found by walking the `collected_at` index month by month.
3. For each month, in **one transaction** (`dbTransaction`):
   1. Aggregate the month's real posts into `monthly_topic_rollups` (GROUP BY month, first matched keyword, source category, location, language) and `monthly_source_rollups` (GROUP BY month, source).
   2. Replace any text still stored with the removal notice (`raw_posts.content` is `NOT NULL`; `text_removed_at` is set), with the retention mechanism below. Normally the retention job has already done this at the end of each post's window.
   3. Delete the month's `post_embeddings` rows.
   4. Write one `data_retention_log` row, `action = 'compacted'`, with the true counts.
   5. Write the `compaction_log` row.

**What is preserved after compaction:**
- `raw_posts` row (text replaced by the removal notice, metadata kept — for audit chain integrity)
- `decision_audit_log` rows (input_hash, output JSONB, model_name — full audit)
- `sentiment_results`, `relevance_results`, `discourse_results`
- `methodology_versions` (never deleted)
- `monthly_topic_rollups` and `monthly_source_rollups`
- `bias_assessments` and `alert_events`

**What is deleted after compaction:**
- `post_embeddings` (large, re-computable if needed)
- the post text: `raw_posts.content` (NOT NULL) is replaced by a removal notice and `text_removed_at` is set (P10-2)

**Text windows (P10-2, ingest@1.6.0).** The text is stored once, in `raw_posts.content`. The worker's repeatable `maintenance` job removes it when its source's window ends: Reddit 48 h, YouTube and TikTok 30 days (their terms), every other source `RETENTION_DETAIL_DAYS` (90) — the Guardian included (Jennifer, 2026-09-29: "Use normal retention"; ingest@1.7.0). A platform-terms blanking also deletes the post's embedding in the same transaction (PR #22 decision G3); scores and audit rows stay. Each batch writes one `data_retention_log` row listing the post ids it changed; every post stored through `src/pipeline/ingest.js` has a `collected` row (the demo batch of `scripts/populate.js` writes none).

**Demo data at the retention boundary (P9-3).** Posts whose source has
`data_sources.source_type = 'demo'` (the fictional standup population from
`scripts/populate.js`) are never rolled up, and before compaction runs they are
deleted outright once `collected_at` is past `RETENTION_DETAIL_DAYS` — owner
decision 2026-09-29. Deleted with each demo post: its `sentiment_results`,
`relevance_results`, `discourse_results`, `post_embeddings` and
`decision_audit_log` rows (every table with a foreign key to `raw_posts`; an
integration test checks that list against the live catalog). Also deleted:
`user_platform_sightings` recorded against a demo feed past the same boundary,
and any `pseudonymous_users` profile those rows referenced that has no sighting
or post left. The purge runs in bounded batches (`DEMO_PURGE_BATCH_SIZE`,
default 500, max 5000), one transaction per batch, and writes one
`data_retention_log` row per batch: `action = 'purged_demo'`, `raw_post_id`
NULL, a JSON `reason` with the per-table counts, the time window, the
cutoff and the purged `post_ids`, and a `legal_basis` stating that the data was
fictional demo data. The
`source_type = 'demo'` filter is in the SQL of every delete, so posts from real
sources and their audit trails are never deleted.

**Embed jobs of removed posts.** After the purge commits, the pending
(`wait`, `paused`, `prioritized`, `delayed`) embed jobs of the purged posts are
removed from the queue (`src/queues/embed-cleanup.js`). An embed job that still
runs for a purged post — one already taken by a worker — completes as a no-op
with `{ skipped: true, reason: 'purged_demo' }`, matched through the purge
row's `post_ids`; a post whose text was removed completes the same way with
`reason: 'text_removed'`, and the removal notice is never embedded (the vector
is stored only while the post exists with its text). A post that is missing
with no purge record is a real error: the job fails with `Post not found`.
The standup smoke check requires 0 failed jobs on every worker queue.

### Platform-terms retention: Reddit (ADR 0001 ruling 9)
Jennifer's ruling, verbatim: "Blank text, keep audit rows". The risk acceptance against the Reddit terms is recorded in ADR 0001; this section describes the mechanism only (`src/collectors/retention.js`, `src/collectors/reddit/recheck.js`, `src/collectors/reddit/maintenance.js`).
- The Reddit registry entry carries a `retention` block: `maxAgeHours: 48`, `recheckHours: 6`, a legal basis and a notice. YouTube and TikTok carry a 30-day block, applied by analogy (ADR 0001).
- The worker runs the retention job every 5 minutes whatever the gate. 48 hours after collection, or as soon as the 6-hourly `/api/info` re-check (batches of 100; runs only while Reddit's gate is open, the database kill switch is off and Reddit is not in its refusal cooldown (it runs in the post-cooldown probe state)) finds a post deleted, removed, missing, no longer public or NSFW, the post's text is replaced by `[removed: Reddit Data API Terms retention]` in `raw_posts.content` and in the payload's text keys, and the permalink is cut to `https://www.reddit.com/r/<sub>/comments/<id>/`. `text_removed_at` / `text_removed_reason` record when and why (migration 025).
- The post's embedding is deleted in the same transaction (PR #22 decision G3: the embedding is derived from the text). Scores, `decision_audit_log` rows (including the sentiment cue-word fragments), the content hash and the provenance fingerprint are retained by owner decision.
- Each batch writes one `data_retention_log` row, `action = 'blanked_platform_terms'`, with the Reddit terms as legal basis and the post ids it actually changed.
- A blanked post's receipt shows the notice as its text and `provenance.retention = { status: "text_removed", … }`; a live Reddit post's receipt says when its text will be removed. `npm run replay` reports its stages NOT RE-RUNNABLE.

### API Behavior for Historical Queries — PLANNED — not implemented as of v1.2.0
When a `POST /api/query` date range falls partly outside the detail window, the grouped query form (§7) would annotate which part of the result comes from rollups:
```json
{
  "note": "Date range spans both detail and rollup data. Results before 2025-12-08 are from monthly rollups (post-level detail not available).",
  "detail_coverage": { "from": "2025-12-08", "to": "2026-03-08" },
  "rollup_coverage": { "from": "2025-01-01", "to": "2025-12-07" }
}
```
Today `/api/query` reads post-level rows only and returns no note.

---

## 20. Cross-Platform User Correlation

**Status on `master`: not implemented — signal design pending DPIA (PR #22 grumpy M7).** The tables (migration 006), `src/pipeline/correlation.js` and the `correlate` queue and worker exist, but no code path can create `pseudonymous_users` or `user_platform_sightings` rows: nothing enqueues correlate jobs, the correlate worker refuses every job, and `correlateUser()` throws `CorrelationNotImplementedError`. Only the demo purge (§19) deletes from those tables.

### DPIA gate (PR #22)

Collectors store no author (ADR 0001 D2), so the only signal on identity-free data is post-level (a post's topics plus its posting hour), which is not an identity signal. `src/pipeline/correlation-gate.js` reports `awaiting_dpia` (no `CORRELATION_DPIA_REF`), `disabled` (`CORRELATION_ENABLED` is not true), `misconfigured` (`CORRELATION_SALT` empty or a placeholder such as the `.env.example` value), `unverified` (web cannot see a salt set for the worker, and the worker has not reported) or, with every switch set, `not_implemented`; it never reports `enabled`. `GET /api/health` reports `correlation: { enabled: false, status, reason, checked_by, checked_at }`. `CORRELATION_SALT` reaches the worker container only (PR #22 security L1); web gets the presence flag `CORRELATION_SALT_SET`, the worker publishes its gate status with its heartbeat, and `/api/health` serves that (`checked_by: "worker"`), or web's own `unverified` judgement (`checked_by: "web"`); and while the gate is closed the worker's connection pool does not budget for correlate jobs. Every change of the gate's status or DPIA reference is recorded in the append-only `correlation_gate_events` table (migration 056; principal #19), with who: the named approval in `GATE_APPROVED_BY` when set (decision G5). The design below is the target a DPIA must approve before any of it is built.

### Design Principles

Cross-platform user correlation is the most privacy-sensitive feature in the system. The goal is to identify when the same person appears on multiple platforms so that their discourse contribution can be analyzed as a coherent voice — without ever storing who that person is.

**Hard rules:**
- No platform username, handle, or ID is ever stored (stripped on ingest — §8)
- A pseudonymous ID may be assigned only when correlation confidence ≥ 0.85 (design; PR #22 removed the scoring code and the `CORRELATION_MIN_CONFIDENCE` constant with it, and `correlateUser()` now always throws)
- The correlation signals used to compute the ID are hashed before storage — not reversible (`computeSignalHash` = HMAC-SHA256 of the signals keyed with the salt; it throws on an unset or placeholder salt)
- A user's cross-platform identity cannot be recovered from any stored data
- IDs are salted per deployment (`CORRELATION_SALT`) so they cannot be correlated across instances. The salt is required: an unset or placeholder salt makes the gate report `misconfigured` and `computeSignalHash` throw (PR #22)

### Pseudonymous ID System (implemented: adjective-animal)

A pseudonymous ID is a two-word `<adjective>-<animal>` combination from the `unique-names-generator` word lists (1,202 adjectives × 355 animals = 426,710 IDs), e.g. `balanced-impala`.

**Generation (`generatePseudoId`):**
```
seed      = signal_hash + CORRELATION_SALT
seed_int  = first 4 bytes of SHA-256(seed), as an unsigned 32-bit integer
pseudo_id = uniqueNamesGenerator({ dictionaries: [adjectives, animals],
                                   separator: '-', style: 'lowerCase', seed: seed_int })
```
The same seed always gives the same ID; the seed is never stored. `pseudonymous_users.pseudo_id` is `UNIQUE`. In the design, an ID that already exists is the same pseudonymous user (its `platform_count` and `last_sighted_at` updated and a sighting added); that code was removed in PR #22 (grumpy M7) and nothing writes these tables today, so of this ID system only `generatePseudoId` is implemented (with `computeSignalHash`, above).

**Superseded:** v1.1's verb-noun scheme (`running-tiger`; 500 verbs × 500 nouns = 250,000 IDs, indexed from the correlation fingerprint). The code first shipped a 20 × 20 = 400-ID verb-noun list and replaced it with the adjective-animal space (426,710 IDs) for its collision rate (`src/pipeline/correlation.js`).

### Migration 006 — Cross-Platform Correlation Tables (as migrated; the comments are this spec's, the migration's own comments still describe the superseded verb-noun IDs)

```sql
CREATE TABLE pseudonymous_users (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pseudo_id               TEXT NOT NULL UNIQUE,   -- adjective-animal ID, e.g. 'balanced-impala'
    style_cluster_id        TEXT,                   -- PLANNED (never written)
    topic_affinity          TEXT[],
    platform_count          INTEGER DEFAULT 1,
    correlation_confidence  REAL NOT NULL,          -- >= 0.85 to exist
    first_sighted_at        TIMESTAMPTZ DEFAULT NOW(),
    last_sighted_at         TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_pseudo_id      ON pseudonymous_users(pseudo_id);
CREATE INDEX idx_pseudo_cluster ON pseudonymous_users(style_cluster_id) WHERE style_cluster_id IS NOT NULL;
CREATE INDEX idx_pseudo_count   ON pseudonymous_users(platform_count DESC);

CREATE TABLE user_platform_sightings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pseudo_user_id  UUID NOT NULL REFERENCES pseudonymous_users(id),
    source_id       UUID NOT NULL REFERENCES data_sources(id),
    signal_hash     TEXT NOT NULL,              -- HMAC-SHA256 of the correlation signals, keyed with CORRELATION_SALT (not reversible)
    confidence      REAL NOT NULL,
    sighted_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_sightings_user   ON user_platform_sightings(pseudo_user_id);
CREATE INDEX idx_sightings_source ON user_platform_sightings(source_id);
CREATE INDEX idx_sightings_at     ON user_platform_sightings(sighted_at DESC);

-- raw_posts.pseudo_user_id (declared in 001) gets its foreign key here
ALTER TABLE raw_posts ADD CONSTRAINT fk_raw_posts_pseudo_user
    FOREIGN KEY (pseudo_user_id) REFERENCES pseudonymous_users(id);
CREATE INDEX idx_raw_posts_pseudo ON raw_posts(pseudo_user_id) WHERE pseudo_user_id IS NOT NULL;
```

### Correlation Signals — PLANNED — not implemented as of v1.2.0

`correlateUser()` takes no arguments and always throws `CorrelationNotImplementedError` (PR #22 grumpy M7); no code computes the signals or the weighted score below, and nothing calls it: nothing enqueues `correlate` jobs, and the correlate worker (`src/workers/correlate.worker.js`) completes every job it is given as refused, with the DPIA gate status (`src/pipeline/correlation-gate.js`). The design is kept as intent for a DPIA to review:

| Signal | Description | Weight |
|---|---|---|
| Writing style embedding | Cosine similarity between post embeddings of candidate authors | 0.40 |
| Temporal pattern | Distribution of posting times (hour of day, day of week) | 0.25 |
| Topic affinity | Overlap in topic categories engaged with | 0.20 |
| Vocabulary fingerprint | TF-IDF character n-gram similarity (stylometry) | 0.15 |

**Correlation score:**
```
confidence = (style_sim × 0.40) + (temporal_sim × 0.25) +
             (topic_sim × 0.20) + (vocab_sim × 0.15)

if confidence ≥ 0.85:
    assign existing pseudo_id (if match found) or generate new one
else:
    post remains unlinked (pseudo_user_id = NULL)
```

### API: Cross-Platform Profile — PLANNED — not implemented as of v1.2.0
`GET /api/users/:pseudo_id` — returns a pseudonymous user's cross-platform discourse profile. Not mounted.

```json
{
  "pseudo_id": "balanced-impala",
  "platform_count": 3,
  "source_categories": ["social", "blog", "developer"],
  "topic_affinity": ["AI safety", "regulation", "open source models"],
  "sentiment_profile": { "positive": 0.42, "neutral": 0.38, "negative": 0.20 },
  "avg_dqi_score": 0.71,
  "first_sighted_at": "2026-01-15T08:23:00Z",
  "last_sighted_at": "2026-03-07T19:45:00Z",
  "note": "Profile derived from behavioral signals only. No identifying information stored."
}
```

### Privacy Audit Checklist for Correlation Feature
Before shipping this feature:
- [ ] Verify no username/handle stored in any correlation table
- [ ] Verify `CORRELATION_SALT` (the deployment salt) is not logged anywhere
- [ ] Verify `signal_hash` cannot be reversed to source signals
- [ ] Verify `GET /api/users/:pseudo_id` (PLANNED) returns no content older than the detail window without rollup label
- [x] Require `CORRELATION_SALT` (PR #22: an unset or placeholder salt makes the gate `misconfigured` and `computeSignalHash` throw)
- [ ] DPIA (Data Protection Impact Assessment) completed — correlation of behavioral signals is high-risk processing under GDPR Article 35
- [ ] Legal basis documented: `legitimate interest` (public discourse analysis) with minimization evidence

---

## 21. Licence and Legal Notices

**Scope.** The licence and the legal-notices UI arrived with PR #40 (`docs/diagrams-and-readme`); before it, `master` declared `"license": "MIT"` in `package.json` and had no `LICENSE` file or notice UI. The licensing decision and its wording belong to `LICENSE` and `ADDITIONAL-TERMS.md`; this section states how the code carries them and does not restate the terms differently.

### Licence
- `LICENSE` is the complete, unmodified GNU Affero General Public License v3.
- The project is licensed **AGPL-3.0-or-later** (`package.json` and the `package-lock.json` root entry: `"license": "AGPL-3.0-or-later"`).
- `ADDITIONAL-TERMS.md` adds exactly one term, under AGPL section 7(b): the author attribution 'Built on Pulse of AI by Jennifer McKinney', with a link to https://github.com/jennifer-mckinney/pulse-of-ai, must be preserved in the Appropriate Legal Notices of any covered work or modified version, including a user interface reached over a network. It places no other restriction.
- AGPL section 13: whoever runs a modified version for users over a network must offer them its complete corresponding source; `SOURCE_URL` in `legal.config.js` (and the three static "Source code" links: the `<noscript>` block and the About-panel fallback markup in `public/index.html`, and the footer of `public/credits.html`) must then point at that source. The attribution line stays as it is.
- Third-party components keep their own licences; vendored frontend assets are listed in `public/vendor/README.md`.

### Legal-notices UI
The credits page (`credits.html`, §11) and the About panel are different things. The About panel and these notices concern the software: its licence and the section 7(b) attribution. The credits page and the per-excerpt credit lines concern the third-party content shown, and they never claim the software's licence for that content or the sources' licences for the software. Because `credits.html` is a second page of the UI, it repeats the same six notice lines at its foot as static markup (`<footer class="credits-legal">`, one `<li data-notice>` per line, no JavaScript needed); a deployer of a modified version who changes `SOURCE_URL` must also change its "Source code" link there, in both "Source code" links of `public/index.html`, and in the config.
- **Data:** `public/js/config/legal.config.js` (`PulseLegalConfig`), frozen data only with zero functions: `UPSTREAM_URL`, `SOURCE_URL` (defaults to the upstream repository) and `NOTICE`, six lines in this order:
  1. `Copyright © 2026 Jennifer McKinney`
  2. `Built on Pulse of AI by Jennifer McKinney` → the upstream repository (the §7(b) attribution)
  3. `Licensed under AGPL-3.0-or-later` → `LICENSE`
  4. `Additional terms (AGPL section 7(b))` → `ADDITIONAL-TERMS.md`
  5. `Source code` → `SOURCE_URL`
  6. `No warranty: provided "as is", without warranty of any kind (AGPL sections 15 and 16).`
- **Rendering:** `public/js/main.js` `renderLegalNotice` builds the header "about" panel (`#about-panel`, `role="region"`, hidden by default) with `createElement` + `textContent` only. The panel also ships the same notices as static markup in `public/index.html` (a unit test keeps it equal to the config): `renderLegalNotice` replaces it when `legal.config.js` loads, and if that file fails to load the static list stays and a warning is logged, so the attribution is never lost. The about chip toggles it and sets `aria-expanded`; while a drawer is open the chip is inert and carries `aria-disabled="true"` (kept in sync by the same observer), and a drawer opened with focus on a notice link returns focus to the chip on close, because the panel folds away; Escape closes it, and opening the audit or health drawer folds it away (a `MutationObserver` on the drawers' `open` class, so every open path is covered). Closing it by Escape or by the chip returns focus to the chip when focus was inside the panel (or on the page body), so it never stays in the hidden subtree, including in Safari, where a click does not focus the button; focus elsewhere on the page is left where it is. The panel is bounded to the viewport below it and scrolls, so every notice stays reachable at a narrow or zoomed viewport (`public/styles/main.css`). Links carry `rel="noopener noreferrer"` and no `target`. All hrefs are static https constants; no API data reaches an href.
- **No-JS and fallback:** `public/index.html` repeats the same six lines, texts and links inside `<noscript>` and, as the panel's static content, inside `#about-panel` (kept when the config is missing, empty, partial or malformed; the `<noscript>` links carry the same `rel="noopener noreferrer"`, pinned by the unit test: `isValidNoticeConfig` in `main.js` accepts only a non-empty array of entries with non-empty string `id` and `text` that carries each of the six ids (`copyright`, `attribution`, `license`, `terms`, `source`, `warranty`) exactly once, with a non-empty `href` on `attribution`, `license`, `terms` and `source`; extra notices with other ids are allowed).
- **CSP:** the config loads as an external `<script src>` before `main.js`; no inline script or style is added, and styling lives in `styles/main.css`.
- **Tests:** `tests/unit/pure/legalNotice.test.js` pins the literal texts and URLs, the noscript copy, the absence of inline `style=` and of `innerHTML`-family writes, the `LICENSE` header, the package licence and the additional terms. `tests/e2e/legal-notice.spec.ts` asserts the rendered panel, its links, the Escape behaviour, focus return on a chip click that does not move focus, the chip's `aria-disabled` while a drawer is open and its inert click, a drawer opened from a focused notice link returning focus to the chip, an unrelated class change on an open drawer leaving the panel open, and the panel opening below the header with every chip on screen and the header ending above the explore filters at widths from 320 to 900 px (the header wraps at 640 px and below, and the panel then opens at 112 px instead of 64 px); and a 320 × 240 viewport where the panel stays inside the viewport and scrolls to the last notice, with zero console errors.
