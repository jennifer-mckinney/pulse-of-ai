-- Migration 012: register embedding@1.0.0 and record it on every vector (P9-5).
--
-- python/embeddings_service.py now loads sentence-transformers/all-MiniLM-L6-v2
-- at a pinned Hugging Face commit (EMBED_MODEL_REVISION) instead of the moving
-- main branch. That pin is methodology: it decides every stored vector, so it
-- is registered here like the other scoring components.
--
-- Mirrors the embedding@1.0.0 entry of src/config/methodology-registry.js
-- FIELD FOR FIELD (tests/unit/pure/methodologyRegistry.test.js parses this
-- file). effective_from = clock_timestamp() (see 011: one transaction applies
-- every pending migration). Idempotent: ON CONFLICT DO NOTHING / IF NOT EXISTS.
--
-- Additive column: post_embeddings.methodology_version names the embedding
-- methodology version that produced each vector. Nullable — vectors stored
-- before this migration (or under a non-registered model/revision override)
-- carry NULL rather than a version they may not match.

-- embedding@1.0.0
INSERT INTO methodology_versions (component, version, model_name, config, justification, effective_from)
VALUES (
    'embedding',
    '1.0.0',
    'sentence-transformers/all-MiniLM-L6-v2',
    $cfg${
    "revision": "1110a243fdf4706b3f48f1d95db1a4f5529b4d41",
    "dimensions": 384,
    "normalize_embeddings": true,
    "library": "sentence-transformers==2.7.0",
    "service": "python/embeddings_service.py",
    "revision_env": "EMBED_MODEL_REVISION"
}$cfg$::jsonb,
    $just$Sentence embeddings for semantic search and discourse novelty come from all-MiniLM-L6-v2 (Reimers & Gurevych 2019; 384 dimensions, L2-normalised so cosine similarity is a dot product), served by python/embeddings_service.py. The model is loaded at a fixed Hugging Face commit (revision), not the moving main branch, so a vector can always be traced to, and regenerated from, the exact weights that produced it; each stored vector records this methodology version. Changing the model or its revision changes the vectors, so it ships as a new version row.$just$,
    clock_timestamp()
)
ON CONFLICT (component, version) DO NOTHING;

ALTER TABLE post_embeddings
    ADD COLUMN IF NOT EXISTS methodology_version TEXT;
