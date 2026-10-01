#!/usr/bin/env bash
# scripts/test/embeddings-bind.test.sh — the embeddings service's listen
# address (security finding: python/start.sh bound the UNAUTHENTICATED
# FastAPI service to 0.0.0.0 on the host).
#
#   bash scripts/test/embeddings-bind.test.sh      (any bash >= 3.2)
#
# Runs the REAL python/start.sh, copied into a scratch tree whose
# python/.venv/bin/python is a stub that prints its argv, so nothing is
# started and no virtualenv is needed. Asserts:
#   - the host default is 127.0.0.1 (empty EMBEDDINGS_HOST counts as unset);
#   - EMBEDDINGS_HOST overrides it, with a stderr warning for a
#     non-loopback address;
#   - the rest of the uvicorn command line is unchanged;
#   - the container keeps its explicit 0.0.0.0 bind in python/Dockerfile's
#     CMD (it must not inherit start.sh's host default: the compose network
#     reaches it as embeddings:8000), and start.sh stays out of the image.
# The "compose publishes no embeddings port" half is scripts/test/
# check-compose.sh (F9-8), which needs docker compose.
#
# tests/unit/pure/embeddingsBind.test.js runs this file from jest, so
# `npm run verify` covers it; CI also runs it directly (.github/workflows/ci.yml).
#
# Exit code: 0 when every case passed, 1 otherwise.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PASSED=0
FAILED=0
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/embeddings-bind-test.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSED=$((PASSED + 1)); printf 'ok   %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# assert_eq NAME EXPECTED ACTUAL
assert_eq() {
    if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "expected [$2], got [$3]"; fi
}

# ─── Scratch repo: the real start.sh + a stub interpreter ────────────────────
mkdir -p "$SCRATCH/repo/python/.venv/bin" "$SCRATCH/elsewhere"
cp "$ROOT/python/start.sh" "$SCRATCH/repo/python/start.sh"
cat > "$SCRATCH/repo/python/.venv/bin/python" <<'STUB'
#!/bin/sh
# Stub interpreter: record the working directory and argv, one per line.
echo "cwd=$(pwd -P)"
for a in "$@"; do echo "arg=$a"; done
STUB
chmod +x "$SCRATCH/repo/python/.venv/bin/python"
REPO_REAL="$(cd "$SCRATCH/repo" && pwd -P)"

# run_start [VAR=value ...]: run start.sh with /bin/sh (its shebang) from an
# unrelated directory, in a clean environment plus the given assignments.
# Sets OUT (stdout), ERR (stderr) and STATUS.
run_start() {
    OUT=$(cd "$SCRATCH/elsewhere" && env -i PATH="$PATH" "$@" \
        sh "$SCRATCH/repo/python/start.sh" 2>"$SCRATCH/stderr")
    STATUS=$?
    ERR=$(cat "$SCRATCH/stderr")
}

# host_arg: the value that follows --host in the stub's recorded argv.
host_arg() { printf '%s\n' "$OUT" | awk '/^arg=--host$/ { getline; sub(/^arg=/, ""); print; exit }'; }

# ─── Default: loopback ───────────────────────────────────────────────────────
run_start
assert_eq "default run exits 0" "0" "$STATUS"
assert_eq "default host is 127.0.0.1" "127.0.0.1" "$(host_arg)"
assert_eq "default run prints no warning" "" "$ERR"
assert_eq "runs from the repo root whatever the caller's cwd" "cwd=$REPO_REAL" \
    "$(printf '%s\n' "$OUT" | head -n 1)"
expected_args='arg=-m
arg=uvicorn
arg=python.embeddings_service:app
arg=--host
arg=127.0.0.1
arg=--port
arg=8000
arg=--reload'
assert_eq "uvicorn command line is otherwise unchanged" "$expected_args" \
    "$(printf '%s\n' "$OUT" | grep '^arg=')"
assert_eq "--host appears exactly once" "1" "$(printf '%s\n' "$OUT" | grep -c '^arg=--host$')"

# ─── Empty EMBEDDINGS_HOST is treated as unset ───────────────────────────────
run_start EMBEDDINGS_HOST=
assert_eq "empty EMBEDDINGS_HOST keeps 127.0.0.1" "127.0.0.1" "$(host_arg)"
assert_eq "empty EMBEDDINGS_HOST prints no warning" "" "$ERR"

# ─── Loopback overrides: honoured, no warning ────────────────────────────────
for h in localhost ::1; do
    run_start EMBEDDINGS_HOST="$h"
    assert_eq "EMBEDDINGS_HOST=$h is honoured" "$h" "$(host_arg)"
    assert_eq "EMBEDDINGS_HOST=$h prints no warning" "" "$ERR"
done

# ─── Opt-in exposure: honoured, with a warning ───────────────────────────────
for h in 0.0.0.0 192.168.1.20; do
    run_start EMBEDDINGS_HOST="$h"
    assert_eq "EMBEDDINGS_HOST=$h exits 0" "0" "$STATUS"
    assert_eq "EMBEDDINGS_HOST=$h is honoured" "$h" "$(host_arg)"
    if [[ "$ERR" == *WARNING*"$h"*unauthenticated* ]]; then
        pass "EMBEDDINGS_HOST=$h warns that the API is unauthenticated"
    else
        fail "EMBEDDINGS_HOST=$h warns that the API is unauthenticated" "stderr: [$ERR]"
    fi
done

# ─── A hostile value stays one argument (no word splitting / injection) ──────
run_start EMBEDDINGS_HOST='127.0.0.1 --port 1 --reload-dir /'
assert_eq "an EMBEDDINGS_HOST with spaces stays a single --host value" \
    '127.0.0.1 --port 1 --reload-dir /' "$(host_arg)"
assert_eq "…and adds no extra --port" "1" "$(printf '%s\n' "$OUT" | grep -c '^arg=--port$')"

# ─── Container: explicit 0.0.0.0 inside, start.sh not in the image ───────────
cmd_line=$(grep -E '^CMD ' "$ROOT/python/Dockerfile" || true)
assert_eq "python/Dockerfile has exactly one CMD" "1" "$(grep -cE '^CMD ' "$ROOT/python/Dockerfile")"
assert_eq "the container CMD binds 0.0.0.0 explicitly (compose network)" \
    'CMD ["uvicorn", "embeddings_service:app", "--host", "0.0.0.0", "--port", "8000"]' "$cmd_line"
if grep -Eq '^(ENTRYPOINT|ENV .*EMBEDDINGS_HOST)' "$ROOT/python/Dockerfile"; then
    fail "the image sets no ENTRYPOINT / EMBEDDINGS_HOST that could override the CMD" \
        "$(grep -E '^(ENTRYPOINT|ENV .*EMBEDDINGS_HOST)' "$ROOT/python/Dockerfile")"
else
    pass "the image sets no ENTRYPOINT / EMBEDDINGS_HOST that could override the CMD"
fi
if grep -qx 'start.sh' "$ROOT/python/.dockerignore"; then
    pass "python/.dockerignore keeps start.sh out of the image"
else
    fail "python/.dockerignore keeps start.sh out of the image" "no 'start.sh' line"
fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[[ "$FAILED" -eq 0 ]]
