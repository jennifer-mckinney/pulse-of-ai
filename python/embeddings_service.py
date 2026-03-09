"""
python/embeddings_service.py
Embedding service for Pulse of AI.

PRODUCTION: Run via Infinity for dynamic batching and ctranslate2 acceleration:
    infinity_emb start \\
        --model-name-or-path sentence-transformers/all-MiniLM-L6-v2 \\
        --batch-size 64 \\
        --model-warmup true

    Exposes OpenAI-compatible API on :8000
    POST /embeddings with { "input": [...texts], "model": "..." }

DEVELOPMENT FALLBACK: This file provides a minimal FastAPI service for
environments where Infinity is not yet installed. Phase A: health endpoint only.
Full embedding implementation comes in Phase D (TDD — test first).
"""

import os
from fastapi import FastAPI
from fastapi.responses import JSONResponse

app = FastAPI(title="Pulse of AI — Embeddings Service", version="0.1.0")

MODEL_NAME = os.getenv("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
_model = None  # lazy-loaded in Phase D


@app.get("/health")
async def health():
    """
    Health check endpoint.
    Returns model load status. The Node.js pipeline checks this before
    submitting embedding requests.
    """
    return JSONResponse({
        "status": "healthy",
        "model": MODEL_NAME,
        "model_loaded": _model is not None,
        "note": "Phase A skeleton — full embedding support implemented in Phase D"
    })


# Phase D: POST /embeddings will be added here after test is written first.
# Signature will match OpenAI embeddings API for drop-in compatibility with Infinity.
# See: tests/python/test_embeddings.py (to be written in Phase D)
