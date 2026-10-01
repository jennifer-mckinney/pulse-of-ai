#!/bin/sh
# python/start.sh — activate venv and launch the embeddings FastAPI service
# on the HOST (local development).
#
# The API is UNAUTHENTICATED: anyone who can reach it can burn this machine's
# CPU through POST /embeddings. It therefore binds the loopback interface by
# default. EMBEDDINGS_HOST opts in to another address (e.g. 0.0.0.0 to serve
# the LAN) — deliberately, never by default.
#
# The compose `embeddings` container does NOT use this script (python/
# .dockerignore excludes it): python/Dockerfile's CMD sets --host 0.0.0.0
# explicitly, which the compose network needs, and compose publishes no port.
set -e
cd "$(dirname "$0")/.."

# Empty counts as unset, so `EMBEDDINGS_HOST=` cannot widen the bind.
host="${EMBEDDINGS_HOST:-127.0.0.1}"

case "$host" in
    127.0.0.1 | localhost | ::1) ;;
    *)
        echo "WARNING: embeddings service binding $host (EMBEDDINGS_HOST) —" \
            "the API is unauthenticated; anyone who can reach this address can use it." >&2
        ;;
esac

exec python/.venv/bin/python -m uvicorn python.embeddings_service:app \
    --host "$host" --port 8000 --reload
