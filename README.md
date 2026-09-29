# Pulse of AI

**Global real-time AI discourse monitoring dashboard with ethical monitoring, audit trail, and bias detection.**

Pulse of AI aggregates AI-related posts from the top 50 online sources across 7 categories, applies a multi-stage NLP pipeline, and surfaces findings through an interactive Mapbox globe. Every inference — sentiment score, relevance rating, discourse quality score — is written to an immutable audit log with full provenance so any decision is traceable and defensible.

---

## Table of Contents

- [Features](#features)
- [Architecture](#architecture)
- [Tech Stack](#tech-stack)
- [Stand it up](#stand-it-up)
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

## Stand it up

One command builds and starts the whole solution (frontend, API, workers, embeddings service, databases), fills it with data and checks that it works:

```bash
git clone https://github.com/jennifer-mckinney/pulse-of-ai.git
cd pulse-of-ai
npm run standup          # or: bash scripts/standup.sh
```

When it finishes, open **http://localhost:3000**: the globe, the eleven chapters with their numbers, and a "why?" receipt on any post that opens its real audit trail.

### Prerequisites

- Docker Desktop (macOS / Windows) or Docker Engine with the Compose v2 plugin (Linux), with the daemon running.
- `curl` (used by the smoke check).
- No Node.js or Python on the host. Everything runs in containers.

The script checks these first and prints how to fix anything that is missing.

### What it does

1. Creates `.env` from `.env.example` if you don't have one, generating strong random `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `AUDIT_HASH_KEY` and `CORRELATION_SALT` values. It never prints them. An existing `.env` keeps its values: only keys that are missing get added (standup refuses to add secrets to a group- or world-writable file), and the file is set to mode 600. If a secret is empty or still has its `.env.example` placeholder, standup stops and names it.
2. Builds two images: `pulse-of-ai/app` (Node 22; one image for web, worker, migrate and populate) and `pulse-of-ai/embeddings` (Python 3.13, FastAPI and sentence-transformers, CPU only). Both run as non-root users.
3. Starts the compose `full` profile. A one-shot `migrate` job applies migrations 001–011 and the seed, and web and the worker start only after it exits successfully.
4. Waits for health, with timeouts. If a service fails, its logs are printed.
5. Populates data (see below) and starts the `populate` feed.
6. Runs a smoke check. It looks at the API, the page, and the page's own data calls (globe, themes, bias, ribbon, drill-down). It counts posts, audit decisions, bias assessments and embeddings, opens one receipt and checks its four audience views and bias lineage, and runs `npm run replay` on that post, which must PASS. It ends with a population summary.

Re-running is safe. The images come from the build cache, running containers are kept, and a second population batch is skipped while the trailing hour is still full.

### What runs where

| Service | Host port (override) | Role |
|---|---|---|
| `web` | `3000` (`WEB_PORT`) | Express API and the static frontend (`public/`) |
| `worker` | none | BullMQ workers for ingest, embed and correlate (`src/workers/start.js`) |
| `embeddings` | none (compose network only: `embeddings:8000`) | `/embeddings` and `/health`, unauthenticated, so never published; standup checks it with `compose exec`. The model downloads once into the `hf_cache` volume |
| `populate` | none | Demo feed. Adds a batch of fictional posts every 150 s (profile `demo`) |
| `migrate` | none | One-shot job: migrations and seed |
| `postgres` | `5434` in `.env` (`POSTGRES_PORT`) | PostgreSQL 16 + pgvector (`postgres_data` volume) |
| `postgres_test` | `5433` (`POSTGRES_TEST_PORT`) | Test database (not used by the running app) |
| `redis` | `6379` (`REDIS_PORT`) | BullMQ queue backend (`redis_data` volume). Password required (`REDIS_PASSWORD`) |

Every published port (web and the databases and redis) binds to `127.0.0.1` by default (`PULSE_BIND_ADDR`). Setting `PULSE_BIND_ADDR=0.0.0.0` exposes all of them to your network, databases included. To run a second stack beside this one, give it its own project name and ports:

```bash
COMPOSE_PROJECT_NAME=pulse-demo WEB_PORT=3200 \
POSTGRES_PORT=5534 POSTGRES_TEST_PORT=5533 REDIS_PORT=6479 npm run standup
```

`npm run docker:up` hasn't changed. It still starts only `postgres`, `postgres_test` and `redis`, for host-side development.

### Live vs demo data

**Live collection is not implemented yet.** Nothing consumes the `collect.*` queues, the collector scheduler is not wired in, and `POST /api/refresh` is a placeholder that completes its job with 0 posts. So standup always populates **demo** data, and it says so in its output and in the smoke-check summary.

The demo data is honest about what it is:

- **Real pipeline, fictional input.** The posts are invented text with no people, handles or personal data. They go through the real ingest normaliser, the real sentiment, relevance and discourse scorers, the real job-level bias checks, and the real embed worker, which calls the embeddings container. No score is made up: every one has a genuine audit trail, and `npm run replay -- --post <id>` reports PASS.
- **Labelled in the data.** Posts belong to inactive `demo_<category>` sources named "Demo feed — <Category> (fictional)", and that name shows up in the source ribbon. Every text starts with `[Demo]`, and the processing jobs are recorded as `triggered_by = 'demo'`.
- **Real timestamps, kept current.** The page shows the trailing hour. Every demo post is stamped with the time it was actually ingested, and nothing is backdated or re-stamped. The `populate` service ingests 14 more every 150 s (`DEMO_FEED_BATCH`, `DEMO_FEED_INTERVAL_MS`), which keeps the hour full. If you stop that service, the demo posts age out of the window on their own.
- **Shown as DEMO on the page.** The API reports the data origin (`data_mode` on `GET /api/health`, `demo_posts` / `data_mode` on every aggregated row, `data_origin` on each receipt), classified by source. With demo data the intro kicker reads **DEMO**, the intro numbers are computed from the data the globe renders, chapter titles carry the same "— Demo data" marker as the bundled fallback, receipts say the post is fictional demo content generated for this installation (audit narration 1.2.0), and the health drawer counts demo feeds separately from the registry's sources.

`scripts/populate.js` is the seam for real collectors. When they exist, the population step becomes "collect live, with demo as the fallback".

### Embeddings

The first start downloads the ~90 MB `all-MiniLM-L6-v2` model into the `hf_cache` volume. Later starts and rebuilds reuse it. If the download fails (you're offline, behind a proxy, or Hugging Face is unreachable), standup says so clearly and carries on without embeddings: posts are still scored and audited, but vector search stays empty. Fix the network and run `npm run standup` again.

### Tear it down

```bash
npm run teardown                    # stop and remove containers, keep the data volumes
npm run teardown -- --purge         # also delete the volumes (database, redis, model cache); asks first
npm run teardown -- --purge --yes   # non-interactive purge
```

Both act on one compose project only: `COMPOSE_PROJECT_NAME` if it's set, otherwise the one in `.env`, otherwise `pulse-of-ai`. The first line of output says which one it used and where the name came from (shell env, env file or default).

- If `COMPOSE_PROJECT_NAME` comes from your shell and differs from the project in `.env` (for example, it's still exported for another app), teardown asks you to type the project name before it stops anything, even without `--purge`. `--yes` confirms non-interactively.
- Containers that carry the project's name but aren't defined in this compose file (orphans) are left alone. They may belong to another app.
- `pulse-of-ai` is the shared dev project that `npm run docker:up` and `npm run dev` use. Tearing it down also stops `postgres_test` on port 5433, the test database every jest run uses, so teardown warns before it does.

### Upgrading an existing dev database

- **Standup applies migrations for you.** The `migrate` job runs every pending migration and the idempotent seed before web and the worker start, on every `npm run standup`.
- **Host-side development (`npm run dev`)**: after pulling, run `npm run migrate && npm run seed` against your dev database.
- **Migrations are forward-only.** There are no down migrations, and older code isn't guaranteed to run against a newer schema. Take a backup first if you may need to go back: `docker compose exec postgres pg_dump -U pulse_user pulse_of_ai > backup.sql`.
- **New secrets.** Standup adds keys that are missing from an existing `.env` (such as `REDIS_PASSWORD`) and stops if a secret is empty or still has its `.env.example` placeholder. If you only use `npm run docker:up`, add `REDIS_PASSWORD=$(openssl rand -hex 32)` to `.env` yourself: the redis service now requires a password.
- **A placeholder `POSTGRES_PASSWORD` on an existing volume.** Postgres reads `POSTGRES_PASSWORD` only when it first creates the database, so editing `.env` alone breaks the connection. Change it inside Postgres as well, without putting it on a command line: run `docker compose exec postgres psql -U pulse_user -d pulse_of_ai`, then `\password pulse_user`, and put the same value in `.env`. Or start over with `npm run teardown -- --purge`, which deletes the data.

Flags: `npm run standup -- --help`. `--no-build` skips the image build, and `--demo` adds a fresh demo batch even when the hour is already full. Timeouts: `STANDUP_TIMEOUT` (core services, default 300 s) and `STANDUP_EMBEDDINGS_TIMEOUT` (first model download, default 900 s).

---

## Quick Start

For host-side development: Node and Python run on your machine, and only the databases and redis run in Docker. For the all-in-Docker path, see [Stand it up](#stand-it-up).

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
| `REDIS_PORT` | No | Redis host port (default `6379`) |
| `WEB_PORT` | No | Standup: host port of the web service (default `3000`) |
| `PULSE_BIND_ADDR` | No | Interface every published port binds to: web, postgres, postgres_test, redis (default `127.0.0.1`) |
| `REDIS_PASSWORD` | Yes (Docker) | Redis `requirepass`; BullMQ, the worker and `/api/health` authenticate with it. Standup generates it |
| `DEMO_FEED_INTERVAL_MS` | No | Standup demo feed: ms between fictional batches (default `150000`) |
| `DEMO_FEED_BATCH` | No | Standup demo feed: posts per batch (default `14`) |

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
├── docker-compose.yml          PostgreSQL + test DB + Redis; profile "full" adds web, worker, embeddings, migrate
├── Dockerfile                  Node 22 app image (web / worker / migrate / populate)
├── jest.config.js
└── package.json
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

Author: Jennifer McKinney
