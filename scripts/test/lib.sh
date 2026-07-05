# scripts/test/lib.sh
# Shared helpers for the test runner scripts. Sourced, not executed.

# Resolve repo root from the location of the *sourcing* script.
# BASH_SOURCE[0] here is lib.sh itself, which lives in scripts/test/.
repo_root() {
    cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd
}

# True once the test DB (compose service postgres_test, host port 5433)
# accepts connections. pg_isready runs inside the container so no local
# postgres client tools are required.
test_db_ready() {
    docker compose exec -T postgres_test \
        pg_isready -q \
        -U "${POSTGRES_USER:-pulse_user}" \
        -d "${POSTGRES_TEST_DB:-pulse_of_ai_test}" >/dev/null 2>&1
}

# Ensure the docker compose stack is up and the test DB is accepting
# connections. Starts the stack if needed, then polls up to ~60s.
ensure_test_db() {
    if test_db_ready; then
        echo "Test DB already accepting connections (port ${POSTGRES_TEST_PORT:-5433})."
        return 0
    fi

    echo "Test DB not reachable — starting docker compose stack..."
    npm run docker:up

    local waited=0
    local max_wait=60
    while ! test_db_ready; do
        if (( waited >= max_wait )); then
            echo "ERROR: test DB (postgres_test, port ${POSTGRES_TEST_PORT:-5433}) did not accept connections within ${max_wait}s." >&2
            echo "Check 'docker compose ps' and 'docker compose logs postgres_test'. POSTGRES_PASSWORD must be set in .env." >&2
            return 1
        fi
        sleep 2
        waited=$(( waited + 2 ))
    done
    echo "Test DB ready after ${waited}s."
}

# Print PASS/FAIL summary line with elapsed seconds.
# Usage: summary <label> <exit_code> <start_epoch>
summary() {
    local label=$1 code=$2 start=$3
    local elapsed=$(( $(date +%s) - start ))
    if (( code == 0 )); then
        echo "${label}: PASS (${elapsed}s)"
    else
        echo "${label}: FAIL (${elapsed}s, exit ${code})"
    fi
}
