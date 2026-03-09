"""
python/tests/test_embeddings.py
Tests for the FastAPI embedding service (python/embeddings_service.py).

Uses httpx's async test client — no real HTTP server is started.
Run: python -m pytest python/tests/test_embeddings.py -v

These tests verify:
  - GET  /health returns correct shape
  - POST /embeddings returns correct OpenAI-compatible shape
  - Embedding dimensions are correct (384 for all-MiniLM-L6-v2)
  - Batch input works correctly
  - Empty input is rejected with 400
  - Embeddings are L2-normalised (cosine similarity ready)
"""

import math
import pytest
from httpx import AsyncClient, ASGITransport

# Import the FastAPI app directly — no running server required
from python.embeddings_service import app, BATCH_SIZE


# ─── Client fixture ───────────────────────────────────────────────────────────

@pytest.fixture
async def client():
    """Async test client for the embeddings FastAPI app."""
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
        yield ac


# ─── Health endpoint ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_health_returns_200(client):
    response = await client.get("/health")
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_health_returns_correct_shape(client):
    response = await client.get("/health")
    body = response.json()

    assert "status"       in body
    assert "model"        in body
    assert "model_loaded" in body
    assert "embedding_dims" in body


@pytest.mark.asyncio
async def test_health_reports_healthy_status(client):
    response = await client.get("/health")
    assert response.json()["status"] == "healthy"


@pytest.mark.asyncio
async def test_health_reports_correct_embedding_dims(client):
    response = await client.get("/health")
    assert response.json()["embedding_dims"] == 384


# ─── Embeddings endpoint ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_embeddings_returns_200_for_valid_input(client):
    response = await client.post("/embeddings", json={"input": ["Hello world"]})
    assert response.status_code == 200


@pytest.mark.asyncio
async def test_embeddings_response_has_openai_compatible_shape(client):
    response = await client.post("/embeddings", json={"input": ["test text"]})
    body = response.json()

    assert body["object"] == "list"
    assert "model"  in body
    assert "data"   in body
    assert "usage"  in body
    assert len(body["data"]) == 1
    assert body["data"][0]["object"] == "embedding"
    assert body["data"][0]["index"]  == 0
    assert isinstance(body["data"][0]["embedding"], list)


@pytest.mark.asyncio
async def test_embeddings_returns_384_dimensions(client):
    response = await client.post("/embeddings", json={"input": ["AI discourse analysis"]})
    embedding = response.json()["data"][0]["embedding"]

    assert len(embedding) == 384


@pytest.mark.asyncio
async def test_embeddings_values_are_floats(client):
    response = await client.post("/embeddings", json={"input": ["test"]})
    embedding = response.json()["data"][0]["embedding"]

    for value in embedding[:10]:   # spot-check first 10 values
        assert isinstance(value, float)


@pytest.mark.asyncio
async def test_embeddings_are_l2_normalised(client):
    """
    Normalised embeddings have a magnitude (L2 norm) of approximately 1.0.
    This enables cosine similarity via dot product without explicit normalisation.
    """
    response = await client.post(
        "/embeddings", json={"input": ["machine learning ethics"]},
    )
    embedding = response.json()["data"][0]["embedding"]

    magnitude = math.sqrt(sum(v ** 2 for v in embedding))
    assert abs(magnitude - 1.0) < 1e-3, f"Expected norm ≈ 1.0, got {magnitude}"


@pytest.mark.asyncio
async def test_embeddings_handles_batch_input(client):
    texts = [
        "AI is transforming society",
        "Ethics in machine learning",
        "Neural networks and deep learning",
    ]
    response = await client.post("/embeddings", json={"input": texts})
    body = response.json()

    assert len(body["data"]) == 3
    for i, item in enumerate(body["data"]):
        assert item["index"] == i
        assert len(item["embedding"]) == 384


@pytest.mark.asyncio
async def test_embeddings_index_matches_input_order(client):
    """Each output embedding's index must match its position in the input list."""
    texts = ["first", "second", "third"]
    response = await client.post("/embeddings", json={"input": texts})

    for i, item in enumerate(response.json()["data"]):
        assert item["index"] == i


@pytest.mark.asyncio
async def test_embeddings_different_texts_produce_different_vectors(client):
    response = await client.post(
        "/embeddings",
        json={"input": ["cats are friendly animals", "quantum computing hardware"]},
    )
    emb_a = response.json()["data"][0]["embedding"]
    emb_b = response.json()["data"][1]["embedding"]

    # Dot product of L2-normalised vectors = cosine similarity
    cosine_sim = sum(a * b for a, b in zip(emb_a, emb_b))
    # Unrelated texts should have cosine similarity well below 1.0
    assert cosine_sim < 0.9, f"Expected dissimilar texts; got cosine sim = {cosine_sim:.4f}"


@pytest.mark.asyncio
async def test_embeddings_similar_texts_produce_similar_vectors(client):
    """Semantically similar texts should have higher cosine similarity."""
    response = await client.post(
        "/embeddings",
        json={"input": [
            "artificial intelligence ethics",
            "AI ethical considerations",
        ]},
    )
    emb_a = response.json()["data"][0]["embedding"]
    emb_b = response.json()["data"][1]["embedding"]

    cosine_sim = sum(a * b for a, b in zip(emb_a, emb_b))
    # Semantically similar texts should be relatively close
    assert cosine_sim > 0.7, f"Expected similar texts; got cosine sim = {cosine_sim:.4f}"


@pytest.mark.asyncio
async def test_embeddings_rejects_empty_input(client):
    response = await client.post("/embeddings", json={"input": []})
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_embeddings_usage_contains_token_counts(client):
    response = await client.post(
        "/embeddings", json={"input": ["hello world this is a test"]},
    )
    usage = response.json()["usage"]

    assert "prompt_tokens" in usage
    assert "total_tokens"  in usage
    assert usage["total_tokens"] > 0
