# Pulse of AI diagrams

These diagrams explain how Pulse of AI works, for reviewers and contributors. Each one describes the code on `master` @ `973cad8` (PRs #9 standup, #10 source collectors and #22 collection hardening merged), plus what this PR ships: the legal-notice UI (`public/js/config/legal.config.js`, the header about panel). Nothing drawn is in flight.

## How the files fit together

Every diagram has three files with the same name:

| File | Role |
|---|---|
| `<name>.mmd` | **Canonical** Mermaid source. Edit this file only. |
| `<name>.html` | Standalone page. It embeds the `.mmd` definition verbatim and renders it in the browser with Mermaid 11 and the forest theme. |
| `<name>.png` | Rendered from the `.mmd` with `@mermaid-js/mermaid-cli` 11.12.0 (`mmdc -t forest`, natural width via `mmdc-config.json`). Both dimensions stay under 8000 px. |

After editing a `.mmd`, regenerate its HTML and PNG and verify that everything is in sync:

```bash
bash docs/diagrams/render.sh docs/diagrams/flows/data-flow-live.mmd   # one diagram
bash docs/diagrams/render.sh                                          # all of them
bash docs/diagrams/render.sh --check   # HTML <pre> embeds the .mmd exactly; each PNG carries the SHA-256 of the .mmd it was rendered from and it must match; PNG is under 8000 px and matches a fresh re-render (same size, pixels within tolerance); needs Pillow; no timestamps
bash docs/diagrams/render.sh --check --hash-only   # the same without the re-render (HTML sync, size and hash only)
```

The first two lines of each `.mmd` are `%% Title:` and `%% Summary:`, and the next comment lines name the source files and the `docs/TECHNICAL_SPEC.md` sections the diagram was derived from.

## Status legend

| Style | Meaning |
|---|---|
| solid green | **done**: exists on `master`, or ships in this PR (the legal-notice UI) |
| dotted red | **gap**: a drawn target that the code on `master` cannot reach. No diagram has one today: the compaction gap of the v1.2.0 draft was fixed by PR #22 |

Nothing is marked in flight: the former **wip** items (PR #10 Part 2) all landed with PR #22 and are drawn as done. Flowcharts, the architecture diagrams and every state diagram carry the legend, which says "all done" when every element is on `master` or ships in this PR. The ERDs, class diagrams and sequence diagrams show only done elements, so they carry no legend.

## Index

| # | Diagram | What it shows | Derived from | Status |
|---|---|---|---|---|
| 1 | [architecture](architecture.html) ([.mmd](architecture.mmd), [.png](architecture.png)) | High-level container architecture: browser modules, web and its routes, the Valkey queues, the worker with its maintenance schedules, the watchdog, the embeddings service, PostgreSQL, migrate and populate, compose profiles, and the 52-source registry grouped by gate status (fresh clone, contact URL only, everything set) | `docker-compose.yml`, `src/server.js`, `src/routes/*`, `src/queues/index.js`, `src/workers/{start,maintenance.worker}.js`, `scripts/watchdog.js`, `public/index.html`, `src/config/source-registry.js` | done |
| 2 | [architecture/deployment-standup](architecture/deployment-standup.html) | Deployment of `npm run standup`: images (Valkey 8.1.10 by digest), loopback port bindings, volumes (`valkey_data`), health checks, the watchdog container, and the per-role environment (web gets no collector credentials; only the watchdog gets `SMTP_PASSWORD`) | `docker-compose.yml`, `Dockerfile`, `python/Dockerfile`, `scripts/standup.sh`, `.env.example` | done |
| 3 | [architecture/trust-boundaries](architecture/trust-boundaries.html) | Trust boundaries and their controls: CSP and headers, CORS scope, JSON error handler, refresh CSRF guard and token rules, SSRF guard, secret scrubbing (collectors, routes, pool), PII redaction, port binding, the secrets split and the named gate approval | `src/server.js`, `src/middleware/{same-origin,log-error}.js`, `src/routes/*`, `src/collectors/*`, `docker-compose.yml` | done |
| 4 | [flows/collection-1-schedule-and-gates](flows/collection-1-schedule-and-gates.html) | Process flow, part 1: job schedulers, gate transitions recorded in `source_gate_events`, the gate status (kill switches, blocked, contact URL, open routes, the operator acknowledgement and the named approval `GATE_APPROVED_BY`), deadline, database kill switch, refused state, poll-interval claim | `src/workers/collector.scheduler.js`, `src/collectors/runner.js`, `src/config/source-registry.js`, `src/collectors/{state,refusal,governance}.js` | done |
| 5 | [flows/collection-2-fetch-store-score](flows/collection-2-fetch-store-score.html) | Process flow, part 2: guarded fetch (allowed hosts, SSRF, robots, redirects, size caps), normalisation with redaction, the admission filter and the provenance fingerprint, storage with the `collected` retention row, scoring through the `ingest` queue or inline with audit rows, the run record | `src/collectors/{base,http,netguard,transport,robots,normalize,identity,provenance,ai-filter,state,cycle}.js`, `src/pipeline/ingest.js`, `src/workers/ingest.worker.js` | done |
| 6 | [flows/collection-3-cycle-close-bias-alerts](flows/collection-3-cycle-close-bias-alerts.html) | Process flow, part 3: cycle close with in-flight runs, bias checks once per cycle with minimum samples, the daily rolling 24 h window, source-health and retention-overdue alerts, the unscored sweep, scoring retries, embeddings, the watchdog, and how alerts reach the page | `src/workers/start.js`, `src/collectors/{cycle,sweep,source-health,retention-overdue}.js`, `src/pipeline/{bias,bias-window,embeddings}.js`, `src/routes/{health,bias}.js`, `public/js/{main,utils,ui}.js` | done |
| 7 | [flows/data-flow-live](flows/data-flow-live.html) | Data flow: source → collector → admission filter → tables → aggregate endpoints → page modules (globe with the publisher layer, chapters, explore, ribbon, drawers) | `src/collectors/runner.js`, `src/pipeline/*`, `src/routes/*`, `public/js/*` | done |
| 8 | [flows/data-flow-demo-and-retention](flows/data-flow-demo-and-retention.html) | Data flow: the demo population path and the maintenance flows (text retention every 5 min per source window, the demo purge, daily compaction, the `source_runs` rollup) | `scripts/populate.js`, `src/workers/maintenance.worker.js`, `src/collectors/{retention,run-retention}.js`, `src/collectors/reddit/*`, `scripts/compact.js` | done |
| 9 | [data/erd-1-sources-and-jobs](data/erd-1-sources-and-jobs.html) | ERD 1 of 4: `data_sources`, `source_collection_state` (refusal state, error kinds, unchanged runs, freshness), `source_runs`, `processing_jobs` (progress), `alert_events` and its alert types, the three `reddit_*` tables | migrations 001, 003, 013, 016, 018–021, 023, 025, 033, 037, 038, 040, 050 | done |
| 10 | [data/erd-2-posts-scores-audit](data/erd-2-posts-scores-audit.html) | ERD 2 of 4: `raw_posts` (provenance, `ingest_mv_id`, `admission_mv_id`, `text_removed_at`), the three result tables, `decision_audit_log`, `methodology_versions`, `post_embeddings`, `bias_assessments` | migrations 001–004, 006, 010, 012, 017, 022, 025, 042 | done |
| 11 | [data/erd-3-retention-and-correlation](data/erd-3-retention-and-correlation.html) | ERD 3 of 4: `data_retention_log` (every action written), monthly rollups, `compaction_log`, `pseudonymous_users`, `user_platform_sightings` (never written), `correlation_gate_events`, `schema_migrations` | migrations 002, 005, 006, 036, 056, `scripts/migrate.js` | done |
| 12 | [model/collector-framework](model/collector-framework.html) | Class diagram: `Collector` and its RSS / JSON API / bulk / IMAP subclasses, adapters by type, `HttpClient`, `RobotsPolicy`, netguard, transport, errors, Reddit API and budget, and the runner, cycle, state, refusal, status, normalise, admission filter, gate governance, source health, retention and redact modules | `src/collectors/**` | done |
| 13 | [model/pipeline-and-workers](model/pipeline-and-workers.html) | Class diagram: pipeline modules with their current methodology versions (relevance 1.2.0, bias 1.5.0, ingest 1.7.0, admission_filter 1.0.0), the bias window, the correlation gate, the methodology resolver, replay, the BullMQ queues (maintenance included) and the worker handlers | `src/pipeline/*`, `src/queues/index.js`, `src/workers/*`, `src/audit/replay.js` | done |
| 14 | [model/frontend-modules](model/frontend-modules.html) | Class diagram: the UMD modules (`PulseGlobe` with the publisher-location layer, `PulseStory`, `PulseUI`, `PulseMain`, data, insights, chapters, config registries including `PulseLegalConfig`), their public APIs, `pulse:*` events and the endpoints each calls | `public/index.html`, `public/js/**` | done |
| 15 | [sequences/audit-receipt](sequences/audit-receipt.html) | Sequence: the "why?" receipt, from the drawer to `GET /api/audit/:post_id` and the database, with provenance (admission version, retention status for every source), lineage and the four audiences | `public/js/ui.js`, `src/routes/audit.js`, `src/config/{audit-narration,bias-lineage}.js` | done |
| 16 | [sequences/refresh](sequences/refresh.html) | Sequence: `POST /api/refresh`, the same-origin guard, token rules, the no-progress stale check, 409 / 429 / 503 / 202, and the worker queuing one `ingest` job per new post and completing the job (or the cycle closer, while scores are outstanding) | `src/routes/refresh.js`, `src/middleware/same-origin.js`, `src/workers/{collect,ingest}.worker.js`, `src/collectors/{runner,cycle}.js` | done |
| 17 | [states/source-gate-status](states/source-gate-status.html) | State: collecting, awaiting_key / approval / licence, blocked, disabled, blocked_by_source (refused), online; every gated opening needs `GATE_APPROVED_BY` (G5) | `src/config/source-registry.js`, `src/collectors/{status,refusal,state,governance}.js`, `scripts/source-admin.js` | done |
| 18 | [states/story-beats](states/story-beats.html) | State: the 11-beat story and explore (city detail, receipt, health drawer with the SYSTEM WATCHDOG section), and the header about panel of the legal-notice UI | `public/js/config/story.config.js`, `public/js/{story,ui,main}.js` | done |
| 19 | [states/retention-lifecycle](states/retention-lifecycle.html) | State: a stored post through text removal at its source's window (platform terms: embedding deleted with it; detail window), the demo purge and compaction | `src/collectors/retention.js`, `src/workers/maintenance.worker.js`, `scripts/compact.js` | done |
| 20 | [states/processing-job-lifecycle](states/processing-job-lifecycle.html) | State: `processing_jobs.status` (running, closing, awaiting_retries, completed, failed), when bias checks run, the no-progress stale rule, and that rows are never removed | `src/collectors/{cycle,runner,stale-jobs}.js`, `src/routes/refresh.js`, `src/workers/maintenance.worker.js` | done |
| 21 | [data/erd-4-governance-alerting-maintenance](data/erd-4-governance-alerting-maintenance.html) | ERD 4 of 4: audited alert resolutions and named approvals (`alert_status` view), methodology errata, the daily source-run rollup, source gate events and terms snapshots, maintenance and watchdog state, the watchdog e-mail log, rolling 24 h bias window runs and assessments; append-only tables marked | migrations 028, 030, 032, 034, 035, 036, 039, 041, 050, 056, 060; writers in `src/collectors/{source-alerts,run-retention,governance}.js`, `src/workers/maintenance.worker.js`, `src/watchdog/store.js`, `src/pipeline/bias-window.js` | done |

`docs/diagrams/architecture.*` is the entry point and keeps its original path so existing links still work. The previous version, a dark-theme diagram of the Mapbox / globe.gl era with 6 migrations and `/api/config`, is replaced.

## Known gaps the diagrams show

- **Correlation is not implemented.** `pseudonymous_users` and `user_platform_sightings` exist, but the signal design is pending a DPIA: `correlateUser()` throws, nothing enqueues correlate jobs, and the correlate worker refuses any job it is given with the gate status (`src/pipeline/correlation-gate.js`). Only the demo purge deletes from those tables.
- **Two endpoints the page does not call.** `GET /api/sentiment/latest` and `GET /api/bias/latest` are mounted for API consumers. `api.config.js` also lists `/api/bias/latest` and `/api/refresh`, but no module calls them.
- **No endpoint reads the monthly rollups yet.** Compaction writes them daily; `GET /api/rollups/:year/:month` is PLANNED.

## Spec drift notes

This table records where the v1.1 specification disagreed with the code. `docs/TECHNICAL_SPEC.md` v1.2.0 adopts the right-hand column (reconciled with PR #22 on 2026-09-29); the rows are kept so a reader of v1.1 can see what changed. The code is the authority, and the diagrams follow it.

| Spec section | Spec says | Code on master |
|---|---|---|
| §4 Architecture overview | Source box lists Reddit, Twitter/X, Mastodon, Bluesky, TechCrunch, LessWrong and others; browser is "Mapbox GL JS + D3.js v7 + Vanilla JS + Scrollama" | The 52-source registry of `src/config/source-registry.js` (§17 is current). The browser is a vanilla Canvas-2D globe with no Mapbox, D3 or Scrollama (the FuN.zip design-handoff prototype, the requirement of record in PRD §4.3) |
| §4, §5, §12 | Embeddings are served by Infinity (`infinity-embed`) | A FastAPI + sentence-transformers service, `python/embeddings_service.py` |
| §5 Alternatives | Redis rejected for the MVP | Valkey 8 (Redis protocol; it replaced Redis 7 in PR #22) backs the BullMQ queues, the job schedulers and the worker heartbeat |
| §6 Schema overview | 17 tables across 6 migrations | 46 migrations (001–060, with gaps) and 34 tables, plus `schema_migrations` (added since v1.1 include `source_collection_state`, `source_runs`, the `reddit_*` tables, `alert_resolutions`, `source_gate_events`, `maintenance_state`, the `watchdog_*` and `bias_window_*` tables; see the ERDs) |
| §7 `GET /api/health` | 503 when the DB is unreachable; a `timestamp` field | 200 with `status: degraded` and `db_connected: false`, or 500 on error. No `timestamp`. Adds `data_mode`, `data_window`, `active_sources`, `demo_feeds`, `redis`, `worker`, `sources`, `alerts_closed`, `maintenance`, `jobs`, `watchdog`, `bias_sample` and `correlation`; cached 5 s |
| §7 API specification | Documents 9 endpoints | 12 are mounted: `GET /api/bias/history`, `GET /api/sources/timeseries` and `GET /api/themes` are not in §7 |
| §7 `GET /api/audit/:post_id` | Response has `post.source` and `decisions` | Response has `provenance`, `post` (`source_name`, `attribution`, `data_origin`), `narration`, `ingest`, `decisions` (with `audiences`) and `bias` |
| §7 `POST /api/query` | "Rate limited: 10 requests per minute per IP" (§8 says GET endpoints have no rate limit) | No rate limit on `/api/query`. Only `/api/refresh` is limited |
| §8 PII handling | Dedup when `content_hash` exists; logs `data_retention_log` action `collected`; "falls back to mock data" when an API key is absent | Dedup on `(source_id, external_id)`; `content_hash` is a join key. A `collected` row is written per stored post since `ingest@1.6.0`. A source without its key is `awaiting_key` and not collected; demo data is used only when the trailing hour has no live posts |
| §9 Bias monitoring | Three layers: demographic parity, equalized odds, counterfactual fairness; runs at the end of every job; alert type `bias_violation` | Three checks: `location_concentration`, `platform_sentiment_parity`, `negative_dominance`, run once per collection cycle (or per refresh / standup job) and daily over a rolling 24 h window, each with a minimum sample (`bias@1.5.0`); each alert's type is the check's name |
| §10 Audiences | Journalist, Regulator, Internal audit, Researcher | Four views: Public, Journalist (`plain`), Regulator (`config`), Researcher |
| §11 Scroll-driven narrative | Scrollama steps with D3 charts | `public/js/story.js`: 11 beats on the Canvas globe |
| §12 Vector search use cases | `POST /api/similar/:post_id` | Not mounted (Phase 2 in the spec) |
| §19 Retention | Tier 2 includes `monthly_discourse_rollups` and `GET /api/rollups/:year/:month`; compaction "runs on the 1st of each month"; query responses carry a rollup note | No `monthly_discourse_rollups` table and no rollups endpoint. Compaction runs in the worker's daily maintenance task (and `npm run compact`) and blanks text instead of nulling it. `/api/query` has no rollup note |
| §20 Correlation | `GET /api/users/:pseudo_id` | Not mounted; correlation is not implemented (DPIA gate) |
