-- Migration 041: terms snapshots keep the terms TEXT (PR #22 principal
-- P1-13, grumpy #15).
--
-- A SHA-256 of the raw HTML is not evidence: nonces, build ids and A/B
-- scripts change it on every fetch, and the content was not kept. Each
-- fetched snapshot now also stores the normalised visible text of the page
-- (scripts, styles, comments and tags removed, entities decoded, whitespace
-- collapsed — src/collectors/terms-text.js, version terms-text@1) and the
-- SHA-256 of THAT text, which is reproducible from the stored text and
-- stable while the terms are unchanged. A changed text hash opens a
-- terms_changed alert. The raw-HTML hash stays for continuity.
-- Additive; the append-only trigger of migration 036 still applies.
ALTER TABLE source_terms_snapshots ADD COLUMN IF NOT EXISTS terms_text TEXT;
ALTER TABLE source_terms_snapshots ADD COLUMN IF NOT EXISTS text_sha256 TEXT;
ALTER TABLE source_terms_snapshots ADD COLUMN IF NOT EXISTS normaliser TEXT;
