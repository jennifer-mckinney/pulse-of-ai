#!/bin/sh
# python/start.sh — activate venv and launch the embeddings FastAPI service
set -e
cd "$(dirname "$0")/.."
exec python/.venv/bin/python -m uvicorn python.embeddings_service:app \
  --host 0.0.0.0 --port 8000 --reload
