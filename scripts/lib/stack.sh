# shellcheck shell=bash
# scripts/lib/stack.sh
# Shared helpers for scripts/standup.sh and scripts/teardown.sh. Sourced, not
# executed. Callers run with `set -euo pipefail`.
#
# Environment knobs (all optional):
#   PULSE_ENV_FILE        env file to use (default: <repo>/.env)
#   COMPOSE_PROJECT_NAME  compose project; overrides the env file's value and
#                         the compose file's `name: pulse-of-ai`
#   WEB_PORT, EMBEDDINGS_PORT, POSTGRES_PORT, POSTGRES_TEST_PORT, REDIS_PORT
#                         host ports (shell values override the env file)

STACK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
STACK_COMPOSE_FILE="$STACK_ROOT/docker-compose.yml"
STACK_ENV_FILE="${PULSE_ENV_FILE:-$STACK_ROOT/.env}"
# shellcheck disable=SC2034  # read by scripts/standup.sh after sourcing
STACK_EXAMPLE_FILE="$STACK_ROOT/.env.example"

# ─── Output ──────────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
    _B=$'\033[1m'; _R=$'\033[31m'; _G=$'\033[32m'; _Y=$'\033[33m'; _N=$'\033[0m'
else
    _B=''; _R=''; _G=''; _Y=''; _N=''
fi
step() { printf '\n%s==> %s%s\n' "$_B" "$*" "$_N"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %sok%s  %s\n' "$_G" "$_N" "$*"; }
warn() { printf '    %sWARNING%s  %s\n' "$_Y" "$_N" "$*" >&2; }
die()  { printf '\n%sERROR%s  %s\n' "$_R" "$_N" "$*" >&2; exit 1; }

# ─── Env file ────────────────────────────────────────────────────────────────

# Value of KEY in the env file (last assignment wins, inline comment and
# surrounding quotes stripped). Prints nothing when absent. Never echo the
# result of this for secret keys.
env_file_value() {
    local key=$1
    [[ -f "$STACK_ENV_FILE" ]] || return 0
    grep -E "^(export[[:space:]]+)?${key}=" "$STACK_ENV_FILE" | tail -n 1 \
        | cut -d= -f2- \
        | sed -E 's/[[:space:]]+#.*$//; s/^[[:space:]]+//; s/[[:space:]]+$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' \
        || true
}

# Effective setting: shell environment first (compose gives it precedence
# too), then the env file, then the supplied default.
effective() {
    local key=$1 default=${2:-}
    local shell_val=${!key:-}
    if [[ -n "$shell_val" ]]; then
        printf '%s' "$shell_val"
        return
    fi
    local file_val
    file_val=$(env_file_value "$key")
    printf '%s' "${file_val:-$default}"
}

# ─── Compose project ─────────────────────────────────────────────────────────

stack_project() {
    local project
    project=$(effective COMPOSE_PROJECT_NAME pulse-of-ai)
    [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
        || die "invalid compose project name '$project' (lowercase letters, digits, '-' and '_' only)"
    printf '%s' "$project"
}

# docker compose pinned to this repo's compose file, env file and project,
# with the "full" profile (web, worker, embeddings, migrate).
compose_full() {
    local env_args=()
    [[ -f "$STACK_ENV_FILE" ]] && env_args=(--env-file "$STACK_ENV_FILE")
    docker compose --project-directory "$STACK_ROOT" -f "$STACK_COMPOSE_FILE" \
        ${env_args[@]+"${env_args[@]}"} -p "$STACK_PROJECT" --profile full "$@"
}

# Same, plus the "demo" profile (the population feed). Used where every
# service must be in scope: starting the feed, status, logs, teardown.
compose_all() {
    local env_args=()
    [[ -f "$STACK_ENV_FILE" ]] && env_args=(--env-file "$STACK_ENV_FILE")
    docker compose --project-directory "$STACK_ROOT" -f "$STACK_COMPOSE_FILE" \
        ${env_args[@]+"${env_args[@]}"} -p "$STACK_PROJECT" --profile full --profile demo "$@"
}

# ─── Prerequisites ───────────────────────────────────────────────────────────

check_docker() {
    command -v docker >/dev/null 2>&1 || die "docker not found.
    Install Docker Desktop (macOS/Windows): https://docs.docker.com/desktop/
    or Docker Engine (Linux):              https://docs.docker.com/engine/install/"

    local compose_version major
    compose_version=$(docker compose version --short 2>/dev/null || true)
    [[ -n "$compose_version" ]] || die "Docker Compose v2 plugin not found ('docker compose' failed).
    Docker Desktop ships it; on Linux install the plugin: https://docs.docker.com/compose/install/linux/
    (the legacy 'docker-compose' v1 binary is not supported)"
    major=${compose_version#v}
    major=${major%%.*}
    if ! [[ "$major" =~ ^[0-9]+$ ]] || (( major < 2 )); then
        die "Docker Compose v2+ required, found '$compose_version'. Upgrade Docker Desktop or the compose plugin."
    fi

    docker info >/dev/null 2>&1 || die "the Docker daemon is not running (or this user cannot reach it).
    macOS/Windows: start Docker Desktop and wait until it reports 'running'.
    Linux: sudo systemctl start docker   (and add yourself to the 'docker' group)"
    # shellcheck disable=SC2034  # reported by scripts/standup.sh
    COMPOSE_VERSION=$compose_version
}

# Project containers / volumes, by compose label (independent of profiles).
project_containers() { docker ps -a -q --filter "label=com.docker.compose.project=$STACK_PROJECT"; }
project_volumes()    { docker volume ls -q --filter "label=com.docker.compose.project=$STACK_PROJECT"; }
