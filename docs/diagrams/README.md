# Pulse of AI diagrams

These diagrams explain how Pulse of AI works, for reviewers and contributors. Each one describes the code on `master` (PRs #9 standup and #10 source collectors merged), plus what this PR ships: the legal-notice UI (`public/js/config/legal.config.js`, the header about panel). Anything still being built in PR #10 Part 2 is marked **wip**.

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
bash docs/diagrams/render.sh --check   # HTML embeds the .mmd byte for byte; PNG is under 8000 px and matches a fresh re-render (same size, pixels within tolerance); no timestamps
```

The first two lines of each `.mmd` are `%% Title:` and `%% Summary:`, and the next comment lines name the source files and the `docs/TECHNICAL_SPEC.md` sections the diagram was derived from.

## Status legend

| Style | Meaning |
|---|---|
| solid green | **done**: exists on `master`, or ships in this PR (the legal-notice UI) |
| dotted red | **gap**: drawn target that the code on `master` cannot reach (retention-lifecycle: the compacted month) |
| dashed amber | **wip**: PR #10 Part 2, in flight. It covers the worker topology (collect enqueues ingest), per-source retention and scheduled compaction, `source_gate_events`, the terms-snapshot table, the publisher-location globe layer excluded from bias, a bias minimum sample, staleness alerts in `/api/health`, `relevance@1.2.0`, `env_file` in compose, and binding the dev server to 127.0.0.1 |

Flowcharts, the architecture diagrams and every state diagram carry the legend; a state diagram with no wip element says "all done" in its legend note (processing-job-lifecycle, source-gate-status, story-beats). The ERDs, class diagrams and sequence diagrams show only done elements (on `master` or shipped in this PR), so they carry no legend.

## Index

| # | Diagram | What it shows | Derived from | Status |
|---|---|---|---|---|
| 1 | [architecture](architecture.html) ([.mmd](architecture.mmd), [.png](architecture.png)) | High-level container architecture: browser modules, web and its routes, Redis queues, the worker, the embeddings service, PostgreSQL, migrate and populate, compose profiles, and the 52-source registry grouped by gate status | `docker-compose.yml`, `src/server.js`, `src/routes/*`, `src/queues/index.js`, `src/workers/start.js`, `public/index.html`, `src/config/source-registry.js` | done, with wip items |
| 2 | [architecture/deployment-standup](architecture/deployment-standup.html) | Deployment of `npm run standup`: images, loopback port bindings, volumes, health checks, and the per-role environment (web gets no collector credentials) | `docker-compose.yml`, `Dockerfile`, `python/Dockerfile`, `scripts/standup.sh`, `.env.example` | done, with wip items |
| 3 | [architecture/trust-boundaries](architecture/trust-boundaries.html) | Trust boundaries and their controls: CSP and headers, CORS scope, refresh CSRF guard, SSRF guard, secret scrubbing, PII redaction, port binding and the secrets split | `src/server.js`, `src/middleware/same-origin.js`, `src/routes/*`, `src/collectors/*`, `docker-compose.yml` | done |
| 4 | [flows/collection-1-schedule-and-gates](flows/collection-1-schedule-and-gates.html) | Process flow, part 1: job schedulers, the gate status (kill switches, blocked, contact URL, open routes and the operator acknowledgement), deadline, database kill switch, refused state, poll-interval claim | `src/workers/collector.scheduler.js`, `src/collectors/runner.js`, `src/config/source-registry.js`, `src/collectors/{state,refusal}.js` | done |
| 5 | [flows/collection-2-fetch-store-score](flows/collection-2-fetch-store-score.html) | Process flow, part 2: guarded fetch (allowed hosts, SSRF, robots, redirects, size caps), normalisation with redaction and the provenance fingerprint, storage, inline scoring with audit rows, the run record | `src/collectors/{base,http,netguard,transport,robots,normalize,identity,provenance,state,cycle}.js`, `src/pipeline/ingest.js` | done, with wip item |
| 6 | [flows/collection-3-cycle-close-bias-alerts](flows/collection-3-cycle-close-bias-alerts.html) | Process flow, part 3: cycle close with in-flight runs, bias checks once per cycle, alerts, the unscored sweep, scoring retries, embeddings, and how alerts reach the page | `src/workers/start.js`, `src/collectors/{cycle,sweep}.js`, `src/pipeline/{bias,embeddings}.js`, `src/routes/{health,bias}.js`, `public/js/main.js` | done, with wip items |
| 7 | [flows/data-flow-live](flows/data-flow-live.html) | Data flow: source → collector → tables → aggregate endpoints → page modules (globe, chapters, explore, ribbon, drawers) | `src/collectors/runner.js`, `src/pipeline/*`, `src/routes/*`, `public/js/*` | done |
| 8 | [flows/data-flow-demo-and-retention](flows/data-flow-demo-and-retention.html) | Data flow: the demo population path and the retention flows (Reddit 48 h text blanking, the demo purge, compaction) | `scripts/populate.js`, `src/collectors/retention.js`, `src/collectors/reddit/*`, `scripts/compact.js` | done, with wip items |
| 9 | [data/erd-1-sources-and-jobs](data/erd-1-sources-and-jobs.html) | ERD: `data_sources`, `source_collection_state` (refusal state, error kinds, unchanged runs), `source_runs`, `processing_jobs`, `alert_events`, the three `reddit_*` tables | migrations 001, 003, 013, 016, 018–021, 023, 025 | done |
| 10 | [data/erd-2-posts-scores-audit](data/erd-2-posts-scores-audit.html) | ERD: `raw_posts` (provenance, `ingest_mv_id`, `text_removed_at`), the three result tables, `decision_audit_log`, `methodology_versions`, `post_embeddings`, `bias_assessments` | migrations 001–004, 006, 010, 012, 017, 022, 025 | done |
| 11 | [data/erd-3-retention-and-correlation](data/erd-3-retention-and-correlation.html) | ERD: `data_retention_log`, monthly rollups, `compaction_log`, `pseudonymous_users`, `user_platform_sightings`, `schema_migrations` | migrations 002, 005, 006, `scripts/migrate.js` | done |
| 12 | [model/collector-framework](model/collector-framework.html) | Class diagram: `Collector` and its RSS / JSON API / bulk / IMAP subclasses, adapters by type, `HttpClient`, `RobotsPolicy`, netguard, transport, errors, Reddit API and budget, and the runner, cycle, state, refusal, status, normalise, retention and redact modules | `src/collectors/**` | done |
| 13 | [model/pipeline-and-workers](model/pipeline-and-workers.html) | Class diagram: pipeline modules with their current methodology versions, the methodology resolver, replay, the BullMQ queues and the worker handlers | `src/pipeline/*`, `src/queues/index.js`, `src/workers/*`, `src/audit/replay.js` | done |
| 14 | [model/frontend-modules](model/frontend-modules.html) | Class diagram: the UMD modules (`PulseGlobe`, `PulseStory`, `PulseUI`, `PulseMain`, data, insights, chapters, config registries including `PulseLegalConfig`), their public APIs, `pulse:*` events and the endpoints each calls | `public/index.html`, `public/js/**` | done |
| 15 | [sequences/audit-receipt](sequences/audit-receipt.html) | Sequence: the "why?" receipt, from the drawer to `GET /api/audit/:post_id` and the database, with provenance, lineage and the four audiences | `public/js/ui.js`, `src/routes/audit.js`, `src/config/{audit-narration,bias-lineage}.js` | done |
| 16 | [sequences/refresh](sequences/refresh.html) | Sequence: `POST /api/refresh`, the same-origin guard, token, 409 / 429 / 503 / 202, and the worker completing the job | `src/routes/refresh.js`, `src/middleware/same-origin.js`, `src/workers/collect.worker.js` | done |
| 17 | [states/source-gate-status](states/source-gate-status.html) | State: collecting, awaiting_key / approval / licence, blocked, disabled, blocked_by_source (refused), online | `src/config/source-registry.js`, `src/collectors/{status,refusal,state}.js`, `scripts/source-admin.js` | done |
| 18 | [states/story-beats](states/story-beats.html) | State: the 11-beat story and explore (city detail, receipt, health drawer) | `public/js/config/story.config.js`, `public/js/{story,ui,main}.js` | done |
| 19 | [states/retention-lifecycle](states/retention-lifecycle.html) | State: a stored post through Reddit blanking, the demo purge and compaction | `src/collectors/retention.js`, `scripts/compact.js` | done, with wip item and a gap state |
| 20 | [states/processing-job-lifecycle](states/processing-job-lifecycle.html) | State: `processing_jobs.status` (running, closing, awaiting_retries, completed, failed) and when bias checks run | `src/collectors/{cycle,runner}.js`, `src/routes/refresh.js` | done |

`docs/diagrams/architecture.*` is the entry point and keeps its original path so existing links still work. The previous version, a dark-theme diagram of the Mapbox / globe.gl era with 6 migrations and `/api/config`, is replaced.

## Not drawn yet (wip)

The wip tables `source_gate_events` and the terms-snapshot table are named in diagram 1 but have no columns in the ERDs, because their schema is not on `master` yet. They will be added when PR #10 Part 2 merges.

## Known gaps the diagrams show

- **Compaction cannot finish on a real month.** `scripts/compact.js` nulls `raw_posts.content`, but migration 001 declares that column `NOT NULL`, so the UPDATE fails on any month with real posts (`tests/integration/compact.test.js` drops the constraint to test the step). The demo purge works. The rollups are written only for months without real posts: each month compacts in one transaction, so on a month with real posts the failed content-nulling step rolls back its rollups and embedding deletes too. Compaction also runs only by hand (`npm run compact`); scheduling it is wip.
- **Correlation is reserved.** `pseudonymous_users` and `user_platform_sightings` exist and `correlate.worker.js` runs, but nothing enqueues correlation jobs: collectors store no identity signals.
- **Two endpoints the page does not call.** `GET /api/sentiment/latest` and `GET /api/bias/latest` are mounted for API consumers. `api.config.js` also lists `/api/bias/latest` and `/api/refresh`, but no module calls them.

## Spec drift notes

`docs/TECHNICAL_SPEC.md` is the requirements source of truth for names and intent, and the code is the authority for what exists. The diagrams follow the code. Where the two disagree, the difference is listed here and was **not** changed in either:

| Spec section | Spec says | Code on master |
|---|---|---|
| §4 Architecture overview | Source box lists Reddit, Twitter/X, Mastodon, Bluesky, TechCrunch, LessWrong and others; browser is "Mapbox GL JS + D3.js v7 + Vanilla JS + Scrollama" | The 52-source registry of `src/config/source-registry.js` (§17 is current). The browser is a vanilla Canvas-2D globe with no Mapbox, D3 or Scrollama (the FuN.zip design-handoff prototype, the requirement of record in PRD §4.3) |
| §4, §5, §12 | Embeddings are served by Infinity (`infinity-embed`) | A FastAPI + sentence-transformers service, `python/embeddings_service.py` |
| §5 Alternatives | Redis rejected for the MVP | Redis 7 backs the BullMQ queues and the worker heartbeat |
| §6 Schema overview | 17 tables across 6 migrations | 26 migrations and 22 tables, plus `schema_migrations` (added: `source_collection_state`, `source_runs`, `reddit_subreddit_rankings`, `reddit_api_budget`, `reddit_maintenance`) |
| §7 `GET /api/health` | 503 when the DB is unreachable; a `timestamp` field | 200 with `status: degraded` and `db_connected: false`, or 500 on error. No `timestamp`. Adds `data_mode`, `data_window`, `active_sources`, `demo_feeds`, `redis`, `worker`, `sources` |
| §7 API specification | Documents 9 endpoints | 12 are mounted: `GET /api/bias/history`, `GET /api/sources/timeseries` and `GET /api/themes` are not in §7 |
| §7 `GET /api/audit/:post_id` | Response has `post.source` and `decisions` | Response has `provenance`, `post` (`source_name`, `attribution`, `data_origin`), `narration`, `ingest`, `decisions` (with `audiences`) and `bias` |
| §7 `POST /api/query` | "Rate limited: 10 requests per minute per IP" (§8 says GET endpoints have no rate limit) | No rate limit on `/api/query`. Only `/api/refresh` is limited |
| §8 PII handling | Dedup when `content_hash` exists; logs `data_retention_log` action `collected`; "falls back to mock data" when an API key is absent | Dedup on `(source_id, external_id)`; `content_hash` is a join key. No `collected` rows are written. A source without its key is `awaiting_key` and not collected; demo data is used only when the trailing hour has no live posts |
| §9 Bias monitoring | Three layers: demographic parity, equalized odds, counterfactual fairness; runs at the end of every job; alert type `bias_violation` | Three checks: `location_concentration`, `platform_sentiment_parity`, `negative_dominance`, run once per collection cycle (or per refresh / standup job); each alert's type is the check's name. Minimum sample is wip |
| §10 Audiences | Journalist, Regulator, Internal audit, Researcher | Four views: Public, Journalist (`plain`), Regulator (`config`), Researcher |
| §11 Scroll-driven narrative | Scrollama steps with D3 charts | `public/js/story.js`: 11 beats on the Canvas globe |
| §12 Vector search use cases | `POST /api/similar/:post_id` | Not mounted (Phase 2 in the spec) |
| §19 Retention | Tier 2 includes `monthly_discourse_rollups` and `GET /api/rollups/:year/:month`; compaction "runs on the 1st of each month"; query responses carry a rollup note | No `monthly_discourse_rollups` table and no rollups endpoint. Compaction is manual (`npm run compact`) and its content-nulling step is blocked (see Known gaps). `/api/query` has no rollup note |
| §20 Correlation | `GET /api/users/:pseudo_id` | Not mounted; correlation is reserved |
