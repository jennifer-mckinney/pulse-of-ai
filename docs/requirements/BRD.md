# The Pulse of AI — Business Requirements Document (BRD)

| | |
|---|---|
| **Document** | Business Requirements Document |
| **Product** | The Pulse of AI — global real-time AI discourse dashboard |
| **Version** | 1.0 |
| **Date** | 2026-07-05 |
| **Status** | Approved baseline, derived from Technical Specification v1.1.0 |
| **Related documents** | `docs/TECHNICAL_SPEC.md` (v1.1.0), `docs/requirements/PRD.md`, `docs/plans/2026-07-05-globe-storytelling-design.md` |

This document describes the business context: why the product exists, who it serves, what business outcomes it must deliver, and the boundaries within which it must operate. The companion PRD (`docs/requirements/PRD.md`) translates these business requirements into product requirements. The Technical Specification describes how the system is built; this document intentionally does not.

---

## 1. Problem Statement

Public discourse about artificial intelligence is happening at enormous scale across social platforms, news outlets, academic repositories, policy organizations, and developer communities. Despite that scale, four gaps persist (spec §2):

1. **No neutral monitoring system** tracks how AI sentiment evolves across demographics and geographies. Existing coverage is anecdotal, platform-siloed, or produced by parties with a stake in the narrative.
2. **No explainability for bias claims.** When bias in AI coverage is identified, there is no mechanism to explain which algorithm flagged it, on what evidence, and under which threshold.
3. **Journalists lack a fast tool.** There is no product that delivers story-ready, defensible insights about AI discourse in under 2 minutes.
4. **Researchers cannot reproduce findings.** Sentiment dashboards do not publish their methodology, version their algorithms, or expose per-decision audit trails, making independent verification impossible.

The Pulse of AI addresses all four gaps with a single system: a global, near-real-time discourse monitor whose every inference is auditable, versioned, and explainable in plain English.

## 2. Product Vision

A global, real-time AI discourse monitoring dashboard that aggregates AI-related content from the top 50 online sources across 7 categories, applies NLP analysis (sentiment, relevance, discourse quality), and presents findings through an interactive globe-driven narrative — with every inferred score traceable to the model, version, parameters, and plain-English justification that produced it (spec §1).

The one-line positioning: **responsible AI monitoring, not just another dashboard.**

## 3. The Differentiator: The Responsible-AI Audit Trail

Most sentiment dashboards are black boxes. The Pulse of AI is architected so that explainability is a property of the data model, not a bolt-on report:

- **Every inferred decision** — sentiment score, relevance rating, topic classification, demographic inference, discourse quality score — is captured in an immutable audit log with full provenance: which model, which version, which parameters, what the input was, what the output was (spec §1, §10).
- **Every algorithm version is documented before it runs**, with a plain-English justification field written to be defensible to regulators (spec §6, §10).
- **Anyone asking "why does this say that?" gets a traceable answer** through a public audit endpoint, tailored to the asker: plain English for journalists, model/version/config for regulators, full reproducibility traces for researchers (spec §10).
- **Bias is monitored automatically**, not on request: a three-layer bias detection stack (demographic parity, equalized odds, counterfactual fairness) runs against every processing job and raises alerts when evidence-based thresholds are exceeded (spec §9).

This audit trail is the moat. Competing on data volume or visualization polish is a commodity race; competing on *defensibility of every number on screen* is not. It is also what makes the product credible to its most demanding audiences — regulators, researchers, and journalists whose reputations depend on the numbers they cite.

## 4. Stakeholders and Audiences

| Audience | Need | What the product gives them |
|---|---|---|
| **Journalists** (primary) | Story angles in under 2 minutes, defensible numbers to publish | Globe loads immediately with current sentiment; scroll-driven narrative surfaces derived insights; every data point has a "why?" trail (spec §11) |
| **Researchers** | Verify methodology, reproduce findings, access historical trends | Public methodology endpoint, per-post audit trails with input hashes and full configs, monthly rollups for longitudinal work (spec §10, §19) |
| **Policy makers** | Monitor bias incidents, track sentiment over time, cite evidence | Traffic-light model health indicator, bias alert history, evidence-based thresholds with academic sourcing (spec §9, §11) |
| **General public** | Understand how the world feels about AI, without expertise | Guided storytelling experience over the globe; insights in plain language; free exploration with filters |
| **Product owner / operator** | A system that is compliant, testable, and cheap to run | Self-hosted open-source stack, layered retention limiting storage growth, quality gates enforced in CI (spec §14, §19) |
| **Regulators (indirect)** | Evidence that automated inference is governed | Immutable audit log, versioned methodologies with justifications, GDPR lifecycle logging, DPIA checklist for high-risk features (spec §8, §10, §20) |

## 5. Business Objectives and Success Criteria

Objectives are taken directly from the specification's objectives table (spec §2) and constitute the acceptance basis for the programme.

| # | Objective | Success Criteria |
|---|---|---|
| O1 | Monitor AI discourse globally in near-real-time | 2–3 minute refresh cycle; 99% uptime |
| O2 | Surface geographic sentiment patterns worldwide | Map/globe renders with real data in under 3 seconds |
| O3 | Detect and report bias across sources and demographics | Automated alerts for demographic parity violations |
| O4 | Be explainable to any audience | Audit endpoint returns a human-readable decision trail for any post |
| O5 | Be compliant by design | GDPR data minimization, AI Act documentation, layered retention built in |
| O6 | Be testable and reproducible | 80%+ test coverage; 99% inference accuracy; all thresholds documented |
| O7 | Surface cross-platform discourse patterns | Cross-platform user correlation with PII-obfuscated verb-noun pseudonymous IDs |
| O8 | Support user interaction and queries | Insights delivered via interactive frontend and on-demand query API |
| O9 | Maintain research-grade historical access | Monthly compacted rollups preserve trends beyond the 3-month detail window |

## 6. Scope

### 6.1 In Scope (phased)

**Phase 1 — Foundation (delivered):**
- Ingestion, processing, and storage backbone: immutable raw post store, processing jobs, versioned methodology registry, immutable decision audit log (spec §6, §13 Phases A–C)
- Sentiment v1 (lexicon-based, establishing the audit pattern), keyword relevance scoring, three-layer bias monitoring with alerting (spec §9)
- Public read API: health, aggregated posts by location, latest sentiment, audit trail, bias results, methodology, sources, on-demand refresh, structured query (spec §7)
- Embedding pipeline and vector storage for semantic capabilities (spec §12, §13 Phase D)
- Privacy-first collection: PII stripped at ingest, GDPR lifecycle logging (spec §8)

**Phase E — Storytelling frontend (in flight):**
- Globe-based scroll-driven narrative with dynamically derived insights, ending in free exploration with sentiment and source-category filters (spec §11; approved design of 2026-07-05)

**Phase 2 — Accuracy and depth (planned, spec §16):**
- Transformer-based sentiment upgrade validated to the 99% accuracy target; demographic inference; topic clustering; similar-post retrieval; full discourse quality scoring; full cross-platform correlation; automated monthly compaction

**Phase 3 — Reach and hardening (planned, spec §16):**
- Topic relationship graph, semantic free-text search, kiosk/TV display mode, full counterfactual fairness, differential privacy on aggregates

### 6.2 Out of Scope

- Storing or displaying any personally identifying information: usernames, handles, user IDs, emails, IP addresses, profile data, or location below city level (spec §8)
- Content moderation, takedown workflows, or engagement with platform users
- Paid data resale or advertising; the product is a monitoring and transparency tool
- Real-time push alerting to external channels (dashboard and API surface alerts; external notification integrations are a future consideration)
- Editorial commentary — the product reports measured discourse; it does not opine

## 7. Constraints

| Constraint | Implication |
|---|---|
| **GDPR compliance posture** | Target posture (planned — verified as the retention and lifecycle-logging phases land): data minimization at ingest (no PII stored); every data action logged with legal basis; right-to-erasure supported through the retention log; DPIA required before shipping cross-platform correlation, which is high-risk processing under GDPR Article 35 (spec §8, §20) |
| **EU AI Act readiness** | Documented, versioned methodology with plain-English justification for every automated inference; fairness thresholds sourced from academic literature and regulatory guidance (spec §3, §9, §10) |
| **Privacy-first architecture** | Target posture (planned — verified when cross-platform correlation ships behind its DPIA gate): pseudonymization by design — correlation to use salted, non-reversible verb-noun IDs without storing the underlying identity (spec §20); location capped at city granularity (spec §17) |
| **Open-source, self-hosted ethos** | No data leaves the operator's infrastructure for inference or embedding; managed AI APIs were explicitly rejected on GDPR and lock-in grounds; the stack is composed of mature open-source components and can run on a single host (spec §5, §15) |
| **Layered retention** | Post-level detail retained 3 months, then compacted into permanent monthly rollups with content nulled and embeddings deleted — bounding both privacy exposure and storage cost while preserving research-grade trends (spec §19) |
| **Source economics** | Almost all 50 sources use free APIs or RSS; the only recurring data cost under decision is one commercial platform API (~$100/month), with free substitutes identified (spec §16, §17) |
| **Quality bar** | Nothing ships without passing tests, 98% coverage, and the ethical quality gates (all thresholds documented, all decisions auditable, no PII in the database, bias assessment on every job) (spec §14) |

## 8. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Phase 1 lexicon sentiment falls short of the 99% accuracy target and is quoted as authoritative | High (by design — v1 is the audit-pattern foundation, spec §14) | Reputational | Methodology endpoint discloses model and accuracy status; Phase 2 transformer upgrade is the accuracy vehicle; accuracy validated monthly on a labeled benchmark |
| R2 | Source APIs change terms, pricing, or rate limits (notably the commercial social platform tier) | Medium | Coverage gaps | 50-source diversification across 7 categories; free substitutes identified; source concentration is itself a monitored bias metric (spec §9, §17) |
| R3 | Cross-platform correlation is perceived as surveillance despite pseudonymization | Medium | Regulatory / reputational | Hard privacy rules (spec §20): no identity stored, salted non-reversible IDs, DPIA before launch, documented legitimate-interest basis |
| R4 | Location inference for platforms without location metadata is weak, skewing the geographic story | Medium | Data quality | GDPR-safe inference approaches selected (community geography mapping plus content NLP); location concentration alerts flag skew automatically (spec §9, §16) |
| R5 | Bias monitoring thresholds generate alert fatigue or, conversely, miss real violations | Medium | Trust | All thresholds are evidence-based with academic citations, stored as versioned configuration, and adjustable without code changes (spec §3, §9) |
| R6 | Storage and cost growth from continuous global collection | Low | Operational | Layered retention compacts detail after 3 months; embeddings deleted on compaction; deduplication at ingest (spec §19) |
| R7 | A public-facing dashboard makes an incorrect claim that is traced back to the product | Low | Reputational | This is precisely what the audit architecture exists for: every number is traceable to model, version, config, and justification — errors are diagnosable and correctable with a new methodology version (spec §10) |

## 9. Business Success Measures

Beyond the objective criteria in Section 5, the programme is judged on:

- **Time-to-insight:** a journalist reaches a publishable, sourced insight in under 2 minutes from page load (spec §3, §11).
- **Explainability coverage:** 100% of processed posts have a complete audit trail (spec §14, ethical quality gates).
- **Compliance evidence:** retention log, methodology registry, and bias assessment history are sufficient to answer a regulator's inquiry without engineering work (spec §8, §10).
- **Reproducibility:** an external researcher can re-derive any published score from the audit record (spec §10).

## 10. Approval and Change Control

The Technical Specification v1.1.0 is the source of truth for requirements; this BRD summarizes its business content and must be revised when the specification's objectives (§2), scope resolutions (§16), or compliance posture (§8, §19, §20) change. Methodology and threshold changes do not require BRD revision — they are governed by the versioned methodology registry by design.
