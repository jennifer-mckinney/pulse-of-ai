# The Pulse of AI — Technical Specification
**Version:** 1.1.0
**Date:** 2026-03-08
**Status:** Design Phase — Pre-Implementation
**Maps to:** `pulse-of-ai-mvp-v1-final-requirements.pdf`, `pulse-of-ai-evidence-based-thresholds.pdf`, `pulse-of-ai-model-health-dashboard.pdf`

**v1.1.0 Amendments:**
- Scope: Global (not US-only)
- Refresh interval: 2–3 minutes (was 5 min)
- Inference accuracy target: 99% for all components (was 80%/75%)
- Source coverage: Top 50 global online sources across 7 categories
- Cross-platform user correlation with verb-noun pseudonymous ID (PII-obfuscated)
- Discourse algorithm: Deliberative Quality Index (DQI) + semantic improvements
- Layered retention: 3-month detail → monthly compaction → permanent topic rollups
- User interaction + query-driven insight delivery (not passive-only)

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
17. [Source Taxonomy — Top 50](#17-source-taxonomy--top-50)
18. [Discourse Algorithm](#18-discourse-algorithm)
19. [Layered Retention Architecture](#19-layered-retention-architecture)
20. [Cross-Platform User Correlation](#20-cross-platform-user-correlation)

---

## 1. Executive Summary

The Pulse of AI is a global, real-time AI discourse monitoring dashboard designed for journalists, researchers, policy makers, and the general public. It aggregates AI-related discourse from the top 50 online sources across 7 categories — social platforms, blogs, news outlets, academic repositories, political/policy organizations, non-profits, and developer communities — applies NLP analysis, and presents findings through an interactive map-driven narrative with user interaction and query-driven insight delivery.

**What makes this system responsible AI, not just a dashboard:**

Every inferred decision — sentiment score, relevance rating, topic classification, demographic inference, discourse quality score — is captured in an immutable audit log with full provenance: which model, which version, which parameters, what the input was, what the output was, and what the plain-English justification for the methodology is. Anyone asking "why does this say that?" gets a traceable, defensible answer.

**Key architectural principles:**
- Global coverage — 50 sources across 7 categories, all geographies
- Immutable raw data — collected posts are never modified
- Auditable inferences — every score is traceable to its methodology version
- Versioned methodology — algorithms change over time; we track which version produced which decision
- Privacy-first collection — no usernames, no PII; cross-platform users get verb-noun pseudonymous IDs
- Cross-platform correlation — same user appearing across platforms identified without re-identification
- Layered retention — 3-month full detail; monthly compaction thereafter into topic/category rollups
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
| O7 | Surface cross-platform discourse patterns | Cross-platform user correlation with PII-obfuscated verb-noun IDs |
| O8 | Support user interaction + queries | Insights delivered via interactive frontend AND on-demand queries |
| O9 | Maintain research-grade historical access | Monthly compacted rollups preserve trends beyond 3-month detail window |

---

## 3. Requirements Mapping

### From `pulse-of-ai-mvp-v1-final-requirements.pdf`

| Requirement | Technical Implementation | Spec Section |
|---|---|---|
| Global real-time data pipeline | 2–3 min cron across 50 sources + `POST /api/refresh` on demand | §13 Phase C, §17 |
| Sentiment analysis with 99% accuracy | AFINN v1 → RoBERTa v2; all results audited; accuracy validated continuously | §10, §18 |
| Demographic inference 99% accuracy | Phase 2 feature; methodology_version pre-registered; validated on labeled set | §10 |
| AI relevance filtering 99% | Keyword + embedding hybrid scoring v1; methodology versioned | §10 |
| Discourse quality scoring | Deliberative Quality Index (DQI) + semantic cluster improvements | §18 |
| Geographic visualization (global) | Mapbox GL JS, real GROUP BY queries from PostgreSQL, worldwide coverage | §7 |
| Bias & harm monitoring | 3-layer bias stack, `bias_assessments` table, alerts | §9 |
| <3s page load | No framework, minimal JS, static assets, indexed queries | §14 |
| Story-ready in <2min | Map loads on page load, refresh auto-updates narrative | §11 |
| WCAG 2.1 compliance | Seaborn colorblind palettes, high contrast, alt text | §11 |
| Cross-platform user correlation | Verb-noun pseudonymous IDs, style + temporal embedding correlation | §20 |
| User interaction + queries | Interactive frontend filtering + `POST /api/query` for non-real-time | §11, §7 |
| Layered retention | 3-month detail, monthly compaction, permanent topic rollups | §19 |

### From `pulse-of-ai-evidence-based-thresholds.pdf`

All thresholds below are stored in the `methodology_versions` table with their academic source as the `justification` field:

| Metric | Threshold | Stored As |
|---|---|---|
| Sentiment accuracy target | ≥ 99% (validated against labeled set) | methodology_versions.config |
| Demographic inference accuracy | ≥ 99% (Phase 2, labeled test set required) | methodology_versions.config |
| AI relevance score | ≥ 0.99 precision | methodology_versions.config |
| Discourse quality score (DQI) | 0.0–1.0 scale, thresholds per component | methodology_versions.config |
| Location concentration alert | > 60% from single geography | methodology_versions.config |
| Source concentration alert | > 40% from single source | methodology_versions.config |
| Negative sentiment dominance | > 70% | methodology_versions.config |
| Demographic parity difference | > 0.10 | methodology_versions.config |
| Equalized odds difference | > 0.08 | methodology_versions.config |
| Counterfactual fairness | > 0.05 | methodology_versions.config |
| Cross-platform correlation confidence | ≥ 0.85 before assigning verb-noun ID | methodology_versions.config |

### From `pulse-of-ai-model-health-dashboard.pdf`

| Health Indicator | Implementation |
|---|---|
| Traffic light status | `GET /api/health` → active_alerts array |
| Bias alerts | bias_assessments.is_violation → alert_events |
| Model health | Latest processing_job status + last N job success rate |
| Data freshness | last_job.completed_at vs NOW() |

---

## 4. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│              DATA SOURCES — TOP 50 GLOBAL (§17)                  │
│  Social: Reddit, Twitter/X, Mastodon, Bluesky, HackerNews       │
│  News:   TechCrunch, Wired, MIT Tech Review, Ars Technica       │
│  Academic: arXiv, Semantic Scholar, ACM DL                      │
│  Policy: EFF, AI Now, RAND, Brookings, Future of Life           │
│  Dev: GitHub Discussions, Stack Overflow AI, Hugging Face       │
│  Blog: LessWrong, Alignment Forum, Substack, Medium             │
│  Non-profit: Partnership on AI, Mozilla Foundation, OpenMind    │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    INGESTION LAYER                               │
│  src/pipeline/ingest.js                                          │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 1. Strip PII (usernames, handles)                        │    │
│  │ 2. SHA-256 content hash (deduplication)                  │    │
│  │ 3. Strip raw_payload of author fields                    │    │
│  │ 4. Write to raw_posts (immutable)                        │    │
│  │ 5. Log to data_retention_log (GDPR lifecycle)            │    │
│  └─────────────────────────────────────────────────────────┘    │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PROCESSING PIPELINE                           │
│  ┌──────────────┐ ┌───────────────┐ ┌──────────────┐ ┌────────┐  │
│  │ pipeline/    │ │ pipeline/     │ │ pipeline/    │ │Infinity│  │
│  │ sentiment.js │ │ relevance.js  │ │ discourse.js │ │EmbedSvc│  │
│  │ (AFINN→audit)│ │ (hybrid→audit)│ │ (DQI→audit)  │ │:8000   │  │
│  └──────┬───────┘ └───────┬───────┘ └──────┬───────┘ └───┬────┘  │
│         └─────────────────┴────────────────┘             │       │
│                             ▼                             ▼       │
│            └────────────────┬────┘                   │          │
│                             ▼                         ▼          │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              decision_audit_log (immutable)               │   │
│  │  model, version, input_hash, output JSONB, confidence    │   │
│  └──────────────────────────────────────────────────────────┘   │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    POSTGRESQL + pgvector                         │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────────┐  │
│  │  raw_posts     │ │sentiment_result│ │ post_embeddings    │  │
│  │  processing_   │ │relevance_result│ │ VECTOR(384)        │  │
│  │  jobs          │ │bias_assessment │ │ HNSW index         │  │
│  │  methodology_  │ │alert_events    │ │ cosine similarity  │  │
│  │  versions      │ │data_retention_ │ └────────────────────┘  │
│  └────────────────┘ │log             │                          │
│                     └────────────────┘                          │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EXPRESS API (src/server.js)                   │
│  GET /api/health             GET /api/bias/latest               │
│  GET /api/posts/aggregated   GET /api/methodology               │
│  GET /api/sentiment/latest   POST /api/refresh                  │
│  GET /api/audit/:post_id                                         │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│                    BROWSER (public/)                             │
│  Mapbox GL JS + D3.js v7 + Vanilla JS + Scrollama               │
│  Seaborn color palette · Dark Bloomberg theme · WCAG 2.1        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 5. Technology Stack

### Primary Stack

| Layer | Technology | Version | Reason |
|---|---|---|---|
| Runtime | Node.js | 18+ | LTS, existing project |
| Web framework | Express.js | 4.x | Minimal, existing |
| Primary DB | PostgreSQL | 16 | JSONB, row-level security, extensions |
| Vector search | pgvector | 0.7+ | Integrated with PostgreSQL, no separate service |
| Embeddings | sentence-transformers `all-MiniLM-L6-v2` | 2.7.0 | Local, 384-dim, 22M params, 1000s/sec CPU |
| Embed service | Infinity (`infinity-embed`) | latest | Dynamic batching, 30-40% throughput gain over plain FastAPI |
| Sentiment v1 | `sentiment` npm (AFINN) | 5.0.2 | Already installed, synchronous, no API calls |
| Sentiment v2 | RoBERTa (Python, Phase 2) | — | 80%+ accuracy target; v1 establishes the audit pattern first |
| Infrastructure | Docker Compose | — | PostgreSQL + test DB in one command |
| Node testing | Jest + supertest | — | Unit + integration, 80%+ coverage required |
| Python testing | pytest | — | Embedding service tests |

### Alternatives Considered — Why Not

| Alternative | Considered For | Why Rejected |
|---|---|---|
| SQLite | Primary DB | No pgvector support; no row-level security; single-writer bottleneck; not production-grade |
| MongoDB | Primary DB | Schema flexibility not needed; poor JOIN performance for audit queries; no native vector support |
| Chroma / Weaviate | Vector store | Separate service adds ops complexity; pgvector integrates vector + relational in one transaction |
| Redis | Caching / rate limit | Additional dependency for MVP; in-memory counter sufficient for 1 req/min rate limit |
| React / Vue | Frontend framework | Original design decision: Vanilla JS avoids build tooling, keeps deployment simple |
| OpenAI Embeddings API | Embeddings | API cost at scale; data leaves your infrastructure (GDPR risk); offline not possible |
| larger sentence-transformers | Embeddings | `all-mpnet-base-v2` is 5x slower for 3-4% gain — not worth it for trend monitoring |
| IVFFlat | pgvector index | HNSW is 15.5x faster at query time (40.5 vs 2.6 QPS at 0.998 recall); higher build cost is acceptable |
| Flask/FastAPI | Embedding service | Infinity provides dynamic batching (30-40% better throughput), ctranslate2 backend (2-4x faster inference), same interface |

---

## 6. Database Design

### Schema Overview (17 tables across 6 migrations)

```
data_sources ──────────────────────────────────────────────────┐
                                                                │
raw_posts (immutable) ──────────────────────────────────────┐  │
  content_hash (SHA-256)                                     │  │
  raw_payload (JSONB, PII stripped)                          │  │
                │                                            │  │
                ├── processing_jobs                          │  │
                │                                            │  │
                ├── decision_audit_log ──── methodology_ver  │  │
                │         │                                  │  │
                ├── sentiment_results ──── (audit_id FK)     │  │
                ├── relevance_results ──── (audit_id FK)     │  │
                ├── post_embeddings (VECTOR(384))            │  │
                └── data_retention_log (GDPR)                │  │
                                                             │  │
bias_assessments ──── processing_jobs                        │  │
alert_events                                                 │  │
                                                             │  │
raw_posts.source_id ────────────────────────────────────────┘  │
data_sources.id ────────────────────────────────────────────────┘
```

### Migration 001 — Core Schema (`src/db/migrations/001_core_schema.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Where data comes from
CREATE TABLE data_sources (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            TEXT NOT NULL UNIQUE,           -- 'reddit_artificial', 'arxiv_cs_ai'
    source_type     TEXT NOT NULL,                  -- 'reddit', 'twitter', 'arxiv', 'discourse'
    config          JSONB,                          -- non-secret config only
    active          BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Immutable: never UPDATE or DELETE
CREATE TABLE raw_posts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    source_id       UUID NOT NULL REFERENCES data_sources(id),
    external_id     TEXT NOT NULL,                  -- platform's own ID
    content         TEXT NOT NULL,                  -- sanitized, PII stripped
    raw_payload     JSONB,                          -- full response, author stripped
    content_hash    TEXT NOT NULL,                  -- SHA-256 of normalized content
    location        TEXT DEFAULT '',                -- inferred or metadata-provided
    collected_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source_id, external_id)                  -- prevents duplicate ingestion
);

CREATE INDEX idx_raw_posts_source      ON raw_posts(source_id);
CREATE INDEX idx_raw_posts_collected   ON raw_posts(collected_at DESC);
CREATE INDEX idx_raw_posts_hash        ON raw_posts(content_hash);
CREATE INDEX idx_raw_posts_location    ON raw_posts(location) WHERE location != '';

-- One row per collection run
CREATE TABLE processing_jobs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    triggered_by    TEXT NOT NULL,                  -- 'cron', 'api', 'startup'
    status          TEXT NOT NULL DEFAULT 'running',
    posts_collected INTEGER DEFAULT 0,
    posts_processed INTEGER DEFAULT 0,
    error_details   TEXT,
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ
);

CREATE INDEX idx_jobs_status    ON processing_jobs(status);
CREATE INDEX idx_jobs_started   ON processing_jobs(started_at DESC);

-- Every algorithm version is documented before it runs
CREATE TABLE methodology_versions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    component       TEXT NOT NULL,                  -- 'sentiment', 'relevance', 'demographics'
    version         TEXT NOT NULL,
    model_name      TEXT NOT NULL,
    config          JSONB NOT NULL,                 -- thresholds, parameters
    justification   TEXT NOT NULL,                  -- plain English, defensible to regulators
    effective_from  TIMESTAMPTZ DEFAULT NOW(),
    deprecated_at   TIMESTAMPTZ,
    UNIQUE(component, version)
);
```

### Migration 002 — Audit Tables (`src/db/migrations/002_audit_tables.sql`)

```sql
-- Immutable: INSERT only, never UPDATE or DELETE
-- This is the source of truth for all explainability queries
CREATE TABLE decision_audit_log (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id             UUID NOT NULL REFERENCES raw_posts(id),
    job_id                  UUID NOT NULL REFERENCES processing_jobs(id),
    methodology_version_id  UUID NOT NULL REFERENCES methodology_versions(id),
    decision_type           TEXT NOT NULL,          -- 'sentiment', 'relevance', 'topic', 'demographic'
    model_name              TEXT NOT NULL,
    input_hash              TEXT NOT NULL,          -- SHA-256(input text) — not raw text
    output                  JSONB NOT NULL,         -- full scored output
    confidence              REAL,                   -- null if not applicable
    created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_post     ON decision_audit_log(raw_post_id);
CREATE INDEX idx_audit_job      ON decision_audit_log(job_id);
CREATE INDEX idx_audit_type     ON decision_audit_log(decision_type);
CREATE INDEX idx_audit_created  ON decision_audit_log(created_at DESC);

-- Derived sentiment result — queried for dashboard display
CREATE TABLE sentiment_results (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id         UUID NOT NULL REFERENCES raw_posts(id),
    audit_id            UUID NOT NULL REFERENCES decision_audit_log(id),
    score               REAL NOT NULL,              -- AFINN raw integer sum
    comparative         REAL NOT NULL,              -- score / token count
    indicator           TEXT NOT NULL,              -- 'positive', 'neutral', 'negative'
    positive_words      TEXT[],
    negative_words      TEXT[],
    token_count         INTEGER,
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sentiment_post       ON sentiment_results(raw_post_id);
CREATE INDEX idx_sentiment_indicator  ON sentiment_results(indicator);

-- Derived relevance result
CREATE TABLE relevance_results (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id         UUID NOT NULL REFERENCES raw_posts(id),
    audit_id            UUID NOT NULL REFERENCES decision_audit_log(id),
    score               REAL NOT NULL,
    matched_keywords    TEXT[],
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_relevance_post   ON relevance_results(raw_post_id);
CREATE INDEX idx_relevance_score  ON relevance_results(score DESC);

-- GDPR lifecycle: every data action is recorded
CREATE TABLE data_retention_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id     UUID,                           -- nullable after erasure
    action          TEXT NOT NULL,                  -- 'collected', 'anonymized', 'deleted', 'erasure_requested'
    reason          TEXT,
    legal_basis     TEXT,                           -- 'GDPR Article 6(1)(f) - Legitimate Interest'
    performed_at    TIMESTAMPTZ DEFAULT NOW(),
    performed_by    TEXT DEFAULT 'system'
);
```

### Migration 003 — Bias & Ethics Tables (`src/db/migrations/003_bias_tables.sql`)

```sql
CREATE TABLE bias_assessments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    job_id          UUID NOT NULL REFERENCES processing_jobs(id),
    assessment_type TEXT NOT NULL,                  -- 'demographic_parity', 'equalized_odds', 'location_concentration'
    group_field     TEXT NOT NULL,                  -- 'location', 'platform', 'age_group', 'source_type'
    group_value     TEXT NOT NULL,
    metric_name     TEXT NOT NULL,
    metric_value    REAL NOT NULL,
    threshold       REAL NOT NULL,
    is_violation    BOOLEAN NOT NULL DEFAULT FALSE,
    severity        TEXT,                           -- 'warning', 'critical'
    evidence        JSONB,                          -- supporting data for the assessment
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_bias_job        ON bias_assessments(job_id);
CREATE INDEX idx_bias_violations ON bias_assessments(is_violation, created_at DESC)
    WHERE is_violation = TRUE;

CREATE TABLE alert_events (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_type      TEXT NOT NULL,                  -- 'bias_violation', 'data_quality', 'model_health'
    severity        TEXT NOT NULL,                  -- 'info', 'warning', 'critical'
    source_id       UUID,                           -- FK to bias_assessments or processing_jobs
    details         JSONB,
    acknowledged_at TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_alerts_unresolved ON alert_events(severity, created_at DESC)
    WHERE resolved_at IS NULL;
```

### Migration 004 — Vector Support (`src/db/migrations/004_vector_support.sql`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE post_embeddings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_post_id     UUID NOT NULL REFERENCES raw_posts(id) UNIQUE,
    embedding       VECTOR(384),                    -- all-MiniLM-L6-v2 output dimensions
    model_name      TEXT NOT NULL DEFAULT 'sentence-transformers/all-MiniLM-L6-v2',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for approximate nearest-neighbor (cosine similarity)
-- Chosen over IVFFlat: 15.5x faster query time (40.5 vs 2.6 QPS at 0.998 recall)
-- Build time is higher (~4000s vs ~130s) but is a one-time cost per index build
-- m=16: good balance of memory and recall; ef_construction=400: higher = better quality index
CREATE INDEX idx_embeddings_hnsw ON post_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 400);
```

---

## 7. API Specification

All responses: `Content-Type: application/json`. All errors follow: `{ "error": "descriptive message" }`. Stack traces, SQL errors, and file paths are never returned to clients.

### `GET /api/health`
Returns system status, last job info, and active unresolved alerts.

**Response 200:**
```json
{
  "status": "healthy",
  "db_connected": true,
  "last_job": {
    "id": "uuid",
    "status": "completed",
    "triggered_by": "cron",
    "posts_collected": 42,
    "posts_processed": 42,
    "started_at": "2026-03-08T10:00:00Z",
    "completed_at": "2026-03-08T10:00:08Z"
  },
  "active_alerts": [
    {
      "id": "uuid",
      "alert_type": "bias_violation",
      "severity": "warning",
      "created_at": "2026-03-08T10:00:08Z"
    }
  ],
  "timestamp": "2026-03-08T10:05:00Z"
}
```
**Response 503:** DB unreachable — `{ "status": "degraded", "db_connected": false }`

---

### `GET /api/posts/aggregated-by-location`
Sentiment breakdown by city for Mapbox. Backed by real PostgreSQL GROUP BY query.

**Query params:** `?platform=reddit` (optional) `?from=ISO8601` (optional) `?to=ISO8601` (optional)

**Validation:** `from`/`to` must be valid ISO dates; reject with `400` if not.

**Response 200:**
```json
[
  {
    "city": "San Francisco",
    "lat": 37.7749,
    "lng": -122.4194,
    "positive": 145,
    "neutral": 88,
    "negative": 32,
    "total": 265,
    "dominant": "positive",
    "last_updated": "2026-03-08T10:00:08Z"
  }
]
```
Note: key is `"city"` (not `"name"`) — matches `map.js` line 34 which reads `p.city`.

---

### `GET /api/sentiment/latest`
Aggregate summary + recent posts for dashboard refresh panel.

**Query params:** `?limit=20` (1–100, default 20) `?platform=reddit` (optional)

**Response 200:**
```json
{
  "summary": {
    "total": 1240,
    "positive": 612,
    "neutral": 445,
    "negative": 183,
    "avg_comparative": 0.12,
    "last_updated": "2026-03-08T10:00:08Z"
  },
  "recent_posts": [
    {
      "id": "uuid",
      "content_snippet": "Discussion about AI job displacement concerns...",
      "sentiment_indicator": "negative",
      "score": -3,
      "comparative": -0.21,
      "location": "London",
      "source": "reddit",
      "collected_at": "2026-03-08T09:58:12Z",
      "audit_id": "uuid"
    }
  ],
  "refreshed_at": "2026-03-08T10:05:00Z"
}
```

---

### `POST /api/refresh`
Triggers a data collection + processing run. Rate limited: 1 request per minute per IP.

**Response 200:**
```json
{ "job_id": "uuid", "status": "started", "triggered_by": "api" }
```
**Response 429:** `{ "error": "Rate limit exceeded. Try again in 60 seconds." }`

---

### `GET /api/audit/:post_id`
The explainability endpoint. Returns complete decision trail for any post. This is what you show to journalists, regulators, and researchers who ask "why".

**Path param:** `post_id` — validated as UUID format before query.

**Response 200:**
```json
{
  "post": {
    "id": "uuid",
    "content_snippet": "Discussion about AI job displacement concerns growing across manufacturing...",
    "source": "reddit",
    "location": "London",
    "collected_at": "2026-03-08T09:58:12Z"
  },
  "decisions": [
    {
      "decision_type": "sentiment",
      "model_name": "afinn-sentiment-npm-v5.0.2",
      "methodology_version": "1.0.0",
      "justification": "AFINN-165 English word list with comparative normalization (score / token count). Thresholds: comparative > 0.05 → positive, < -0.05 → negative, else neutral. Evidence-based threshold derived from distribution analysis of AI discourse corpus. See: pulse-of-ai-evidence-based-thresholds.pdf Section 3.",
      "output": {
        "score": -3,
        "comparative": -0.21,
        "indicator": "negative",
        "positive_words": [],
        "negative_words": ["displacement", "concerns", "growing"],
        "token_count": 14
      },
      "confidence": null,
      "created_at": "2026-03-08T09:58:14Z"
    },
    {
      "decision_type": "relevance",
      "model_name": "keyword-relevance-v1.0",
      "methodology_version": "1.0.0",
      "justification": "Keyword matching against 16 AI-domain terms. Score = matched_count * 0.1, capped at 1.0. Terms sourced from AI taxonomy in config/taxonomy.yaml. Threshold > 0.95 to qualify as AI discourse.",
      "output": {
        "score": 0.97,
        "matched_keywords": ["ai", "autonomous", "machine learning"]
      },
      "confidence": null,
      "created_at": "2026-03-08T09:58:14Z"
    }
  ]
}
```
**Response 400:** `{ "error": "Invalid post_id format" }`
**Response 404:** `{ "error": "Post not found" }`

---

### `GET /api/bias/latest`
Returns the most recent bias assessment run results.

**Response 200:**
```json
{
  "assessed_at": "2026-03-08T10:00:08Z",
  "job_id": "uuid",
  "overall_status": "warning",
  "violations": [
    {
      "id": "uuid",
      "assessment_type": "location_concentration",
      "group_field": "location",
      "group_value": "San Francisco",
      "metric_name": "share_of_total_posts",
      "metric_value": 0.68,
      "threshold": 0.60,
      "severity": "warning",
      "evidence": {
        "total_posts": 265,
        "san_francisco_posts": 180
      }
    }
  ],
  "all_metrics": {
    "location_concentration": {
      "San Francisco": 0.68,
      "New York": 0.15,
      "London": 0.10,
      "Tokyo": 0.07
    },
    "platform_sentiment_parity": {
      "reddit_avg_comparative": 0.12,
      "simulated_avg_comparative": 0.09,
      "difference": 0.03
    }
  }
}
```

---

### `GET /api/methodology`
Returns all versioned methodology configurations, ordered by component and effective date. Designed for researchers and auditors.

**Response 200:**
```json
[
  {
    "id": "uuid",
    "component": "sentiment",
    "version": "1.0.0",
    "model_name": "afinn-sentiment-npm-v5.0.2",
    "config": {
      "positive_threshold": 0.05,
      "negative_threshold": -0.05,
      "accuracy_target": 0.80
    },
    "justification": "AFINN-165 lexicon validated on social media text by Nielsen (2011). Comparative score normalizes for post length. Thresholds of ±0.05 separate meaningful sentiment from noise. See: pulse-of-ai-evidence-based-thresholds.pdf Section 3.",
    "effective_from": "2026-03-08T00:00:00Z",
    "deprecated_at": null
  },
  {
    "id": "uuid",
    "component": "relevance",
    "version": "1.0.0",
    "model_name": "keyword-relevance-v1.0",
    "config": {
      "keywords": ["artificial intelligence", "machine learning", "deep learning", "neural network", "chatgpt", "gpt", "ai", "automation", "algorithm", "robot", "autonomous", "computer vision", "natural language", "llm", "generative", "openai"],
      "score_per_match": 0.1,
      "max_score": 1.0,
      "ai_relevance_threshold": 0.95
    },
    "justification": "Domain keyword taxonomy from AI academic literature. Each matched keyword contributes 0.1 to relevance score, capped at 1.0. Threshold 0.95 ensures 95%+ AI-relevance filter per MVP requirements.",
    "effective_from": "2026-03-08T00:00:00Z",
    "deprecated_at": null
  }
]
```

---

### `GET /api/sources`
Returns all registered data sources with their collection status and category.

**Response 200:**
```json
[
  {
    "id": "uuid",
    "name": "reddit_artificial",
    "source_type": "reddit",
    "category": "social",
    "active": true,
    "last_collected_at": "2026-03-08T10:00:00Z",
    "posts_last_run": 42
  }
]
```

---

### `POST /api/query`
Non-real-time query interface. Accepts structured filters and returns aggregated results. Designed for journalists and researchers who need custom slices not covered by the live dashboard.

**Rate limited:** 10 requests per minute per IP.

**Request body:**
```json
{
  "filters": {
    "source_categories": ["social", "news"],
    "date_from": "2026-01-01T00:00:00Z",
    "date_to": "2026-03-01T00:00:00Z",
    "sentiment_indicators": ["negative"],
    "locations": ["United Kingdom", "Germany"],
    "min_relevance_score": 0.95
  },
  "group_by": "location",
  "limit": 100
}
```

**Response 200:**
```json
{
  "query_id": "uuid",
  "executed_at": "2026-03-08T10:05:00Z",
  "filters_applied": { "source_categories": ["social", "news"], "...": "..." },
  "total_matched": 834,
  "results": [
    {
      "group": "United Kingdom",
      "positive": 210,
      "neutral": 380,
      "negative": 244,
      "total": 834,
      "dominant": "neutral",
      "avg_comparative": -0.04
    }
  ],
  "note": "Query covers detailed data. For dates > 3 months ago, results are from monthly rollups (§19)."
}
```
**Response 400:** Invalid filter values.
**Response 429:** Rate limit exceeded.

---

## 8. Security & Privacy Design

### Secrets Management
- All credentials in `.env` only — never in code, comments, or git history
- `.env.example` committed (structure only, no values)
- `.env` in `.gitignore`
- `process.env` is the only access point — values are never logged, never returned in API responses
- If external API key is absent, system falls back to mock data with an explicit log warning — no silent failure

### PII Handling on Ingest (GDPR Data Minimization)

```
Incoming post (Reddit/Twitter)
        │
        ▼
Strip: @mentions, u/usernames (regex)
Strip: raw_payload.author, .author_fullname, .user_id
Normalize: trim whitespace, lowercase for hashing
        │
        ▼
content_hash = SHA-256(normalized_content)
        │
        ▼
Check: content_hash EXISTS in raw_posts?
  YES → skip (deduplication via hash, not re-identification)
  NO  → INSERT into raw_posts with sanitized content
        │
        ▼
Log to data_retention_log: action='collected', legal_basis='GDPR Article 6(1)(f)'
```

**What is NEVER stored:**
- Usernames or account handles
- User IDs (platform-internal)
- Email addresses
- IP addresses or location beyond city-level metadata
- Profile information of any kind
- Post metadata that enables user re-identification (karma score, account age, etc.)

### Input Sanitization (Route Layer)
All route inputs are validated before reaching the DB layer:

| Input | Validation | Rejection |
|---|---|---|
| `:post_id` path param | UUID regex `/^[0-9a-f-]{36}$/i` | 400 Invalid format |
| `?from`, `?to` query params | `Date.parse()` !== NaN | 400 Invalid date |
| `?limit` query param | parseInt, clamp 1–100 | Default to 20 |
| `?platform` query param | Allowlist check | Ignored if unknown |

### Rate Limiting
- `POST /api/refresh`: 1 request per minute per IP. In-memory counter (no Redis for MVP). Resets on server restart — acceptable for v1.
- All GET endpoints: no rate limit (public read-only dashboard).

### Error Responses — No Information Leakage
```javascript
// Good — generic message only
res.status(500).json({ error: 'Internal server error' });

// Never — do not return:
// - Stack traces
// - SQL error messages (contain table/column names)
// - File paths
// - Environment variable names
```

---

## 9. Bias Monitoring System

### When It Runs
Automatically at the end of every processing job, after all posts are processed and stored.

### Three-Layer Bias Detection Stack

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

### Bias Metrics Table

| Metric | Field | Formula | Threshold | Severity | Source |
|---|---|---|---|---|---|
| Location concentration | location | max(posts_per_loc / total) | > 0.60 | warning | Evidence-based thresholds doc |
| Negative dominance | global | negative / total | > 0.70 | warning | Evidence-based thresholds doc |
| Platform parity | platform | |avg_comp_A - avg_comp_B| | > 0.30 | warning | Research literature |
| Demographic parity diff | group | |P(pos|A) - P(pos|B)| | > 0.10 | warning, > 0.20 critical | AI Act fairness guidance |
| Equalized odds | group | |TPR_A - TPR_B| | > 0.08 | warning | Hardt et al. 2016 |
| Counterfactual fairness | sample | |conf_A - conf_B| | > 0.05 | review flag | Russell et al. 2017 |

### Alert Flow
```
bias_assessments.is_violation = TRUE
        │
        ▼
alert_events INSERT (severity from assessment)
        │
        ▼
GET /api/health → active_alerts array includes this alert
        │
        ▼
Frontend status dot → yellow (warning) or red (critical)
        │
        ▼
GET /api/bias/latest → full detail for dashboard display
```

---

## 10. Governance & Audit Architecture

### The Explainability Chain

Every inference follows this chain. All links are navigable from a single post ID:

```
raw_posts.id
    → decision_audit_log.raw_post_id
        → decision_audit_log.methodology_version_id
            → methodology_versions.justification (plain English)
            → methodology_versions.config (exact parameters used)
        → decision_audit_log.output (full scored result)
        → decision_audit_log.input_hash (SHA-256 of what was analyzed)
    → sentiment_results.audit_id (derived display data)
```

### Responding to "Why?" by Audience

| Audience | What they ask | What they get from `GET /api/audit/:post_id` |
|---|---|---|
| Journalist | "Why does this city score negative?" | Plain English: negative words found, model used, threshold explanation |
| Regulator | "What algorithm made this decision?" | Model name, version, config JSONB, justification, date effective |
| Internal audit | "Did methodology change between runs?" | methodology_versions.deprecated_at shows when and processing_jobs links each run to its version |
| Researcher | "Can I reproduce this score?" | input_hash + model_name + config + output — full reproducibility trace |

### Methodology Seeding
Before any inference runs, `scripts/seed.js` inserts the initial methodology versions:

```javascript
// Seeded on project setup — never changes in production without a new version row
{
    component: 'sentiment',
    version: '1.0.0',
    model_name: 'afinn-sentiment-npm-v5.0.2',
    config: { positive_threshold: 0.05, negative_threshold: -0.05, accuracy_target: 0.80 },
    justification: 'AFINN-165 lexicon...' // full text
}
```

---

## 11. End User Experience Design

### Three Primary Personas (from MVP requirements doc)

**Persona 1: The Journalist (primary)**
- Goal: Find story angles in <2 minutes
- Entry point: Map loads immediately on page load with current sentiment
- Flow: scroll down → demographics → topics → specific post → audit trail
- Key feature: Every data point has a "why?" link (audit endpoint)
- Device: Desktop primarily, tablet secondary

**Persona 2: The Researcher**
- Goal: Verify methodology, download data, reproduce findings
- Entry point: `GET /api/methodology` for algorithm documentation
- Flow: API-first, uses `GET /api/audit/:post_id` for spot-checking
- Key feature: Full audit trail, methodology versioning history

**Persona 3: The Policy Maker**
- Goal: Monitor for bias incidents, track sentiment over time
- Entry point: Model health indicator (top right of dashboard)
- Flow: health → bias/latest → specific violation → remediation
- Key feature: Traffic light system, alert history

### Page Load Priority (Performance Budget: <3s)

```
Priority 1 (immediate): Navbar + Map container
Priority 2 (on data): Map markers populate from /api/posts/aggregated-by-location
Priority 3 (lazy): Demographics section
Priority 4 (lazy): Topics section
```

Map is visible and labeled within 1s (even before data loads). Markers appear as soon as the API responds (targeting <500ms DB query).

### Scroll-Driven Narrative (Scrollama)

Scrollama library is already in the project but unused. Integration plan:
- Step 1 (50% viewport): Map section → trigger marker animation
- Step 2 (50% viewport): Demographics → D3 chart begins drawing
- Step 3 (50% viewport): Topics → topic tree animates in

### Color System (Seaborn — locked in design phase)
| Purpose | Color | Hex |
|---|---|---|
| Positive sentiment | mako scale high | #62C370 |
| Negative sentiment | rocket scale high | #B63634 |
| Neutral sentiment | vlag mid | #2E3B4E |
| UI accent | — | #58a6ff |
| Background primary | — | #0d1117 |
| Background secondary | — | #161b22 |

All palettes are colorblind-friendly (WCAG 2.1 AA compliance requirement from MVP spec).

### Accessibility Requirements
- All map markers have aria-label with city name and dominant sentiment
- Color is never the only indicator (shape + label on tooltips)
- Font contrast ratio ≥ 4.5:1 (AA standard)
- Keyboard navigation for all interactive elements
- Screen reader-compatible DOM structure

---

## 12. Embedding & Vector Search

### Model: `sentence-transformers/all-MiniLM-L6-v2`

| Property | Value |
|---|---|
| Dimensions | 384 |
| Parameters | 22M |
| Disk size | ~22MB |
| CPU throughput | ~1000 sentences/sec |
| STS-B accuracy | 84-85% |
| Chosen over `all-mpnet-base-v2` | 5x faster, 3-4% accuracy trade-off — acceptable for trend monitoring |

### Deployment: Infinity Service

```bash
# Install
pip install infinity-embed

# Start (exposes :8000, OpenAI-compatible API)
infinity_emb start \
  --model-name-or-path sentence-transformers/all-MiniLM-L6-v2 \
  --batch-size 64 \
  --model-warmup true
```

**Why Infinity over plain Flask:**
- Dynamic batching: queues concurrent requests, 30-40% throughput improvement
- ctranslate2 backend: 2-4x faster inference than vanilla PyTorch
- Same OpenAI-compatible API: easy to swap embedding model later

### Node.js Integration (`src/pipeline/embeddings.js`)

```javascript
const axios = require('axios');

const EMBEDDINGS_URL = process.env.EMBEDDINGS_SERVICE_URL || 'http://localhost:8000';

// Cache: content_hash → embedding vector
// Avoids re-embedding identical content (common in discourse monitoring)
const cache = new Map();

async function embedTexts(texts, hashes) {
    const uncached = texts.filter((_, i) => !cache.has(hashes[i]));

    if (uncached.length > 0) {
        const response = await axios.post(`${EMBEDDINGS_URL}/embeddings`, {
            input: uncached,
            model: 'sentence-transformers/all-MiniLM-L6-v2'
        });
        response.data.data.forEach((item, i) => {
            cache.set(hashes[texts.indexOf(uncached[i])], item.embedding);
        });
    }

    return hashes.map(h => cache.get(h));
}
```

### Vector Index: HNSW

```sql
-- HNSW chosen over IVFFlat
-- Benchmark: HNSW achieves 40.5 QPS vs IVFFlat's 2.6 QPS at 0.998 recall (15.5x faster)
-- Build time trade-off: HNSW ~4065s vs IVFFlat ~128s (acceptable: one-time cost)
-- Storage trade-off: HNSW ~729MB vs IVFFlat ~257MB (acceptable for 1M rows)
CREATE INDEX idx_embeddings_hnsw ON post_embeddings
    USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 400);
```

### Use Cases for Vector Search
1. **Deduplication**: Before inserting, check if content_hash already exists (hash-based, faster than vector)
2. **Similar post retrieval**: `POST /api/similar/:post_id` — Phase 2 feature
3. **Topic clustering**: Group semantically similar posts — replaces BERTopic in Phase 2
4. **Semantic search**: Free-text search across discourse — Phase 3 feature

---

## 13. Implementation Phases (TDD)

### TDD Rule: Every component follows Red → Green → Refactor
Write the failing test first. Write only enough code to make it pass. Refactor. Never write production code without a failing test.

### Phase A: Infrastructure (Pre-coding Setup)

All of these must be complete before writing a single feature:

1. `docker-compose.yml` — postgres:pgvector16 + postgres_test
2. `.env.example` + `.env` + `.gitignore` entries
3. `package.json` — add `pg`, `@pgvector/pg`, `jest`, `supertest`; remove `sqlite3`
4. `jest.config.js` + `tests/setup.js` (test DB connection + migration + truncate)
5. `src/db/migrations/001–004.sql` — all four migration files
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
tests/integration/api.method.test.js    → src/routes/methodology.js
```

### Phase D: Embeddings

```
python/tests/test_embeddings.py         → python/embeddings_service.py (full)
tests/unit/embeddings.test.js           → src/pipeline/embeddings.js
tests/integration/api.similar.test.js  → src/routes/similar.js (Phase 2)
```

### Phase E: Frontend (back to front, last)
Only after all backend tests pass:
- Fix `map.js` tooltip bug (`p.city` was correct, server was wrong — fixed in new endpoint)
- Wire `main.js` to real `/api/sentiment/latest`
- Add `/api/health` to status dot logic (show yellow/red for alerts)
- Integrate Scrollama for scroll-driven sections
- Demographics and Topics sections (D3.js charts)

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
| Data refresh interval | 2–3 min | cron schedule (global, 50 sources) |
| System uptime | 99% | Process health check |
| Cross-platform correlation latency | < 30s per batch | processing_jobs.completed_at - started_at |

### Accuracy Targets (v1.1.0 — 99% target across all components)
| Component | Target | How to Measure |
|---|---|---|
| Sentiment v1 (AFINN) | ≥ 99% on validated sample | Hand-labeled 500-post benchmark set, re-run monthly |
| Sentiment v2 (RoBERTa, Phase 2) | ≥ 99% | Standard SemEval sentiment benchmark |
| AI relevance filter | ≥ 99% precision | Manual review of 200 random posts per month |
| Discourse quality (DQI) | Calibrated to labeled deliberation corpus | Academic DQI benchmark from Steenbergen et al. |
| Demographic inference (Phase 2) | ≥ 99% | Labeled test set with known demographics |
| Cross-platform correlation | ≥ 99% precision (low false-positive tolerance) | Labeled test set of known cross-platform accounts |

**Rationale for 99% target:** Inferences appear in a public-facing dashboard read by journalists and policy makers. A false negative or false positive at 80% confidence can produce a misleading headline. All models must be validated on labeled benchmarks before production. AFINN v1 will not meet 99% — it is the audit pattern foundation only. RoBERTa (Phase 2) targets 99% on the validated benchmark.

### Ethical Quality Gates
| Check | Pass Criteria |
|---|---|
| All thresholds documented | methodology_versions table has justification for every component |
| All decisions auditable | decision_audit_log has a row for every processed post |
| No PII in DB | grep for @, username, email patterns in raw_posts.content sample |
| Bias assessment runs | bias_assessments table populated after every job |

---

## 15. Alternatives Considered

### Database

| Alternative | Why Considered | Why Not Chosen |
|---|---|---|
| SQLite | Existing in project, zero setup | No pgvector; no row-level security; no concurrent writes; not production-grade |
| MongoDB | Flexible JSONB-like documents | Poor JOIN performance for audit queries; no native vector index; no ACID transactions across collections |
| MySQL + separate Pinecone | Familiar + managed vector | Pinecone sends data to external API (GDPR risk); MySQL lacks JSONB; additional infrastructure |
| Neo4j | Graph relationships between topics | Excellent for Phase 2 topic graphs; too complex for Phase 1 foundation; add later |

### Vector Index

| Alternative | Why Considered | Why Not Chosen |
|---|---|---|
| IVFFlat | Faster to build (~128s vs ~4065s) | 15.5x slower at query time (2.6 vs 40.5 QPS at 0.998 recall); acceptable build cost |
| Chroma | Popular open-source vector DB | Separate service adds ops complexity; pgvector puts vector + relational in one transaction boundary |
| Weaviate | Production-grade vector search | Significant ops overhead; overkill for MVP data volumes |

### Embedding Model

| Alternative | Why Considered | Why Not Chosen |
|---|---|---|
| `all-mpnet-base-v2` (768-dim) | 3-4% better accuracy | 5x slower inference; 2x more storage; marginal gain for trend monitoring |
| OpenAI `text-embedding-3-small` | High quality, easy API | Data leaves infrastructure (GDPR risk); API cost at scale; offline impossible |
| `e5-large` (1024-dim) | State of the art | Too slow for real-time; 8GB+ RAM required; extreme overkill for discourse trends |

### Sentiment Analysis

| Alternative | Why Considered | Why Not Chosen |
|---|---|---|
| VADER (Python) | Designed for social media | Requires Python subprocess call; `sentiment` npm achieves comparable results synchronously |
| RoBERTa (Phase 1) | 80%+ accuracy target | Too slow for MVP; 6GB RAM; methodology_versions allows upgrade without code changes |
| AWS Comprehend | Managed, accurate | Data leaves infrastructure; per-request cost at scale |
| TextBlob | Simple Python NLP | Requires Python service for Phase 1; not worth the overhead vs `sentiment` npm |

---

## 16. Open Questions & Future Phases

### Resolved (v1.1.0)
1. **Refresh interval**: ✅ Resolved — 2–3 minutes. Sources are batched; each source polled on its own schedule within the 2-3 min window. Rate limits handled per-source with exponential backoff. See §17.
2. **Retention policy**: ✅ Resolved — Layered 3-tier architecture. See §19 for full design.
3. **Accuracy target**: ✅ Resolved — 99% for all inference components. Phase 1 (AFINN) is the audit pattern foundation; Phase 2 (RoBERTa) must validate ≥ 99% before serving as primary signal.
4. **Scope**: ✅ Resolved — Global. No geographic restriction. Top 50 sources from all regions. See §17.
5. **Discourse algorithm**: ✅ Resolved — Deliberative Quality Index (DQI) with semantic embedding improvements. See §18.

### Open Questions (to resolve before Phase B)
1. **Location inference**: Reddit posts don't include location metadata. Inference approach options: (a) user flair text extraction, (b) subreddit geography mapping (r/unitedkingdom → UK), (c) content NLP for mentioned locations, (d) IP geolocation at collection time (GDPR risk). Recommended: (b) + (c) as GDPR-safe combination.
2. **Discourse API vs "discourse"**: The existing `discourse.db` refers to the project name, not the Discourse platform. Confirmed: no Discourse instance to scrape. All sources defined in §17.
3. **Academic source access**: arXiv is open. Semantic Scholar API is free tier (100 req/day) — need to evaluate if sufficient for 2–3 min polling. ACM Digital Library requires institutional access for full text.
4. **Twitter/X API cost**: $100/month Basic tier required for meaningful search. Decision needed: include in initial 50 or substitute with Mastodon/Bluesky?
5. **Cross-platform correlation cold start**: Verb-noun ID assignment requires ≥ 2 platform sightings with ≥ 0.85 correlation confidence. How to handle single-platform authors? (Answer: no ID assigned, counted as unlinked in analytics.)

### Future Phases (not in scope for Phase 1)
| Feature | Phase | Prerequisite |
|---|---|---|
| RoBERTa sentiment upgrade (99% target) | 2 | Phase A/B/C complete, AFINN baseline established, labeled benchmark set |
| BERTopic / pgvector topic clustering | 2 | Embeddings pipeline (Phase D) complete |
| Demographic inference (99% target) | 2 | Labeled training data, bias framework established |
| Similar post retrieval (`/api/similar/:post_id`) | 2 | Embeddings in DB |
| Full DQI discourse scoring | 2 | Embeddings + topic pipeline complete |
| Cross-platform correlation (full) | 2 | Phase D complete, 2+ source coverage |
| Neo4j topic relationship graph | 3 | Topic classification working |
| D3 demographics charts | E | Backend complete |
| D3 topic evolution tree | E | Topics pipeline complete |
| D3 discourse quality timeline | E | DQI pipeline complete |
| TV display / kiosk mode | 3 | Full dashboard working |
| Counterfactual fairness (full) | 3 | Labeled dataset, RoBERTa in place |
| Differential privacy on aggregates | 3 | Regulatory requirement assessment |
| Monthly compaction job automation | 2 | 3+ months of data collected |

---

## 17. Source Taxonomy — Top 50

Sources are organized into 7 categories. Each category has a `source_type` in `data_sources` and a `category` field for bias analysis (source concentration across categories is a monitored metric).

The 2–3 minute refresh is achieved by distributing collection across the window. High-volume sources (Reddit, arXiv) run every 2 min; lower-volume sources (policy blogs, non-profits) run every 10–15 min on a staggered schedule.

### Category 1: Social Platforms (8 sources)
| Source | API/Method | Rate Limit | Priority |
|---|---|---|---|
| Reddit (`r/artificial`, `r/MachineLearning`, `r/AIEthics`) | Reddit API (free) | 60 req/min | P1 |
| Twitter/X (AI discourse search) | Basic API ($100/mo) | 500K tweets/mo | P1 (pending cost decision) |
| Mastodon (`mastodon.social`, `hachyderm.io`) | ActivityPub (free) | No hard limit | P1 |
| Bluesky (AI-tagged posts) | AT Protocol (free) | No hard limit | P1 |
| Hacker News (AI submissions) | Algolia API (free) | No limit | P1 |
| LinkedIn (public AI posts) | Web scraping (Playwright) | Politeness delay | P2 |
| Threads (AI hashtags) | Web scraping | Politeness delay | P2 |
| Discord (public AI servers) | Discord API (approved) | Varies | P2 |

### Category 2: News Outlets (10 sources)
| Source | Method | Frequency |
|---|---|---|
| TechCrunch | RSS + scrape | 5 min |
| Wired | RSS + scrape | 10 min |
| MIT Technology Review | RSS + scrape | 10 min |
| Ars Technica | RSS + scrape | 10 min |
| The Verge (AI section) | RSS + scrape | 10 min |
| VentureBeat (AI section) | RSS + scrape | 10 min |
| IEEE Spectrum | RSS + scrape | 15 min |
| Nature News | RSS + scrape | 15 min |
| Science Magazine | RSS + scrape | 15 min |
| Reuters Technology | RSS | 5 min |

### Category 3: Academic (6 sources)
| Source | Method | Coverage |
|---|---|---|
| arXiv (`cs.AI`, `cs.CL`, `cs.LG`, `cs.CV`, `cs.RO`) | arXiv API (free) | Preprints, daily |
| Semantic Scholar | S2 API (free, 100 req/day) | Citations + abstracts |
| ACM Digital Library | RSS (open abstracts only) | Conference papers |
| PubMed (AI in medicine) | E-utilities API (free) | Medical AI |
| SSRN (AI policy papers) | RSS | Policy preprints |
| OpenReview (NeurIPS, ICML, ICLR) | OpenReview API (free) | Peer review discourse |

### Category 4: Policy & Political (8 sources)
| Source | Method |
|---|---|
| Electronic Frontier Foundation | RSS |
| AI Now Institute | RSS + scrape |
| RAND Corporation (AI reports) | RSS |
| Brookings Institution (AI) | RSS |
| Center for AI Safety | RSS + scrape |
| EU AI Office | RSS |
| US NIST AI Resources | RSS |
| Georgetown CSET | RSS |

### Category 5: Non-Profit & Think Tanks (7 sources)
| Source | Method |
|---|---|
| Future of Life Institute | RSS + scrape |
| Partnership on AI | RSS + scrape |
| Mozilla Foundation (AI) | RSS |
| OpenMind (constructive AI discourse) | RSS + scrape |
| AI4People | RSS |
| Algorithm Watch | RSS |
| Access Now | RSS |

### Category 6: Developer & Research Communities (6 sources)
| Source | Method |
|---|---|
| GitHub Discussions (major AI repos: transformers, llama.cpp, stable-diffusion) | GitHub API |
| Stack Overflow (AI/ML tags) | Stack Exchange API (free) |
| Hugging Face Community | HF API (free) |
| Papers With Code (comments, trending) | Web scrape |
| Kaggle Forums | Web scrape |
| fast.ai Forums | Discourse API |

### Category 7: Blogs & Newsletters (5 sources)
| Source | Method |
|---|---|
| LessWrong | LessWrong API (free) |
| AI Alignment Forum | API (shared with LessWrong) |
| Substack (AI-tagged newsletters) | RSS aggregation |
| Medium (AI tag, top 50 posts) | RSS |
| Stratechery (AI analysis) | RSS (public posts) |

### Source Registry Seed Data (`scripts/seed.js`)
All 50 sources are seeded into `data_sources` on setup. Each row includes:
- `name`: unique slug (e.g., `reddit_machinelearning`)
- `source_type`: `reddit | twitter | rss | api | scrape`
- `category`: `social | news | academic | policy | nonprofit | developer | blog`
- `config` JSONB: non-secret settings (subreddit name, RSS URL, poll interval in seconds, etc.)
- `active`: `true` for all P1 sources; `false` for P2 until enabled

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

### Industry Standard Foundation: Deliberative Quality Index (DQI)

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

**Stored in `methodology_versions` as:** component = `'discourse'`, version = `'1.0.0-DQI'`

### Pulse of AI Improvements Over Baseline DQI

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
cross_platform_spread = unique source_categories mentioning argument cluster / 7
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

### DQI Score Output Format (stored in `decision_audit_log.output`)
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
TIER 1: Detail Window (0–3 months)
  Tables: raw_posts, sentiment_results, relevance_results,
          decision_audit_log, post_embeddings, data_retention_log
  Granularity: Post-level (every individual post stored)
  Purpose: Dashboard display, audit trail, explainability, spot-checks
  Access: All API endpoints, full resolution

TIER 2: Monthly Compaction (3 months → indefinite)
  Tables: monthly_topic_rollups, monthly_source_rollups,
          monthly_discourse_rollups
  Granularity: Monthly aggregate per topic/category/location
  Purpose: Trend research, historical journalism, policy analysis
  Access: GET /api/rollups/:year/:month, POST /api/query (with note)
  Raw posts: content field nulled, embeddings deleted, audit skeleton kept

TIER 3: Permanent Archival (automatic — no expiry)
  Tables: methodology_versions, processing_jobs (metadata only),
          bias_assessments (aggregates), alert_events
  Granularity: Run-level and methodology-level
  Purpose: Audit compliance, reproducibility, GDPR accountability
  Access: GET /api/methodology, GET /api/audit/:post_id (audit skeleton)
```

### Migration 005 — Retention & Compaction Tables

```sql
-- Monthly rollup: topic-level aggregates for historical access
CREATE TABLE monthly_topic_rollups (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    rollup_month    DATE NOT NULL,              -- first day of month
    topic_label     TEXT NOT NULL,              -- BERTopic label or keyword cluster
    source_category TEXT,                       -- null = all categories combined
    location        TEXT,                       -- null = global
    post_count      INTEGER NOT NULL,
    positive_count  INTEGER NOT NULL DEFAULT 0,
    neutral_count   INTEGER NOT NULL DEFAULT 0,
    negative_count  INTEGER NOT NULL DEFAULT 0,
    avg_comparative REAL,
    avg_dqi_score   REAL,
    top_keywords    TEXT[],
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(rollup_month, topic_label, source_category, location)
);

CREATE INDEX idx_rollup_month   ON monthly_topic_rollups(rollup_month DESC);
CREATE INDEX idx_rollup_topic   ON monthly_topic_rollups(topic_label);
```

```sql
-- Monthly source-level aggregates
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
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(rollup_month, source_id)
);

-- Compaction job log: tracks which months have been compacted
CREATE TABLE compaction_log (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    compacted_month DATE NOT NULL UNIQUE,
    posts_compacted INTEGER NOT NULL,
    rollups_created INTEGER NOT NULL,
    embeddings_deleted INTEGER NOT NULL DEFAULT 0,
    content_nulled  INTEGER NOT NULL DEFAULT 0,
    completed_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### Compaction Job Logic (`scripts/compact.js`)
Runs on the 1st of each month. Compacts all posts older than 3 months:

```
1. Identify posts WHERE collected_at < NOW() - INTERVAL '3 months'
2. Aggregate into monthly_topic_rollups (GROUP BY month, topic, source_category, location)
3. Aggregate into monthly_source_rollups (GROUP BY month, source_id)
4. Null out raw_posts.content (keep id, source_id, content_hash, location, collected_at)
5. Delete post_embeddings rows for compacted posts
6. Write data_retention_log: action='compacted', reason='3-month detail window expired'
7. Write compaction_log entry
```

**What is preserved after compaction:**
- `raw_posts` row (content nulled, metadata kept — for audit chain integrity)
- `decision_audit_log` rows (input_hash, output JSONB, model_name — full audit)
- `methodology_versions` (never deleted)
- `monthly_topic_rollups` and `monthly_source_rollups`
- `bias_assessments` and `alert_events`

**What is deleted after compaction:**
- `post_embeddings` (large, re-computable if needed)
- `raw_posts.content` field (nulled — privacy compliance)

### API Behavior for Historical Queries
When `POST /api/query` date range falls partly outside the detail window:
```json
{
  "note": "Date range spans both detail and rollup data. Results before 2025-12-08 are from monthly rollups (post-level detail not available).",
  "detail_coverage": { "from": "2026-03-08", "to": "2026-01-08" },
  "rollup_coverage": { "from": "2025-01-01", "to": "2025-12-31" }
}
```

---

## 20. Cross-Platform User Correlation

### Design Principles

Cross-platform user correlation is the most privacy-sensitive feature in the system. The goal is to identify when the same person appears on multiple platforms so that their discourse contribution can be analyzed as a coherent voice — without ever storing who that person is.

**Hard rules:**
- No platform username, handle, or ID is ever stored (stripped on ingest — §8)
- A pseudonymous verb-noun ID is assigned only when correlation confidence ≥ 0.85
- The correlation signals used to compute the ID are hashed before storage — not reversible
- A user's cross-platform identity cannot be recovered from any stored data
- IDs are stable within a session but salted per-deployment (cannot correlate across instances)

### Verb-Noun ID System

A pseudonymous ID is a two-word combination: `<verb>-<noun>`. Examples: `running-tiger`, `collapsed-orbit`, `diverging-forest`.

**Generation:**
```
correlation_fingerprint = SHA-256(
    style_embedding_cluster_id +     -- which writing-style cluster this author belongs to
    temporal_pattern_hash +          -- posting time distribution (morning/evening/weekly)
    topic_affinity_hash +            -- top 5 topic categories by engagement
    deployment_salt                  -- random value set at deployment, never logged
)

verb_index = correlation_fingerprint[0:8] mod len(VERB_LIST)   -- 500 verbs
noun_index = correlation_fingerprint[8:16] mod len(NOUN_LIST)  -- 500 nouns

pseudo_id = VERB_LIST[verb_index] + '-' + NOUN_LIST[noun_index]
```

ID space: 500 × 500 = 250,000 unique IDs. Collision rate is low enough for discourse analytics; not intended as a unique key.

### Migration 006 — Cross-Platform Correlation Tables

```sql
-- Pseudonymous user profiles: no PII, only inferred behavioral signals
CREATE TABLE pseudonymous_users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pseudo_id           TEXT NOT NULL,              -- verb-noun ID (e.g., 'running-tiger')
    style_cluster_id    TEXT,                       -- writing style embedding cluster
    topic_affinity      TEXT[],                     -- top 5 topic categories
    platform_count      INTEGER DEFAULT 1,          -- how many platforms sighted on
    first_sighted_at    TIMESTAMPTZ DEFAULT NOW(),
    last_sighted_at     TIMESTAMPTZ DEFAULT NOW(),
    correlation_confidence REAL NOT NULL            -- ≥ 0.85 to be assigned
);

CREATE INDEX idx_pseudo_id      ON pseudonymous_users(pseudo_id);
CREATE INDEX idx_pseudo_cluster ON pseudonymous_users(style_cluster_id);
```

```sql
-- Link raw posts to pseudonymous users (optional FK — null if unlinked)
-- raw_posts gains a nullable FK: pseudo_user_id UUID REFERENCES pseudonymous_users(id)
-- This is applied as an ALTER TABLE in migration 006, after migration 001

ALTER TABLE raw_posts ADD COLUMN pseudo_user_id UUID REFERENCES pseudonymous_users(id);
CREATE INDEX idx_raw_posts_pseudo ON raw_posts(pseudo_user_id) WHERE pseudo_user_id IS NOT NULL;

-- Sighting log: each time a correlated user appears on a new platform
CREATE TABLE user_platform_sightings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pseudo_user_id  UUID NOT NULL REFERENCES pseudonymous_users(id),
    source_id       UUID NOT NULL REFERENCES data_sources(id),
    signal_hash     TEXT NOT NULL,              -- SHA-256 of correlation signals (not reversible)
    confidence      REAL NOT NULL,
    sighted_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_sightings_user   ON user_platform_sightings(pseudo_user_id);
CREATE INDEX idx_sightings_source ON user_platform_sightings(source_id);
```

### Correlation Signals

Correlation runs as a background step after embeddings are stored (Phase D). No correlation runs in Phase 1.

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

### API: Cross-Platform Profile
`GET /api/users/:pseudo_id` — returns a pseudonymous user's cross-platform discourse profile.

```json
{
  "pseudo_id": "running-tiger",
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
- [ ] Verify `deployment_salt` is not logged anywhere
- [ ] Verify `signal_hash` cannot be reversed to source signals
- [ ] Verify `GET /api/users/:pseudo_id` returns no content older than 3-month detail window without rollup label
- [ ] DPIA (Data Protection Impact Assessment) completed — correlation of behavioral signals is high-risk processing under GDPR Article 35
- [ ] Legal basis documented: `legitimate interest` (public discourse analysis) with minimization evidence
