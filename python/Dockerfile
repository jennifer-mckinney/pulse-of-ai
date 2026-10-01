# syntax=docker/dockerfile:1
#
# Pulse of AI — embeddings service image (FastAPI + sentence-transformers,
# all-MiniLM-L6-v2, 384-dim vectors) on port 8000.
#
# Build (context is this python/ directory):
#   docker build -t pulse-of-ai/embeddings:local python
#
# Python 3.13, not 3.14: the pinned torch / tokenizers wheels exist for 3.13.
#
# Dependencies are HASH-LOCKED (F9-6): requirements-service.txt is generated
# by pip-compile --generate-hashes from requirements-service.in (header of
# that file has the exact command) and installed with --require-hashes, so
# a re-published or tampered wheel on PyPI or the PyTorch index fails the
# build instead of being installed. torch is the CPU-only build
# (2.12.1+cpu) from the PyTorch index, hashed for x86_64 and aarch64.
# The base image is pinned to an exact patch release AND its image digest
# (F9-6); bump both deliberately (Dependabot proposes digest bumps).
#
# Model weights are NOT baked into the image. They download on the first
# start into HF_HOME, which docker-compose.yml mounts as the named volume
# `hf_cache` — so the ~90 MB model downloads once per volume, not on every
# build, and survives container rebuilds.

# Tag: python:3.13.15-slim-bookworm
ARG PYTHON_IMAGE=python:3.13.15-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26

# ─── Stage 1: build an isolated virtualenv ───────────────────────────────────
FROM ${PYTHON_IMAGE} AS builder

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# One hash-checked install. torch==2.12.1+cpu exists only on the PyTorch CPU
# index (the lock's --extra-index-url): the default PyPI wheel drags in CUDA
# libraries (~2 GB) this CPU service never loads.
COPY requirements-service.txt .
RUN pip install --require-hashes -r requirements-service.txt

# ─── Stage 2: runtime ────────────────────────────────────────────────────────
FROM ${PYTHON_IMAGE} AS runtime

ENV PATH=/opt/venv/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/home/app/.cache/huggingface \
    EMBED_MODEL=sentence-transformers/all-MiniLM-L6-v2 \
    EMBED_MODEL_REVISION=1110a243fdf4706b3f48f1d95db1a4f5529b4d41

# Non-root runtime user. The HF cache directory is created here and owned by
# `app` so a fresh named volume mounted over it inherits that ownership.
RUN groupadd --system --gid 10001 app \
    && useradd --system --uid 10001 --gid app --create-home --home-dir /home/app app \
    && mkdir -p "${HF_HOME}" \
    && chown -R app:app /home/app

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
# Service code stays root-owned (read-only to the runtime user).
COPY embeddings_service.py ./

USER app

EXPOSE 8000

# Healthy = the model is loaded, not merely that uvicorn is up. The lifespan
# handler loads the model before uvicorn accepts connections, so the first
# start (model download) needs the long start period.
HEALTHCHECK --interval=10s --timeout=5s --start-period=600s --retries=3 \
    CMD ["python", "-c", "import json,sys,urllib.request; b=json.load(urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4)); sys.exit(0 if b.get('model_loaded') else 1)"]

# Listen on every CONTAINER interface, set explicitly here (not inherited from
# python/start.sh, whose host default is 127.0.0.1 and which is not in the
# image): the worker reaches the service as embeddings:8000 over the compose
# network, which a loopback bind inside the container would refuse. This is
# not host exposure — docker-compose.yml publishes no port for this service
# (F9-8, asserted by scripts/test/check-compose.sh and
# scripts/test/embeddings-bind.test.sh).
CMD ["uvicorn", "embeddings_service:app", "--host", "0.0.0.0", "--port", "8000"]
