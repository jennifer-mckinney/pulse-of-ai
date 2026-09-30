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
| Job queue | BullMQ + Valkey 8 (Redis protocol, BSD-3-Clause) |
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
bash scripts/standup.sh  # needs Bash + Docker only
# or: npm run standup    # the same script, launched by npm (also needs Node.js/npm)
```

When it finishes, open **http://localhost:3000**: the globe, the eleven chapters with their numbers, and a "why?" receipt on any post that opens its real audit trail.

### Prerequisites

- Docker Desktop (macOS / Windows) or Docker Engine with the Compose plugin (Linux), with the daemon running. **Docker Compose 2.39.0 or newer** (`docker compose version`): `docker-compose.yml` uses `build.provenance` / `build.sbom`, which Compose added in 2.39.0, and older versions reject the file. Standup checks the version and stops with upgrade instructions if it is too old.
- **Bash 3.2 or newer.** macOS's `/bin/bash` (3.2) and any Linux bash work. On **Windows**, run it from **WSL 2** (recommended, with Docker Desktop's WSL integration turned on) or **Git Bash**. PowerShell and `cmd.exe` cannot run the script themselves: `npm run standup` from them works only when one of those `bash` executables is on `PATH`. Under Git Bash, NTFS does not enforce the `chmod 600` standup applies to `.env`, so restrict that file with Windows permissions yourself.
- `curl` (used by the smoke check), plus the standard tools every macOS, Linux, WSL and Git Bash install has: `awk`, `sed`, `grep`, `find`, and `openssl` (or `/dev/urandom` with `od`) for the generated secrets.

Two ways to start it, same script:

| Command | Needs on the host |
|---|---|
| `bash scripts/standup.sh` | Bash, Docker (Compose 2.39.0+), `curl` |
| `npm run standup` | all of the above, plus Node.js and npm (npm only launches `bash scripts/standup.sh`; no `npm install` needed) |

Neither runs Node.js or Python on the host: those run only inside the containers. The same goes for teardown (`bash scripts/teardown.sh` or `npm run teardown`). The hints the scripts print use whichever form you started them with.

The script checks Docker, the Compose version, the daemon and `curl` first, and prints how to fix anything that is missing.

### What it does

1. Creates `.env` from `.env.example` if you don't have one, generating strong random `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `AUDIT_HASH_KEY` and `CORRELATION_SALT` values. It never prints them. An existing `.env` keeps its values: only keys that are missing get added (standup refuses to add secrets to a group- or world-writable file), and the file is set to mode 600. If a secret is empty or still has its `.env.example` placeholder, standup stops and names it.
2. Builds two images: `pulse-of-ai/app` (Node 22; one image for web, worker, migrate and populate) and `pulse-of-ai/embeddings` (Python 3.13, FastAPI and sentence-transformers, CPU only). Both run as non-root users.
3. Starts the compose `full` profile. A one-shot `migrate` job applies migrations 001–015 and the seed, and web and the worker start only after it exits successfully.
4. Waits for health, with timeouts. If a service fails, its logs are printed.
5. Populates data (see below) and starts the `populate` feed.
6. Runs a smoke check. It looks at the API, the page, and the page's own data calls (globe, themes, bias, ribbon, drill-down). It counts posts, audit decisions, bias assessments and embeddings, opens one receipt and checks its four audience views and bias lineage, and runs `npm run replay` on that post, which must PASS. It ends with a population summary.

`GET /api/health` also reports `redis.reachable` and `worker.alive` / `worker.last_heartbeat`, and every container's logs rotate (json-file, 5 × 10 MB).

Re-running is safe. The images come from the build cache, running containers are kept, and a second population batch is skipped while the trailing hour is still full. If an earlier run had no embeddings (the model could not be downloaded), a re-run with the embeddings service healthy queues embed jobs for every trailing-hour demo post that has none and waits for them (up to 180 s) before the smoke check.

### What runs where

| Service | Host port (override) | Role |
|---|---|---|
| `web` | `3000` (`WEB_PORT`) | Express API and the static frontend (`public/`) |
| `worker` | none | Collection scheduler + `collect.{rss,api,bulk}` consumers (live data from the 52-source registry), ingest retries, embed, correlate (`src/workers/start.js`). The only role holding collector credentials: it loads the env file (`PULSE_ENV_FILE`, default `.env`) whole through Compose `env_file`, while web gets only a "set" marker per credential. Healthy while its Redis heartbeat is fresh; `docker stop` gives it 180 s to finish in-flight jobs |
| `embeddings` | none (compose network only: `embeddings:8000`) | `/embeddings` and `/health`, unauthenticated, so never published; standup checks it with `compose exec`. The model downloads once into the `hf_cache` volume |
| `populate` | none | Demo fallback. Adds fictional posts every 150 s only while the trailing hour has no live posts (profile `demo`) |
| `migrate` | none | One-shot job: migrations and seed |
| `postgres` | `5434` in `.env` (`POSTGRES_PORT`) | PostgreSQL 16 + pgvector (`postgres_data` volume) |
| `postgres_test` | `5433` (`POSTGRES_TEST_PORT`) | Test database (not used by the running app) |
| `redis` | `6379` (`REDIS_PORT`) | Valkey 8, the BullMQ queue backend (`valkey_data` volume). It speaks the Redis protocol, so the service name and the `REDIS_*` variables keep that name. Password required (`REDIS_PASSWORD`) |

**Upgrading a stack that ran Redis 7.** The queue store is now Valkey 8 on a new `valkey_data` volume. Redis 7.4 writes RDB format 12, which Valkey 8 will not load, so the old `redis_data` volume is left unused rather than reused. Nothing needs migrating because the queue data is transient: the worker re-registers every schedule when it starts. Stop the stack cleanly, bring it back up, and once it is healthy remove the old volume with `docker volume rm <project>_redis_data`.

Every published port (web and the databases and redis) binds to `127.0.0.1` by default (`PULSE_BIND_ADDR`). Setting `PULSE_BIND_ADDR=0.0.0.0` exposes all of them to your network, databases included. To run a second stack beside this one, give it its own project name and ports:

```bash
COMPOSE_PROJECT_NAME=pulse-demo WEB_PORT=3200 \
POSTGRES_PORT=5534 POSTGRES_TEST_PORT=5533 REDIS_PORT=6479 npm run standup
```

`npm run docker:up` hasn't changed. It still starts only `postgres`, `postgres_test` and `redis`, for host-side development.

### Live vs demo data

**Standup collects live data first.** The source registry of record is the workbook's 52 sources (`src/config/source-registry.js`, ADR 0001 in `docs/adr/`; Rev. 4 added Reddit as #52 in Forums). The population step runs one real collection job; the worker then collects every *collecting* source on its 2–3 minute schedule (stretched where a documented rate limit needs it), and `POST /api/refresh` enqueues a real collection job to the worker (409 while one is running; `REFRESH_TOKEN` required when the site is bound beyond loopback). Per-source status (collecting, awaiting key / approval / licence, blocked, disabled) is in the health drawer, in `GET /api/sources` and in the smoke check. `.env.example` lists every key, where to get it, and the per-source kill switches (`SOURCE_<SLUG>_ENABLED=false`).

**Live collection is off on a fresh clone** (ADR 0001, decision D1 "Off for others, on for you"). `COLLECTOR_CONTACT_URL` ships empty: without it every source is disabled and standup populates demo data only, and says so. Collection goes out under the operator's identity, so each operator sets their own contact URL — a page where publishers can reach them. The 8 permission-gated news feeds (BBC, NYT, Guardian, Al Jazeera, WSJ, NBC News, Washington Post, Ars Technica) additionally need `PERMISSION_GATED_FEEDS_ACCEPTED_BY="<your name> <YYYY-MM-DD>"`, which records that you accept the legal risk of reading them (their terms require permission for automated analysis). Run on a terminal, `npm run standup` asks for both; `npm run standup -- --yes` never asks. With the contact URL alone, 23 of the 51 sources collect with no keys; with both, 31.

**Jennifer's deployment** sets both values in her own `.env` (never in `.env.example` or the compose file):

```bash
COLLECTOR_CONTACT_URL=https://github.com/jennifer-mckinney/pulse-of-ai
PERMISSION_GATED_FEEDS_ACCEPTED_BY="Jennifer McKinney 2026-09-29"
```

Demo data is only the **fallback**: when collection yields nothing in the trailing hour (offline, or every source switched off), fictional posts fill it, and the `populate` loop stays idle while live posts exist. The smoke-check summary labels the hour LIVE, MIXED or DEMO, per category. `npm run collect` runs one collection job by hand; `npm run collect:smoke` live-fetches every keyless route once without writing anything.

When demo data is used, it is honest about what it is:

- **Real pipeline, fictional input.** The posts are invented text with no people, handles or personal data. They go through the real ingest normaliser, the real sentiment, relevance and discourse scorers, the real job-level bias checks, and the real embed worker, which calls the embeddings container. No score is made up: every one has a genuine audit trail, and `npm run replay -- --post <id>` reports PASS.
- **Labelled in the data.** Posts belong to inactive `demo_<category>` sources named "Demo feed — <Category> (fictional)", and that name shows up in the source ribbon. Every text starts with `[Demo]`, and the processing jobs are recorded as `triggered_by = 'demo'`.
- **Real timestamps, kept current.** The page shows the trailing hour. Every demo post is stamped with the time it was actually ingested, and nothing is backdated or re-stamped. The `populate` service ingests 16 more every 150 s (two per category) (`DEMO_FEED_BATCH`, `DEMO_FEED_INTERVAL_MS`), which keeps the hour full. If you stop that service, the demo posts age out of the window on their own.
- **Shown as DEMO on the page.** The API reports the data origin (`data_mode` on `GET /api/health`, `demo_posts` / `data_mode` on every aggregated row, `data_origin` on each receipt), classified by source. `data_mode` on `/api/health` classifies exactly what the globe shows for the trailing hour (scored posts at a city in the registry), and `data_window` reports those counts next to all posts stored in that hour (`stored_posts`, `stored_demo_posts`). With demo data the intro kicker reads **DEMO**, the intro numbers are computed from the data the globe renders, chapter titles carry the same "— Demo data" marker as the bundled fallback, receipts say the post is fictional demo content generated for this installation (audit narration 1.2.0), and the health drawer counts demo feeds separately from the registry's sources.



### Adding a keyed source (supervised first run)

A source whose key, licence or approval arrives later is not scheduled blind (PR #10 review P10-17):

1. Keep the new credential out of `.env` for now, and run a supervised dry run of that one source. **Never type a key on the command line** (a `NAME=value` prefix in front of a command): the whole line is saved in your shell history (`~/.zsh_history`, `~/.bash_history`), which persists, is often backed up or synced, and is outside every log-scrubbing control. Use one of these instead:
   - Prompt for it. `read -rs` does not echo the key and nothing reaches the history; unset it afterwards:
     ```bash
     read -rs -p 'Guardian API key: ' GUARDIAN_API_KEY; echo; export GUARDIAN_API_KEY
     read -r -p 'Guardian licence reference: ' GUARDIAN_COMMERCIAL_LICENSE_REF; export GUARDIAN_COMMERCIAL_LICENSE_REF
     npm run collect -- --supervised --only guardian
     unset GUARDIAN_API_KEY GUARDIAN_COMMERCIAL_LICENSE_REF
     ```
     (In zsh, `read -rs` takes the prompt as `read -rs 'GUARDIAN_API_KEY?Guardian API key: '`.)
   - Or write it with an editor into a private env file outside the repository, readable only by you, load it for this one run, then delete it:
     ```bash
     umask 077 && "${EDITOR:-vi}" ~/guardian-trial.env        # GUARDIAN_API_KEY=… and GUARDIAN_COMMERCIAL_LICENSE_REF=…
     node --env-file="$HOME/guardian-trial.env" scripts/collect.js --supervised --only guardian
     rm ~/guardian-trial.env
     ```
2. It fetches every open route through the real collectors (robots, allowed hosts, quotas and redaction all apply), prints what each route returned and a sample of up to 5 payloads exactly as they would be stored, and stores nothing: no posts, scores, cursors, collection state or job. Its only database access is one read of the source's kill switch and refusal state: a source disabled with `npm run source:disable` or still in its refusal cooldown is refused before any request, exactly as the worker would refuse it.
3. Sign off if the sample is on topic and carries no personal data beyond the ingest claim. Then add the credential to `.env` and recreate the containers (`docker compose up -d worker web`); the worker schedules the source on its next reschedule.

### Embeddings

The first start downloads the ~90 MB `all-MiniLM-L6-v2` model into the `hf_cache` volume. Later starts and rebuilds reuse it. If the download fails (you're offline, behind a proxy, or Hugging Face is unreachable), standup says so clearly and carries on without embeddings: posts are still scored and audited, but vector search stays empty. Fix the network and run `npm run standup` again.

### Tear it down

```bash
npm run teardown                    # stop and remove containers, keep the data volumes
npm run teardown -- --purge         # also delete the volumes (database, redis, model cache); asks first
npm run teardown -- --purge --yes   # non-interactive purge
bash scripts/teardown.sh --purge    # the same without Node.js/npm on the host
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

Flags: `bash scripts/standup.sh --help` (or `npm run standup -- --help`). `--no-build` skips the image build, and `--demo` adds a fresh demo batch even when the hour is already full. Timeouts: `STANDUP_TIMEOUT` (core services, default 300 s) and `STANDUP_EMBEDDINGS_TIMEOUT` (first model download, default 900 s).

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
npm run docker:up   # PostgreSQL (5434) + test DB (5433) + Valkey (6379)
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
| `REDIS_PORT` | No | Valkey host port (default `6379`; the `REDIS_*` names refer to the Redis protocol Valkey speaks) |
| `WEB_PORT` | No | Standup: host port of the web service (default `3000`) |
| `PULSE_BIND_ADDR` | No | Interface every published port binds to: web, postgres, postgres_test, redis (default `127.0.0.1`) |
| `REDIS_PASSWORD` | Yes (Docker) | Valkey `requirepass`; BullMQ, the worker and `/api/health` authenticate with it. Standup generates it |
| `DEMO_FEED_INTERVAL_MS` | No | Standup demo feed: ms between fictional batches (default `150000`) |
| `DEMO_FEED_BATCH` | No | Standup demo feed: posts per batch (default: two per category, `16`) |

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
| `bias_window_runs` / `bias_window_assessments` | The rolling 24 h bias checks (bias@1.5.0): one run per day or on demand, and its assessments |
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
| `bias-window.js` | The same checks over a rolling 24 h window, daily and on demand (`npm run bias:window`); the insufficient-sample share per check in `/api/bias/latest` and `/api/health` |
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
├── docker-compose.yml          PostgreSQL + test DB + Valkey; profile "full" adds web, worker, embeddings, migrate
├── Dockerfile                  Node 22 app image (web / worker / migrate / populate)
├── jest.config.js
└── package.json
```

---

## License

MIT — see [LICENSE](LICENSE) for details.

Author: Jennifer McKinney
