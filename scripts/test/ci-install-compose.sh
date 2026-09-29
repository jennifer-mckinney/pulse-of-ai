#!/usr/bin/env bash
# scripts/test/ci-install-compose.sh — CI only: install a pinned Docker
# Compose plugin that meets the repo's minimum, then run the same gate
# standup uses (check_docker, scripts/lib/stack.sh).
#
#   bash scripts/test/ci-install-compose.sh
#
# Why: docker-compose.yml sets build.provenance / build.sbom, which need
# Compose 2.39.0+ (STACK_COMPOSE_MIN_VERSION). GitHub's ubuntu-24.04 image
# (20260920) ships Compose 2.38.2, which rejects the file — every compose
# call in CI failed ("additional properties 'provenance', 'sbom' not
# allowed"). The binary is pinned by version AND SHA-256 (GitHub's release
# asset digest), like every image is pinned by digest (F9-6); it goes to
# ~/.docker/cli-plugins, which the docker CLI prefers over the system plugin.
#
# Linux x86_64 only (GitHub-hosted ubuntu runners). Exit 1 on any failure.

set -euo pipefail

COMPOSE_VERSION=v5.5.1
COMPOSE_SHA256=db1889184726840f75c4f9c001048430d4f25b3be3cb084d3ddd762bc0aed576   # docker-compose-linux-x86_64

[[ "$(uname -s)-$(uname -m)" == "Linux-x86_64" ]] \
    || { echo "ci-install-compose: Linux x86_64 only (got $(uname -s)-$(uname -m))" >&2; exit 1; }

dest="$HOME/.docker/cli-plugins/docker-compose"
tmp="$dest.tmp.$$"
mkdir -p "$(dirname "$dest")"
trap 'rm -f "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp" \
    "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64"
echo "${COMPOSE_SHA256}  ${tmp}" | sha256sum -c - >/dev/null \
    || { echo "ci-install-compose: SHA-256 mismatch for compose ${COMPOSE_VERSION}" >&2; exit 1; }
chmod 755 "$tmp"
mv "$tmp" "$dest"
docker compose version

# The same prerequisite gate as standup / teardown (minor-version aware).
# shellcheck source=scripts/lib/stack.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/stack.sh"
check_docker
echo "ci-install-compose: compose $COMPOSE_VERSION meets the minimum $STACK_COMPOSE_MIN_VERSION"
