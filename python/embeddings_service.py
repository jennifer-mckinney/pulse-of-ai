"""
python/embeddings_service.py
Embedding service for Pulse of AI.

Exposes an OpenAI-compatible POST /embeddings endpoint using sentence-transformers
(all-MiniLM-L6-v2, 384 dimensions).  The Node.js pipeline calls this service via
src/pipeline/embeddings.js.

PRODUCTION:
    For maximum throughput, run via Infinity for dynamic batching + ctranslate2:
        infinity_emb start \\
            --model-name-or-path sentence-transformers/all-MiniLM-L6-v2 \\
            --batch-size 64 --model-warmup true
    This file provides an equivalent fallback for environments without Infinity.

DEVELOPMENT:
    uvicorn python.embeddings_service:app --port 8000

TESTS:
    python -m pytest python/tests/test_embeddings.py -v
"""

import os
import time
from contextlib import asynccontextmanager
from typing import List

import numpy as np
from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

# ─── Configuration ────────────────────────────────────────────────────────────

MODEL_NAME = os.getenv("EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
BATCH_SIZE = int(os.getenv("EMBED_BATCH_SIZE", "64"))

# Module-level model instance — loaded once at startup, shared across requests
_model: SentenceTransformer | None = None
_model_load_time: float | None = None


# ─── Model lifecycle ─────────────────────────────────────────────────────────

def get_model() -> SentenceTransformer:
    """Lazy-load the embedding model on first request and cache it."""
    global _model, _model_load_time
    if _model is None:
        load_start = time.time()
        _model = SentenceTransformer(MODEL_NAME)
        _model_load_time = time.time() - load_start
    return _model


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    FastAPI lifespan handler — replaces deprecated @app.on_event("startup").
    Pre-loads the embedding model once at startup so the first HTTP request
    does not pay the cold-start penalty.
    """
    get_model()   # warm up on startup
    yield         # application runs here
    # (no teardown needed — model is in-process memory)


app = FastAPI(
    title="Pulse of AI — Embeddings Service",
    version="1.0.0",
    description="OpenAI-compatible embedding endpoint backed by sentence-transformers",
    lifespan=lifespan,
)


# ─── Request/response models ──────────────────────────────────────────────────

class EmbeddingRequest(BaseModel):
    input: List[str]
    model: str = MODEL_NAME


class EmbeddingObject(BaseModel):
    index: int
    embedding: List[float]
    object: str = "embedding"


class EmbeddingResponse(BaseModel):
    object: str = "list"
    model: str
    data: List[EmbeddingObject]
    usage: dict


# ─── Routes ──────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """
    Health check endpoint.
    Returns model load status and service configuration.
    Used by the Node.js pipeline before submitting batches.
    """
    model_loaded = _model is not None
    return JSONResponse({
        "status":           "healthy",
        "model":            MODEL_NAME,
        "model_loaded":     model_loaded,
        "load_time_s":      round(_model_load_time, 2) if _model_load_time else None,
        "embedding_dims":   384,
        "batch_size":       BATCH_SIZE,
    })


@app.post("/embeddings", response_model=EmbeddingResponse)
async def create_embeddings(request: EmbeddingRequest):
    """
    Generate embeddings for a list of input strings.

    OpenAI-compatible endpoint — the same request/response format used by
    Infinity, so the service can be swapped without changing the Node.js client.

    Request:
        { "input": ["text one", "text two"], "model": "..." }

    Response:
        { "object": "list", "model": "...",
          "data": [{ "index": 0, "embedding": [float, ...] }],
          "usage": { "prompt_tokens": N, "total_tokens": N } }
    """
    if not request.input:
        raise HTTPException(status_code=400, detail="input must be a non-empty list")

    model = get_model()

    # Encode in batches to avoid OOM on large payloads
    embeddings: np.ndarray = model.encode(
        request.input,
        batch_size=BATCH_SIZE,
        convert_to_numpy=True,
        normalize_embeddings=True,   # cosine similarity ready without further normalisation
    )

    # Approximate token count (sentence-transformers word-pieces average ~1.3 tokens/word)
    total_tokens = sum(len(text.split()) for text in request.input)

    data = [
        EmbeddingObject(index=i, embedding=vec.tolist())
        for i, vec in enumerate(embeddings)
    ]

    return EmbeddingResponse(
        model=MODEL_NAME,
        data=data,
        usage={"prompt_tokens": total_tokens, "total_tokens": total_tokens},
    )
