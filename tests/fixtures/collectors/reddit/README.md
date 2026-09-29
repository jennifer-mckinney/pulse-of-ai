# Reddit fixtures — hand-written from docs, unverified against live API

Every file here was **hand-written from docs, unverified against live API**.
Pulse of AI holds no Reddit credentials and Reddit has not approved the app,
so nothing was recorded: reddit.com and oauth.reddit.com were never contacted.

Sources for the shapes:
- `docs/research/2026-09-29-reddit-access.md` §1.2-1.4, §4 and §5;
- Reddit's legacy API docs (github.com/reddit-archive/reddit wiki: OAuth2,
  JSON) and the archived source (listing `limit` 100, `/api/info` up to 100
  fullnames, `ignore_missing`);
- PRAW 8 docs for the client-credentials flow and `subscribers`.

Author fields (`author`, `author_fullname`, `author_flair_*`, …), media
oEmbed blocks and crosspost parents are included ON PURPOSE so the tests
prove they never reach storage. Every name and user in them is fictional.
Confirm the real shapes on the first authenticated call (research §1.3, §5).
