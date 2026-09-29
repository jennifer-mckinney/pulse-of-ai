# Reddit as source #52 (Forums): access route, terms, audience figure, subreddits — research

**Question:** Can pulse-of-ai add Reddit as workbook source #52 (Forums) through an official, terms-compliant route? Specifically:
- What is that route and its gate?
- What do Reddit's current terms say about non-commercial use, AI/ML use, sentiment analysis, storage and retention, and deletion?
- What is Reddit's latest primary-source audience figure, filled in the workbook's own column style?
- Which AI subreddits are candidates, and at what size?

**Dispatched by:** Orchestrator, for Jennifer's request to add Reddit as source #52. The workbook's Methodology sheet currently lists Reddit as excluded. These rulings apply:
- Official, terms-compliant routes only.
- Never get around robots.txt, bot walls or CAPTCHAs.
- Non-commercial use.
- Forum-type sources go in the Forums category.

**Date:** 2026-09-29. Every citation below was accessed on 2026-09-29.

**Method:**
- Reddit Inc.'s policy pages (redditinc.com) and the Q2 2026 results PDFs were fetched with curl, using the User-Agent `pulse-of-ai-research/0.1 (source-access audit; https://github.com/jennifer-mckinney)`.
- Reddit's help-centre articles (support.reddithelp.com) answer a plain page request with a Cloudflare challenge (HTTP 403, "Just a moment..."). The challenge was **not** bypassed. The same articles were read through the site's official Zendesk Help Center API instead (`/api/v2/help_center/en-us/articles/{id}.json`). That path is allowed by the support site's robots.txt.
- Reddit's legacy API documentation was read from Reddit's own archived wiki and source code on GitHub (`reddit-archive/reddit`).
- **Nothing on www.reddit.com, old.reddit.com or oauth.reddit.com was fetched except the three robots.txt files.** Every path on those hosts is disallowed for us, and we hold no OAuth token. So no subreddit page, `about.json` or `/dev/api` page was read. That is why §7's subscriber counts are marked unverified.
- No account was created and no form was submitted.

---

## 0. Headline

1. **There is one compliant route: the Reddit Data API over OAuth, and it is approval-gated.**
   - Since the Responsible Builder Policy (RBP), every Data API client needs explicit approval from Reddit before it touches any Reddit data. Self-service creation of keys at reddit.com/prefs/apps is closed.
   - Jennifer must file a Data API access request, marked non-commercial, on Reddit's developer-support form (§1.1).
   - Reddit publishes no approval SLA on its own pages. Secondary sources report a "7-day target" and low approval rates for personal projects (§1.1).
2. **Classification risk.**
   - Reddit's help centre says the Data API may **not** be used for academic research. Research is allowed only through the Reddit for Researchers (RFR) program.
   - RFR is limited to researchers at accredited universities, with IRB approval. Its data is six months delayed and sits in BigQuery with no redistribution.
   - That cannot feed a live public dashboard.
   - pulse-of-ai must therefore be described honestly as a **non-commercial public discourse dashboard, not academic research**, and Reddit decides the classification.
   - If Reddit classifies it as research, Reddit is effectively **BLOCKED** for this product.
3. **Unauthenticated scraping is not a compliant route.**
   - `.json`, `.rss` and HTML scraping are all out.
   - www, old and oauth.reddit.com all serve `User-agent: *` / `Disallow: /`.
   - The User Agreement allows crawling only within robots.txt, and scraping needs prior written consent.
   - The Data API wiki says traffic without OAuth "will be blocked".
4. **The terms fit pulse-of-ai's pipeline if the pipeline changes in five ways** (details in §2 and §5):
   - Keep Reddit text and per-post rows for at most 48 hours. Reddit strongly recommends this.
   - Re-check stored IDs against `/api/info` to purge anything deleted or removed.
   - Never store author fields.
   - Do not train, fine-tune or fit models on the data.
   - Do not infer sensitive characteristics of users. That includes political affiliation, which touches the bias stage.
5. **Audience figure:** 130.3M daily active uniques (DAUq), averaged over Q2 2026 (quarter ended 30 Jun 2026).
   - Published 30 Jul 2026 in Reddit Inc.'s Q2 2026 results: the Form 8-K Exhibit 99.1 press release and the Letter to Shareholders.
   - Also stated in the Q2 2026 Form 10-Q.
   - It is an **unaudited** company KPI. The Methodology sheet's word "audited" overstates it (§6.2).
6. **Subreddit subscriber counts are no longer publicly displayed.**
   - Since Sept 2025 Reddit shows "weekly visitors" and "weekly contributions" in place of member counts (Reddit help article, §7).
   - The member counts in §7 come from third-party trackers and are marked **unverified**.

---

## 1. Official access route

### 1.1 Gate: what Jennifer must do to get credentials

| Step | What | Source |
|---|---|---|
| 1 | Read and accept the Developer Terms, the Data API Terms and the Responsible Builder Policy. | RBP (Reddit help centre, edited 2026-06-05) |
| 2 | File a Data API access request on Reddit's developer-support form: https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164 . Reddit's "Developer Platform & Accessing Reddit Data" article links this form for the Data API "for non-commercial purposes". The RBP links the same form with the developer role preselected (`tf_42139884615700=api_request_type_developer_clone`). Do **not** select "researcher" (that is RFR, academics only) or "enterprise" (commercial). | Developer Platform & Accessing Reddit Data (edited 2026-05-28); RBP |
| 3 | Describe the use case accurately. The RBP bans misrepresenting or masking how or why you access data, and bans registering multiple accounts or requests for the same use case. Suggested content is in §8. | RBP "Be transparent"; Developer Terms §4.2 |
| 4 | On approval, register the app. The RBP says apps must register at https://developers.reddit.com/app-registration to get an App profile label. This gives the client ID and secret. | RBP "App Transparency"; "Apps on Reddit and how to get a label" (edited 2026-03-25) |
| 5 | Publish a privacy policy for the dashboard covering how Reddit data is collected, used, stored and deleted. | Data API Terms §2.6; Developer Terms §7 |

**Is pre-approval now required for non-commercial use?**
- **Yes.** The RBP lists approval first among its key restrictions: you must request access and get explicit approval before accessing any Reddit data through the API.
- The Data API wiki's Rules section also says "To request, please contact us here" and links the same form.
- **Timeline: not published by Reddit on any page read (not verified).** Secondary sources:
  - Reddit closed self-service access on **11 Nov 2025**, announced in r/redditdev post `1oug31u` (https://www.reddit.com/r/redditdev/comments/1oug31u/introducing_the_responsible_builder_policy_new/). The post was not fetched because of robots.txt; the date is reported by molehill.io (11 Feb 2026) and by GitHub issue jordanburke/reddit-mcp-server#29 (27 Sep 2026).
  - molehill.io reports a Reddit-stated "target" of about 7 days to respond. It also reports that personal scripts are "rarely approved" and that academic applicants with ethics documentation have "moderate" odds. These are unverified secondary claims.
- **Plan for weeks, and plan for a possible denial.**

### 1.2 App type and grant

| Option | How it works | Fit for pulse-of-ai |
|---|---|---|
| **Application-only OAuth, `grant_type=client_credentials`** (recommended) | For confidential clients (web or script apps) acting without a user. `POST https://www.reddit.com/api/v1/access_token` with HTTP Basic auth (user = client_id, password = client_secret) and body `grant_type=client_credentials`. Returns a bearer token valid 1 hour, with no refresh token. Call the API at `https://oauth.reddit.com`. | **Right fit.** Read-only public data, no Reddit password stored. PRAW calls this the default flow for read-only mode in script and web apps. |
| Script app, `grant_type=password` | For "YOU are the only person who will use your app". Needs the Reddit account's username **and password** in the environment. | Works, but stores a personal Reddit password in the dashboard's secrets for no benefit. Not recommended. |
| Web app, authorization-code flow | For acting on behalf of other Reddit users. | Not needed. |
| Installed app, `installed_client` grant | For clients that cannot keep a secret. | Not applicable (server side). |

Sources:
- https://github.com/reddit-archive/reddit/wiki/OAuth2 ("Application Only OAuth" section)
- https://github.com/reddit-archive/reddit/wiki/OAuth2-App-Types
- https://github.com/reddit-archive/reddit/wiki/OAuth2-Quick-Start-Example
- https://praw.readthedocs.io/en/stable/getting_started/authentication.html (PRAW 8.0.3)

Caveat: the reddit-archive wiki is Reddit's legacy documentation. The current Data API wiki links it and warns that some legacy material may be out of date.

**Scope:** `read`. `/api/info` requires the `read` scope, per `@require_oauth2_scope("read")` in `r2/controllers/api.py` of the archived source.

**Env vars:**

| Var | Content | Notes |
|---|---|---|
| `REDDIT_CLIENT_ID` | OAuth client ID from the approved app | required |
| `REDDIT_CLIENT_SECRET` | OAuth client secret | required; secret. Developer Terms §1.4 and §7.4 bar sharing access info. |
| `REDDIT_USER_AGENT` | e.g. `server:pulse-of-ai:v0.1.0 (by /u/<Jennifer's Reddit username>)` | required. Reddit's format is `<platform>:<app ID>:<version string> (by /u/<reddit username>)`. It must be unique and truthful; the wiki says "NEVER lie about your User-Agent". Default agents such as "Python/urllib" are heavily limited. |
| `REDDIT_API_APPROVAL_REF` (suggested) | Reddit's ticket or approval reference | Mirrors the registry's existing `*_APPROVAL_REF` pattern, e.g. `META_CONTENT_LIBRARY_APPROVAL_REF`. |

No `REDDIT_USERNAME` or `REDDIT_PASSWORD` is needed with client credentials.

**Implementation note:** `src/collectors/http.js` sets one User-Agent for every request. The Reddit route must send `REDDIT_USER_AGENT` instead, because Reddit requires its own format.

### 1.3 Endpoints

All are GET on `https://oauth.reddit.com` with `Authorization: bearer <token>` and the Reddit User-Agent. Add `raw_json=1` to get unescaped text.

| Purpose | Endpoint | Notes |
|---|---|---|
| Newest submissions in a subreddit | `/r/{sub}/new?limit=100&after={fullname}` | Listing. `limit` defaults to 25 and caps at 100 (`VLimit(default=25, max_limit=100)` in the archived `r2/lib/validator/validator.py`). Paginate with `after` (the fullname of the last item). |
| Top submissions | `/r/{sub}/top?t=day&limit=100` | `t` takes hour, day, week, month, year or all (PRAW Subreddit.top `time_filter`). |
| Search restricted to one subreddit | `/r/{sub}/search?q={query}&restrict_sr=1&sort=new&t=week&limit=100` | `restrict_sr` defaults to false (`VBoolean('restrict_sr', default=False)` in the archived `r2/controllers/front.py`), so it **must** be set. `sort` takes relevance, hot, top, new or comments. |
| Batch re-check by ID (deletion sweep) | `/api/info?id=t3_a,t3_b,...` | Up to 100 fullnames per call (`VByName('id', multiple=True, ignore_missing=True, limit=100)`). Unknown IDs are dropped from the response (`ignore_missing`). |
| Subreddit metadata | `/r/{sub}/about` | PRAW documents a `subscribers` attribute. Whether the API still returns it after the Sept 2025 display change is **not verified**. |

The live reference is https://www.reddit.com/dev/api. It was **not fetched**, because robots.txt disallows it and we hold no token. Confirm these parameters against it on the first authenticated call.

### 1.4 Rate limits (free tier)

| Limit | Value | Source |
|---|---|---|
| Queries per minute | **100 QPM per OAuth client ID**, averaged over a 10-minute window so short bursts are allowed | Reddit Data API Wiki, edited 2026-05-11 |
| Headers to honour | `X-Ratelimit-Used`, `X-Ratelimit-Remaining`, `X-Ratelimit-Reset` | same |
| Unauthenticated traffic | Traffic not using OAuth or login credentials will be blocked, and the default rate limit will not apply | same |
| Over the limit | Circumventing or exceeding limits is prohibited and can mean a permanent block. Research above the rate limits needs a separate agreement. | Data API Terms §3.1–3.2; Developer Terms §4.1–4.2 |

The archived wiki page (`reddit-archive/reddit/wiki/API`) still says 60 requests per minute. That is **stale**; the current wiki says 100.

**Budget:**
- 8 subreddits × `/new` every 15 min = 768 calls/day.
- A deletion sweep of 3,000 stored IDs every 6 h = 120 calls/day.
- Total is under 1% of the 144,000/day that 100 QPM allows.
- A registry `rateLimit` of `minIntervalMs: 700` (about 85 QPM) plus honouring `X-Ratelimit-Remaining` is enough.

### 1.5 robots.txt and unauthenticated scraping

`https://www.reddit.com/robots.txt` (HTTP 200, `last-modified: Mon, 01 Jul 2024`). Comment lines point to the Public Content Policy and to r/reddit4researchers. The only rules are:

```
User-agent: *
Disallow: /
```

- `https://oauth.reddit.com/robots.txt` and `https://old.reddit.com/robots.txt` serve the same two rules.
- The User Agreement (effective 1 Jul 2026) bans collecting data by automated means except as its terms or a separate agreement allow. Crawling is permitted only within robots.txt, and scraping needs Reddit's prior written consent.
- **So unauthenticated `.json`, `.rss` or HTML fetching of reddit.com is NOT a compliant route.** It is disallowed by robots.txt, barred by the User Agreement, and blocked in practice for non-OAuth traffic (Data API Wiki).
- **How this squares with the robots ruling:**
  - Reddit's Data API Wiki says "Our robots.txt is for search engines, not Data API users".
  - The project's `JsonApiCollector` is already not robots-gated by design: documented APIs are governed by their terms and rate limits (`src/collectors/base.js` header; ADR 0001).
  - An authenticated, approved Data API client at `oauth.reddit.com` therefore does not get around robots.txt. It is the route Reddit's robots.txt comments send you to.
  - **Jennifer should confirm this reading explicitly, because her robots ruling is absolute.**

---

## 2. Terms: the clauses that matter

These are paraphrased with section references. Read the linked originals before relying on them. Versions:
- Data API Terms: effective 19 Jun 2023, last revised 20 Jul 2026.
- Developer Terms: effective 24 Sep 2024, last revised 24 Mar 2026.
- RBP: edited 5 Jun 2026.
- Data API Wiki: edited 11 May 2026.
- Public Content Policy (PCP): edited 29 May 2025.

| Topic | What the terms say | Where | Effect on pulse-of-ai |
|---|---|---|---|
| **Approval** | Explicit approval is required before accessing any Reddit data through the API. | RBP intro | Hard gate (§1.1). |
| **Non-commercial** | No use by or for a business or monetized product, and no revenue derived directly or indirectly from Reddit data, including derived data, without written approval. Reddit's examples of commercial use include paywalls, subscriptions, sponsorships, and showing Reddit content on sites with ads. Reddit content may not be displayed next to ads. | Developer Terms §4.1; Data API Terms §3.2; "Developer Platform & Accessing Reddit Data" (Commercial Use) | The dashboard must stay ad-free, sponsor-free and unmonetized while it shows Reddit-derived data. |
| **Research** | Research using Reddit data is allowed only through RFR. Using developer tools or APIs for academic research violates policy. RFR is for accredited-university researchers, with occasional non-profit or government exceptions. | "Developer Platform & Accessing Reddit Data" (Research); RBP (Researchers); RFR article (edited 2026-06-02) | **Key classification risk** (§0 item 2). Describe the product as a public dashboard, not research. Do not publish papers from Reddit data collected through the Data API. |
| **AI/ML training** | No use of User Content to train an ML or AI model without the rightsholders' express permission, and no access to Reddit data to train "large language, artificial intelligence, or other algorithmic models" without Reddit's permission. The RBP extends this to commercial and non-commercial mining for model training. On termination, you must also delete data or **models derived** from Reddit data. | Data API Terms §2.4, §3.2, §6; Developer Terms §2.1, §4.2; RBP "No Unapproved Commercialization or AI Training"; help centre "Can I use content on Reddit to build a large language / AI model? No." | Running pre-trained sentiment, relevance and embedding models on the text is inference, not training, and is not named in any clause. **Fitting anything on Reddit text is out:** fine-tuning, training a classifier, fitting a topic model or clustering model whose parameters persist, or calibrating thresholds on Reddit data. The phrase "other algorithmic models" is broad. Confirm in the application that stateless inference with pre-trained models is acceptable. |
| **Sentiment analysis** | Not mentioned in any Reddit page read (not verified as permitted or prohibited). The PCP lists "companies that help brands monitor trends" among Reddit's *commercial licensees*. | PCP | Say it plainly in the application: aggregate, non-commercial sentiment over public posts in named AI subreddits. |
| **Sensitive inference** | You may not process data to derive or infer sensitive characteristics of Reddit users, such as health, political affiliation or sexual orientation. You may not re-identify or de-anonymize users. The Developer Terms bring in the PCP's licensee restrictions: no profiling on sensitive attributes, and no tracking or monitoring of sensitive events or groups such as protests, unions or activist groups. | RBP "Zero Tolerance for Privacy Violations"; Developer Terms §4.2 (last bullet); PCP | Our pipeline never stores authors, so nothing is attributed to a user. But the **bias and discourse stages must not output a political-affiliation label** for Reddit posts. Also **exclude activist communities** (e.g. r/antiai) from the subreddit list, to stay clear of "monitor sensitive groups". |
| **Content modification** | The licence is to copy and display User Content in your app, and to modify it **only to format it for display**. | Data API Terms §2.4; Developer Terms §2.1 | Redacting handles out of displayed text is arguably more than formatting. **Recommendation: do not display Reddit post text on the public dashboard.** Show aggregates plus a link-out permalink. Keep the redacted text internal and short-lived (§5). |
| **Retention (general)** | Do not use or retain data beyond the approved use case, and delete immediately what is not needed. Delete when no longer needed, when the app stops, or when Reddit or the user asks. Encrypt at rest. | Data API Terms §3.2; Developer Terms §7.3, §7.4 | The PostgreSQL volume holding Reddit rows needs encryption at rest. Purge on shutdown or revocation. |
| **Deletion of removed content** | You must remove any user content you hold that has been deleted from Reddit. For a deleted post or comment, delete all related content (title, body, embedded URLs). For a deleted account, delete all related user IDs (`t2_*`) and all author-identifying references (ID, name, profile URL, avatar URL, flair). Reddit strongly recommends routinely deleting stored user data and content **within 48 hours**. Keeping deleted content, even disassociated, de-identified or anonymized, is a violation. Deleted, protected, suspended, withheld or removed content must be deleted or modified as soon as possible. | Data API Wiki (Rules); Developer Terms §3.3 | See §5. There is no push feed of deletions for free-tier clients: Reddit's real-time compliance tools are described for commercial data licensees. Compliance is therefore **re-checking IDs plus a 48 h retention window**. |
| **Attribution / branding** | Do not use "Reddit" in the app's name or logo, and do not imply partnership or endorsement. The wordmark may be used to attribute Reddit as the source of content, in the form "[name] for Reddit". | Data API Terms §4.1–4.3; Developer Terms §2.1 | Label the source row "Reddit" as attribution only. |
| **Audit** | Reddit may monitor and audit the app's use of Reddit data. | Developer Terms §2.2 | Keep the collector's run logs. |
| **Surveillance** | No use for law-enforcement or surveillance purposes. | Developer Terms §4.2 | Not applicable; state it in the privacy policy. |

---

## 3. RFR: why it does not fit

From the RFR article (edited 2026-06-02):
- Applicants must be researchers at an accredited university, applying from an institutional email with IRB or ethics approval and a sponsor. Non-profits or government researchers are accepted only "on limited occasions", for non-partisan public-benefit projects.
- Access is through BigQuery Analytics Hub.
- The data covers 5 years **with a six-month delay**, updated monthly.
- No redistribution, one year of access per project, a preprint copy to Reddit, and deletion of all data and derivatives when the project ends.

A live public dashboard can meet none of the delay, redistribution or display constraints. **Not recommended**, unless Jennifer later wants a separate academic study with a university partner.

---

## 4. What "a post" is, and which fields to keep

**Recommendation: v1 collects submissions only.** A submission is a `link` thing with fullname prefix `t3_`.

| Option | Pros | Cons |
|---|---|---|
| **A. Submissions only (recommended)** | Title and self-text carry the topic. Low volume keeps the 48 h deletion sweep cheap. This matches how Hacker News is collected (`tags: 'story'`). | Misses the discussion inside threads, which is where most discourse on the heavy subreddits happens. |
| B. Submissions plus the top N comments per AI-relevant thread | Captures the discourse. | 10–100× the rows. Every comment needs a deletion re-check. More free text naming other users (`u/` mentions). |

**Field allowlist.** Use an allowlist rather than a denylist: Reddit adds fields over time, and a denylist would let new author fields through.

| Keep | Use |
|---|---|
| `name` (e.g. `t3_1abc2d`) | **external_id**: stable base-36 fullname with no identity in it, so it can be stored as-is under the migration 017 rule |
| `id` | base-36 id, used for the short link |
| `subreddit`, `subreddit_id`, `subreddit_type` | provenance. **Drop the item unless `subreddit_type == 'public'`**. |
| `title`, `selftext` | text. Raw markup with `<`, `>` and `&` escaped unless `raw_json=1`. |
| `created_utc` | timestamp, UTC epoch seconds |
| `permalink` | provenance URL (below) |
| `is_self`, `domain`, `url` | link-post handling. **Drop `url` if it points to reddit.com/user/ or /u/.** |
| `over_18` | **drop the item if true**. The PCP excludes sexually explicit content even for licensees. |
| `link_flair_text` | post flair, set by the post rather than the author. Optional. |
| `num_comments`, `score`, `upvote_ratio` | engagement. Optional. |
| `removed_by_category`, `edited`, `locked` | deletion and removal signals (§5) |

**Must NOT store (author-identifying):**
- `author`, `author_fullname` (`t2_…`), and every `author_flair_*` field (text, css_class, richtext, template_id, background_color, text_color, type).
- `author_premium`, `author_patreon_flair`, `author_is_blocked`.
- On comments: `link_author`.
- `approved_by`, `banned_by`, `mod_reason_by`, `user_reports`, `mod_reports`, `all_awardings`.
- `crosspost_parent_list`, which nests another post's full author block.
- `media`, `secure_media`, `media_embed`. Their oEmbed blocks carry `author_name` and `author_url` for embedded videos.
- `preview`, if it holds user images.
- **Any item whose `subreddit` starts with `u_`.** That is a post to a user's own profile, so the subreddit name is the username.
- The legacy JSON doc lists `author` and the `author_flair_*` fields. `author_fullname`, `removed_by_category`, `upvote_ratio`, `author_premium` and the others were added after the archived doc. **Confirm the full key list on the first authenticated response** and fail closed on unknown `author*` keys.

**Free text:**
- `title` and `selftext` can contain `u/username` mentions, e-mail addresses and links.
- The existing redaction stage (handles, e-mails, profile links) must treat `u/<name>` and `/u/<name>` as handles.

**Location:**
- Reddit has no post geolocation. Set `region: 'global'` and `homeCity: null`.
- Subreddit-derived location applies only to geographic subreddits, and none of the candidates is one.
- **Do not infer location from text or users.**

**Permalink and provenance:**
- Permalink: `https://www.reddit.com` + `permalink`, giving `https://www.reddit.com/r/{sub}/comments/{id36}/{title_slug}/`. The path contains subreddit, post ID and a slug made from the title. It **contains no username**, so it meets migration 017's "permalink when it does not identify a person" rule.
- Short form: `https://redd.it/{id36}`.
- For comments (option B only): `external_id` = `t1_{id36}` and permalink `/r/{sub}/comments/{link_id36}/{slug}/{comment_id36}/`.
- **Retention caveat for provenance:** under §5 the fingerprint and permalink rows for a Reddit post must also go when the post is deleted, or after 48 h. So `npm run replay -- --post <id>` and the audit receipt will not work for Reddit posts older than the retention window. This is a real conflict with the audit design, and Jennifer has to accept it or raise it with Reddit.

---

## 5. Deletion and retention design

| Mechanism | Detail |
|---|---|
| **Hard TTL: 48 h** | Every Reddit row (text, redacted text, per-post scores, embedding, provenance fingerprint, permalink) is purged 48 h after `created_utc` or after ingest, whichever is later. This follows Reddit's "strongly recommend … within 48 hours". |
| **Re-check sweep: every 6 h** (recommended cadence; Reddit states none) | Send `GET /api/info?id=` in batches of up to 100 stored fullnames. **Purge** the item if (a) it is missing from the response, (b) `selftext` or `title` is `[deleted]` or `[removed]`, (c) `removed_by_category` is set, or (d) `subreddit_type` is no longer `public`. These field meanings are **not documented on any Reddit page read**. Confirm them on first authenticated use, and treat any doubt as "purge". |
| **Aggregates** | Freeze a day's aggregates (counts, mean sentiment per subreddit) only after its posts have survived the 48 h window without deletion. Then drop the per-post rows. Whether an aggregate that once included a later-deleted post must be recomputed is **not addressed** in the terms read. Ask Reddit in the application. |
| **Account deletion** | Author fields are never stored, so the rule to delete a deleted account's `t2_` data and author references is met by construction. |
| **Revocation or termination** | On token revocation or a Reddit request, purge every Reddit row and derived artefact (Data API Terms §6; Developer Terms §8). |

---

## 6. Workbook row #52 (Forums)

### 6.1 Proposed row, in the workbook's column style

| Column | Value |
|---|---|
| rank | 52 |
| category | forums |
| source | Reddit (Reddit, Inc.) |
| metric_type | Daily active uniques (DAUq) |
| value | 130.3M |
| value_numeric | 130300000 |
| as_of | Q2 2026 (quarter avg., ended 30 Jun 2026) |
| publisher_of_figure | Reddit Q2 2026 results (30 Jul 2026): Letter to Shareholders + Form 8-K Ex. 99.1; restated in Q2 2026 Form 10-Q |
| figure_type | Company-reported |
| credibility_basis | Reddit, Inc. is an NYSE-listed SEC registrant. The DAUq is an unaudited company KPI. 59.6% of it (77.7M) is logged-out users, and bots are removed only going forward. WAUq 514.6M. +18% YoY (Q2 2025: 110.4M). |
| confidence | High |

**Figure details:**

| Item | Value |
|---|---|
| Exact figure | 130.3 million DAUq, global, average for the three months ended 30 Jun 2026 |
| Splits | U.S. 53.2M, international 77.1M; logged-in 52.6M, logged-out 77.7M. WAUq 514.6M (U.S. 197.2M, international 317.4M). |
| Definition (Reddit's) | A user identifiable by a unique identifier who visited a www.reddit.com page or opened a Reddit app at least once in a 24-hour period, averaged over the days of the period |
| Publication date | 30 Jul 2026 |
| Primary URLs | Letter: https://s203.q4cdn.com/380862485/files/doc_financials/2026/q2/Q2-26-Shareholder-Letter.pdf ; press release (8-K Ex. 99.1): https://www.sec.gov/Archives/edgar/data/1713445/000171344526000098/earningspressreleaseq226.htm ; 10-Q: https://www.sec.gov/Archives/edgar/data/0001713445/000171344526000100/rddt-20260630.htm |
| Why this and not a later figure | Q3 2026 ends 30 Sep 2026 and has not been reported as of 2026-09-29 |

**Why Company-reported / High:**
- This follows the workbook's convention: Tencent's audited-issuer MAU is "Company-reported, High".
- It is stated in SEC-filed earnings materials by a public issuer, which is the ladder's COMPANY-REPORTED definition.
- The metric is **not audited**. The 10-Q notes that when Reddit identifies automated agents it removes them from DAUq going forward and does not recalculate prior periods if the impact is immaterial.

### 6.2 Methodology-sheet edits this row implies (for the executor; not made here)

1. **"The central problem":**
   - It calls Reddit's 126.8M (Q1 2026) an "audited daily active user figure". That overstates it: DAUq is an SEC-disclosed, unaudited KPI.
   - Suggested wording: "SEC-disclosed (unaudited KPI)".
   - Update the figure to 130.3M (Q2 2026).
   - The Q1 figure, 126.8M, is confirmed by the Q2 letter's trend chart.
2. **Reliability ladder:** the AUDITED rung includes "SEC filing". Read literally, that would promote this row to Audited. Recommend keeping it Company-reported and adding a note that a KPI inside an SEC filing is not audited. Otherwise GitLab's 10-K "registered users" row is also over-ranked.
3. **"Metric types used":** add "Daily active uniques (DAUq): Reddit's identified unique visitors in a 24 h period, logged-in and logged-out combined; quarterly average".
4. **"Notable exclusions":** the paragraph saying Snapchat and Reddit are "still excluded from social" needs updating. Reddit is now #52 in **Forums**, not Social. Snapchat is unchanged.
5. **Title, revision and source-count text:** "Top 51" becomes "Top 52", and add a Rev. 4 note ("Reddit added as #52, Forums, at user request").

---

## 7. AI-focused subreddit candidates

**Subscriber counts are unverified.**
- Reddit replaced public member counts with "weekly visitors" (unique visitors over the past 7 days, 28-day rolling average, excluding bots) and "weekly contributions". Source: Reddit help article "Understanding weekly visitors and contributions on Reddit" (created 2025-09-08, edited 2026-03-12).
- The article says member counts remain visible only to moderators, on the Mod Insights page, and will later be removed there too.
- I could not read `about.json` or subreddit pages: robots.txt disallows them and we have no token.
- The figures below come from third-party trackers. They disagree, and none states a method.
- **None goes into the workbook.** Once access is approved, read `subscribers` (if still returned) or the weekly-visitors figure through `/r/{sub}/about`, and record that instead.

| Subreddit | Members (unverified, third-party) | Tracker and date | Character (from third-party descriptions; measure after access) | Suggested |
|---|---|---|---|---|
| r/ChatGPT | 11.5M (usefulai.com, 12 Jul 2026) vs "5M+" (deadsubs.com, updated 26 Aug 2026) | trackers conflict by 2× | Very high volume. User experiences, screenshots, memes, product-change complaints. Discourse-heavy but noisy. | Yes, with the AI filter. The subreddit is already all-AI, so scope `ai`, but expect low-signal posts. |
| r/singularity | 3,998,116 (freesubstats.com, Sept 2026); 3.91M (usefulai.com, 12 Jul 2026) | close agreement | Capability news links plus long speculative comment threads. Mixed. | Yes |
| r/MachineLearning | 3.05M (usefulai.com, 12 Jul 2026) | — | Research-focused, with [R]/[D]/[P] tagged posts. [D] threads are discussion-heavy. | Yes |
| r/OpenAI | 2.76M (usefulai.com, 12 Jul 2026) | — | Company and product news plus user discussion. News-leaning. | Yes |
| r/ArtificialInteligence (note the spelling: one "l") | 1.9M (web-search snippet of a third-party list, date not stated) | weakest figure | Opinion, text-post debate. Discourse-heavy. | Yes. The correctly spelled r/ArtificialIntelligence is a different, apparently smaller community (not verified). |
| r/artificial | 1,344,846 (freesubstats.com, Sept 2026); 1.28M (usefulai.com, 12 Jul 2026) | close agreement | Broad AI news. **Mostly a link dump.** | Yes (news) |
| r/LocalLLaMA | 733K (usefulai.com, 12 Jul 2026) vs "400K+" (deadsubs.com) | conflict | Technical discussion: local inference, quantization, hardware. Discourse-heavy but narrow and practitioner-focused. | Yes |
| r/AIethics | **not found** in any tracker searched | unverified | Unknown. Probably small and low-activity. | Hold until measured |
| r/ClaudeAI (extra) | 881K (usefulai.com, 12 Jul 2026) | — | Product-usage discussion | Optional |
| r/antiai (not recommended) | 344,980 (freesubstats.com) | — | Activist community | **Exclude**: the PCP bars monitoring activist groups |

**Discourse versus news link-dumps:**
- Discourse-heavy: r/ArtificialInteligence, r/LocalLLaMA, r/MachineLearning ([D] threads), r/singularity (comments).
- News-leaning or link-dump: r/artificial, r/OpenAI.
- High volume, low signal: r/ChatGPT.
- These are qualitative labels from third-party descriptions. **Verify with data once access exists:** measure the share of self-posts (`is_self`) and median `num_comments` per subreddit over 7 days.

---

## 8. What to put in the Reddit access request (draft points)

- **Who:** an individual developer. Reddit username; contact e-mail on the form.
- **What:** a non-commercial, ad-free public dashboard of aggregate sentiment and topics in public discussion of AI. No monetization and no sponsorship.
- **Scope:** read-only, application-only OAuth with the `read` scope. Named public subreddits only (list them). Submissions only. About 1,000 requests/day, well under 100 QPM.
- **Processing:**
  - Inference with pre-trained sentiment and embedding models.
  - **No model training or fine-tuning.**
  - No user-level inference.
  - No author fields stored.
  - No display of post text; aggregates and permalinks only.
- **Retention:** 48 h maximum per post, a deletion re-check every 6 h through `/api/info`, purge on revocation, encryption at rest.
- **Questions to ask Reddit:**
  - (a) Is this "developer, non-commercial" rather than "research"?
  - (b) May de-identified daily aggregates be kept after the 48 h window?
  - (c) May redacted excerpts be displayed?

---

## 9. Findings (sources)

All accessed 2026-09-29.

| Source | Value | URL | Notes |
|---|---|---|---|
| Reddit robots.txt | `User-agent: *` / `Disallow: /` | https://www.reddit.com/robots.txt | last-modified 1 Jul 2024. oauth.reddit.com and old.reddit.com are identical. |
| Responsible Builder Policy | Approval required; no AI training; no sensitive inference; research only via RFR | https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy | edited 2026-06-05. Read via the Zendesk API because the page is Cloudflare-challenged. |
| Reddit Data API Wiki | 100 QPM per client ID; UA format; OAuth required; delete deleted content; 48 h recommendation | https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki | edited 2026-05-11 |
| Developer Platform & Accessing Reddit Data | Non-commercial Data API sign-up form; research only via RFR; no LLM training; no ads beside Reddit content | https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data | edited 2026-05-28 |
| Reddit for Researchers Program | Academics only; 6-month delay; BigQuery; 1-year access | https://support.reddithelp.com/hc/en-us/articles/49381918834964-Reddit-for-Researchers-Program | edited 2026-06-02 |
| Public Content Policy | Licensee restrictions (sensitive groups, NSFW, deletions) | https://support.reddithelp.com/hc/en-us/articles/26410290525844-Public-Content-Policy | edited 2025-05-29 |
| Licensee deletion article | Real-time deletion tools exist for commercial licensees | https://support.reddithelp.com/hc/en-us/articles/26417433892756 | edited 2024-05-09 |
| Weekly visitors article | Member counts replaced; moderators only | https://support.reddithelp.com/hc/en-us/articles/41037560577684-Understanding-weekly-visitors-and-contributions-on-Reddit | created 2025-09-08, edited 2026-03-12 |
| Apps label article | Register at developers.reddit.com/app-registration | https://support.reddithelp.com/hc/en-us/articles/45376380316052 | edited 2026-03-25 |
| Data API Terms | §2.4 licence and no ML training; §3 restrictions; §6 delete derived models | https://redditinc.com/policies/data-api-terms | last revised 20 Jul 2026 |
| Developer Terms | §3.3 deletion; §4.1 commercial; §4.2 algorithmic models, surveillance, PCP; §7.3–7.4 retention and encryption | https://redditinc.com/policies/developer-terms | last revised 24 Mar 2026 |
| User Agreement | Crawling only within robots.txt; scraping needs written consent | https://redditinc.com/policies/user-agreement | effective 1 Jul 2026 |
| Legacy OAuth2 wiki (Reddit) | `client_credentials` for confidential clients; 1 h tokens; oauth.reddit.com | https://github.com/reddit-archive/reddit/wiki/OAuth2 | legacy; linked from the current Data API Wiki |
| Legacy app-types wiki | Script / web / installed | https://github.com/reddit-archive/reddit/wiki/OAuth2-App-Types | legacy |
| Legacy JSON wiki | `link`/`comment` fields: `author`, `permalink`, `created_utc` | https://github.com/reddit-archive/reddit/wiki/JSON | legacy; predates newer fields |
| Archived Reddit source | `limit` max 100; `restrict_sr` default false; `/api/info` limit 100 with `read` scope | https://github.com/reddit-archive/reddit/tree/master/r2/r2 | 2017 open-source snapshot; confirm against live `/dev/api` |
| PRAW 8.0.3 docs | Read-only mode uses client credentials; Subreddit.search/top parameters; `subscribers` attribute | https://praw.readthedocs.io/en/stable/getting_started/authentication.html | third-party library, secondary |
| Reddit Q2 2026 Letter to Shareholders | DAUq 130.3M; WAUq 514.6M; logged-out 77.7M | https://s203.q4cdn.com/380862485/files/doc_financials/2026/q2/Q2-26-Shareholder-Letter.pdf | published 30 Jul 2026 |
| Reddit Q2 2026 press release (8-K Ex. 99.1) | Same figures; DAUq definition | https://www.sec.gov/Archives/edgar/data/1713445/000171344526000098/earningspressreleaseq226.htm | dated 30 Jul 2026 |
| Reddit Q2 2026 Form 10-Q | DAUq 130.3M; bots removed only going forward | https://www.sec.gov/Archives/edgar/data/0001713445/000171344526000100/rddt-20260630.htm | filed on or about 30 Jul 2026 |
| molehill.io | Self-service closed Nov 2025; "7-day target"; approval odds | https://molehill.io/blog/reddit_killed_self-service_api_keys_your_options_for_automated_reddit_integration | 11 Feb 2026; secondary, unverified |
| GitHub issue reddit-mcp-server#29 | Self-service closed 11 Nov 2025; prefs/apps redirects to the RBP | https://github.com/jordanburke/reddit-mcp-server/issues/29 | 27 Sep 2026; secondary |
| usefulai.com | Subreddit member counts | https://usefulai.com/feeds/subreddits | 12 Jul 2026; unverified |
| freesubstats.com | Subreddit member counts | https://freesubstats.com/best/ai-subreddits | Sept 2026; method unstated; unverified |
| deadsubs.com | Rounded member counts and characterizations | https://www.deadsubs.com/best/ai-subreddits | updated 26 Aug 2026; unverified |

---

## 10. Synthesis

- Every Reddit primary source agrees on the essentials:
  - Access requires OAuth and prior approval.
  - Scraping is out.
  - Deleted content must go, and 48 h is the recommended retention.
  - No model training.
  - No sensitive or user-level inference.
  - Non-commercial only.
- The outlier is the research carve-out. Reddit steers all research to RFR, which a live dashboard cannot use. So whether Reddit is usable depends on Reddit accepting the dashboard as a developer, non-commercial use case.
- The audience figure is the strongest-documented number in the Forums category: SEC-disclosed, quarterly, with a published definition. Its known weakness is that 60% of it is logged-out users.

## 11. Recommendation

Proceed in this order:
1. **Add Reddit to the registry now** as rank 52, Forums, with:
   - `auth.kind: 'approval'` and `closedStatus: 'awaiting_approval'`;
   - a `JsonApiCollector` route requiring `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` and `REDDIT_API_APPROVAL_REF`;
   - scope `ai`, submissions only, from r/MachineLearning, r/singularity, r/OpenAI, r/ArtificialInteligence, r/artificial, r/LocalLLaMA and r/ChatGPT;
   - a 48 h TTL plus a 6 h `/api/info` deletion sweep.
2. **Jennifer files the non-commercial Data API request** (§1.1 step 2, §8 content).
3. The collector stays closed until approval is granted.
4. Add the workbook row in §6.1.

**Trade-offs:**
- Reddit data can never back a per-post audit receipt older than 48 h.
- Post text is not displayed publicly.
- Approval may be denied, or the product classified as research. Either would leave Reddit BLOCKED, like WeChat and Telegram.

**Confidence:**
- **HIGH** on the route, gate and terms clauses: Reddit primary pages, fetched today.
- **HIGH** on the audience figure: SEC filing and shareholder letter.
- **LOW** on the approval timeline and odds: secondary sources only.
- **LOW** on the subscriber counts: third-party, conflicting, and marked unverified.
- **MEDIUM** on the deletion-signal fields: undocumented; confirm on first authenticated call.
