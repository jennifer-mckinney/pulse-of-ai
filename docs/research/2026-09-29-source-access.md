# Source access for the 51 workbook sources — research

**Question:** For each of the 51 sources in the Top 51 workbook (the source registry of record), what is the official, terms-compliant way to collect AI-related public content from that source itself? For each: the route, the auth it needs, the limits and terms that govern automated use, what a "post" is, the collector type, and whether the endpoint was fetched live.

**Dispatched by:** Orchestrator, for Jennifer's rulings of 2026-09-29:
- "wire all source's in the excel sheet. all sources have a public way to gather the data. no wordarounds or being lazy."
- "use the 51 sources exactly. no exceptions."
- Hacker News and Stack Overflow move to Forums (workbook Rev. 3).

**Date:** 2026-09-29. Research ran 2026-09-28 local time, 2026-09-29 UTC. Every citation below was accessed on that date.

**Inputs:**
- `sources-top-50-sources-tidy.csv` (51 rows).
- `sources-analysis.md` (the prior analysis, whose access columns were all marked [inferred]).

**Method:**
- Every endpoint was fetched with curl using the User-Agent `pulse-of-ai-research/0.1 (source-access audit; https://github.com/jennifer-mckinney)`.
- Terms of use were read from each source's own page wherever the page could be reached.
- No bot wall, CAPTCHA or login was bypassed, and no account was created.

---

## 0. Headline

1. **47 of 51 sources have an official, terms-compliant route that collects from the source itself.** 21 need no credentials, 7 need a free self-service key, 10 need approval or a licence, and 9 need payment.
2. **4 are BLOCKED: no compliant route.** WeChat and Telegram are blocked by terms. ResearchGate and Cato are blocked by a bot wall with no official feed or API behind it. Details, clauses and links are in §4.
3. **For most news outlets, the terms decide the verdict, not whether the feed is reachable.**
   - BBC, NYT, Guardian, Al Jazeera, WSJ, NBC News, Washington Post and Ars Technica (Condé Nast) all serve live feeds.
   - But their current terms forbid automated aggregation, "computer analysis", text and data mining, or ML/AI use of that content without a licence or written permission.
   - Our pipeline runs sentiment models and embeddings over the text, so it falls inside those clauses.
   - These sources are therefore **licence- or approval-gated**, not free RSS. The collector code can still be built now and switched on when the licence reference is set (§6).
   - This rests on my reading of the clauses, which are quoted in §3. Jennifer or counsel should confirm it.
4. **Several seeded endpoints are dead or stale:**
   - Reuters RSS: DNS fails.
   - CNN `rss.cnn.com`: newest items 2016–2017.
   - WSJ `feeds.a.dj.com`: newest Jan 2025.
   - RAND AI topic feed: valid Atom with zero entries.
   - Mozilla Foundation blog RSS: newest 2025-02-20.
5. **Two platform facts in the prior analysis are out of date:**
   - X has no $100/mo Basic tier any more. Access is now pay-per-use at $0.005 per post read.
   - YouTube `search.list` now has its own quota of 100 calls/day.

### Counts by access group

| Group | Count | Sources |
|---|---|---|
| No auth (works today) | 21 | NPR*, arXiv, PubMed/PMC, Council on Foreign Relations, RAND, Urban Institute, Pew, Wikipedia, Mozilla, Khan Academy, Our World in Data, OpenStreetMap, Internet Archive, GitHub, Docker Hub, Hugging Face, Hacker News, TLDR, Substack, One Useful Thing, Platformer |
| Free self-service key | 7 | YouTube, SpringerLink*, Google Scholar* (alert mailbox credentials), GovInfo, Congress.gov, GitLab, Stack Overflow |
| Approval or licence required | 10 | WhatsApp, Instagram, Facebook, TikTok (researcher programs); BBC News, NBC News, Ars Technica (publisher permission); ScienceDirect, IEEE Xplore, JSTOR (publisher programs) |
| Paid | 9 | X, The New York Times, CNN, The Guardian, Al Jazeera, WSJ, Associated Press, Reuters, The Washington Post |
| **BLOCKED: no compliant route** | 4 | WeChat/Weixin, Telegram, ResearchGate, Cato Institute |

\* A condition applies; see the source's detail section. These routes are compliant only if pulse-of-ai is operated as non-commercial (NPR, Springer), and the Google Scholar route needs Jennifer's sign-off (§3.24).

---

## 1. Summary table (one row per source)

Column key:
- **Cat** is the canonical slug after the Forums move. Forums gets 2 sources and Developer keeps 4.
- **Type** is the collector type: rss, api or bulk.
- **Verified** means the recommended endpoint was fetched live today and returned content:
  - "yes": fetched and returned content.
  - "no": needs credentials, or is walled.
  - "feed only": a public feed answered, but the compliant route is the licensed one, which cannot be tested without the licence.
- **Compliant** means officially allowed for our use:
  - "yes": allowed now.
  - "cond.": allowed under a stated condition.
  - "after approval" or "with licence": allowed once that is granted.
  - "BLOCKED": no compliant route.

| # | Source | Cat | Route (primary) | Auth | Type | Verified | Compliant |
|---|---|---|---|---|---|---|---|
| 1 | WhatsApp (Channels) | social | Meta Content Library API (WhatsApp Channels) | Researcher approval | bulk | no | after approval |
| 2 | Instagram | social | Meta Content Library API | Researcher approval | bulk | no | after approval |
| 3 | YouTube | social | YouTube Data API v3 `search.list` + `videos.list` | Free key | api | no | yes (see derived-metrics note) |
| 4 | Facebook | social | Meta Content Library API; or Graph API Page Public Content Access | Researcher approval / App Review | bulk / api | no | after approval |
| 5 | TikTok | social | TikTok Research API `research/video/query` | Researcher approval | api | no | after approval |
| 6 | WeChat / Weixin | social | none | n/a | n/a | robots.txt only | **BLOCKED** |
| 7 | Telegram | social | none | n/a | n/a | t.me/s audit only | **BLOCKED** |
| 8 | X | social | X API v2 `tweets/search/recent` | Paid (pay-per-use) | api | no | yes |
| 9 | BBC News | news | Technology RSS, under a BBC permission | Permission | rss | feed only (200, 21 items) | with licence |
| 10 | The New York Times | news | Article Search API / Technology RSS, under an NYT Licensing TDM licence | Paid licence | api / rss | feed only (200, 30 items) | with licence |
| 11 | CNN | news | CNN Wire Store (text licensing) | Paid licence | api / bulk | no (public RSS stale) | with licence |
| 12 | The Guardian | news | Content API with a commercial key, tag `technology/artificialintelligenceai` | Paid (commercial key) | api | feed only (AI tag RSS 200, 20 items) | with licence |
| 13 | Al Jazeera | news | All-news RSS under an Al Jazeera Content Sales licence | Paid licence | rss | feed only (200, 25 items) | with licence |
| 14 | The Wall Street Journal | news | Dow Jones Factiva feeds/API; or WSJ tech RSS under licence | Paid licence | api / rss | feed only (200, 40 items) | with licence |
| 15 | Associated Press | news | AP Media API | Paid | api | no (Cloudflare 403) | with licence |
| 16 | Reuters | news | Reuters Connect / Reuters News API | Paid | api | no (DataDome 401) | with licence |
| 17 | NBC News | news | Tech RSS under an NBCUniversal permission | Permission | rss | feed only (200, 25 items) | with licence |
| 18 | The Washington Post | news | WP Licensing & Syndication content feed | Paid licence | rss / bulk | feed only (200, 5 items) | with licence |
| 19 | NPR | news | Technology RSS `feeds.npr.org/1019/rss.xml` | None | rss | yes (200, 10 items) | cond. |
| 20 | SpringerLink | academic | Springer Nature Meta API v2 | Free key | api | no (401 without key) | cond. (non-commercial) |
| 21 | arXiv | academic | arXiv API + RSS `cs.AI` | None | api / rss | yes (25 entries; RSS 331 items) | yes |
| 22 | PubMed / PMC | academic | E-utilities esearch/efetch, `"Artificial Intelligence"[MeSH]` | None (free key optional) | api | yes (435 hits / 7 days) | yes |
| 23 | ScienceDirect | academic | Elsevier ScienceDirect Search API v2 | Key + Elsevier approval of use case | api | no (401 without key) | after approval |
| 24 | Google Scholar | academic | Scholar email alerts, read from a dedicated mailbox | Free (mailbox credentials) | api (IMAP) | no | cond. (owner sign-off) |
| 25 | ResearchGate | academic | none | n/a | n/a | no (CAPTCHA 403) | **BLOCKED** |
| 26 | IEEE Xplore | academic | IEEE Xplore Metadata API under an IEEE licence | Key + licence | api | no (403 without key) | after approval |
| 27 | JSTOR | academic | JSTOR Text Analysis Support dataset request | Approval (institutional) | bulk | no | after approval |
| 28 | GovInfo (US GPO) | policy | `POST api.govinfo.gov/search` + collection RSS | Free key (RSS keyless) | api / rss | yes (DEMO_KEY 200; RSS 100 items) | yes |
| 29 | Congress.gov | policy | Congress.gov API v3 `/bill`, `/summaries` | Free key | api | yes (DEMO_KEY 200) | yes |
| 30 | Council on Foreign Relations | policy | `https://www.cfr.org/feed` (site-wide; filter AI locally) | None | rss | yes (200, 24 items) | yes (robots note) |
| 31 | Cato Institute | policy | none reachable | n/a | n/a | no (Incapsula 403) | **BLOCKED** |
| 32 | RAND | policy | `/pubs/commentary.xml`, `/pubs/research_reports.xml`, `/pubs/perspectives.xml`, `/news/press.xml` | None | rss | yes (20 entries each) | yes |
| 33 | Urban Institute | policy | `https://www.urban.org/research/rss.xml` | None | rss | yes (200, 150 items) | yes |
| 34 | Pew Research Center | policy | WP REST `/wp-json/wp/v2/posts?categories=299` (AI category) | None | api | yes (200, 100 posts) | yes |
| 35 | Wikipedia / Wikimedia | nonprofit | EventStreams + DiscussionTools talk-page API for AI articles | None | api | yes | yes |
| 36 | Mozilla | nonprofit | `https://blog.mozilla.org/en/category/ai/feed/` | None | rss | yes (200, 20 items) | yes |
| 37 | Khan Academy | nonprofit | `https://blog.khanacademy.org/feed/` (filter AI) | None | rss | yes (200, 10 items) | yes |
| 38 | Our World in Data | nonprofit | `atom.xml` + `atom-data-insights.xml` (filter AI) | None | rss | yes | yes |
| 39 | OpenStreetMap | nonprofit | Diary RSS + community forum Discourse search JSON | None | rss / api | yes | yes |
| 40 | Internet Archive | nonprofit | `advancedsearch.php` (subject AI) + blog feed | None | api / rss | yes (868 items, Aug–Sep) | yes |
| 41 | GitHub | developer | REST search (topic, issues) + GitHub blog AI feed | None (token advised) | api / rss | yes | yes |
| 42 | GitLab | developer | REST `/projects?topic=`, `/issues` + forum Discourse | Free token | api | yes (projects 200) | yes |
| 43 | Stack Overflow | **forums** | Stack Exchange API 2.3, `tagged=artificial-intelligence`, sites `stackoverflow` + `ai` | Free key | api | yes (200, 30 each) | yes (AUP note) |
| 44 | Docker Hub | developer | Hub API `/v2/namespaces/ai/repositories` + docker.com feed + forum | None | api / rss | yes | yes |
| 45 | Hacker News | **forums** | HN Firebase API + Algolia HN Search | None | api | yes | yes |
| 46 | Hugging Face | developer | `/api/daily_papers`, `/api/models`, blog feed, forum Discourse | None (token optional) | api / rss | yes | yes |
| 47 | TLDR | blog | `https://tldr.tech/api/rss/ai` | None | rss | yes (200, 20 items) | yes |
| 48 | Substack (platform) | blog | Substack-hosted per-publication `/feed` for a named list of AI publications | None | rss | yes (via One Useful Thing) | yes (see note) |
| 49 | Ars Technica | blog | `https://arstechnica.com/ai/feed/` under Condé Nast permission | Permission | rss | feed only (200, 20 items) | with licence |
| 50 | One Useful Thing | blog | `https://www.oneusefulthing.org/feed` | None | rss | yes (200, 20 items) | yes |
| 51 | Platformer | blog | `https://www.platformer.news/rss/` | None | rss | yes (200, 15 items) | yes |

Category counts after the move: social 8, news 11, academic 8, policy 7, nonprofit 6, developer 4, forums 2, blog 5 (51 in total).

---

## 2. Rules that apply to every source

- **Identity:** never request or store user profile fields: author, username, `user.location`, GitHub/GitLab profile location, Stack Exchange `/users`, HN `/user`, or Wikipedia editor names or IPs. The pipeline strips identities, and the collectors should not fetch them in the first place.
- **Location:** at most city level, and only from a content-level field. Examples:
  - PubMed first-author affiliation country;
  - X `place` (rare);
  - the YouTube channel's `snippet.country`;
  - TikTok `region_code` (country);
  - OSM diary geo-tags, rounded to city level;
  - Congress sponsor state;
  - Pew `regions-countries` taxonomy.
  Never geolocate IPs.
- **User-Agent:** send a descriptive User-Agent with a contact URL; Wikimedia requires one. The audit User-Agent above is the model.
- **Attribution:** keep the source link and licence field for Stack Exchange (CC BY-SA), Wikipedia (CC BY-SA), OWID (CC BY), Pew (attribution required) and NPR (attribution adjacent to feed content).

---

## 3. Per-source detail

Key: **R** route; **A** auth; **T** limits and terms; **P** what a post is, plus its text, timestamp and region fields; **C** collector; **V** live verification; **Verdict** compliance and confidence.

### Social

**3.1 WhatsApp (Channels)** — approval-gated
- **R:** Meta Content Library (MCL) and its API. MCL covers "WhatsApp Channels" updates in active channels that are verified or have 100+ followers; personal chats are excluded. https://transparency.meta.com/researchtools/meta-content-library (page updated 2026-04-30).
- **A:** apply in Meta Research Tools Manager; the application is reviewed independently by CASD.
  - Eligibility: affiliation with an academic institution or a not-for-profit organization.
  - Cost: none on Meta's Secure Research Environment. A third-party hosting route through SOMAR/ICPSR reportedly charges fees, which I could not confirm (LOW confidence).
  - Env var: none. Queries run inside Meta's environment and only aggregates leave it.
- **T:** the public web routes are not compliant:
  - WhatsApp Terms forbid collecting information about users "in any impermissible or unauthorized manner" (https://www.whatsapp.com/legal/terms-of-service).
  - whatsapp.com robots.txt points to Meta's Automated Data Collection Terms, which require Meta's express written permission (https://www.facebook.com/apps/site_scraping_tos_terms.php).
- **P:** a channel update, with `text` and `creation_time`. There is no location field. Drop admin names.
- **C:** bulk. Aggregates are exported from MCL and loaded; there is no live feed into our DB.
- **V:** not verifiable without approval. For audit only, one WhatsApp channel page returned 200 with 3 previews.
- **Verdict:** compliant after approval. Confidence HIGH on the route; MEDIUM on eligibility, because Jennifer's affiliation decides it.

**3.2 Instagram** — approval-gated
- **R:**
  - Route A: MCL API, which covers Instagram business/creator accounts and verified or 100+ follower personal accounts.
  - Route B: Graph API hashtag search, `GET /ig_hashtag_search` then `/{hashtag-id}/recent_media`. It needs Instagram Public Content Access plus App Review and Business Verification (https://developers.facebook.com/docs/features-reference/instagram-public-content-access). That feature is scoped to brand and business use cases, so a general AI-discourse monitor is a poor fit for App Review.
- **A:**
  - Route A: MCL approval (see 3.1).
  - Route B: `META_APP_ID`, `META_APP_SECRET`, `IG_USER_ID`, `IG_ACCESS_TOKEN`.
- **T:**
  - Instagram Terms forbid collecting information in an automated way without express permission (https://help.instagram.com/581066165581870).
  - Route B limits: 30 unique hashtags per 7 days; `recent_media` returns only the last 24 hours, 50 per page.
- **P:** a post, with `caption`/`text`, `timestamp`/`creation_time` and `lang`. No usable location.
- **C:** bulk (A) or api (B).
- **V:** no (credentials needed).
- **Verdict:** compliant after approval. HIGH for Route A, MEDIUM for Route B.

**3.3 YouTube** — free key
- **R:**
  - `GET https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=artificial+intelligence&order=date&publishedAfter=…`
  - then `videos.list` for full descriptions, and optionally `commentThreads.list`.
  - Docs: https://developers.google.com/youtube/v3/docs/search/list
- **A:** free key, env `YOUTUBE_API_KEY`. Enable the YouTube Data API in Google Cloud and create a key under Credentials: https://console.cloud.google.com/apis/library/youtube.googleapis.com
- **T:**
  - **Quota:** the default allocation is 100 `search.list` calls per day, plus 10,000 units per day for all other endpoints (https://developers.google.com/youtube/v3/determine_quota_cost, confirmed in the fetched page).
  - **Stored data:** must be refreshed or deleted within 30 days.
  - **Derived metrics:** the Developer Policies (https://developers.google.com/youtube/terms/developer-policies) restrict creating new derived metrics from API data. Sentiment aggregates may fall under that, so request written confirmation through the API compliance audit before launch.
  - **The keyless Atom feed `youtube.com/feeds/videos.xml` is NOT a compliant route.** robots.txt disallows it, and the YouTube Terms (https://www.youtube.com/t/terms) allow automated access only for public search engines or with written permission.
- **P:** a video (or a comment), with `snippet.title` + `snippet.description` and `snippet.publishedAt`. Region hint: the channel's `snippet.country`. Drop channel and author names.
- **C:** api. Node library: `googleapis` (official).
- **V:** API no (key needed). The Atom feed returned 200 (15 entries) in an audit-only check and is not to be used.
- **Verdict:** compliant. HIGH on the route, MEDIUM on the derived-metrics clause.

**3.4 Facebook** — approval-gated
- **R:**
  - MCL API (Pages, groups, public profiles; see 3.1).
  - Or Graph API with Page Public Content Access, `/{page-id}/posts`, which requires App Review and Business Verification (https://developers.facebook.com/docs/features-reference/page-public-content-access).
- **A:** MCL approval; or `META_APP_ID`, `META_APP_SECRET`, `FB_ACCESS_TOKEN`.
- **T:**
  - Facebook Terms §3.2 bar automated collection without prior permission (https://www.facebook.com/terms.php).
  - Meta Platform Terms bar surveillance and profiling (https://developers.facebook.com/terms/).
- **P:** a post, with `text`, `creation_time` and `lang`. Region hint: the Page's own `location.city`/`country`, at Page level only.
- **C:** bulk (MCL) or api (Graph).
- **V:** no.
- **Verdict:** compliant after approval. HIGH.

**3.5 TikTok** — approval-gated
- **R:** `POST https://open.tiktokapis.com/v2/research/video/query/` with `keyword`/`hashtag_name`, `region_code` and `create_date` filters (https://developers.tiktok.com/doc/research-api-specs-query-videos/).
- **A:**
  - Program: TikTok Research API, https://developers.tiktok.com/products/research-api/
  - Eligibility: academic or not-for-profit research institutions in the US, EEA, UK, Switzerland or Canada, independent of commercial interests.
  - Decision "within 4 weeks".
  - Env vars: `TIKTOK_RESEARCH_CLIENT_KEY`, `TIKTOK_RESEARCH_CLIENT_SECRET`.
- **T:**
  - Limits: 1,000 requests/day, up to 100,000 records/day; new videos take up to 48 hours to become searchable (https://developers.tiktok.com/doc/research-api-faq/).
  - The Research API terms (https://www.tiktok.com/legal/page/global/terms-of-service-research-api/en) require refreshing data at least every 30 days and forbid outputs linkable to a user.
  - They may also treat aggregated data as confidential outside research outputs, so a live public dashboard needs explicit confirmation in the application.
- **P:** a video, with `video_description` + `voice_to_text`, `create_time` and `region_code` (country). Drop `username`.
- **C:** api (no official Node SDK).
- **V:** no.
- **Verdict:** compliant after approval. HIGH on the route, MEDIUM on public-dashboard use.

**3.6 WeChat / Weixin** — **BLOCKED: no compliant route**
- **Searched:**
  - The Official Account APIs manage only accounts you operate; there is no public read or search API.
  - There is no official RSS.
  - mp.weixin.qq.com article pages and Sogou WeChat search.
- **Clauses:**
  - Weixin Service Agreement §8.2.1.6 bars automated operations through third-party software not developed or authorized by Tencent, and §8.2.1.8 bars other acts not expressly authorized by Tencent (https://weixin.qq.com/agreement?lang=en_US).
  - `mp.weixin.qq.com/robots.txt` disallows `/` apart from a few paths, and article pages are disallowed.
  - `weixin.sogou.com/robots.txt` is `User-agent: *` / `Disallow: /`.
- **V:** both robots.txt files fetched (200). No article page was fetched, because robots.txt disallows them.
- **Verdict:** BLOCKED. Confidence HIGH. No substitute is proposed.

**3.7 Telegram** — **BLOCKED: no compliant route**
- **Searched:** the t.me/s/ public channel previews, the MTProto API (api_id/api_hash from my.telegram.org) and the Bot API.
- **Clauses:**
  - The Content Licensing and AI Scraping Terms (https://telegram.org/tos/content-licensing) prohibit access to user content for any purpose other than ordinary use as a user, except to run a legitimate client, bot or Mini App.
  - The same page firmly prohibits scraping, aggregation, or use of platform data to deploy ML models. Its only exception needs explicit consent from every user, per chat.
  - Telegram API Terms §1.5 (https://core.telegram.org/api/terms) prohibit using, accessing or aggregating platform data to deploy AI or machine-learning models.
  - Our sentiment and embedding pipeline is a deployment of ML models over that data.
- **V:** audit only: `t.me/s/durov` returned 200 (20 messages) and `t.me/s/telegram` returned 200. Not a route.
- **Verdict:** BLOCKED. Confidence HIGH on the text of the terms, MEDIUM on applying "deployment" to non-training analytics. No substitute is proposed.

**3.8 X (Twitter)** — paid
- **R:** `GET https://api.x.com/2/tweets/search/recent?query=(AI OR "artificial intelligence") -is:retweet lang:en` (https://docs.x.com/x-api/posts/search/introduction).
- **A:**
  - Pay-per-use credits, from https://developer.x.com
  - Price: $0.005 per post read, up to 3M reads/month; about $150/month at 1,000 posts/day (https://docs.x.com/x-api/getting-started/pricing).
  - Env var `X_BEARER_TOKEN`. `.env.example` currently says `TWITTER_BEARER_TOKEN`, "$100/mo Basic"; both the name and the price are stale.
- **T:**
  - Developer Agreement (https://docs.x.com/developer-terms/agreement): honour deletion requests within 24 hours, store location only together with the post, no redistribution.
  - The X Terms prohibit scraping outside the API (https://x.com/en/tos).
- **P:** a post, with `text` and `created_at`. Region: `place.full_name`/`country_code` when present. Drop `author_id`.
- **C:** api (`twitter-api-v2` is a community library).
- **V:** no.
- **Verdict:** compliant once paid. HIGH.

### News

All the news-outlet clauses below were read from each outlet's own terms page on 2026-09-28, and the saved copies are in the scratchpad. The recurring issue is that our pipeline is automated aggregation plus computer analysis (sentiment, embeddings).

**3.9 BBC News** — permission-gated
- **R:** `https://feeds.bbci.co.uk/news/technology/rss.xml`, under a BBC permission.
- **T:** BBC Terms of Use (https://www.bbc.co.uk/usingthebbc/terms-of-use):
  - §8a lists "anything plucked from our services ... to do computer analysis" as needing permission.
  - §15a: you are not allowed to pluck metadata from BBC content or RSS feeds.
  - §15b: business use of RSS needs permission and may carry a fee.
- **A:** permission through the metadata/permissions route linked from §15. No published timeline. Proposed env `BBC_LICENSE_REF`.
- **P:** an article, with `title` + `description` and `pubDate`. No location field; the section is UK and world.
- **C:** rss (`rss-parser`).
- **V:** 200, 21 items, newest 2026-09-29.
- **Verdict:** compliant with permission. HIGH.

**3.10 The New York Times** — paid licence
- **R:**
  - Article Search API, `https://api.nytimes.com/svc/search/v2/articlesearch.json?fq=timesTag.subject:"Artificial Intelligence"`.
  - Or `https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml`. There is no AI-specific feed; `ArtificialIntelligence.xml` returns 404.
- **A:**
  - A free key at https://developer.nytimes.com (`NYT_API_KEY`; 500 requests/day, 5/minute) gives technical access only.
  - Our use needs an NYT Licensing text-and-data-mining licence: https://nytlicensing.com/data-solutions/ (no published price or timeline). Env `NYT_LICENSE_REF`.
- **T:**
  - The NYT Terms of Service §4.1 (https://help.nytimes.com/hc/en-us/articles/115014893428-Terms-of-Service) ban using content in connection with the development or operation of an ML or AI system, and ban automated collection without consent.
  - The API terms (https://developer.nytimes.com/terms) incorporate them.
- **P:** an article, with `headline.main` + `abstract`, `pub_date`, and a region hint from the `glocations` keywords or the dateline. The Times Wire API is no longer listed.
- **C:** api or rss.
- **V:** RSS 200, 30 items, newest 2026-09-29.
- **Verdict:** compliant with licence. HIGH.

**3.11 CNN** — paid licence
- **R:** there is no current public feed.
  - `cnn.com/services/rss/` now redirects to the homepage.
  - `rss.cnn.com/rss/cnn_tech.rss` returns 200 but its newest item is from 2017; `edition_technology.rss` is from 2016.
  - The official text route is the **CNN Wire Store** / CNN International Syndication (https://www.cnn.com/intlsyndication/; https://commercial.cnn.com/our-solutions/).
- **A:** commercial licence, env `CNN_LICENSE_REF`. The delivery credentials depend on the contract.
- **T:** CNN Terms (https://www.cnn.com/terms) limit downloads to personal use; copying or redistribution needs express permission.
- **P:** a wire article (text, timestamp, dateline city).
- **C:** api or bulk, depending on the contract.
- **V:** no. The public feeds are stale.
- **Verdict:** compliant with licence. MEDIUM, because the wire delivery format is unverified.

**3.12 The Guardian** — paid (commercial key)
- **R:**
  - `https://content.guardianapis.com/search?tag=technology/artificialintelligenceai&show-fields=trailText,bodyText`
  - The RSS twin is `https://www.theguardian.com/technology/artificialintelligenceai/rss`.
- **A:**
  - The Guardian's own access page names "sentiment analysis where content is not reproduced" as a commercial-key use case (https://open-platform.theguardian.com/access/).
  - Register at https://bonobo.capi.gutools.co.uk/register/commercial. Env `GUARDIAN_API_KEY`. Price "dependent on usage".
- **T:**
  - The free developer key (1 call/s, 500 calls/day) is ruled out: Open Platform terms §6 ban text and data "aggregation, analysis or mining ... (including to generate any patterns, trends or correlations)" and ML/AI use (https://www.theguardian.com/open-platform/terms-and-conditions).
  - §5 requires deleting content within 24 hours.
  - The site terms apply the same rule to RSS (https://www.theguardian.com/help/terms-of-service).
- **P:** an article, with `webTitle` + `trailText`, `webPublicationDate`, and a region hint from the section or tags.
- **C:** api.
- **V:** AI tag RSS returned 200, 20 items, newest 2026-09-29. The Content API with `api-key=test` returned 401.
- **Verdict:** compliant with the commercial key. HIGH.

**3.13 Al Jazeera** — paid licence
- **R:** `https://www.aljazeera.com/xml/rss/all.xml`, the only feed; the tech and AI feed URLs return 404. Filter for AI locally, under a licence from **Al Jazeera Content Sales** (https://contentsales.aljazeera.net/).
- **A:** licence, env `ALJAZEERA_LICENSE_REF`. Content Sales mainly markets video; text-feed licensing is unconfirmed.
- **T:** Terms §6 (https://www.aljazeera.com/terms-and-conditions) ban automated processes that analyse content "for the purpose of identifying trends, correlations or patterns".
- **P:** an article, with `title` + `description` and `pubDate`. No location field.
- **C:** rss.
- **V:** 200, 25 items, newest 2026-09-29.
- **Verdict:** compliant with licence. MEDIUM, because the text-licence scope is unconfirmed.

**3.14 The Wall Street Journal** — paid licence
- **R:**
  - `https://feeds.content.dowjones.io/public/rss/RSSWSJD` (Technology; live).
  - The old `feeds.a.dj.com/rss/RSSWSJD.xml` is stale (newest Jan 2025).
  - The licensed route is Dow Jones Factiva feeds/API (https://www.dowjones.com/, contact sales).
- **A:** licence, env `DOWJONES_API_KEY` (or per the contract).
- **T:** Dow Jones terms (https://www.dowjones.com/terms-of-use/, effective 2026-06-30):
  - §9.1: no commercial use of content, RSS included, without consent;
  - §9.3: no text or data mining;
  - §9.4.2: no ingesting content for any form of AI without permission.
- **P:** a headline + summary, with `pubDate`.
- **C:** rss or api.
- **V:** 200, 40 items, newest 2026-09-29.
- **Verdict:** compliant with licence. HIGH.

**3.15 Associated Press** — paid
- **R:** AP Media API (https://developer.ap.org). AP publishes no public RSS.
- **A:** sales contract, env `AP_API_KEY`. No published price.
- **T:** `apnews.com` and its terms page return a Cloudflare challenge (403), which I did not bypass. The licensed API is the only official route.
- **P:** a story, with headline, body or abstract, `firstcreated`, and a dateline city.
- **C:** api.
- **V:** no (API needs a key; the site returns 403).
- **Verdict:** compliant with licence. HIGH on the route; the terms clause is unread because it sits behind the wall.

**3.16 Reuters** — paid
- **R:** Reuters Connect / Reuters News API (https://www.reutersagency.com; reutersconnect.com). Public RSS is gone: `feeds.reuters.com` no longer resolves, so the seed row `reuters_technology` is dead.
- **A:** enterprise contract (OAuth), env `REUTERS_CONNECT_CLIENT_ID` and `REUTERS_CONNECT_CLIENT_SECRET`.
- **T:** reuters.com returns a DataDome challenge (401), which I did not bypass. The Reuters Agency terms page (https://www.reutersagency.com/en/terms-of-use/) was saved.
- **P:** a story, with headline, body, timestamp and dateline.
- **C:** api.
- **V:** no.
- **Verdict:** compliant with licence. HIGH.

**3.17 NBC News** — permission-gated
- **R:** `https://feeds.nbcnews.com/nbcnews/public/tech`, under an NBCUniversal permission.
- **T:**
  - The RSS terms (https://www.nbcnews.com/id/wbna5216556) provide feeds "for use by individuals for personal, non-commercial uses", with "NBCNews.com" attribution.
  - The site terms (https://www.nbcnews.com/id/wbna3303540) ban data-gathering tools that "monitor, scrape or aggregate Content".
- **A:** NBCUniversal permission; no published program. Env `NBC_LICENSE_REF`.
- **P:** an article, with `title` + `description` and `pubDate`.
- **C:** rss.
- **V:** 200, 25 items, newest 2026-09-28.
- **Verdict:** compliant with permission. MEDIUM-HIGH.

**3.18 The Washington Post** — paid licence
- **R:** WP Licensing & Syndication content feeds (https://www.washingtonpost.com/licensing-syndication/; syndication@washpost.com). The public `feeds.washingtonpost.com/rss/business/technology` is live.
- **A:** licence, env `WAPO_LICENSE_REF`.
- **T:** the Terms of Service (https://www.washingtonpost.com/terms-of-service/) ban automated harvesting other than search indexing, and ban use with ML/AI tools. The page returns 403 to curl, so the clause comes from indexed text (MEDIUM).
- **P:** an article, with `title` + `description` and `pubDate`.
- **C:** rss or bulk.
- **V:** public feed 200, 5 items, newest 2026-09-29.
- **Verdict:** compliant with licence. MEDIUM.

**3.19 NPR** — no auth, conditional
- **R:** `https://feeds.npr.org/1019/rss.xml` (Technology).
- **A:** none. NPR's API is closed to new registrations.
- **T:** NPR Terms of Use (https://www.npr.org/about-npr/179876898/terms-of-use):
  - You may display and excerpt Content Feeds on "your personal site or application", or on a non-news 501(c)(3) site.
  - Attribution "NPR" must sit adjacent to the feed content, and the whole feed must not be redistributed.
  - No building or training of ML/AI systems.
- **P:** a story, with `title` + `description` and `pubDate`.
- **C:** rss.
- **V:** 200, 10 items, newest 2026-09-28.
- **Verdict:** compliant **if** pulse-of-ai runs as Jennifer's personal, non-commercial site, shows NPR attribution next to NPR-derived items, and never trains models on the text. Running a pre-trained sentiment model is not training. MEDIUM.

### Academic

**3.20 SpringerLink (Springer Nature)** — free key, conditional
- **R:** `https://api.springernature.com/meta/v2/json?q=keyword:"artificial intelligence" sort:date&api_key=…`, plus the Open Access API for OA full text.
- **A:** free key from https://dev.springernature.com, env `SPRINGER_API_KEY`.
- **T:**
  - The Springer Nature TDM page (https://www.springernature.com/gp/researchers/text-and-data-mining) says the metadata and OA APIs are free, with 150 requests/minute for API users. The TDM API for commercial use is fee-based.
  - The API terms (https://dev.springernature.com/terms-conditions/) allow TDM output to be made available to third parties "for noncommercial use only".
- **P:** a record, with `title` + `abstract`, `publicationDate`, and affiliation country when present.
- **C:** api.
- **V:** 401 without a key, as expected.
- **Verdict:** compliant for a non-commercial dashboard. MEDIUM; the portal's limits page renders only with JavaScript.

**3.21 arXiv** — no auth
- **R:**
  - `http://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.LG+OR+cat:cs.CL&sortBy=submittedDate&sortOrder=descending&max_results=100`
  - `https://rss.arxiv.org/rss/cs.AI`
- **T:** API Terms of Use (https://info.arxiv.org/help/api/tou.html): at most one request every three seconds, on a single connection. Metadata is CC0. Do not serve PDFs.
- **P:** a paper, with title + abstract and `published`. No location.
- **C:** api or rss (`rss-parser` handles Atom).
- **V:** API 200, 25 entries; RSS 200, 331 items.
- **Verdict:** yes. HIGH.
- **Note:** the seed types this source as `api`, while the scheduler expects `arxiv` (prior analysis §4).

**3.22 PubMed / PMC (NCBI)** — no auth (key optional)
- **R:**
  - `esearch.fcgi?db=pubmed&term="Artificial Intelligence"[MeSH]&reldate=1&datetype=edat&usehistory=y`
  - then `efetch.fcgi?db=pubmed&retmode=xml`, in batches of 200 or fewer.
- **A:** optional free key, from NCBI account Settings (https://www.ncbi.nlm.nih.gov/account/settings/). Env vars `NCBI_API_KEY`, `NCBI_TOOL=pulse-of-ai`, `NCBI_EMAIL`.
- **T:**
  - 3 requests/s without a key, 10/s with one. Register `tool` and `email` (NLM support KA-05317: https://support.nlm.nih.gov/kbArticle/?pn=KA-05317).
  - NCBI's own policy page (NBK25497) serves a reCAPTCHA to automated fetches and was not bypassed.
- **P:** an article, with `ArticleTitle` + `AbstractText` and `PubDate`/EDAT. Region: country parsed from the first-author affiliation, with emails stripped from that string.
- **C:** api.
- **V:** esearch 200, 435 hits in the last 7 days; efetch 200.
- **Verdict:** yes. HIGH.

**3.23 ScienceDirect (Elsevier)** — approval-gated
- **R:** ScienceDirect Search API v2, `https://api.elsevier.com/content/search/sciencedirect` (PUT query "artificial intelligence").
- **A:**
  - Key from https://dev.elsevier.com (`ELSEVIER_API_KEY`).
  - Our use is outside the listed use cases, so Elsevier must approve it through the developer portal contact. No timeline.
  - Limits: 20,000 requests/week at 2 requests/s (https://dev.elsevier.com/api_key_settings.html).
- **T:** the Elsevier API use policies (https://dev.elsevier.com/policy.html) permit only the listed use cases. Text mining is for researchers at subscribing academic institutions, non-commercial. A public dashboard is not listed.
- **P:** an article, with title + description and `coverDate`.
- **C:** api.
- **V:** 401 without a key.
- **Verdict:** compliant after approval. MEDIUM.

**3.24 Google Scholar** — free (mailbox credentials), conditional
- **R:**
  - Scholar has no API. The official automated-delivery feature is **Scholar email alerts**.
  - Scholar's help page (https://scholar.google.com/intl/en/scholar/help.html) describes creating an alert from a search, after which Scholar emails newly added papers that match. It does this several times a week.
  - Set up alerts for AI queries (for example "artificial intelligence", "large language model") that deliver to a dedicated mailbox, and read that mailbox over IMAP.
- **A:** env `SCHOLAR_ALERTS_IMAP_HOST`, `SCHOLAR_ALERTS_IMAP_USER`, `SCHOLAR_ALERTS_IMAP_PASSWORD`. Use an app password on a dedicated account; Jennifer creates it and enters the credential.
- **T:**
  - Scholar's `robots.txt` disallows `/scholar` and `/search` (fetched, 200).
  - The Scholar help page says to respect robots.txt when using automated software.
  - Google's Terms (https://policies.google.com/terms) bar automated access to content that violates robots.txt.
  - The alert route never requests a Scholar page, so neither clause applies. I found no clause that forbids processing alert emails you receive.
  - The collector must not follow the `scholar_url` links in the emails.
- **P:** an alert entry, with paper title + snippet + venue and the email's `Date`. No location.
- **C:** api (IMAP). New dependencies would be needed (e.g. `imapflow`, `mailparser`); none is in the repo today.
- **V:** no (the mailbox does not exist yet).
- **Verdict:** compliant in my reading. **MEDIUM-LOW; Jennifer should sign off.** It is the only official route to Scholar content, and nothing in Google's terms addresses it directly either way.

**3.25 ResearchGate** — **BLOCKED: no compliant route**
- **Searched:**
  - There is no public API and no RSS or Atom feed.
  - `researchgate.net/robots.txt` (200) allows `/` with some disallows.
  - Every content page tested, including `/topic/Artificial-Intelligence`, and the terms page itself return **403 with a CAPTCHA page** ("Temporarily Unavailable") to a non-browser client.
- **Clause:** the terms page (https://www.researchgate.net/terms-of-service) sits behind the same CAPTCHA wall. WebFetch also received 403, so I could not quote its automated-access clause: **not verified**. Collecting would mean getting past a CAPTCHA, which the rules forbid.
- **Verdict:** BLOCKED. HIGH on the facts, and the clause is unread. No substitute is proposed. The remedy would be to ask ResearchGate directly for data access; I found no published program.

**3.26 IEEE Xplore** — approval-gated
- **R:** `https://ieeexploreapi.ieee.org/api/v1/search/articles?querytext=artificial intelligence&sort_field=publication_date&sort_order=desc&apikey=…`
- **A:** a key from https://developer.ieee.org (`IEEE_API_KEY`), plus IEEE's alternative licensing for our use (https://developer.ieee.org/contact). No timeline.
- **T:** API Terms of Use (https://developer.ieee.org/API_Terms_of_Use2):
  - The licence is for non-commercial activities "within the Licensee's educational institution".
  - Content may be presented only in response to an individual query, not in bulk (§4a).
  - Using content to train or develop AI/ML systems is prohibited.
  - Rate limits are set at registration.
  - TDM requires an institutional subscription (https://developer.ieee.org/Allowed_API_Uses).
- **P:** an article, with title + abstract, `publication_date`, and affiliation.
- **C:** api.
- **V:** 403 without a key.
- **Verdict:** compliant after approval. MEDIUM-HIGH.

**3.27 JSTOR** — approval-gated
- **R:** **JSTOR Text Analysis Support** dataset requests (https://www.jstor.org/ta-support). This replaced Constellate, which shut down on 2025-07-01; the Data for Research datasets continue through this route.
- **A:** request per JSTOR; reported to require an institutional authorized user. The page renders only with JavaScript, so eligibility is MEDIUM confidence. Env `JSTOR_DATASET_PATH` for the delivered file. No published timeline.
- **T:** JSTOR Terms (https://about.jstor.org/terms/, updated 2026-04-24) ban any activity that automatically downloads or exports content, including web scraping. The journal RSS URL tested returned 404.
- **P:** a dataset record (metadata, n-grams or full text, per the grant), with title/abstract and publication date.
- **C:** bulk.
- **V:** no.
- **Verdict:** compliant after approval. MEDIUM.

### Policy

**3.28 GovInfo (US GPO)** — free key
- **R:**
  - API: `POST https://api.govinfo.gov/search?api_key=…` with the body `{"query":"collection:(BILLS OR CREC OR FR OR CHRG OR CRPT) AND title:(\"artificial intelligence\")","pageSize":100,"offsetMark":"*","sorts":[{"field":"publishdate","sortOrder":"DESC"}]}`.
  - Keyless RSS: `https://www.govinfo.gov/rss/{bills,fr,crec,chrg,crpt}.xml` (list at https://www.govinfo.gov/feeds).
- **A:** free api.data.gov key from https://api.data.gov/signup/, env `GOVINFO_API_KEY`. Issued instantly. DEMO_KEY showed a limit of 10 requests, which is too low for real use.
- **T:** 1,000 requests/hour per key (https://api.data.gov/docs/developer-manual/). Federal works are public domain.
- **P:** a document (bill, Congressional Record granule, Federal Register notice), with `title` + summary and `dateIssued`.
- **C:** api + rss.
- **V:**
  - Search 200: 679 AI-title hits, newest 2026-09-24.
  - `/rss/bills.xml` 200, 100 items, newest 2026-09-28.
  - `/rss/billstatus.xml` returns 0 items; don't use it.
- **Verdict:** yes. HIGH.

**3.29 Congress.gov (Library of Congress)** — free key
- **R:** `https://api.congress.gov/v3/bill?fromDateTime=…&sort=updateDate+desc&limit=250`, then `/bill/{congress}/{type}/{n}/summaries` and `/subjects`; also `/v3/summaries?fromDateTime=…`.
  - **There is no keyword search**: a `query=` parameter is silently ignored.
  - Filter titles and summaries for AI locally, or seed candidate bill IDs from the GovInfo search.
- **A:** free key from https://api.congress.gov/sign-up/, env `CONGRESS_API_KEY`.
- **T:** 5,000 requests/hour (https://github.com/LibraryOfCongress/api.congress.gov). Public domain.
- **P:** a bill summary, with `text` and `actionDate`/`updateDate`. Region: sponsor state.
- **C:** api.
- **V:** `/bill` with DEMO_KEY returned 200 (5 bills).
- **Verdict:** yes. HIGH.

**3.30 Council on Foreign Relations** — no auth
- **R:** `https://www.cfr.org/feed` (site-wide; `?page=2` also works). `/rss.xml` and the topic feeds return 404, and there is no AI feed, so filter locally.
- **T:**
  - I could not locate a terms page: `/terms-of-use` and `/legal-notices` return 404.
  - `robots.txt` has `Disallow: /feed/` (with a trailing slash). The feed lives at `/feed` (no slash), which that rule does not match by path. The intent is ambiguous, so Jennifer may want to confirm with CFR.
- **P:** an item, with title + description and `pubDate`.
- **C:** rss.
- **V:** 200, 24 items, newest 2026-09-28.
- **Verdict:** yes. MEDIUM.

**3.31 Cato Institute** — **BLOCKED: no compliant route**
- **Searched:**
  - `https://www.cato.org/`, `/rss/recent-opeds`, `/rss`, `/rss/blog`, `/rss/topics/technology-privacy`, `/robots.txt`, `/sitemap.xml` and `/terms-use` all return an **Incapsula 403** to the audit User-Agent. The research agent saw the same with other clients.
  - The FeedBurner mirrors (`feeds.feedburner.com/Cato-at-liberty`, `/CatoRecentOpeds`) redirect into the same wall.
  - WebFetch (a different network) also received 403.
- **Clause:** Cato's terms page is itself behind the wall, so no clause could be read. Collecting would mean getting past bot detection, which the rules forbid.
- **Verdict:** BLOCKED. HIGH on the facts. No substitute is proposed. The remedy is to ask Cato to allowlist a named collector User-Agent; the contact route is not verified.

**3.32 RAND** — no auth
- **R:** `https://www.rand.org/pubs/commentary.xml`, `/pubs/research_reports.xml`, `/pubs/perspectives.xml` and `/news/press.xml`, with AI filtered locally.
  - **The seed's `/topics/artificial-intelligence.xml` returns 200 with zero entries**, and every topic feed tested is empty.
  - `/pubs.xml` and `/news.xml` return a CloudFront 403 to non-browser clients; don't use them.
  - `/pubs/articles.xml` is stale (newest 2026-07-24).
- **T:** the terms page (`/about/terms.html`) returns 403 to automated fetches, so it is unread.
- **P:** an Atom entry, with `title` + `summary` and `published`.
- **C:** rss.
- **V:** each of the four feeds returned 200 with 20 entries; newest 2026-09-22 (commentary), 09-18, 09-24 and 09-09.
- **Verdict:** yes. MEDIUM.

**3.33 Urban Institute** — no auth
- **R:** `https://www.urban.org/research/rss.xml` (site-wide; topic parameters are ignored). Filter AI locally; the current feed has 36 AI mentions.
- **T:** I could not locate a terms page (`/terms-use` returns 404). robots.txt does not block the feed.
- **P:** an item, with title + description and `pubDate`. Drop `dc:creator`.
- **C:** rss.
- **V:** 200, 150 items, newest 2026-09-28.
- **Verdict:** yes. MEDIUM-HIGH.

**3.34 Pew Research Center** — no auth
- **R:** `https://www.pewresearch.org/wp-json/wp/v2/posts?categories=299&per_page=100&_fields=id,date_gmt,link,title,excerpt,regions-countries`. Category 299 is "Artificial Intelligence" (204 posts). The RSS topic URLs redirect to the site-wide feed, so they cannot filter.
- **T:**
  - The Pew terms (https://www.pewresearch.org/about/terms-and-conditions/, updated 2018-05-25) license content obtained through "widgets, RSS feeds, APIs or other similar means", with attribution.
  - They ban unauthorized scraping, and republishing content in principal part.
  - robots.txt does not disallow `/wp-json`.
- **P:** a post, with `title` + `excerpt` and `date_gmt`. Region: `regions-countries` taxonomy.
- **C:** api.
- **V:** 200, 100 posts, newest 2026-09-17.
- **Verdict:** yes. HIGH.

### Non-profit

**3.35 Wikipedia / Wikimedia** — no auth
- **R:**
  - Build the AI article set from `action=query&list=categorymembers&cmtitle=Category:Artificial_intelligence`.
  - Collect talk-page comments with `https://en.wikipedia.org/w/api.php?action=discussiontoolspageinfo&page=Talk:<Title>&prop=threaditemshtml&format=json&formatversion=2`.
  - Trigger on `https://stream.wikimedia.org/v2/stream/recentchange` (SSE) filtered to that set.
  - Optionally add attention data from the Pageviews API.
- **T:**
  - 200 requests/minute for unauthenticated bots with a compliant User-Agent, 10/minute without one; at most 3 concurrent requests; honour `Retry-After` (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits).
  - The User-Agent must include contact information (https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy). Content is CC BY-SA.
- **P:** **a talk-page comment**, which is the discourse unit. It has `html` and `timestamp`. Drop `author` and strip signatures and `[[User:…]]` links. Edit summaries are secondary and contain usernames. No location, and never geolocate IP editors.
- **C:** api (+ SSE).
- **V:**
  - The stream returned 200 (332 events in 8 seconds).
  - `Talk:Artificial_intelligence`: 33 comments, newest 2026-09-29.
  - History 200; pageviews 200.
- **Verdict:** yes. HIGH.

**3.36 Mozilla** — no auth
- **R:** `https://blog.mozilla.org/en/category/ai/feed/`; the tag feed is `/en/tag/ai/feed/`.
  - **The seed's `foundation.mozilla.org/en/blog/rss/` is stale**; its newest item is 2025-02-20.
  - The workbook row measures Firefox users; the Mozilla blog is Mozilla's own official channel for Firefox and Mozilla news.
- **T:** terms not read. This is Mozilla's own published feed.
- **P:** an item, with title + description and `pubDate`.
- **C:** rss.
- **V:** 200, 20 items, newest 2026-09-17.
- **Verdict:** yes. MEDIUM-HIGH.

**3.37 Khan Academy** — no auth
- **R:** `https://blog.khanacademy.org/feed/`, with AI filtered locally. The AI category feed returns 404, and the AI tag feed holds 1 item from 2023.
- **T:** the ToS page renders client-side, and no automated-access clause appeared in the server text.
- **P:** an item, with title + description and `pubDate`.
- **C:** rss.
- **V:** 200, 10 items, newest 2026-09-21.
- **Verdict:** yes. MEDIUM.

**3.38 Our World in Data** — no auth
- **R:** `https://ourworldindata.org/atom.xml` and `https://ourworldindata.org/atom-data-insights.xml`, with AI filtered locally. OWID also documents CSV/JSON data URLs for "automated workflows" (https://ourworldindata.org/faqs).
- **T:** content is CC BY.
- **P:** an entry, with `title` + `summary` and `published`.
- **C:** rss.
- **V:** 200, 10 and 20 entries; newest 2026-09-21 and 2026-09-29.
- **Verdict:** yes. HIGH.

**3.39 OpenStreetMap** — no auth
- **R:**
  - `https://www.openstreetmap.org/diary/rss` (diaries, which carry geo tags).
  - `https://community.openstreetmap.org/search.json?q=artificial%20intelligence%20order:latest` and `/tag/ai.json` (Discourse).
  - `https://blog.openstreetmap.org/feed/`
- **T:** Discourse JSON includes usernames and avatars, which must be dropped.
- **P:** a diary entry or forum post, with text and date. Region: diary `geo:lat`/`geo:long`, rounded to city level.
- **C:** rss + api.
- **V:** diary 200, 20 items, newest 2026-09-28; forum search 200, 48 posts; blog 200.
- **Verdict:** yes. HIGH.

**3.40 Internet Archive** — no auth
- **R:**
  - `https://archive.org/advancedsearch.php?q=subject:("artificial intelligence") AND publicdate:[<from> TO <to>]&fl[]=identifier,title,description,publicdate&sort[]=publicdate desc&output=json`
  - `https://blog.archive.org/feed/`
- **T:** the documented public search API; the terms page (https://archive.org/about/terms.php) returned 200 with no automated-access clause in its server text.
- **P:** an item's metadata, with title + description and `publicdate`. Drop `uploader`.
- **C:** api + rss.
- **V:** search 200 (868 items for Aug–Sep 2026, newest 2026-09-29); blog 200.
- **Verdict:** yes. MEDIUM-HIGH.

### Developer

**3.41 GitHub** — no auth (token advised)
- **R:**
  - `https://api.github.com/search/repositories?q=topic:artificial-intelligence&sort=updated`
  - `/search/issues?q=AI+in:title+type:issue+created:>DATE&sort=created`
  - `https://github.blog/ai-and-ml/feed/`
  - Discussions need GraphQL plus a token.
- **A:** optional `GITHUB_TOKEN` (fine-grained, no scopes), from https://github.com/settings/tokens. Search is 10 requests/minute without it, 30 with it (https://docs.github.com/en/rest/search/search).
- **T:** GitHub Terms §H (https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) and the Acceptable Use Policies (https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies) allow research use of public data only if any resulting publications are open access. Our dashboard output is public. No excessive API use.
- **P:** an issue (title + body, `created_at`) or a repo (description, `pushed_at`). Never `user.location`.
- **C:** api + rss. Node library `@octokit/rest`.
- **V:** repo search 200 (49,990 total); issue search 200; AI blog feed 200 (10 items, newest 2026-09-25).
- **Verdict:** yes. HIGH.

**3.42 GitLab** — free token
- **R:** `https://gitlab.com/api/v4/projects?topic=artificial-intelligence&order_by=last_activity_at`, `/api/v4/issues?scope=all&search=…`, and `https://forum.gitlab.com/latest.json`.
- **A:** `GITLAB_TOKEN` (read_api), from https://gitlab.com/-/user_settings/personal_access_tokens. The global `/search` returns 401 without a token.
- **T:**
  - Unauthenticated requests are limited to 60/hour; authenticated requests to 5,000/hour (https://docs.gitlab.com/user/gitlab_com/rate_limits/).
  - The website terms ban scraping and data mining of the website. The API is the sanctioned route.
- **P:** an issue or project description, or a forum topic.
- **C:** api. Node library `@gitbeaker/rest`.
- **V:** projects 200 (20 results, newest 2026-09-28); forum 200 (30 topics).
- **Verdict:** yes. HIGH.

**3.44 Docker Hub** — no auth
- **R:**
  - `https://hub.docker.com/v2/namespaces/ai/repositories?ordering=last_updated&page_size=100` (documented at https://docs.docker.com/reference/api/hub/latest/).
  - `https://www.docker.com/feed/`, filtered for AI; the AI category feed is empty.
  - `https://forums.docker.com/latest.json`
  - Don't use `/v2/search/repositories`: it works but is undocumented.
- **T:** the Docker Terms (https://www.docker.com/legal/docker-terms-service/, effective 2026-08-26) allow automated access only through documented APIs and within published limits.
- **P:** a repo description or update, a blog post, or a forum topic.
- **C:** api + rss.
- **V:** namespace 200 (110 repositories, newest 2026-09-29); feed 200 (10 items); forum 200 (30 topics).
- **Verdict:** yes. MEDIUM-HIGH.

**3.46 Hugging Face** — no auth (token optional)
- **R:** `https://huggingface.co/api/daily_papers` (in the OpenAPI spec at https://huggingface.co/.well-known/openapi.json), `/api/models?sort=lastModified&filter=text-generation`, `https://huggingface.co/blog/feed.xml` and `https://discuss.huggingface.co/latest.json`. Don't use the undocumented `/api/posts` list.
- **A:** optional `HF_TOKEN`, from https://huggingface.co/settings/tokens. Anonymous use allows 500 requests per 5 minutes (https://huggingface.co/docs/hub/rate-limits).
- **T:** the ToS has no scraping clause; the forum's robots.txt disallows only `/search`.
- **P:** a daily paper (title + summary), a blog item, a forum topic, or model metadata.
- **C:** api + rss. Node library `@huggingface/hub`.
- **V:** daily_papers 200 (50); models 200; blog 200 (869 items, newest 2026-09-28); forum 200.
- **Verdict:** yes. HIGH.

### Forums (moved from Developer per Rev. 3)

**3.43 Stack Overflow** — free key
- **R:** `https://api.stackexchange.com/2.3/questions?order=desc&sort=creation&tagged=artificial-intelligence&site=stackoverflow&filter=withbody`, plus `site=ai` (Artificial Intelligence Stack Exchange). Consider the tags `large-language-model` and `openai-api`.
- **A:** `STACKEXCHANGE_KEY`, from https://stackapps.com/apps/oauth/register. Without a key the quota is 300/day, which polling two sites exhausts; with a key it is 10,000/day.
- **T:**
  - Honour `backoff`; more than 30 requests/s gets an IP banned (https://api.stackexchange.com/docs/throttle).
  - The API ToU (https://stackexchange.com/legal/api-terms-of-use) requires visibly naming Stack Exchange as the source. Content is CC BY-SA.
  - The AUP (https://stackoverflow.com/legal/acceptable-use-policy) bans automated gathering to train or test generative AI or to build a competing service. Aggregate sentiment is neither, but it passes text through ML models, so there is residual risk.
- **P:** a question, with title + body and `creation_date`. Don't call `/users`.
- **C:** api.
- **V:** both sites 200 with 30 questions each; newest 2026-09-27 (SO tag) and 2026-09-29 (ai site).
- **Verdict:** yes. MEDIUM, pending Jennifer's read of the AUP.

**3.45 Hacker News** — no auth
- **R:**
  - The official Firebase API, `https://hacker-news.firebaseio.com/v0/newstories.json` then `/v0/item/{id}.json` (https://github.com/HackerNews/API).
  - Keyword filtering through `https://hn.algolia.com/api/v1/search_by_date?query=AI&tags=story&hitsPerPage=50`.
- **T:** the Firebase API documents no rate limit. Algolia's limit of about 10,000 requests/hour per IP comes from secondary sources, because the Algolia docs page renders only with JavaScript. HN's legal page returns 404, and I found no restricting clause.
- **P:** a story, with title + `url`/`story_text` and `created_at_i`. Don't call `/user`.
- **C:** api.
- **V:** Algolia 200 (817,794 hits, newest 2026-09-29); Firebase 200 (500 IDs).
- **Verdict:** yes. HIGH.

### Blogs and newsletters

**3.47 TLDR** — no auth
- **R:** `https://tldr.tech/api/rss/ai` (TLDR AI). Ignore one placeholder item dated 2018.
- **T:** the terms page (https://tldr.tech/terms) returned 200 with no automated-access clause in its server text.
- **P:** a daily issue, with title + description and `pubDate`.
- **C:** rss.
- **V:** 200, 20 items, newest 2026-09-28.
- **Verdict:** yes. MEDIUM-HIGH.

**3.48 Substack (platform-level)** — no auth
- **R:** Substack offers **no platform-wide feed or API**: `substack.com/feed` returns 404. Its only official programmatic route is each publication's own feed, `https://<pub>.substack.com/feed` or `<custom-domain>/feed`, served by Substack.
  - The collector covers "Substack" through a named list of Substack-hosted AI publications.
  - Jennifer should approve the list, and it must contain only Substack-hosted titles. Check each one; for example, the seed's therundown.ai may not be on Substack.
- **T:** the Substack Terms (https://substack.com/tos, updated 2025-04-21) ban crawling, scraping or spidering pages and storing a significant portion of content. Polling the RSS feeds Substack publishes for readers is the intended use of those feeds, and page crawling is not used. MEDIUM.
- **P:** a post, with title + description and `pubDate`. Paid posts show only a preview.
- **C:** rss.
- **V:** verified through One Useful Thing, which is Substack-hosted: 200, 20 items.
- **Verdict:** yes. MEDIUM. Platform-wide coverage is not offered by Substack.

**3.49 Ars Technica** — permission-gated
- **R:** `https://arstechnica.com/ai/feed/`, under Condé Nast permission. It is narrower than the seed's `technology-lab` feed.
- **T:** the Condé Nast User Agreement (https://www.condenast.com/user-agreement) bans any automated process to crawl, scrape, gather, aggregate or access content for any purpose other than indexing for a search engine, explicitly including data mining.
- **A:** Condé Nast permission (licensing); no published program. Env `ARSTECHNICA_LICENSE_REF`.
- **P:** an article, with title + description and `pubDate`.
- **C:** rss.
- **V:** 200, 20 items, newest 2026-09-28.
- **Verdict:** compliant with permission. HIGH.

**3.50 One Useful Thing (Ethan Mollick)** — no auth
- **R:** `https://www.oneusefulthing.org/feed`, a Substack-hosted publication.
- **T:** Substack Terms, as in 3.48.
- **P:** a post, with title + content and `pubDate`.
- **C:** rss.
- **V:** 200, 20 items, newest 2026-09-18.
- **Verdict:** yes. MEDIUM-HIGH.

**3.51 Platformer (Casey Newton)** — no auth
- **R:** `https://www.platformer.news/rss/`, a Ghost feed. Paywalled posts appear as excerpts.
- **T:** terms not read. This is the publication's own feed.
- **P:** a post, with title + description and `pubDate`.
- **C:** rss.
- **V:** 200, 15 items, newest 2026-09-29.
- **Verdict:** yes. MEDIUM-HIGH.

---

## 4. BLOCKED: no compliant route (4)

| Source | Why | Clause / evidence | Link |
|---|---|---|---|
| WeChat / Weixin | Terms ban unauthorised automated operations; robots.txt disallows article pages and Sogou WeChat search; there is no public read API | Weixin Service Agreement §8.2.1.6 and §8.2.1.8; `mp.weixin.qq.com/robots.txt`; `weixin.sogou.com/robots.txt` `Disallow: /` | https://weixin.qq.com/agreement?lang=en_US |
| Telegram | Terms prohibit aggregating platform data to deploy ML models, and allow access only for ordinary use or to run a client, bot or Mini App | API Terms §1.5; Content Licensing and AI Scraping Terms | https://core.telegram.org/api/terms ; https://telegram.org/tos/content-licensing |
| ResearchGate | There is no API or feed, and every page, the terms page included, returns 403 with a CAPTCHA to non-browser clients | CAPTCHA wall (403); the terms clause could not be read (not verified) | https://www.researchgate.net/terms-of-service |
| Cato Institute | The whole site, including RSS, robots.txt and the terms page, returns an Incapsula 403; the FeedBurner mirrors redirect into the wall | Incapsula bot wall; the terms clause could not be read | https://www.cato.org/ |

For ResearchGate and Cato, the only way to change the verdict is for the organization to grant access, for example by allowlisting a named collector User-Agent. Nothing in this report recommends getting around either wall.

---

## 5. Environment variables needed

All of these are proposals; none is read by code today. The prior analysis found that no `process.env` source key is used anywhere in `src/`.

| Env var | Source(s) | Kind | Signup / program URL |
|---|---|---|---|
| `YOUTUBE_API_KEY` | YouTube | Free key | https://console.cloud.google.com/apis/library/youtube.googleapis.com |
| `X_BEARER_TOKEN` (replaces `TWITTER_BEARER_TOKEN`) | X | Paid credits | https://developer.x.com |
| `META_APP_ID`, `META_APP_SECRET`, `FB_ACCESS_TOKEN`, `IG_USER_ID`, `IG_ACCESS_TOKEN` | Facebook, Instagram (Graph route only) | App Review | https://developers.facebook.com/ |
| (none; queries run inside Meta's secure environment) | WhatsApp, Instagram, Facebook (MCL route) | Researcher approval | https://transparency.meta.com/researchtools/meta-content-library |
| `TIKTOK_RESEARCH_CLIENT_KEY`, `TIKTOK_RESEARCH_CLIENT_SECRET` | TikTok | Researcher approval | https://developers.tiktok.com/products/research-api/ |
| `BBC_LICENSE_REF` | BBC News | Permission | https://www.bbc.co.uk/usingthebbc/terms-of-use (§15) |
| `NYT_API_KEY` + `NYT_LICENSE_REF` | NYT | Key + licence | https://developer.nytimes.com ; https://nytlicensing.com/data-solutions/ |
| `CNN_LICENSE_REF` | CNN | Licence | https://www.cnn.com/intlsyndication/ |
| `GUARDIAN_API_KEY` (commercial) | The Guardian | Paid | https://bonobo.capi.gutools.co.uk/register/commercial |
| `ALJAZEERA_LICENSE_REF` | Al Jazeera | Licence | https://contentsales.aljazeera.net/ |
| `DOWJONES_API_KEY` | WSJ | Licence | https://www.dowjones.com/ (Factiva / Dow Jones feeds) |
| `AP_API_KEY` | Associated Press | Paid | https://developer.ap.org |
| `REUTERS_CONNECT_CLIENT_ID`, `REUTERS_CONNECT_CLIENT_SECRET` | Reuters | Paid | https://www.reutersagency.com |
| `NBC_LICENSE_REF` | NBC News | Permission | NBCUniversal (no published program) |
| `WAPO_LICENSE_REF` | Washington Post | Licence | https://www.washingtonpost.com/licensing-syndication/ |
| `SPRINGER_API_KEY` | SpringerLink | Free key | https://dev.springernature.com |
| `NCBI_API_KEY`, `NCBI_TOOL`, `NCBI_EMAIL` | PubMed/PMC | Free key (optional) | https://www.ncbi.nlm.nih.gov/account/settings/ |
| `ELSEVIER_API_KEY` | ScienceDirect | Key + approval | https://dev.elsevier.com |
| `SCHOLAR_ALERTS_IMAP_HOST`, `SCHOLAR_ALERTS_IMAP_USER`, `SCHOLAR_ALERTS_IMAP_PASSWORD` | Google Scholar | Mailbox credentials | https://scholar.google.com/intl/en/scholar/help.html (alerts) |
| `IEEE_API_KEY` | IEEE Xplore | Key + licence | https://developer.ieee.org |
| `JSTOR_DATASET_PATH` | JSTOR | Delivered dataset | https://www.jstor.org/ta-support |
| `GOVINFO_API_KEY` | GovInfo | Free key | https://api.data.gov/signup/ |
| `CONGRESS_API_KEY` | Congress.gov | Free key | https://api.congress.gov/sign-up/ |
| `GITHUB_TOKEN` (exists in `.env.example`) | GitHub | Free token (advised) | https://github.com/settings/tokens |
| `GITLAB_TOKEN` | GitLab | Free token | https://gitlab.com/-/user_settings/personal_access_tokens |
| `STACKEXCHANGE_KEY` | Stack Overflow | Free key | https://stackapps.com/apps/oauth/register |
| `HF_TOKEN` | Hugging Face | Free token (optional) | https://huggingface.co/settings/tokens |
| `ARSTECHNICA_LICENSE_REF` | Ars Technica | Permission | https://www.condenast.com/user-agreement |
| `COLLECTOR_USER_AGENT` | All; required by Wikimedia policy | Config | https://foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_User-Agent_Policy |

---

## 6. Approval-gated and paid programs, with realistic timelines

"Published" means the provider states the timeline. Everything else is an estimate and marked as one.

| Program | Sources | Eligibility | Timeline | Cost |
|---|---|---|---|---|
| Meta Content Library + API | WhatsApp, Instagram, Facebook | Academic or not-for-profit affiliation; reviewed by CASD | Not published; estimate 4–12 weeks (LOW) | Free on Meta's environment |
| Meta Graph API App Review + Business Verification (IG Public Content Access, FB Page Public Content Access) | Instagram, Facebook | A business-verified app with a matching use case | Not published; estimate 2–6 weeks (LOW); IG likely rejected for a non-brand use | Free |
| TikTok Research API | TikTok | Academic or not-for-profit in US, EEA, UK, CH or CA; non-commercial | "Within 4 weeks" (published) | Free |
| YouTube API compliance audit (advised for derived metrics) | YouTube | Any key holder | Not published; estimate 2–6 weeks (LOW) | Free |
| X API pay-per-use | X | Anyone | Immediate once credits are bought | $0.005 per post read |
| BBC permission (§15) | BBC News | By application | Not published | Possibly a fee |
| NYT Licensing (TDM) | NYT | Commercial licensing | Not published; sales-led | Not published |
| CNN Wire Store / International Syndication | CNN | Commercial licensing | Not published; sales-led | Not published |
| Guardian commercial key | The Guardian | By application; sentiment analysis is a named use case | Not published | Usage-based |
| Al Jazeera Content Sales | Al Jazeera | Commercial licensing | Not published | Not published |
| Dow Jones Factiva / feeds | WSJ | Commercial licensing | Not published; sales-led | Not published |
| AP Media API | Associated Press | Commercial licensing | Not published; sales-led | Not published |
| Reuters Connect / News API | Reuters | Enterprise contract | Not published; sales-led | Not published |
| NBCUniversal permission | NBC News | By request (no program found) | Not published | Unknown |
| WP Licensing & Syndication | Washington Post | Commercial licensing | Not published | Not published |
| Condé Nast permission | Ars Technica | By request (no program found) | Not published | Unknown |
| Elsevier use-case approval | ScienceDirect | Via the developer portal; TDM is for subscribing academic institutions | Not published | Free key; the licence may cost |
| IEEE alternative licensing | IEEE Xplore | Government or corporate, or institutional | Not published | Not published |
| JSTOR Text Analysis Support | JSTOR | Reported to need an institutional authorized user (MEDIUM) | Not published | Not published |

**Design implication:**
- The collector for every gated source can be built and tested now against a recorded fixture.
- It should register as inactive and switch on only when its env var or `*_LICENSE_REF` is present.
- It should log a single "disabled: missing credential" warning; it must never fall back to an unlicensed feed.

---

## 7. Seed and registry corrections found along the way

| Seed row / endpoint | Finding | Fix |
|---|---|---|
| `reuters_technology` `feeds.reuters.com/...` | DNS does not resolve | Reuters Connect (licensed), or leave inactive until licensed |
| `rand_ai` `/topics/artificial-intelligence.xml` | 200 with 0 entries | The four `/pubs/*.xml` feeds, with a local AI filter |
| `mozilla_ai` `foundation.mozilla.org/en/blog/rss/` | Newest item 2025-02-20 | `blog.mozilla.org/en/category/ai/feed/` |
| `ars_technica_ai` `technology-lab` | Live, but broader than AI, and needs Condé Nast permission | `arstechnica.com/ai/feed/` once permission is granted |
| CNN `rss.cnn.com/*` | Newest items 2016–2017 | CNN Wire Store (licensed) |
| WSJ `feeds.a.dj.com/rss/RSSWSJD.xml` | Newest item Jan 2025 | `feeds.content.dowjones.io/public/rss/RSSWSJD` (licensed use) |
| GovInfo `/rss/billstatus.xml` | 200 with 0 items | `/rss/bills.xml` + API search |
| `.env.example` `TWITTER_BEARER_TOKEN` ("$100/mo Basic") | X tiers replaced by pay-per-use | Rename to `X_BEARER_TOKEN`; update the pricing note |
| `hackernews_ai` category `social` | Rev. 3 puts HN in Forums | `forums` |
| `stackoverflow_ai` category `developer` | Rev. 3 puts SO in Forums | `forums` |

---

## 8. Synthesis and recommendation

**Synthesis:**
- The median source needs nothing: 21 of 51 run today on keyless official routes, most of them rss or documented JSON APIs.
- **The outliers are mainly news publishers**, and they cluster by cause. Since 2023–2025, nine of the eleven outlets have added clauses covering AI, text and data mining, or automated analysis. Those clauses turn their still-live RSS feeds into licensed products.
- The social platforms split three ways:
  - Meta and TikTok route research access through programs gated on academic or non-profit status.
  - YouTube and X sell or meter API access.
  - Telegram and WeChat forbid the use outright.
- Academic publishers split by openness: arXiv and PubMed are open, while Springer, Elsevier, IEEE and JSTOR restrict TDM to non-commercial or institutional users.

**Recommendation:**
1. Wire the 21 no-auth sources first, then the 7 free-key sources after Jennifer creates the keys listed in §5. That gives 28 of 51 live without any approval.
2. Build the 19 gated collectors behind the credential switch described in §6.
3. File the four free researcher and permission applications now, since they have the longest lead times: Meta Content Library, TikTok Research API, the BBC permission, and the YouTube compliance audit.
4. Mark WeChat, Telegram, ResearchGate and Cato as BLOCKED in the registry, with the §4 citations, for Jennifer's decision.

**Trade-offs:**
- Honouring the news terms delays 11 of the 16 news and blog sources until licences land, and the licences cost money (prices unpublished).
- The alternative is ingesting the live RSS now, which would breach the quoted clauses. This report does not recommend it.
- Eligibility for Meta and TikTok depends on whether pulse-of-ai can apply under an academic or non-profit affiliation. That is Jennifer's call and needs her input.

**Confidence:**
- **HIGH:** the route facts and live checks. Every endpoint marked "yes" was fetched today.
- **MEDIUM:** the terms verdicts for the news outlets. The clauses were read verbatim; applying them to aggregate sentiment analysis is an interpretation that Jennifer or counsel should confirm.
- **MEDIUM-LOW:** Google Scholar (alert-mailbox route) and Substack (platform coverage through per-publication feeds).
- **Unread terms:**
  - Behind walls, or no terms page found: ResearchGate, Cato, CFR, Urban, RAND and AP.
  - Not read: Mozilla and Platformer.
  - Page returned nothing usable (JavaScript-rendered or no clause found in the server text): Khan Academy, TLDR and Internet Archive.
