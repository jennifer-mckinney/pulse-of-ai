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

# env_value_body RAW: the value compose would read from the text after
# `KEY=` (F9-5). Quoted values yield their body — a ' #' INSIDE quotes is
# data, and anything after the closing quote (e.g. an inline comment) is
# ignored; in double quotes \" and \\ are unescaped. Only an UNQUOTED value
# has an inline comment (whitespace then '#') stripped. Surrounding blanks
# are trimmed. Bash 3.2 compatible (no associative arrays, no ${x,,}).
env_value_body() {
    local raw=$1 out='' c q i=1 n
    raw="${raw#"${raw%%[![:space:]]*}"}"          # trim leading blanks
    q=${raw:0:1}
    if [[ "$q" == '"' || "$q" == "'" ]]; then
        n=${#raw}
        while (( i < n )); do
            c=${raw:i:1}
            if [[ "$q" == '"' && "$c" == '\' ]] && (( i + 1 < n )); then
                case "${raw:i+1:1}" in
                    '"'|'\') out+=${raw:i+1:1}; i=$((i + 2)); continue ;;
                esac
            fi
            [[ "$c" == "$q" ]] && break
            out+=$c
            i=$((i + 1))
        done
        printf '%s' "$out"
        return 0
    fi
    # Unquoted: strip an inline comment, then trailing blanks.
    printf '%s' "$raw" | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//'
}

# Value of KEY in the env file (last assignment wins; parsed by
# env_value_body). Prints nothing when absent. Never echo the result of this
# for secret keys.
env_file_value() {
    local key=$1 line
    [[ -f "$STACK_ENV_FILE" ]] || return 0
    line=$(grep -E "^(export[[:space:]]+)?${key}=" "$STACK_ENV_FILE" | tail -n 1 || true)
    [[ -n "$line" ]] || return 0
    env_value_body "${line#*=}"
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

# ─── Env file creation / merge (scripts/standup.sh) ──────────────────────────
# Keys whose value standup GENERATES (openssl rand -hex 32) instead of
# copying the .env.example placeholder. Values are never printed.
STACK_SECRET_KEYS=(POSTGRES_PASSWORD AUDIT_HASH_KEY CORRELATION_SALT)
# Temp file of an env file being created (removed on any exit — F9-4).
STACK_ENV_TMP=''

# 64 hex chars (256 bits) on stdout; non-zero exit when no source works.
gen_secret() {
    local s
    if command -v openssl >/dev/null 2>&1; then
        s=$(openssl rand -hex 32) || return 1
    else
        s=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n') || return 1
    fi
    [[ "$s" =~ ^[0-9a-f]{64}$ ]] || return 1
    printf '%s' "$s"
}

is_secret_key() {
    local k
    for k in "${STACK_SECRET_KEYS[@]}"; do [[ "$1" == "$k" ]] && return 0; done
    return 1
}

# One env line for KEY: a fresh secret for secret keys, else the
# .env.example line verbatim. Fails (instead of writing an empty secret)
# when the generator fails — command substitution inside printf's arguments
# would otherwise swallow that failure.
env_line_for() {
    local key=$1 example_line=$2 secret
    if is_secret_key "$key"; then
        secret=$(gen_secret) || return 1
        printf '%s=%s\n' "$key" "$secret"
    else
        printf '%s\n' "$example_line"
    fi
}

# True when PATH is writable by its group or by others.
writable_by_others() {
    [[ -n "$(find "$1" -prune \( -perm -020 -o -perm -002 \) -print 2>/dev/null)" ]]
}

_stack_drop_env_tmp() {
    if [[ -n "${STACK_ENV_TMP:-}" ]]; then
        rm -f "$STACK_ENV_TMP"
        STACK_ENV_TMP=''
    fi
}

# Create the env file from .env.example (generating the secret keys), or
# append the keys an existing file lacks. Existing values are never changed.
ensure_env_file() {
    local line key
    if [[ ! -f "$STACK_ENV_FILE" ]]; then
        STACK_ENV_TMP="$STACK_ENV_FILE.tmp.$$"
        # F9-4: the temp file holds secrets — remove it on ANY exit until
        # the final mv (a failing generator, `die`, Ctrl-C, SIGTERM).
        trap '_stack_drop_env_tmp' EXIT
        trap '_stack_drop_env_tmp; exit 130' INT
        trap '_stack_drop_env_tmp; exit 143' TERM
        ( umask 077; : > "$STACK_ENV_TMP" ) || die "cannot create $STACK_ENV_TMP"
        while IFS= read -r line || [[ -n "$line" ]]; do
            if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]]; then
                key=${BASH_REMATCH[1]}
                env_line_for "$key" "$line" >> "$STACK_ENV_TMP" \
                    || die "could not generate a value for $key (needs openssl or /dev/urandom)"
            else
                printf '%s\n' "$line" >> "$STACK_ENV_TMP"
            fi
        done < "$STACK_EXAMPLE_FILE"
        chmod 600 "$STACK_ENV_TMP"
        mv "$STACK_ENV_TMP" "$STACK_ENV_FILE"
        STACK_ENV_TMP=''
        trap - EXIT INT TERM
        ok "created $STACK_ENV_FILE from .env.example (generated: ${STACK_SECRET_KEYS[*]} — values not shown)"
        return 0
    fi

    # Merge path: collect the missing keys first, so the permission check
    # below runs BEFORE anything is written.
    local missing=() missing_secret=0
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
        key=${BASH_REMATCH[1]}
        grep -Eq "^(export[[:space:]]+)?${key}=" "$STACK_ENV_FILE" && continue
        missing+=("$key")
        if is_secret_key "$key"; then missing_secret=1; fi
    done < "$STACK_EXAMPLE_FILE"

    # F9-3: a file others can write is not a place for new secrets (someone
    # else may read or have edited it). Nothing is appended; the owner fixes it.
    if (( missing_secret )) && writable_by_others "$STACK_ENV_FILE"; then
        die "$STACK_ENV_FILE is group- or world-writable — refusing to append generated secrets to it.
    Check that nobody else edited it, then: chmod 600 $STACK_ENV_FILE   and re-run."
    fi

    if (( ${#missing[@]} == 0 )); then
        ok "kept existing $STACK_ENV_FILE (all keys present, values untouched)"
        return 0
    fi
    # Make sure the append starts on its own line.
    [[ -z "$(tail -c 1 "$STACK_ENV_FILE")" ]] || printf '\n' >> "$STACK_ENV_FILE"
    printf '\n# Added by scripts/standup.sh on %s (missing from this file)\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$STACK_ENV_FILE"
    for key in "${missing[@]}"; do
        line=$(grep -E "^${key}=" "$STACK_EXAMPLE_FILE" | head -n 1)
        env_line_for "$key" "$line" >> "$STACK_ENV_FILE" \
            || die "could not generate a value for $key (needs openssl or /dev/urandom)"
    done
    ok "kept existing $STACK_ENV_FILE; added missing key(s): ${missing[*]}"
}

# F9-3: the env file holds secrets — always mode 600, and say so when it is
# not ours (chmod then fails for a non-root user, which is fatal).
secure_env_file() {
    [[ -f "$STACK_ENV_FILE" ]] || return 0
    [[ -O "$STACK_ENV_FILE" ]] \
        || warn "$STACK_ENV_FILE is not owned by you (uid $(id -u)) but holds secrets — check who created it"
    chmod 600 "$STACK_ENV_FILE" 2>/dev/null \
        || die "could not chmod 600 $STACK_ENV_FILE — it holds secrets; fix its ownership and re-run"
}

# Placeholder or empty secrets are not secrets. Existing values are never
# rewritten, so this only reports them.
check_env_secrets() {
    local key example_val current
    for key in "${STACK_SECRET_KEYS[@]}"; do
        example_val=$(grep -E "^${key}=" "$STACK_EXAMPLE_FILE" | head -n 1 || true)
        example_val=$(env_value_body "${example_val#*=}")
        current=$(env_file_value "$key")
        if [[ -z "$current" ]]; then
            warn "$key is empty in $STACK_ENV_FILE — set it (openssl rand -hex 32)"
        elif [[ -n "$example_val" && "$current" == "$example_val" ]]; then
            warn "$key still has the .env.example placeholder — replace it (openssl rand -hex 32)"
        fi
    done
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
