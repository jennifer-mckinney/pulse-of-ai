# Pulse of AI — Project Context

## Quick Start
```bash
npm run docker:up      # Start PostgreSQL (5434) + test DB (5433) + Redis (6379)
npm run migrate        # Run pending SQL migrations against dev DB
npm run dev            # Express server on port 3000
```

## Key Commands
| Command | Purpose |
|---|---|
| `npm run db:reset` | Drop + re-migrate + seed dev DB |
| `npm run seed` | Load 50 data sources + methodology versions |
| `npm run test:unit` | Unit tests (no DB required) |
| `npm run test:int` | Integration tests (needs docker:up) |
| `npm run test:cov` | Coverage report (must be ≥80% lines) |
| `black python/` | Format Python files |

## Architecture
- **DB:** PostgreSQL 16 + pgvector — 6 migrations in `src/db/migrations/`
- **Pipeline:** `src/pipeline/` — sentiment → relevance → discourse → embeddings → correlation
- **Workers:** BullMQ queues backed by Redis; worker files mirror pipeline modules
- **Routes:** `src/routes/` — health, config, posts, sentiment, refresh, audit, bias, methodology, sources, query
- **Frontend:** `public/` — map.js (Mapbox globe), main.js (health + refresh)

## Mapbox Token
- Lives in `.env` as `MAPBOX_ACCESS_TOKEN` — never hardcode in client JS
- Served to browser via `GET /api/config` (`src/routes/config.js`)
- `map.js` wraps all init in `async initMap()` that awaits `loadMapboxToken()`

## Security / Hooks
- Write hook blocks `innerHTML` in client JS — use `esc()` helper + DOM methods for dynamic HTML
- Write hook flags GitHub Actions workflow files — acknowledge, then proceed (workflow is safe)
- Stop hook requires preview verification after every edit — run `preview_snapshot` + `preview_console_logs`

## Testing Quirks
- `NODE_ENV=test` makes `migrate.js` and `db/connection.js` target port 5433 (test DB)
- Tests run serially (`maxWorkers: 1`) — shared test DB; parallel runs cause TRUNCATE race conditions
- `globalSetup.js` migrates test DB once; `setup.js` truncates tables before each test file

## Active Plan
Full architecture plan: `~/.claude/plans/composed-coalescing-duckling.md`
Next phase: **Phase B** — pipeline TDD (sentiment → relevance → discourse → ingest → bias)
