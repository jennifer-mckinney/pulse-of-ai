# ADR 0001 — The 51-source registry and real data collection

- **Status:** Accepted
- **Date:** 2026-09-29
- **Decider:** Jennifer McKinney (product owner)
- **Inputs:** `docs/requirements/Top_50_Global_Online_Sources.xlsx` (Rev. 3, the registry of record), `docs/research/2026-09-29-source-access.md` (per-source routes, terms and live verification)
- **Code:** `src/config/source-registry.js`, `src/collectors/`, `src/workers/`, migrations `013_source_collection.sql`, `014_methodology_alignment.sql`, `015_ingest_text_redaction.sql`

## Context

Pulse of AI shipped with a 50-row seed list that did not match the workbook, and with no working collection: nothing consumed the `collect.*` queues, the scheduler was never started, `POST /api/refresh` completed with 0 posts, and `ingest.worker.js` imported a function that does not exist. The source-access research (2026-09-29) established, for each of the workbook's 51 sources, the official way to collect AI or technology content from that source and the terms that govern it.

## Rulings (verbatim, 2026-09-29)

1. The workbook is the registry of record, collected through each source's AI or technology feed or endpoint.
2. "wire all source's in the excel sheet. all sources have a public way to gather the data. no wordarounds or being lazy."
3. "use the 51 sources exactly. no exceptions." Exactly 51 registry rows: no additions, no substitutes, no silent drops.
4. Gated sources: "Build all, free feeds on now." A full collector is built for all 19 approval-, licence- or paid-gated sources.
   - The news RSS feeds that are publicly fetchable but whose terms require permission for automated analysis are ENABLED now. **Jennifer explicitly accepted that legal risk.** That covers BBC, NBC News, Ars Technica, and the free RSS feeds of NYT, Washington Post, Guardian, Al Jazeera and WSJ (the Dow Jones host).
   - Paid APIs are built but only activate when their key is set in env: X, AP, Reuters, CNN, and paid tiers.
   - Researcher programs activate when their credentials are set: Meta Content Library for WhatsApp, Instagram and Facebook, and the TikTok Research API.
   - Other gated APIs activate when their key or permission is set: ScienceDirect, IEEE Xplore, JSTOR.
   - Every source must have a per-source kill switch (env or config) so any feed can be turned off without a code change.
5. The 4 BLOCKED sources are WeChat, Telegram, ResearchGate and Cato. They stay in the registry and are SHOWN in the UI as "blocked: no compliant access", with the terms citation. Each gets a collector class that refuses to run unless an explicit official credential or permission env is set; its intended official route is wired per the research. NEVER get around bot detection, CAPTCHAs, Incapsula or 403 walls, and never scrape against terms.
6. Pulse of AI is non-commercial, so NPR, SpringerLink, IEEE Xplore, and Meta and TikTok eligibility are handled on that basis. Attribution is shown where the terms require it, e.g. NPR.
7. The 8-category canon: Social, News, Academic, Policy, Non-profit, Developer, Forums, Blogs.

## Decision

### Registry of record in code
`src/config/source-registry.js` holds exactly the 51 workbook rows (rank, verbatim name, category, region) plus, per source: collector type, AI/technology endpoints (from the research), auth kind (`none | key | approval | paid | permission | blocked`), the env vars it needs, the gate status when closed, attribution, rate limit, poll cadence and the terms citation. `tests/unit/pure/sourceRegistry.test.js` reads the `.xlsx` directly (no spreadsheet dependency) and fails on any difference in rank, name or category, including the Rev. 3 Forums move. `docs/requirements/Top_51_Global_Online_Sources.rev3.csv` is the committed export (`node scripts/export-workbook-csv.js`).

### Gate status
Each source resolves at runtime to one of `collecting`, `awaiting_key`, `awaiting_approval`, `awaiting_licence`, `blocked`, `disabled`. A source has one or more **routes**; a route is open when every env var it `requires` is set, and a paid tier `replaces` the free feed it upgrades (Guardian commercial Content API over the AI-tag RSS; NYT Article Search under a TDM licence over the Technology RSS; the Dow Jones contract feed over the public WSJ RSS). The permission-gated news feeds of ruling 4 require one operator setting, `PERMISSION_GATED_FEEDS_ACCEPTED_BY` (decision D1 below), and nothing else; their `*_LICENSE_REF` is recorded (shown as on file / not on file) once a publisher grants permission.

Two interpretations are made explicit here for Jennifer to confirm:
- **ScienceDirect and IEEE Xplore** need both the self-service key and the approval / licence reference (`ELSEVIER_APPROVAL_REF`, `IEEE_LICENSE_REF`): the key alone is issued to anyone and is not the permission their terms require.
- **Stack Overflow and GitLab** run keyless at a cadence inside the documented anonymous quota (Stack Exchange 300/day → one run per 15 min; GitLab 60/hour → one run per 5 min). The optional key only raises the quota.

### Kill switches
Per source: `SOURCE_<SLUG>_ENABLED=false` (e.g. `SOURCE_BBC_NEWS_ENABLED=false`) or listing the slug in `COLLECTORS_DISABLED`. Globally: `COLLECTORS_ENABLED=false`. Any of these makes the source `disabled` at the next schedule refresh and before every run; no code change is needed.

### The blocked 4
They remain registry rows and are served by `/api/sources` and the health drawer as "blocked: no compliant access" with the terms citation and the remedy. Each has a collector class that throws before any network call unless its official permission env is set, and then uses only the intended official route: a Tencent-authorized feed (WeChat), the Bot API under Telegram's written permission (Telegram), a dataset delivered under a ResearchGate data-access grant (ResearchGate), and Cato's RSS once Cato allowlists the collector User-Agent (Cato). Any 401/403/challenge response stops the run; nothing retries around it.

### Terms, robots and politeness
- Every request carries `PulseOfAI/<version> (+<COLLECTOR_CONTACT_URL>; non-commercial AI discourse research)`. Without `COLLECTOR_CONTACT_URL` every source is `disabled`, and a fresh clone ships it empty (decision D1 below).
- HTML-origin routes (feeds on a publisher's site) are checked against that host's `robots.txt` before every request, redirects included. **Conservative matching:** a `Disallow: /x/` rule is also applied to the path `/x`. This resolves the CFR ambiguity (`Disallow: /feed/` vs the feed at `/feed`) conservatively: the CFR feed is not fetched and CFR shows `awaiting_approval` until `CFR_FEED_PERMISSION_REF` records CFR's confirmation, after which literal RFC 9309 matching applies to CFR only.
- Documented API hosts are not robots-gated (their terms and rate limits govern them), but the same per-host spacing, backoff (429/5xx, honouring `Retry-After`), timeouts and conditional GET (ETag / Last-Modified) apply.
- Collectors never request identity fields (authors, usernames, profile locations); the normaliser drops any that arrive, does not store links whose path names a person, and replaces e-mail addresses and @handles in the text with `[email]` / `@[user]` (`ingest@1.2.0`, migration 015).

### Location
Location is capped at city level and never inferred for a person. A post gets (1) a content-level city when the item carries one (e.g. an OSM diary geotag rounded to the nearest registry city), else (2) the **publisher's** home city for editorial sources whose items are their own articles (BBC → London, NPR → Washington, D.C.), else nothing. The basis (`content` or `publisher`) is stored with the payload and registered in `ingest@1.1.0`. Platforms and repositories of third-party content (social, forums, arXiv, GitHub issues, Substack, individual newsletter authors) get no publisher city. Six tier-2 cities were added to the city registry for publisher origins.

### Non-commercial basis and attribution
The NPR, SpringerLink, IEEE and Meta/TikTok routes are used on the non-commercial basis of ruling 6. Where the terms require attribution the registry carries it and the API serves it next to the source's content: NPR, NBCNews.com, Stack Exchange (CC BY-SA 4.0), Wikipedia (CC BY-SA 4.0), Our World in Data (CC BY 4.0), Pew Research Center.

### Replacing the old seed
The old 50-row seed list is removed; `scripts/seed.js` upserts the 51 registry rows. Migration 013 marks every old seed row that is not a registry row `active = FALSE` with `retired_at` and a note. No post, score or audit row is deleted: history stays attached to the retired source. The demo feeds (`source_type = 'demo'`) are untouched and never count toward the 51.

### Methodology alignment
The replay tool found drift: relevance was registered with 18 keywords while the code scores 20, with a 0.1-per-match rule the code does not use, and the registered DQI dimensions differ from the code's. Existing rows are never edited. New rows `relevance@1.1.0`, `discourse@1.1.0-DQI` and `ingest@1.1.0` describe exactly what the code does; the pipeline resolves the version it implements from the registry, not "latest by timestamp". The unreachable 0.40 embed gate (8 of 20 keywords) is replaced by "at least one lexicon match" (`score ≥ 1/20`), registered in `relevance@1.1.0`.

## Decisions of 2026-09-29 (PR #10 review)

Recorded verbatim; each is implemented in the code and tests named.

### D1 — clone default: "Off for others, on for you"
- `COLLECTOR_CONTACT_URL` ships **empty** in `.env.example` and in the compose defaults; no test or script supplies one on the operator's behalf. With no contact URL every source is `disabled`, and `npm run standup` populates **demo data only** and says so (step "Live collection", and the final summary).
- `PERMISSION_GATED_FEEDS_ACCEPTED_BY` (operator name plus date) is the operator's acknowledgement for the 8 permission-gated feeds of ruling 4 (BBC, NYT, Guardian, Al Jazeera, WSJ, NBC News, Washington Post, Ars Technica). Their free-feed routes `require` it (`permissionGated: true` in the registry); without it they stay closed, while a licensed or paid route of the same source is unaffected. The value is never served by the API.
- Run on a terminal, standup offers to set both values (`collector_operator_setup` in `scripts/lib/stack.sh`); `--yes` or a non-interactive run never prompts. `ensure_env_file` never adds either key to an existing env file.
- Jennifer's own deployment sets both values in her `.env` (README, "Live vs demo data"). Ruling 4's acceptance of legal risk is hers; the acknowledgement makes every other operator make that decision themselves.
- Tests: `tests/unit/pure/sourceRegistry.test.js` (the 8 gated routes, counts with and without the acknowledgement, a clone collects nothing), `tests/unit/pure/sourceEnv.test.js` (both ship empty; no contact URL baked into compose, standup, the Dockerfile or `.env.example`), `scripts/test/stack-lib.test.sh` (no injection, prompts, `--yes`).

## Consequences

- With the contact URL and the acknowledgement set, 31 of 51 sources collect with no keys (20 keyless sources, GovInfo's keyless RSS, Stack Overflow and GitLab keyless, and the 8 permission-gated feeds of ruling 4); with the contact URL alone, 23; on a fresh clone, none (D1). CFR waits for confirmation; 4 wait for a free key (YouTube, SpringerLink, Google Scholar mailbox, Congress.gov); 6 for approval (Meta ×3, TikTok, ScienceDirect, JSTOR); 5 for a licence (X, CNN, AP, Reuters, IEEE); 4 are blocked.
- Collectors for the 19 gated sources and the blocked 4 are tested only against recorded fixtures until credentials exist.
- Legal risk for the ruling-4 feeds is accepted by the product owner, not eliminated; each has a kill switch.
- Open questions for Jennifer: the Substack publication list; the Google Scholar alert mailbox (setting its credential is the sign-off); the CFR confirmation; the ScienceDirect/IEEE two-credential reading above; the publisher-city location basis.
