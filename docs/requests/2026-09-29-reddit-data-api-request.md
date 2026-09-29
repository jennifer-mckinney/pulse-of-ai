# Reddit Data API access request — draft for Jennifer to submit

**Status:** DRAFT. Jennifer submits this herself; it has not been submitted.
**Form:** https://support.reddithelp.com/hc/en-us/requests/new?ticket_form_id=14868593862164
(the "Developer Platform & Accessing Reddit Data" form for the Data API, non-commercial).
Choose the **developer** request type. Do not choose "researcher" (that is Reddit for Researchers, academics only) or "enterprise" (commercial).
**Background:** `docs/research/2026-09-29-reddit-access.md`; `docs/adr/0001-source-registry-and-collection.md`, rulings 8 and 9.

## Before submitting: prerequisite

- [ ] **Publish a privacy policy for the dashboard.** The Data API Terms (§2.6) and the Developer Terms (§7) require one. It must cover how Reddit data is collected, used, stored and deleted, and that the dashboard is not used for surveillance. Put its URL in the request below. Without it the request is incomplete.
- [ ] Read and accept the Developer Terms, the Data API Terms and the Responsible Builder Policy.
- [ ] Fill in the bracketed fields: your Reddit username, contact e-mail, the dashboard URL and the privacy-policy URL.
- [ ] Decide what to tell Reddit about retention. The text below states what the code does (ruling 9). If you would rather ask Reddit's view first, keep question 2 as written.

## Request text (paste into the form)

**Summary.** I am an individual developer requesting read-only, non-commercial access to the Reddit Data API for **Pulse of AI**, a public dashboard of aggregate sentiment and discussion topics about artificial intelligence. It is **not academic research**, and nothing from it is published as research. It is **non-commercial**: no ads, no sponsorship, no paywall, no subscriptions, and no revenue from Reddit data or anything derived from it.

**Who.** [Your name], individual developer. Reddit username: u/[your username]. Contact: [your e-mail]. Dashboard: [dashboard URL]. Privacy policy: [privacy-policy URL].

**What the dashboard does.** Pulse of AI shows how public discussion of AI changes over time across 52 public sources: news outlets, academic repositories, developer communities and forums. Each post is scored for sentiment, topical relevance and discussion quality, and the results appear as aggregate charts and a map. Every score has a public audit receipt that names the methodology version used.

**Scope of access.**
- Application-only OAuth (`grant_type=client_credentials`), `read` scope, from a server. No user logs in and no user password is stored.
- Submissions only, no comments. They come from the public subreddits that most discuss AI: the seven with the most subscribers among the subreddits with at least 20 AI-mentioning posts in the last 7 days. The candidates we expect include r/technology, r/Futurology, r/ChatGPT, r/singularity, r/MachineLearning, r/OpenAI and r/ArtificialInteligence.
- NSFW, private, quarantined and user-profile subreddits are excluded, and so are activist communities.
- Endpoints: `/r/{subreddit}/new`, `/search` (once a day, to rank subreddits by how often they mention AI), `/r/{subreddit}/about` (subscriber counts for that ranking) and `/api/info` (the deletion re-check).
- **Rate use.** About 1,000–2,000 requests a day, well under 100 queries per minute. Every request goes through one shared budget capped at 90% of the limit per 10-minute window, and it honours your `X-Ratelimit-*` headers. The User-Agent follows your required format.

**Data use.**
- **Inference only.** Post text is scored with pre-trained models: a lexicon sentiment scorer, keyword relevance, a discussion-quality heuristic and a pre-trained sentence-embedding model.
- **No model is trained, fine-tuned or fitted on Reddit data**, no parameters or thresholds are calibrated on it, and Reddit data is never used to build a language or AI model.
- **Please confirm that stateless inference with pre-trained sentiment and embedding models is acceptable under the Data API Terms.**
- **No user-level inference.** No author is ever stored, so nothing is attributed to or profiled about a user. No sensitive characteristic (political affiliation, health, sexual orientation and so on) is inferred about anyone. The fairness checks look only at aggregates: the geographic spread of posts and sentiment balance across platforms. No tracking of users, and no surveillance or law-enforcement use.

**Fields stored.**
- Stored: the post fullname (`t3_…`), subreddit, title and self-text (with user names, e-mail addresses, phone numbers and profile links redacted), the creation time, and the permalink (which contains no username).
- **Never stored:** `author`, `author_fullname`, any `author_flair_*` field or any other user field, moderator fields, awardings, media embeds and crosspost parents.

**Retention and deletion.**
- **48 hours at most for post text.** 48 hours after collection the title and self-text are replaced with a removal notice.
- **Deletion re-check every 6 hours** through `/api/info` in batches of 100. A post that was deleted, removed, is no longer public or is marked NSFW has its text removed at once. Any doubt is treated as removed.
- Everything is removed on revocation or on your request, and storage is encrypted at rest.
- [Choose one and delete the other:]
  - (a) "After the text is removed, we keep each post's numeric scores and audit record, which includes a few scored cue words from the text, so every published chart stays auditable." or
  - (b) "After the text is removed, we delete everything derived from the post."
  - Note: the code currently does (a), by your decision of 2026-09-29 (ADR 0001 ruling 9). If Reddit asks for (b), that ruling has to change first.

**Display.** The dashboard shows the redacted post text next to the permalink to the original on Reddit. Reddit is attributed as the source, and the app does not use the Reddit name or logo in its own name or imply any endorsement.

**Questions for Reddit.**
1. Does this qualify as developer, non-commercial access rather than research?
2. After the post text is removed, may we keep the per-post numeric scores and audit record (derived cue words, no text, no user data), or daily aggregates only?
3. May the dashboard show redacted excerpts of post text (with user names, e-mail addresses and profile links removed) next to the permalink?
4. Please confirm that inference with pre-trained sentiment and embedding models (no training) is acceptable.

Thank you.

## After approval

1. Register the app at https://developers.reddit.com/app-registration.
2. Set `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USER_AGENT` (`server:pulse-of-ai:v1.0.0 (by /u/<your username>)`) and `REDDIT_API_APPROVAL_REF` in `.env`, then run `docker compose up -d worker web`.
3. On the first authenticated calls, confirm the fields the code relies on (research §1.3 and §5): whether `/r/{sub}/about` still returns `subscribers`, and what the deletion signals look like (`removed_by_category`, `[deleted]` / `[removed]`, missing ids in `/api/info`).
