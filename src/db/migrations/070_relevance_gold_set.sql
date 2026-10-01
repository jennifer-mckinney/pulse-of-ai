-- Migration 070: the relevance GOLD SET (Relevance-accuracy Stage 0, P3).
--
-- Two append-only tables for human (and LLM-proposed) labels of a stratified
-- sample of stored posts, under docs/governance/relevance-codebook.md v1:
--
-- 1. relevance_gold_items — one row per post drawn into a sample
--    (scripts/gold-sample.js): the stratum (source category × route scope ×
--    current relevance decision × writing script), the stratum population
--    and sample size, the stratum weight used for allocation and the DESIGN
--    WEIGHT N_h / n_h, the deterministic draw rank sha256(seed:post id), the
--    sampler version and seed, and the sha256 of the post text the sampler
--    saw (input_hash).
--    NO post text is copied: the labelling tool reads raw_posts at labelling
--    time and checks the hash, so text retention (and the later "remove
--    text of non-AI posts early" ruling) applies to the gold set too.
--    NO foreign key to raw_posts: the demo purge (scripts/compact.js) deletes
--    demo posts with every row referencing them, and these rows can never be
--    deleted. The sampler draws only non-demo posts.
-- 2. relevance_gold_labels — one row per label: item, label (AI_CENTRAL /
--    AI_INCIDENTAL / NOT_AI), flags (SPAM / BOT_GENERATED / LANG), labeller,
--    method (human / llm_proposed / adjudicated), the model id for
--    llm_proposed rows only, codebook_version, the input_hash of the text the
--    labeller saw (must equal the item's: checked by trigger), an optional
--    note, created_at. A correction is a NEW row; the latest per labeller
--    and item counts.
-- 3. Append-only: BEFORE UPDATE OR DELETE raises on both tables, with the
--    function migration 036 defined (forbid_append_only_change). TRUNCATE,
--    used only by the test harness, is not a row operation.
--
-- No methodology version is created or changed: this is evaluation
-- infrastructure, not a scoring rule. Additive and idempotent.

CREATE TABLE IF NOT EXISTS relevance_gold_items (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sample_id            TEXT NOT NULL CHECK (sample_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    raw_post_id          UUID NOT NULL,
    input_hash           TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    category             TEXT NOT NULL CHECK (category ~ '^[a-z_]{1,32}$'),
    scope                TEXT NOT NULL CHECK (scope IN ('filter', 'ai', 'unknown')),
    decision             TEXT NOT NULL CHECK (decision IN ('relevant', 'not_relevant', 'unscored')),
    script               TEXT NOT NULL CHECK (script IN ('latin', 'cjk', 'cyrillic', 'arabic', 'other')),
    stratum              TEXT NOT NULL,
    stratum_population   INTEGER NOT NULL CHECK (stratum_population > 0),
    stratum_sample_size  INTEGER NOT NULL CHECK (stratum_sample_size > 0),
    stratum_weight       NUMERIC NOT NULL CHECK (stratum_weight > 0),
    design_weight        NUMERIC NOT NULL CHECK (design_weight >= 1),
    draw_rank            TEXT NOT NULL CHECK (draw_rank ~ '^[0-9a-f]{64}$'),
    relevance_mv_id      UUID REFERENCES methodology_versions(id),
    sampler_version      TEXT NOT NULL CHECK (sampler_version ~ '^\d+\.\d+\.\d+$'),
    seed                 TEXT NOT NULL CHECK (btrim(seed) <> '' AND length(seed) <= 200),
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT relevance_gold_items_sample_post UNIQUE (sample_id, raw_post_id),
    CONSTRAINT relevance_gold_items_stratum_form CHECK (stratum = category || '|' || scope || '|' || decision || '|' || script),
    CONSTRAINT relevance_gold_items_sample_size CHECK (stratum_sample_size <= stratum_population)
);

CREATE INDEX IF NOT EXISTS idx_relevance_gold_items_sample ON relevance_gold_items (sample_id, draw_rank);

CREATE TABLE IF NOT EXISTS relevance_gold_labels (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    item_id           UUID NOT NULL REFERENCES relevance_gold_items(id),
    label             TEXT NOT NULL CHECK (label IN ('AI_CENTRAL', 'AI_INCIDENTAL', 'NOT_AI')),
    flags             TEXT[] NOT NULL DEFAULT '{}' CHECK (flags <@ ARRAY['SPAM', 'BOT_GENERATED', 'LANG']::TEXT[]),
    labeller          TEXT NOT NULL CHECK (btrim(labeller) <> '' AND length(labeller) <= 100),
    method            TEXT NOT NULL CHECK (method IN ('human', 'llm_proposed', 'adjudicated')),
    model_id          TEXT CHECK (model_id IS NULL OR (btrim(model_id) <> '' AND length(model_id) <= 200)),
    codebook_version  TEXT NOT NULL CHECK (codebook_version ~ '^\d+\.\d+\.\d+$'),
    input_hash        TEXT NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    note              TEXT CHECK (note IS NULL OR length(note) <= 2000),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The model is recorded for LLM proposals, and only for them.
    CONSTRAINT relevance_gold_labels_model CHECK ((method = 'llm_proposed') = (model_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_relevance_gold_labels_item ON relevance_gold_labels (item_id, labeller, created_at);

-- A label must be of the text the item was drawn with (the hash the
-- labelling tool computed from raw_posts at labelling time), and list each
-- flag once.
CREATE OR REPLACE FUNCTION relevance_gold_label_check() RETURNS trigger AS $$
DECLARE item_hash TEXT;
BEGIN
    SELECT input_hash INTO item_hash FROM relevance_gold_items WHERE id = NEW.item_id;
    IF item_hash IS NULL THEN
        RAISE EXCEPTION 'gold item % does not exist', NEW.item_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW.input_hash <> item_hash THEN
        RAISE EXCEPTION 'relevance_gold_labels: input_hash does not match the gold item (the post text changed or was removed)'
            USING ERRCODE = 'check_violation';
    END IF;
    IF cardinality(NEW.flags) <> (SELECT COUNT(DISTINCT f) FROM unnest(NEW.flags) AS f) THEN
        RAISE EXCEPTION 'relevance_gold_labels: duplicate flags %', NEW.flags USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS relevance_gold_labels_check ON relevance_gold_labels;
CREATE TRIGGER relevance_gold_labels_check BEFORE INSERT ON relevance_gold_labels
    FOR EACH ROW EXECUTE FUNCTION relevance_gold_label_check();

-- Append-only, as migration 036 (forbid_append_only_change is defined there).
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['relevance_gold_items', 'relevance_gold_labels'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION forbid_append_only_change()',
                       t || '_append_only', t);
    END LOOP;
END $$;
