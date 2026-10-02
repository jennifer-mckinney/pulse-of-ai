# Pulse of AI — Project Context

## Quick Start
```bash
npm run docker:up      # Start compose project `pulse-of-ai`: PostgreSQL (5434) + test DB (5433) + Valkey (6379, Redis protocol)
npm run migrate        # Run pending SQL migrations against dev DB
npm run seed           # Data sources + methodology registry (idempotent)
npm run dev            # Express server on port 3000
# (no `seed:e2e` here: the e2e globalSetup loads the fixture into its own pulse_of_ai_e2e DB;
#  the fixture scripts refuse the dev DB — scripts/lib/fixture-db-guard.js, FIXTURE_DB_ALLOW)
npm run standup        # OR the whole solution in Docker, one command: build, profile "full" (web/worker/embeddings/watchdog/migrate), demo population, smoke check
npm run teardown       # stop it (keeps volumes); `-- --purge` deletes volumes after confirmation (`--yes` non-interactive)
```

- **Compose project name is `pulse-of-ai`** — pinned by `name:` in `docker-compose.yml` AND `COMPOSE_PROJECT_NAME` in `.env`, so every worktree/checkout owns the SAME containers and volumes. Never start the stack with an ad-hoc `-p` project name: that strands the DB data in project-scoped volumes a later run can't adopt.
- **Standup** (`scripts/standup.sh`, `scripts/lib/stack.sh`): the default compose profile is unchanged (`docker:up` = databases + redis only); `full` adds web (3000), worker, embeddings (8000, model cached in the `hf_cache` volume), the `watchdog`, one-shot `migrate`; `demo` adds the `populate` feed. Population collects LIVE data first (`scripts/populate.js` → `src/collectors/runner.js`) and writes fictional DEMO posts only when collection yields nothing in the trailing hour. A deliberate throwaway second stack is fine with its own `COMPOSE_PROJECT_NAME` + ports (`WEB_PORT`, `POSTGRES_PORT`, `POSTGRES_TEST_PORT`, `REDIS_PORT`; the embeddings service publishes no port) and `PULSE_ENV_FILE`; purge it afterwards and never `teardown --purge` the `pulse-of-ai` project unless you mean to wipe the dev data.

## Key Commands
| Command | Purpose |
|---|---|
| `npm run db:reset` | Drop + re-migrate + seed dev DB |
| `npm run seed` | Load the 52 registry sources (`src/config/source-registry.js`) + methodology versions (`src/config/methodology-registry.js`) |
| `npm run seed:e2e` | Load the deterministic Playwright fixture dataset (`scripts/test/seed-e2e.js`) — e2e databases only: refuses any DB not named `pulse_of_ai_e2e[_<suffix>]` unless `FIXTURE_DB_ALLOW` names it (`scripts/lib/fixture-db-guard.js`; CI sets it); `test:e2e` runs it for you |
| `npm run standup` / `npm run teardown` | One-command Docker standup of the whole solution / stop it (see README "Quick start") |
| `npm run replay -- --post <id>` | Re-run a post's stored decisions through `src/pipeline` and print PASS / DIVERGENCE / NOT RE-RUNNABLE per stage |
| `npm run verify` | Full gate: Jest + coverage, pytest, black (needs `python/.venv`) |
| `npm run test:e2e` | Playwright suite on its own database `pulse_of_ai_e2e` (on the dev Postgres, needs `docker:up`) and its own server on 3100; globalSetup creates, migrates and seeds it, runs `seed:e2e` and freshens timestamps; the dev database is never touched |
| `npm run coverage:frontend` | Non-gating coverage of the pure namespaces of globe/story/ui/main |
| `npm run test:unit` | Unit tests (needs the test DB: `npm run docker:up`; jest's globalSetup migrates and seeds port 5433) |
| `npm run test:pure` | Pure unit tests under `tests/unit/pure/` (no DB, no Docker) |
| `npm run test:int` | Integration tests (needs docker:up) |
| `npm run test:cov` | Coverage report (must be ≥80% lines) |
| `black python/` | Format Python files |

## Architecture
- **Sources (ADR 0001):** `src/config/source-registry.js` is the registry of record — exactly the workbook's 52 sources (`docs/requirements/Top_50_Global_Online_Sources.xlsx` Rev. 4 — Reddit #52 in Forums, ADR 0001 rulings 8-9; counts are `SOURCES.length`; `tests/unit/pure/sourceRegistry.test.js` parses the xlsx). Gate status per source comes from env at runtime (collecting / awaiting_key / awaiting_approval / awaiting_licence / blocked / disabled); kill switch `SOURCE_<SLUG>_ENABLED=false` or `COLLECTORS_DISABLED`. Collectors in `src/collectors/` (one HTTP client: UA with `COLLECTOR_CONTACT_URL`, robots.txt, per-host spacing, backoff, Retry-After holds of the host (≤ 10 s waited in-run, longer held up to 24 h in `http_cache`), never retries 401/403); `runner.js` = collect → store → score (audited) → bias → embed. Tests use fixtures only (`tests/fixtures/collectors`, network refused under NODE_ENV=test); `npm run collect:smoke` is the live check. Migrations 013 (collection state, old seed retired), 014 (methodology alignment) and 015 (ingest@1.2.0 in-text redaction); the pipeline records `CURRENT_VERSIONS`, never "latest effective_from" Reddit: approval-gated Data API only (`src/collectors/reddit/`), closed until all four `REDDIT_*` vars are set; top-7 subreddit selection stored in `reddit_subreddit_rankings`; one shared request budget; post text blanked at 48 h by the worker's repeatable `maintenance` job (`src/collectors/retention.js`, `src/workers/maintenance.worker.js`), or on upstream deletion by the worker's Reddit maintenance timer (`src/collectors/reddit/recheck.js`, every 6 h), scores and audit rows kept (ruling 9). Reddit fixtures are hand-written from docs, never recorded — never contact reddit.com.
- **DB:** PostgreSQL 16 + pgvector — 55 migrations in `src/db/migrations/` (001–074 with gaps; 025 Reddit tables + `raw_posts.text_removed_*`, 027–060 PR #22, 061 `bias@1.6.0`, 062 refusal probation, 065 `embedding@1.1.0`, 066 `ingest@1.8.0` / `audit_narration@1.4.0` content-hash wording + errata, 067 `audit_narration@1.5.0` relevance wording + errata, 068 admission rejection counters, 070 relevance gold set (append-only `relevance_gold_items` / `relevance_gold_labels`, `gold_erase_post`; offline tools `npm run gold:*` and `relevance:eval`, codebook `docs/governance/relevance-codebook.md`), 073–074 per-route kill switch) (009 registers the bias / ingest / audit_narration methodology rows; it must stay field-for-field equal to `src/config/methodology-registry.js`; 010 adds per-assessment bias methodology lineage — `bias_assessments.methodology_version_id`, resolved at read time as recorded, inferred or current by `src/config/bias-lineage.js`; 011 registers audit_narration@1.2.0 — 009 is released and never edited, later methodology versions ship as new migrations; 012 registers embedding@1.0.0 — the embedding model pinned to a Hugging Face commit via EMBED_MODEL_REVISION — and adds `post_embeddings.methodology_version`; 013–015 are the source-collection migrations, see Sources above)
- **Data mode:** `src/config/data-mode.js` classifies posts by source (`data_sources.source_type = 'demo'` = standup demo feed): `/api/health` reports `data_mode` (demo / live / mixed / none, trailing hour), `active_sources` (demo feeds excluded) and `demo_feeds`; aggregated rows carry `demo_posts` + `data_mode`; receipts carry `post.data_origin`. The frontend (`data.js dataModeOf`, `chapters.js resolveIntro`) turns it into the intro kicker (LIVE / DEMO / LIVE + DEMO), interpolated intro numbers and the "— Demo data" markers; `isDemo` still means only the bundled fallback (no fetches)
- **Pipeline:** `src/pipeline/` — sentiment → relevance → discourse → embeddings → correlation
- **Workers:** BullMQ queues backed by Valkey 8 (Redis protocol; env vars keep the `REDIS_*` names); worker files mirror pipeline modules
- **Routes:** `src/routes/` — health, posts, sentiment, refresh, audit, bias, methodology, sources, query, themes. `src/server.js` sets the CSP/security headers, applies CORS to the read-only routers only, and mounts `POST /api/refresh` (60 s global debounce) without CORS
- **Watchdog (alerting):** `scripts/watchdog.js` + `src/watchdog/` — compose service `watchdog` (profile `full`), OUTSIDE the worker. Polls `/api/health` (default every 120 s) and probes the DB; writes one critical `alert_events` row per condition (`source_table 'watchdog'`, unique open index from migration 050), resolves cleared ones with `alert_resolutions`, e-mails each open/clear over SMTP (rate-limited). SMTP settings in `.env`; `SMTP_PASSWORD` reaches the watchdog only (the worker blanks it; `scripts/test/check-compose.sh` enforces). SMTP unset → dashboard only, `/api/health` `watchdog.email.status` = "email alerting not configured". Tests use a fake SMTP server (`smtp-server`, dev dependency) — never real e-mail
- **Audit replay:** `src/audit/replay.js` + `scripts/replay.js` back the receipt's reproduce command
- **Frontend:** `public/` — no build step, all assets self-hosted, UMD modules loaded in contract order by `index.html`:
  - `js/config/` — `design.config.js`, `api.config.js`, `story.config.js` (the 11 beats), `cities.config.js` (city registry), `legal.config.js` (the Appropriate Legal Notices: AGPL-3.0-or-later + the section 7(b) attribution, rendered by main.js into the header "about" panel)
  - `js/utils.js`, `js/data.js` (fetch + normalize + baseline merge), `js/insights.js`, `js/chapters.js` (beat copy resolver)
  - `js/globe.js` — Canvas-2D dot globe (ranked city-list fallback when canvas is unavailable)
  - `js/story.js` — scroll story, rail, legend; `js/ui.js` — explore filters, tooltip, ribbon, audit + health drawers; `js/main.js` — bootstrap
  - `styles/main.css`; `vendor/` — self-hosted fonts + world-atlas land GeoJSON (see `vendor/README.md`)
- **Embeddings service:** `python/embeddings_service.py` — FastAPI + sentence-transformers on port 8000 (venv at `python/.venv/`)
- **Docs:** `docs/TECHNICAL_SPEC.md` (full spec), `docs/diagrams/architecture.png` (system diagram)

## Directory Notes
- Root `js/`, `styles/`, `scrollama-main/`, `exported-assets/`, `.playwright-mcp/` are gitignored scratch/vendor dirs — the real frontend lives in `public/`; don't edit the root copies

## Security / Hooks
- Write hook blocks `innerHTML` in client JS — build DOM with `createElement` + `textContent` (textContent is THE escaping boundary; never pre-escape into it)
- CSP is strict (`script-src 'self'; style-src 'self'`, no `unsafe-inline`) — no inline `<script>`/`style=` in `index.html`
- Write hook flags GitHub Actions workflow files — acknowledge, then proceed (workflow is safe)
- Stop hook requires preview verification after every edit — run `preview_snapshot` + `preview_console_logs`

## Testing Quirks
- `NODE_ENV=test` makes `migrate.js` and `db/connection.js` target port 5433 (test DB)
- Tests run serially (`maxWorkers: 1`) — shared test DB; parallel runs cause TRUNCATE race conditions
- `globalSetup.js` drops, re-migrates (`--fresh`) and seeds the test DB once; `setup.js` truncates tables before each test file
- The 5433 test DB is the default for a developer's own `npm test`; agents and automated runs use a throwaway compose project on non-default ports instead (see the Standup notes and "Agent Workflow Principles")

## Status
Phase B (pipeline TDD) is implemented — `tests/unit/` covers sentiment, relevance, discourse, ingest, bias, correlation, embeddings, and the ingest/embed/correlate workers; `tests/integration/` covers all API routes. The plan file previously referenced here (`~/.claude/plans/composed-coalescing-duckling.md`) no longer exists.

The storytelling frontend follows the FuN.zip design-handoff prototype (11 beats, Canvas-2D globe), the master contract by Jennifer's ruling of 2026-09-28. PRD §4.3 (FR-17 to FR-25, rewritten to that design in PRD v1.1 on 2026-09-29) is the requirement of record, and `docs/TECHNICAL_SPEC.md` v1.2.1 §11 describes the shipped frontend; `docs/plans/2026-07-05-globe-storytelling-design.md` (globe.gl / Mapbox era) is superseded.

## Agent Workflow Principles
- **Pipeline audits into fixes (2026-09-30):** as soon as one audit slice's report is final, start a fixer for that slice's files on its own sub-branch (e.g. `docs/r4-diagrams`); don't wait for the consolidated report. Later slices' findings go to the right fixer by message.
- **Run independent slices concurrently:** about 3 audit agents plus 2 fixers stays within the ~5-agent limit.
- **The orchestrator relays completions:** a coordinator's monitor loop doesn't receive its sub-agents' completion notices; the main session tells it the moment a slice finishes, so it doesn't idle-poll.
- **Role separation stays:** the auditor verifies only and fixers never audit. One integrator merges the fixer sub-branches with merge commits (no rebase, no force-push) and runs `render.sh --check`, `npm run test:diagrams` and `npm run test:pure` once.
- **Re-audit scope:** after one full fresh audit, re-check only the fixed lines and their surroundings, unless master has moved materially.
- **Standing rules:** fix every finding ("all failed checks need to be addressed. no exception"); an inaccurate observation or an unsourced external figure is a FAIL; security findings are mandatory; released migrations and released methodology rows are never edited; test only on throwaway compose projects with non-default ports, never the live `pulse-of-ai` stack or the shared 5433 test DB; never pattern-kill processes.
