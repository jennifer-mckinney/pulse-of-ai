#!/usr/bin/env bash
# Integration tests: requires the docker compose test DB (postgres_test, :5433).
# Jest's globalSetup migrates and seeds the test DB itself; we only ensure
# the container is up and accepting connections.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$(repo_root)"

start=$(date +%s)

ensure_test_db

status=0
npx jest tests/integration || status=$?

summary "INTEGRATION" "$status" "$start"
exit "$status"
