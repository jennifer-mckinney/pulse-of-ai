# DRAFT — Legitimate interest assessment: user-generated sources

> **DRAFT for Jennifer McKinney's and counsel's review. Not approved. Not legal advice.**
> Prepared 2026-09-29 for PR #10 review item P10-14. Nothing in this draft changes what the system does; it records the reasoning for review.

## Scope

Sources whose items are written by members of the public rather than by an organisation publishing its own work:

| Source | Route | What is collected |
|---|---|---|
| GitHub | issue search (`AI in:title`, last 24 h) | issue title and body text |
| Hacker News | Algolia search (`AI`, stories) | story title, text or link |
| Wikipedia | talk pages via DiscussionTools | comment text |
| OpenStreetMap | diary RSS and community forum | diary entry or topic text; a diary geotag rounded to the nearest registry city |
| Reddit (#52, not yet approved) | Data API, 7 selected subreddits | submission title and self-text |

Legal basis relied on: GDPR Article 6(1)(f), legitimate interests (registered in `ingest@1.6.0`, `legal_basis`).

## 1. Purpose test — is there a legitimate interest?

- **Interest:** non-commercial research and public-interest transparency: measuring the tone, relevance and deliberative quality of public discussion about AI across categories and regions, with a published methodology and audit trail (ADR 0001 ruling 6; spec §9–§10).
- **Benefit:** aggregate insight for the public, researchers and policy readers; no individual is the object of analysis.
- **Lawful and clearly articulated:** yes, subject to each platform's terms (recorded per source in the registry and ADR 0001).

## 2. Necessity test — is the processing necessary?

- Discourse cannot be measured without the text; the text is processed to compute scores, then **kept only for its window** (P10-2): GitHub, Hacker News, Wikipedia and OpenStreetMap 90 days (spec §19), Reddit 48 hours (ruling 9); scores and audit rows stay.
- **Minimisation already in place:** collectors never request author, username or profile fields; the text is redacted before storage (e-mail addresses, @handles, Reddit u/ names, phone numbers, profile links, sign-offs, Wikipedia signatures; `ingest@1.5.0`/`1.6.0`); identity-bearing upstream ids are stored only as keyed fingerprints (D2); location is city level at most, and never inferred for a person; no profiling, no cross-platform linkage (correlation is off until a DPIA, spec §20).
- **Less intrusive alternatives considered:** keyword counts only (loses the discourse measures); sampling (kept as the per-run caps); no text display (Reddit research recommended it; Jennifer chose display, ruling 8 — see risk below).

## 3. Balancing test — do individuals' interests override?

| Factor | Assessment (draft) |
|---|---|
| Nature of data | Public posts on public platforms; may contain names mentioned in content and, rarely, special-category data a writer disclosed about themselves. |
| Reasonable expectations | Writers on public forums expect wide reading; they may not expect sentiment scoring by a third party. Stated plainly on the site and in the methodology. |
| Impact | Low for individuals: no profile, no decision about a person, aggregates only; residual risk from displayed redacted text naming third parties. |
| Vulnerable people | Not targeted; NSFW / quarantined subreddits excluded for Reddit; no minors' data sought. |
| Safeguards | Redaction, text windows, keyed provenance fingerprints, kill switches (env and database), refusal state, audit receipts, right-to-erasure path through `data_retention_log`. |

**Draft conclusion:** the legitimate interest appears to be balanced **provided** the safeguards above stay in place. Items for review:

1. **Displayed text** (all five sources, Reddit by ruling 8): redaction is not anonymisation; names mentioned in content remain. Counsel to confirm display is proportionate, or that display should be limited (e.g. snippets).
2. **Retained derived data after text removal** (ruling 9, and applied by analogy to YouTube and TikTok; the Guardian follows the default window since Jennifer's ruling of 2026-09-29, "Use normal retention"): scores and cue-word fragments stay; embeddings are deleted with the text (decision G3). Counsel to confirm retention of derived data is compatible with each platform's deletion terms and with Article 5(1)(e).
3. **Wikipedia talk pages and OSM diaries** carry more personal narrative than news items: consider shorter windows.
4. **Erasure requests:** document the operator procedure (find by provenance fingerprint, blank text, log `erasure_requested`).
5. **Transparency notice:** publish a short notice naming the sources, purposes, windows and how to object.

## Sign-off

- [ ] Jennifer McKinney (product owner)
- [ ] Counsel
