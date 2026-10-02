# K1: source credit and link on every excerpt and receipt

**Status:** implemented in the PR that carries this file (`feat/attribution-credits`). **Owner:** this PR is the single owner of the "source link + credit" mechanism; no other PR may build a parallel one.
**Decision of record:** Jennifer, 2026-10-01: "Yes, required before launch" (launch blocker K1).
**Inputs:** the 2026-09-30 terms-of-service review (41 routes; §0 "Source credit" / "Link back" rows, §5 pattern 4, §6E) and a survey of the code at `origin/master` (a17020f).

## 1. What was wrong (survey)

| Fact | Where |
|---|---|
| The only credit was the registry `attribution` string, shown as "via X" for 7 sources (NBC News, NPR, Pew, Wikipedia, OWID, Stack Overflow, Reddit). Every other source showed only its slug. | `src/config/source-registry.js` `attributionFor` (now removed: `src/config/attribution.js` replaces it); `public/js/ui.js` `renderPosts`, audit drawer; `public/js/story.js` `buildMiniPost` |
| No clickable link to the original item existed anywhere. The permalink was plain text in the audit drawer's provenance line. The only `<a>` was the health drawer's "terms" link. | `ui.js` `provenanceLine`; `/api/audit` served `provenance.permalink` only |
| `/api/query` and `/api/sentiment` served excerpts with no link. | `src/routes/query.js`, `sentiment.js` |
| The canonical permalink is already stored and already identity-filtered at ingest (`isIdentityUrl`, decision D2): `raw_posts.raw_payload->>'url'`. Retention drops it when the text is removed (Reddit keeps a slug-less permalink). | `src/collectors/normalize.js`, `src/collectors/retention.js` |
| Site-level notices the terms require (arXiv acknowledgement, NCBI disclaimer, licence links, a "modified" note) appeared nowhere. | ToS review §6E.2 |

Where excerpts are rendered (all covered by this change): the city post list (`ui.js renderPosts`), the story mini-posts (`story.js buildMiniPost`), the audit drawer and its error state (`ui.js`), and the public JSON of `POST /api/query`, `GET /api/sentiment/latest` and `GET /api/audit/:id`.

## 2. Requirements from the ToS review, by source

| Source | Requirement | How it is met |
|---|---|---|
| NPR | credit "NPR" in text and a link back to the story | credit text + per-excerpt link |
| NBC News | credit "NBCNews.com" | credit text + link |
| BBC News | credit "BBC News" with a hyperlink | credit + link (the route is switched off by the operator; any retained post is credited) |
| NYT | attribution | credit + link |
| Pew | citation: title, "Pew Research Center, Washington, D.C.", date, URL | credit text "Pew Research Center, Washington, D.C.", the publication date (`cite_date`), the link; the title is the first line of the excerpt (titles are not stored separately) |
| Wikipedia | link to the page, licence link, mark modifications | link, licence link (CC BY-SA 4.0), "excerpt shortened and redacted" note |
| Stack Overflow | "Stack Exchange" visible, CC BY-SA with link | credit "Stack Exchange", licence link, post link. **Author names are still dropped (D2): the advance attribution exception from Stack Exchange is still needed, see section 8.** |
| OWID | credit, link back, CC BY | credit, link, licence link, modified note |
| Mozilla, Internet Archive, GitHub blog, Hugging Face blog, Docker blog, Hacker News, Platformer, TLDR and the rest | credit and link back (licence, fair-use excerpting, or request) | the generic credit + link (decision D1) |
| arXiv | the acknowledgement statement on the product | `notice` on the arXiv registry entry, shown on the credits page and in the arXiv receipt |
| PubMed | NCBI disclaimer and copyright notice evident to users | `notice` + `noticeUrl` (NCBI policies page), shown the same way |

Not changed here, because they are not display attribution: setting `NCBI_EMAIL`, TLDR/Pew/GitHub back-off, the registry `termsUrl` hygiene.

## 3. Decisions (owner decisions resolved conservatively)

- **D1: credit and link on every real excerpt, for every source, not only the sources whose terms require it.** Rationale: fair-use excerpting and every "unclear" row are safer with a visible source and a link, and one rule is simpler to test than a per-source switch. Reversible: `creditFor` is the one place that decides. *Flagged for Jennifer.*
- **D2: demo posts get no credit and no link.** They are fictional (`data_sources.source_type = 'demo'`, and the frontend's bundled fallback). They are labelled "fictional demo post, no real source". A fake credit to a real source is never rendered. API: `credit: null`, `source_url: null`, `data_origin: 'demo'`.
- **D3: removed text.** When retention has blanked a post, the excerpt is the removal notice. The credit still renders; the link renders only if a URL was kept (Reddit's slug-less permalink). No new suppression logic: retention already drops the URL.
- **D4: kill-switched sources.** Posts are kept and still shown; they get the same credit and link. This PR does **not** suppress the stored excerpts of a switched-off source. Whether it should is a product/legal decision about display, separate from attribution (and the kill switch is owned by PR #46). *Flagged for Jennifer.*
- **D5: legacy rows labelled with a retired slug that has no registry entry** (e.g. the old seed rows) get `credit: null` and **no link** (a link is only ever published for the source it belongs to); the UI shows the slug exactly as before. Their correction is the data-correction script already on the owner's list.
- **D6: derived at read time from the registry, no schema change and no migration.** The credit text, licence and notices live in `source-registry.js`; the link is the stored permalink. A registry fix therefore applies to every existing post. (Migration block 077-079 is unused.)

## 4. Where each piece lives

| Piece | Stored in | Derived by |
|---|---|---|
| Credit text | registry: `creditText` (override) else `attribution` else the source `name` with a trailing "(...)" removed | `src/config/attribution.js creditFor` |
| Licence name and URL | registry: `license`, new `licenseUrl` (CC BY-SA 4.0, CC BY 4.0, CC0) | `creditFor` (a trailing "(LICENCE)" is stripped from the credit text so the licence is rendered once, as a link) |
| Notice (arXiv, NCBI) | registry: new `notice`, `noticeUrl` | `creditFor` |
| Pew citation date | registry: new `citeDate: true` | `creditFor` sets `cite_date`; the API row carries `published_at` |
| "Modified" note | licences starting "CC BY" | `creditFor` sets `modified: true` |
| Link back | `raw_posts.raw_payload->>'url'` (identity-filtered at ingest) | `safeSourceUrl(url, slug)`: the base rule is `public/js/attribution.js safeHttpUrl`, which the server imports (one function, so server and browser cannot drift): http(s) only, at most 2048 characters, no whitespace / control / invisible / bidi characters, no credentials, a real public DNS name (trailing dot stripped; letters, digits and inner hyphens per label; alphabetic or IDN last label; not an IP literal, localhost or a private suffix such as `.local`, `.internal`, `.corp`), tracking and credential query keys (`utm_*`, `fbclid`, `token`, `key`, `sig`, ...) removed, WHATWG-normalised. On top of that, for a slug: the host must be on or under one of the source's **link domains** (the registrable domain of every host its routes use, plus the registry's explicit `linkHosts` where the permalink lives elsewhere, e.g. `feeds.bbci.co.uk` -> `bbc.co.uk`), so a hostile feed item cannot make "via NPR" link to an unrelated site; and it must not be an identity link (re-checked at read time for legacy rows). The rejected value becomes `null`. |
| Publication date | `raw_payload->>'published_at'` | `safeIsoDate`: ISO-8601 shape only (V8's `Date.parse` accepts junk), served as ISO UTC or `null` |

## 5. API shape

Every post row of `POST /api/query`, `GET /api/sentiment/latest` (`recent_posts`, which also gains `source_name`) and `GET /api/audit/:id` (`post`) gains the same fields. Existing fields are unchanged (`attribution` stays). One deliberate tightening: `GET /api/audit/:id` `provenance.permalink` and `provenance.published_at` now come from the same validation as `post.source_url` / `post.published_at` (before, `permalink` was any `^https?://` value, `published_at` any string); a link that is off-source, private, credentialed or malformed, or any link of a demo post, is now `null`. `postAttribution` requires the source type and throws without it, so a demo post can never be credited by omission.

```
data_origin   'live' | 'demo'
source_url    string | null          validated permalink
published_at  string | null          raw_payload.published_at
credit        null | {
  text          string               "NPR", "Pew Research Center, Washington, D.C."
  required      boolean              the registry says the terms require a credit
  license       string | null        "CC BY-SA 4.0"
  license_url   string | null
  modified      boolean              excerpt is shortened/redacted, licence needs it said
  cite_date     boolean              render published_at (Pew)
  notice        string | null        arXiv acknowledgement, NCBI disclaimer
  notice_url    string | null
}
```

New: `GET /api/credits` returns the credit model of every registry source that has stored real posts (demo feeds and unregistered slugs excluded), plus the site notices, for `credits.html`. `/api/sources` is unchanged.

## 6. UI

- New shared pure module `public/js/attribution.js` (`PulseAttribution`, UMD, loaded before `utils.js`, which re-exports it so `story.js` and `ui.js` share it without a new factory parameter): `creditModel(post)` (pure, unit-tested) and `buildCredit(doc, post)` (DOM). It builds elements with `createElement` and `textContent` only. The link text is the destination hostname plus an arrow; `href` is set only after `safeHttpUrl` re-validates it in the browser (defence in depth); `rel="noopener noreferrer"`, `target="_blank"`.
- Every excerpt block shows a credit line directly under the text: "via NPR · npr.org ↗" plus, where relevant, "(2026-09-30)", the licence link, "excerpt shortened and redacted". The old "via X" in the meta line is removed so it is not shown twice.
- Demo posts show "fictional demo post · no real source".
- A persistent "credits" link in the header (to `credits.html`) lists every credited source with its licence and terms link, the arXiv acknowledgement and the NCBI notice, and says excerpts are shortened and redacted. `credits.html` is a separate static page with an external script and stylesheet (strict CSP: no inline script or style).

## 7. Tests

Unit: `creditFor`, `safeSourceUrl` (base rule and source binding: trailing-dot hosts, private suffixes, bidi characters, tracking keys, off-source and identity links, one shared vector set with the browser function), `postAttribution` (demo, unknown slug, missing source type), every registry source (credit never null, link domains never empty, the exact set of sources whose credit is required, notices, licence URLs), `creditModel` (including the cite date), `buildCredit` and the credits page with a fake document (no `innerHTML`, hostile text stays text, `javascript:` href refused). The recorded live responses of `collectorsRecorded.test.js` are also checked: every permalink they yield must survive the link rule for its own source, so a missing link domain cannot silently drop a source's links. Integration: query, sentiment, audit and credits routes (live row, demo row, removed text, kill-switched source, hostile and off-source URLs, identity link, unknown source, ISO dates). Playwright: credit and link on the city list, the mini-post, the audit drawer and its error state, the demo label, the credits page, the header chip at 375px, no console errors.

## 8. Open decisions for Jennifer

1. **D1** (credit on every source, even where the terms do not require one) was chosen as the conservative option.
2. **D4** (stored excerpts of a kill-switched source are still shown, credited) is not changed here; a "hide excerpts of disabled sources" rule would be a separate change.
3. **Stack Exchange:** the terms require the author and a link under CC BY-SA, or an advance exception. Author names are dropped by decision D2, so the exception request to Stack Exchange must still be sent before launch.
4. **Mozilla blog licence** was not verified in the review, so no licence is claimed for it (credit and link only).
5. **Pew title:** the stored data has no separate title, so the citation's title is the first line of the excerpt.
