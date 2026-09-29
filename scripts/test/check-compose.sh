#!/usr/bin/env bash
# scripts/test/check-compose.sh — policy checks on the RESOLVED compose config.
#
#   bash scripts/test/check-compose.sh
#
# Resolves docker-compose.yml with every profile (full + demo) and asserts
# the security / operations policy the one-command standup relies on. It
# runs `docker compose config` only (no daemon calls, nothing started), in a
# clean environment with dummy secrets, so the shipped defaults are checked
# — never a developer's .env. Needs docker compose v2 and jq.
#
# Checks:
#   F9-1  every published port has an explicit host IP, and by default that
#         IP is the loopback address (nothing listens on 0.0.0.0)
#   F9-2  collector credentials are set on `worker` only; web, migrate and
#         populate get the base secrets (DB, Redis, AUDIT_HASH_KEY,
#         CORRELATION_SALT) and nothing else credential-shaped
#
# CI runs it in the docker-images job (.github/workflows/ci.yml);
# tests/integration/composeConfig.test.js runs it under jest.
#
# Exit code: 0 when every check passed, 1 otherwise.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v jq >/dev/null 2>&1 || { echo "check-compose: jq is required" >&2; exit 2; }

# Clean environment: only what the docker CLI itself needs, plus dummy
# values for the required secrets (never real ones).
cfg=$(env -i PATH="$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
    ${DOCKER_CONTEXT:+DOCKER_CONTEXT="$DOCKER_CONTEXT"} \
    POSTGRES_PASSWORD=compose-check REDIS_PASSWORD=compose-check \
    docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" \
        --env-file /dev/null -p compose-check --profile full --profile demo \
        config --format json)

FAILED=0
PASSED=0
check() {   # check NAME OFFENDERS — OFFENDERS: newline-separated, empty = pass
    local name=$1 offenders=${2:-}
    if [[ -z "$offenders" ]]; then
        PASSED=$((PASSED + 1)); printf 'ok   %s\n' "$name"
    else
        FAILED=$((FAILED + 1)); printf 'FAIL %s\n' "$name"
        printf '%s\n' "$offenders" | sed 's/^/     /'
    fi
}

# ─── F9-1: no port without an explicit host IP; loopback by default ──────────
no_ip=$(jq -r '.services | to_entries[] | .key as $s
    | (.value.ports // [])[] | select((.host_ip // "") == "")
    | "\($s): \(.published)->\(.target) has no host IP (would bind 0.0.0.0)"' <<< "$cfg")
check "every published port has an explicit host IP" "$no_ip"
not_lo=$(jq -r '.services | to_entries[] | .key as $s
    | (.value.ports // [])[] | select((.host_ip // "") != "127.0.0.1")
    | "\($s): \(.published)->\(.target) binds \(.host_ip // "0.0.0.0")"' <<< "$cfg")
check "by default every published port binds 127.0.0.1" "$not_lo"

# ─── F9-2: collector credentials reach the worker only ───────────────────────
# Base secrets every app role needs; any OTHER credential-shaped variable is
# a collector credential and may be set on `worker` only (web is the
# internet-facing process; migrate / populate need none).
BASE_SECRETS='["POSTGRES_PASSWORD","REDIS_PASSWORD","AUDIT_HASH_KEY","CORRELATION_SALT"]'
CRED_RE='(_TOKEN|_SECRET|_API_KEY|_KEY|_PASSWORD|_CLIENT_SECRET)$'
leaks=$(jq -r --argjson base "$BASE_SECRETS" --arg re "$CRED_RE" '.services | to_entries[]
    | select(.key != "worker") | .key as $s
    | (.value.environment // {}) | keys[]
    | select(test($re)) | select(. as $k | $base | index($k) | not)
    | "\($s) receives collector credential \(.)"' <<< "$cfg")
check "collector credentials are passed to worker only" "$leaks"
missing=$(jq -r '(.services.worker.environment // {}) as $w
    | ["TWITTER_BEARER_TOKEN","GITHUB_TOKEN","SEMANTIC_SCHOLAR_API_KEY"][]
    | select(. as $k | $w | has($k) | not)
    | "worker lacks \(.) (x-collector-env)"' <<< "$cfg")
check "worker receives the collector credentials (x-collector-env)" "$missing"

#@@CHECKS@@

printf '\ncheck-compose: %d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
