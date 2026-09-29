# syntax=docker/dockerfile:1
#
# Pulse of AI — embeddings service image (FastAPI + sentence-transformers,
# all-MiniLM-L6-v2, 384-dim vectors) on port 8000.
#
# Build (context is this python/ directory):
#   docker build -t pulse-of-ai/embeddings:local python
#
# Python 3.13, not 3.14: the pinned torch / tokenizers wheels exist for 3.13.
# The base image is pinned to an exact patch release; bump it deliberately.
#
# Model weights are NOT baked into the image. They download on the first
# start into HF_HOME, which docker-compose.yml mounts as the named volume
# `hf_cache` — so the ~90 MB model downloads once per volume, not on every
# build, and survives container rebuilds.

ARG PYTHON_IMAGE=python:3.13.15-slim-bookworm
ARG TORCH_VERSION=2.12.1

# ─── Stage 1: build an isolated virtualenv ───────────────────────────────────
FROM ${PYTHON_IMAGE} AS builder
ARG TORCH_VERSION

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

# CPU-only torch first, from the PyTorch index: the default PyPI wheel on
# x86_64 drags in CUDA libraries (~2 GB) this CPU service never loads.
RUN pip install --index-url https://download.pytorch.org/whl/cpu "torch==${TORCH_VERSION}"

COPY requirements-service.txt .
RUN pip install -r requirements-service.txt

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

CMD ["uvicorn", "embeddings_service:app", "--host", "0.0.0.0", "--port", "8000"]
