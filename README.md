# Pulse of AI

**Global real-time AI discourse monitoring dashboard with ethical monitoring, audit trail, and bias detection.**

Pulse of AI aggregates AI-related posts from the top 50 online sources across 7 categories, applies a multi-stage NLP pipeline, and surfaces findings through an interactive Mapbox globe. Every inference — sentiment score, relevance rating, discourse quality score — is written to an immutable audit log with full provenance so any decision is traceable and defensible.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [Database](#database)
- [API Reference](#api-reference)
- [Pipeline](#pipeline)
- [Python Embeddings Service](#python-embeddings-service)
- [Testing](#testing)
- [Project Structure](#project-structure)
- [License](#license)

---

## Features

| Capability | Detail |
|---|---|
| **Global coverage** | Top 50 sources across 7 categories (social, news, academic, policy, dev, blog, non-profit) |
| **Near-real-time refresh** | 2–3 minute cron cycle; `POST /api/refresh` for on-demand |
| **Sentiment analysis** | AFINN-based scoring, versioned methodology |
| **AI relevance filtering** | Keyword + embedding hybrid scoring |
| **Discourse quality** | Deliberative Quality Index (DQI) + semantic clustering |
| **Bias monitoring** | 3-layer bias stack; demographic-parity and equalized-odds alerts |
| **Immutable audit trail** | Every inference logged with model version, parameters, and plain-English justification |
| **Cross-platform correlation** | Verb-noun pseudonymous IDs — no PII, no re-identification |
| **Vector search** | pgvector semantic similarity via `POST /api/query` |
| **Layered retention** | 3-month full detail → monthly compaction → permanent topic rollups |
| **GDPR / AI Act ready** | Data minimisation, lifecycle logging, AI Act methodology documentation |

---

## Architecture

```
┌──────────────────────────────────────────┐
│     DATA SOURCES — TOP 50 GLOBAL         │
│  Social · News · Academic · Policy       │
│  Dev · Blog · Non-profit                 │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│  INGESTION  (src/pipeline/ingest.js)     │
│  Strip PII → SHA-256 dedup → raw_posts   │
└───────────────┬──────────────────────────┘
                │  BullMQ queue
                ▼
┌──────────────────────────────────────────┐
│  NLP PIPELINE                            │
│  sentiment → relevance → discourse       │
│  embeddings (Python/FastAPI) →           │
│  correlation                             │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│  PostgreSQL 16 + pgvector                │
│  raw_posts · sentiment_scores            │
│  discourse_scores · audit_log            │
│  bias_assessments · methodology_versions │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│  EXPRESS API  (src/server.js)            │
│  REST endpoints + WebSocket updates      │
└───────────────┬──────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────┐
│  FRONTEND  (public/)                     │
│  Mapbox GL JS globe + narrative panel    │
└──────────────────────────────────────────┘
```

For a full diagram see [`docs/diagrams/architecture.png`](docs/diagrams/architecture.png).  
For the complete technical specification see [`docs/TECHNICAL_SPEC.md`](docs/TECHNICAL_SPEC.md).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js (Express) |
| Database | PostgreSQL 16 + pgvector |
| Job queue | BullMQ + Redis 7 |
| NLP | `natural`, `sentiment` (AFINN) |
| Embeddings | Python 3 / FastAPI / sentence-transformers |
| Frontend | Vanilla JS, Mapbox GL JS |
| Tests | Jest 29, Supertest |
| Containers | Docker Compose |

---

## Quick Start

### Prerequisites

- Docker & Docker Compose
- Node.js ≥ 18
- Python ≥ 3.10 (for the embeddings service)

### 1 — Clone and install

```bash
git clone https://github.com/jennifer-mckinney/pulse-of-ai.git
cd pulse-of-ai
npm install
```

### 2 — Configure environment

```bash
cp .env.example .env
# Edit .env — see Environment Variables section below
```

### 3 — Start infrastructure

```bash
npm run docker:up   # PostgreSQL (5434) + test DB (5433) + Redis (6379)
```

### 4 — Migrate and seed

```bash
npm run migrate     # Run pending SQL migrations
npm run seed        # Load 50 data sources + methodology versions
```

### 5 — Start the server

```bash
npm run dev         # Express on http://localhost:3000
```

### 6 — (Optional) Start the embeddings service

```bash
cd python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
bash start.sh       # FastAPI on http://localhost:8000
```

Open `http://localhost:3000` to see the dashboard.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in the values below.

| Variable | Required | Description |
|---|---|---|
| `POSTGRES_HOST` | Yes | Database host (default `localhost`) |
| `POSTGRES_PORT` | Yes | Dev DB port (default `5434`) |
| `POSTGRES_DB` | Yes | Dev DB name |
| `POSTGRES_USER` | Yes | DB user |
| `POSTGRES_PASSWORD` | Yes | DB password |
| `POSTGRES_TEST_PORT` | Dev | Test DB port (default `5433`) |
| `PORT` | No | Express port (default `3000`) |
| `EMBEDDINGS_SERVICE_URL` | No | Python FastAPI URL (default `http://localhost:8000`) |
| `MAPBOX_ACCESS_TOKEN` | Yes | Public Mapbox token — served via `GET /api/config` |
| `REDDIT_USER_AGENT` | No | Reddit API user-agent string |
| `TWITTER_BEARER_TOKEN` | No | Twitter/X Basic API bearer token |
| `GITHUB_TOKEN` | No | GitHub PAT for Discussions scraping |
| `SEMANTIC_SCHOLAR_API_KEY` | No | Semantic Scholar API key |
| `AUDIT_HASH_KEY` | No | 64-hex-char key for HMAC-SHA256 audit hashes |
| `CORRELATION_SALT` | Yes | 64-hex-char salt for verb-noun pseudonymous IDs — generate once, never change |
| `CORRELATION_MIN_CONFIDENCE` | No | Min confidence to assign a cross-platform ID (default `0.85`) |
| `RETENTION_DETAIL_DAYS` | No | Days before compaction (default `90`) |

Generate secrets:

```bash
# AUDIT_HASH_KEY
openssl rand -hex 32

# CORRELATION_SALT
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Database

Migrations live in `src/db/migrations/` and are applied in filename order.

```bash
npm run migrate          # Apply pending migrations
npm run db:reset         # Drop + re-migrate + seed (dev only)
npm run seed             # Seed sources and methodology versions only
```

The schema includes the following core tables:

| Table | Purpose |
|---|---|
| `raw_posts` | Immutable ingested posts (PII-stripped) |
| `sentiment_scores` | Per-post sentiment results with methodology reference |
| `discourse_scores` | DQI scores per post |
| `audit_log` | Immutable inference provenance records |
| `bias_assessments` | Bias evaluations and violation flags |
| `methodology_versions` | Versioned algorithm configs with justification |
| `data_sources` | Registry of the 50 monitored sources |
| `cross_platform_users` | Pseudonymous verb-noun correlation IDs |
| `alert_events` | Triggered bias / health alerts |

---

## API Reference

All endpoints are prefixed `/api`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | System health, active alerts, data freshness |
| `GET` | `/api/config` | Public config (Mapbox token) for the frontend |
| `GET` | `/api/posts` | Paginated post list with sentiment |
| `GET` | `/api/sentiment` | Aggregated sentiment by geography / source |
| `POST` | `/api/refresh` | Trigger an on-demand pipeline run |
| `GET` | `/api/audit/:post_id` | Full decision trail for a single post |
| `GET` | `/api/bias` | Bias assessment summary and current alerts |
| `GET` | `/api/methodology` | Current and historical methodology versions |
| `GET` | `/api/sources` | All 50 monitored data sources |
| `GET` | `/api/themes` | Trending topics / discourse themes |
| `POST` | `/api/query` | Semantic vector search over ingested posts |

---

## Pipeline

Each stage is a module in `src/pipeline/` and a corresponding BullMQ worker in `src/workers/`.

```
ingest → sentiment → relevance → discourse → embeddings → correlation
```

| Module | Description |
|---|---|
| `ingest.js` | Fetches sources, strips PII, deduplicates, writes `raw_posts` |
| `sentiment.js` | AFINN scoring; logs to `sentiment_scores` + `audit_log` |
| `relevance.js` | Keyword + embedding hybrid AI-relevance filter |
| `discourse.js` | DQI scoring across posts |
| `embeddings.js` | Calls Python service; stores vectors in pgvector |
| `bias.js` | Demographic-parity / equalized-odds checks; fires alerts |
| `correlation.js` | Cross-platform user clustering by writing style + timing |

---

## Python Embeddings Service

A lightweight FastAPI service (`python/embeddings_service.py`) wraps `sentence-transformers` to produce 384-dimension embeddings stored in PostgreSQL via pgvector.

```bash
cd python
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
bash start.sh          # Starts on port 8000
```

The Node pipeline calls `EMBEDDINGS_SERVICE_URL/embed` (configurable via `.env`). The service can be omitted for local development without vector search.

---

## Testing

```bash
npm run docker:up          # Infrastructure must be running for integration tests

npm run test:unit          # Unit tests only — no DB required
npm run test:int           # Integration tests — requires Docker
npm run test:cov           # Coverage report (target ≥ 80% lines)
npm run test:pure          # Pure unit tests (jest.pure.config.js)
npm run verify             # Full test suite via scripts/test/run-all.sh
```

Tests run serially (`maxWorkers: 1`) to avoid TRUNCATE race conditions on the shared test database.  
`NODE_ENV=test` targets port `5433` (the isolated test DB container).

---

## Project Structure

```
pulse-of-ai/
├── docs/
│   ├── TECHNICAL_SPEC.md       Full technical specification
│   └── diagrams/               Architecture diagrams (PNG, Mermaid)
├── public/                     Frontend (Mapbox globe, narrative panel)
│   ├── index.html
│   ├── js/
│   └── styles/
├── python/                     FastAPI embeddings service
│   ├── embeddings_service.py
│   └── requirements.txt
├── scripts/                    DB migration, seeding, compaction helpers
├── src/
│   ├── db/
│   │   ├── connection.js
│   │   └── migrations/         SQL migration files (applied in order)
│   ├── pipeline/               NLP pipeline modules
│   ├── queues/                 BullMQ queue definitions
│   ├── routes/                 Express route handlers
│   ├── workers/                BullMQ worker processes
│   └── server.js               Express entry point
├── tests/
│   ├── unit/                   Unit tests (no DB)
│   └── integration/            API integration tests
├── .env.example                Environment variable template
├── docker-compose.yml          PostgreSQL + test DB + Redis
├── jest.config.js
└── package.json
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

Author: Jennifer McKinney
