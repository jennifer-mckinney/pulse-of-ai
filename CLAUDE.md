# Pulse of AI — Project Context

## Quick Start
```bash
npm run docker:up      # Start compose project `pulse-of-ai`: PostgreSQL (5434) + test DB (5433) + Redis (6379)
npm run migrate        # Run pending SQL migrations against dev DB
npm run seed           # Data sources + methodology registry (idempotent)
npm run seed:e2e       # Deterministic e2e fixture dataset (idempotent) — needed by `npm run test:e2e`
npm run dev            # Express server on port 3000
```

- **Compose project name is `pulse-of-ai`** — pinned by `name:` in `docker-compose.yml` AND `COMPOSE_PROJECT_NAME` in `.env`, so every worktree/checkout owns the SAME containers and volumes. Never start the stack with an ad-hoc `-p` project name: that strands the DB data in project-scoped volumes a later run can't adopt.

## Key Commands
| Command | Purpose |
|---|---|
| `npm run db:reset` | Drop + re-migrate + seed dev DB |
| `npm run seed` | Load 50 data sources + methodology versions (from `src/config/methodology-registry.js`) |
| `npm run seed:e2e` | Load the deterministic Playwright fixture dataset (`scripts/test/seed-e2e.js`) |
| `npm run replay -- --post <id>` | Re-run a post's stored decisions through `src/pipeline` and print PASS / DIVERGENCE / NOT RE-RUNNABLE per stage |
| `npm run verify` | Full gate: Jest + coverage, pytest, black (needs `python/.venv`) |
| `npm run test:e2e` | Playwright suite (dev DB migrated + seeded + `seed:e2e`; globalSetup freshens timestamps) |
| `npm run coverage:frontend` | Non-gating coverage of the pure namespaces of globe/story/ui/main |
| `npm run test:unit` | Unit tests (no DB required) |
| `npm run test:int` | Integration tests (needs docker:up) |
| `npm run test:cov` | Coverage report (must be ≥80% lines) |
| `black python/` | Format Python files |

## Architecture
- **DB:** PostgreSQL 16 + pgvector — 9 migrations in `src/db/migrations/` (009 registers the bias / ingest / audit_narration methodology rows; it must stay field-for-field equal to `src/config/methodology-registry.js`)
- **Pipeline:** `src/pipeline/` — sentiment → relevance → discourse → embeddings → correlation
- **Workers:** BullMQ queues backed by Redis; worker files mirror pipeline modules
- **Routes:** `src/routes/` — health, posts, sentiment, refresh, audit, bias, methodology, sources, query, themes. `src/server.js` sets the CSP/security headers, applies CORS to the read-only routers only, and mounts `POST /api/refresh` (60 s global debounce) without CORS
- **Audit replay:** `src/audit/replay.js` + `scripts/replay.js` back the receipt's reproduce command
- **Frontend:** `public/` — no build step, all assets self-hosted, UMD modules loaded in contract order by `index.html`:
  - `js/config/` — `design.config.js`, `api.config.js`, `story.config.js` (the 11 beats), `cities.config.js` (city registry)
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
- `globalSetup.js` migrates test DB once; `setup.js` truncates tables before each test file

## Status
Phase B (pipeline TDD) is implemented — `tests/unit/` covers sentiment, relevance, discourse, ingest, bias, correlation, embeddings, and the ingest/embed/correlate workers; `tests/integration/` covers all API routes. The plan file previously referenced here (`~/.claude/plans/composed-coalescing-duckling.md`) no longer exists.

The storytelling frontend follows the FuN.zip design-handoff prototype (11 beats, Canvas-2D globe); PRD §4.3 is the requirement of record and `docs/plans/2026-07-05-globe-storytelling-design.md` (globe.gl / Mapbox era) is superseded.
