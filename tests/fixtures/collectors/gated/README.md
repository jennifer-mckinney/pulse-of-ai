# Gated-source fixtures (hand-written)

No credentials, licences or approvals exist yet for these sources, so their
collectors are tested ONLY against these files. Each is written to the
response shape in the provider's public documentation (linked below). They are
not recordings, and nothing in them was fetched. Items are fictional and carry
no personal data. When a credential arrives, record a real response and
compare it with the fixture before relying on the collector.

| File | API | Docs |
|---|---|---|
| youtube-search.json, youtube-videos.json | YouTube Data API v3 | https://developers.google.com/youtube/v3/docs/search/list |
| tiktok-token.json, tiktok-query.json | TikTok Research API | https://developers.tiktok.com/doc/research-api-specs-query-videos/ |
| x-recent.json | X API v2 recent search | https://docs.x.com/x-api/posts/search/introduction |
| nyt-articlesearch.json | NYT Article Search | https://developer.nytimes.com/docs/articlesearch-product/1/overview |
| guardian-content.json | Guardian Content API | https://open-platform.theguardian.com/documentation/search |
| ap-search.json | AP Media API | https://developer.ap.org |
| reuters-token.json, reuters-graphql.json | Reuters Connect (schema unverified without a contract) | https://www.reutersagency.com |
| licensed-feed.json | Contract feed (CNN Wire Store / Dow Jones), generic JSON shape | per contract |
| springer.json | Springer Nature Meta API v2 | https://dev.springernature.com |
| elsevier.json | ScienceDirect Search API v2 | https://dev.elsevier.com |
| ieee.json | IEEE Xplore Metadata API | https://developer.ieee.org |
| govinfo-search.json | GovInfo search | https://api.govinfo.gov/docs/ |
| congress-bills.json | Congress.gov API v3 | https://github.com/LibraryOfCongress/api.congress.gov |
| mcl/*.jsonl | Meta Content Library export (fields per MCL data dictionary) | https://transparency.meta.com/researchtools/meta-content-library |
| jstor.jsonl | JSTOR Text Analysis Support dataset | https://www.jstor.org/ta-support |
| researchgate.jsonl | ResearchGate granted dataset (shape assumed) | — |
| telegram-updates.json | Telegram Bot API getUpdates | https://core.telegram.org/bots/api#getupdates |
| wechat-feed.xml, cato-feed.xml | authorized / allowlisted RSS | — |
| scholar-alert.eml | Google Scholar alert email | https://scholar.google.com/intl/en/scholar/help.html |
| osm-diary-ai.xml | hand-made OpenStreetMap diary entry (AI topic, geotagged in London) in the recorded feed's shape (G10-15) | — |
