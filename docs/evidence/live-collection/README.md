# Live collection evidence (2026-09-29)

Captured from the throwaway standup `pulse-of-ai-standup-test5` (web :3300)
running `feature/source-collectors`, after `npm run standup` reported
SMOKE: PASS (18 checks) with data LIVE from the 51-source registry.

- `01-landing-live.png`: intro kicker "LIVE · UPDATED EVERY 2–3 MINUTES";
  byline "51 SOURCES · 8 CATEGORIES" from GET /api/sources; globe from
  collected posts placed at city level (publisher cities for editorial
  sources, ADR 0001).
- `02-health-drawer-sources.png`: "SOURCES · 31 / 51 ONLINE" and the
  per-source status list (blocked sources read "blocked: no compliant
  access" with a terms link).
- `03-explore-live-posts.png`: explore mode over live data.

The header's active alerts in this stack include location-concentration
alerts raised by one-source cron jobs BEFORE the collection-cycle fix
(commit 7866f42). They remain unresolved rows in this throwaway database;
cycles since the fix show 0 violations.
