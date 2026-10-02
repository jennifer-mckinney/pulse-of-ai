-- Migration 070: the relevance GOLD SET (Relevance-accuracy Stage 0, P3).
--
-- Two append-only tables for human (and LLM-proposed) labels of a stratified
-- sample of stored posts, under docs/governance/relevance-codebook.md v1:
--
-- 1. relevance_gold_items: one row per post drawn into a sample
--    (scripts/gold-sample.js): the stratum (source category x route scope x
--    current relevance decision x writing script), the stratum population
--    and sample size, the stratum weight used for allocation and the DESIGN
--    WEIGHT N_h / n_h, the deterministic draw rank sha256(seed:post id), the
--    sampler version and seed, and input_hash, the KEYED fingerprint
--    HMAC-SHA256(GOLD_HASH_KEY or AUDIT_HASH_KEY, text) of the post text the
--    sampler saw. It is keyed so it cannot be used to confirm that a person
--    wrote a guessed text.
--    NO post text is copied: the labelling tool reads raw_posts at labelling
--    time and checks the hash, so text retention (and the later "remove
--    text of non-AI posts early" ruling) applies to the gold set too.
--    NO foreign key to raw_posts: the demo purge (scripts/compact.js) deletes
--    demo posts with every row referencing them, and these rows can never be
--    deleted. The sampler draws only non-demo posts.
-- 2. relevance_gold_labels: one row per label: item, label (AI_CENTRAL /
--    AI_INCIDENTAL / NOT_AI), flags (SPAM / BOT_GENERATED / LANG), labeller,
--    method (human / llm_proposed / adjudicated), the model id for
--    llm_proposed rows only, codebook_version, the input_hash of the text the
--    labeller saw (must equal the item's: checked by trigger), an optional
--    short note (at most 200 characters; the tool refuses a note that quotes
--    the post), seq (a strict order within the table: a correction is a NEW
--    row and the highest seq per labeller and item counts), created_at.
--    Labeller names are namespaced by method: a name starting "llm:" is for
--    llm_proposed labels and for nothing else (a model's labels can never
--    pose as, or collapse into, a human labeller's).
-- 3. Append-only: BEFORE UPDATE OR DELETE raises on both tables, with ONE
--    exception, the erasure path below. BEFORE TRUNCATE raises too, unless
--    the transaction sets pulse.gold_allow_truncate = 'on' (the test harness
--    does). These are guard rails against accidents and misuse by the
--    application, NOT a boundary against the table owner (who can ALTER the
--    table or disable triggers): the gold tools are local-only and the
--    owning role must not be given to them in a shared environment.
-- 4. ERASURE (GDPR): an erasure request, or text removal under the retention
--    rulings, must not leave a permanent link to the person's text.
--    gold_erase_post(post id) blanks raw_post_id and input_hash on the item,
--    replaces its draw_rank (sha256(seed:post id), which would re-link the
--    item to the post) with a random unlinkable value,
--    and input_hash and note on its labels, and stamps erased_at. Nothing
--    else changes (stratum, weights, labels and flags are statistics about
--    the sample, kept). An erased item can no longer be labelled.
--    scripts/gold-erase.js runs it for one post, or for every post whose text
--    is gone (--removed).
--
-- No methodology version is created or changed: this is evaluation
-- infrastructure, not a scoring rule. Additive and idempotent.

CREATE TABLE IF NOT EXISTS relevance_gold_items (
    id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sample_id            TEXT NOT NULL CHECK (sample_id ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
    raw_post_id          UUID,
    input_hash           TEXT CHECK (input_hash ~ '^[0-9a-f]{64}$'),
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
    erased_at            TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT relevance_gold_items_sample_post UNIQUE (sample_id, raw_post_id),
    CONSTRAINT relevance_gold_items_stratum_form CHECK (stratum = category || '|' || scope || '|' || decision || '|' || script),
    CONSTRAINT relevance_gold_items_sample_size CHECK (stratum_sample_size <= stratum_population),
    -- Live (post id and hash present) or erased (both gone, stamped), never half.
    CONSTRAINT relevance_gold_items_erasure CHECK (
        (erased_at IS NULL AND raw_post_id IS NOT NULL AND input_hash IS NOT NULL)
        OR (erased_at IS NOT NULL AND raw_post_id IS NULL AND input_hash IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_relevance_gold_items_sample ON relevance_gold_items (sample_id, draw_rank);

CREATE TABLE IF NOT EXISTS relevance_gold_labels (
    id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    seq               BIGSERIAL NOT NULL,
    item_id           UUID NOT NULL REFERENCES relevance_gold_items(id),
    label             TEXT NOT NULL CHECK (label IN ('AI_CENTRAL', 'AI_INCIDENTAL', 'NOT_AI')),
    flags             TEXT[] NOT NULL DEFAULT '{}' CHECK (flags <@ ARRAY['SPAM', 'BOT_GENERATED', 'LANG']::TEXT[]),
    labeller          TEXT NOT NULL CHECK (btrim(labeller) <> '' AND length(labeller) <= 100),
    method            TEXT NOT NULL CHECK (method IN ('human', 'llm_proposed', 'adjudicated')),
    model_id          TEXT CHECK (model_id IS NULL OR (btrim(model_id) <> '' AND length(model_id) <= 200)),
    codebook_version  TEXT NOT NULL CHECK (codebook_version ~ '^\d+\.\d+\.\d+$'),
    input_hash        TEXT CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    note              TEXT CHECK (note IS NULL OR length(note) <= 200),
    erased_at         TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- The model is recorded for LLM proposals, and only for them.
    CONSTRAINT relevance_gold_labels_model CHECK ((method = 'llm_proposed') = (model_id IS NOT NULL)),
    -- The "llm:" labeller namespace belongs to llm_proposed labels alone.
    CONSTRAINT relevance_gold_labels_namespace CHECK ((method = 'llm_proposed') = (labeller LIKE 'llm:%')),
    CONSTRAINT relevance_gold_labels_erasure CHECK (
        (erased_at IS NULL AND input_hash IS NOT NULL)
        OR (erased_at IS NOT NULL AND input_hash IS NULL AND note IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_relevance_gold_labels_seq ON relevance_gold_labels (seq);
CREATE INDEX IF NOT EXISTS idx_relevance_gold_labels_item ON relevance_gold_labels (item_id, labeller, seq);

-- A label must be of the text the item was drawn with (the hash the
-- labelling tool computed from raw_posts at labelling time), on an item that
-- has not been erased, and list each flag once.
CREATE OR REPLACE FUNCTION relevance_gold_label_check() RETURNS trigger AS $$
DECLARE item_row relevance_gold_items%ROWTYPE;
BEGIN
    -- FOR SHARE: a concurrent gold_erase_post cannot commit between this check and the insert.
    SELECT * INTO item_row FROM relevance_gold_items WHERE id = NEW.item_id FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'gold item % does not exist', NEW.item_id USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF item_row.erased_at IS NOT NULL THEN
        RAISE EXCEPTION 'relevance_gold_labels: gold item % was erased and can no longer be labelled', NEW.item_id
            USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.input_hash IS DISTINCT FROM item_row.input_hash THEN
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

-- Append-only, with the one erasure exception: an UPDATE is allowed only
-- inside gold_erase_post (pulse.gold_erasure = 'on', set LOCAL to its
-- transaction) and only when it blanks the erasable columns and stamps
-- erased_at; DELETE is never allowed.
CREATE OR REPLACE FUNCTION relevance_gold_guard() RETURNS trigger AS $$
DECLARE erasable TEXT[];
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION '% is append-only: DELETE is not allowed', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF COALESCE(current_setting('pulse.gold_erasure', true), '') <> 'on' THEN
        RAISE EXCEPTION '% is append-only: UPDATE is allowed only through gold_erase_post()', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF TG_TABLE_NAME = 'relevance_gold_items' THEN
        erasable := ARRAY['raw_post_id', 'input_hash', 'draw_rank', 'erased_at'];
    ELSE
        erasable := ARRAY['input_hash', 'note', 'erased_at'];
    END IF;
    IF OLD.erased_at IS NOT NULL THEN
        RAISE EXCEPTION '% is append-only: an erased row cannot change again', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF (to_jsonb(NEW) - erasable) IS DISTINCT FROM (to_jsonb(OLD) - erasable)
       OR NEW.erased_at IS NULL OR NEW.input_hash IS NOT NULL THEN
        RAISE EXCEPTION '% is append-only: only erasure may change a row', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION relevance_gold_truncate_guard() RETURNS trigger AS $$
BEGIN
    IF COALESCE(current_setting('pulse.gold_allow_truncate', true), '') <> 'on' THEN
        RAISE EXCEPTION '% is append-only: TRUNCATE is not allowed', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['relevance_gold_items', 'relevance_gold_labels'] LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_append_only', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION relevance_gold_guard()',
                       t || '_append_only', t);
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
        EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION relevance_gold_truncate_guard()',
                       t || '_no_truncate', t);
    END LOOP;
END $$;

-- The erasure path. Returns the number of items erased (0 when the post was
-- never sampled or was already erased). Labels keep their label, flags,
-- labeller and method; their input_hash and note go.
CREATE OR REPLACE FUNCTION gold_erase_post(p_raw_post_id UUID) RETURNS INTEGER AS $$
DECLARE n INTEGER;
BEGIN
    PERFORM set_config('pulse.gold_erasure', 'on', true);
    UPDATE relevance_gold_labels
       SET input_hash = NULL, note = NULL, erased_at = NOW()
     WHERE erased_at IS NULL
       AND item_id IN (SELECT id FROM relevance_gold_items WHERE raw_post_id = p_raw_post_id);
    UPDATE relevance_gold_items
       SET raw_post_id = NULL, input_hash = NULL, erased_at = NOW(),
           draw_rank = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
     WHERE raw_post_id = p_raw_post_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    PERFORM set_config('pulse.gold_erasure', 'off', true);
    RETURN n;
END;
$$ LANGUAGE plpgsql;
