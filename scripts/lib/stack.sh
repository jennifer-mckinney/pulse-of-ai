# shellcheck shell=bash
# scripts/lib/stack.sh
# Shared helpers for scripts/standup.sh and scripts/teardown.sh. Sourced, not
# executed. Callers run with `set -euo pipefail`.
#
# Environment knobs (all optional):
#   PULSE_ENV_FILE        env file to use (default: <repo>/.env)
#   COMPOSE_PROJECT_NAME  compose project; overrides the env file's value and
#                         the compose file's `name: pulse-of-ai`
#   WEB_PORT, POSTGRES_PORT, POSTGRES_TEST_PORT, REDIS_PORT
#                         host ports (shell values override the env file);
#                         the embeddings service publishes none (F9-8)

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
            if [[ "$q" == '"' && "$c" == "\\" ]] && (( i + 1 < n )); then
                case "${raw:i+1:1}" in
                    \"|\\) out+=${raw:i+1:1}; i=$((i + 2)); continue ;;
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
STACK_SECRET_KEYS=(POSTGRES_PASSWORD REDIS_PASSWORD AUDIT_HASH_KEY CORRELATION_SALT)
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
# Every path leaves the file at mode 600 before it reports success (F9-3).
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
        # Copilot 4129574000: harden BEFORE reporting success, so the "ok"
        # line never describes a file that is still group/world-readable.
        secure_env_file
        ok "kept existing $STACK_ENV_FILE (all keys present, values untouched; mode 600)"
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
    secure_env_file   # mode 600 before the success line (see above)
    ok "kept existing $STACK_ENV_FILE; added missing key(s): ${missing[*]} (mode 600)"
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

# F9-1: a placeholder or empty secret is not a secret — the .env.example
# placeholders are public, so a stack started with one is open to anyone who
# can reach its ports. Existing values are never rewritten, so standup STOPS
# and names the key instead (the value itself is never printed).
check_env_secrets() {
    local key example_val current bad=()
    for key in "${STACK_SECRET_KEYS[@]}"; do
        example_val=$(grep -E "^${key}=" "$STACK_EXAMPLE_FILE" | head -n 1 || true)
        example_val=$(env_value_body "${example_val#*=}")
        current=$(env_file_value "$key")
        if [[ -z "$current" ]]; then
            bad+=("$key (empty)")
        elif [[ -n "$example_val" && "$current" == "$example_val" ]]; then
            bad+=("$key (the .env.example placeholder)")
        fi
    done
    (( ${#bad[@]} == 0 )) && return 0
    local b msg=''
    for b in "${bad[@]}"; do msg+=$'\n'"      - $b"; done
    die "these secrets in $STACK_ENV_FILE are not secret:$msg
    Set each to a fresh value (openssl rand -hex 32). For POSTGRES_PASSWORD on an
    EXISTING database volume, also change it inside postgres (README: 'Upgrading an
    existing dev database'), or reset the stack with: npm run teardown -- --purge"
}

# ─── Compose project ─────────────────────────────────────────────────────────


stack_project() {
    local project
    project=$(effective COMPOSE_PROJECT_NAME pulse-of-ai)
    [[ "$project" =~ ^[a-z0-9][a-z0-9_-]*$ ]] \
        || die "invalid compose project name '$project' (lowercase letters, digits, '-' and '_' only)"
    printf '%s' "$project"
}

# Where the project name comes from (F9-7): 'shell env' | 'env file' |
# 'default'. Printed next to the name so a stray exported
# COMPOSE_PROJECT_NAME is visible before anything acts on it.
stack_project_source() {
    if [[ -n "${COMPOSE_PROJECT_NAME:-}" ]]; then
        printf 'shell env'
    elif [[ -n "$(env_file_value COMPOSE_PROJECT_NAME)" ]]; then
        printf 'env file'
    else
        printf 'default'
    fi
}

# The project this checkout's env file names (or the compose default).
env_file_project() {
    local v
    v=$(env_file_value COMPOSE_PROJECT_NAME)
    printf '%s' "${v:-pulse-of-ai}"
}

# True when the shell's COMPOSE_PROJECT_NAME overrides a DIFFERENT project
# than the env file names — e.g. exported for another app in this terminal.
project_from_foreign_shell() {
    [[ "$(stack_project_source)" == "shell env" && "$COMPOSE_PROJECT_NAME" != "$(env_file_project)" ]]
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

# ─── Watchdog ───────────────────────────────────────────────────────────────

# PID (= process-group id) of the command run_with_timeout is watching;
# read by its INT/TERM trap.
_RWT_PGID=''

# _rwt_kill_group PGID: TERM the whole process group, give it up to 10 s,
# then KILL whatever is left.
_rwt_kill_group() {
    local pgid=$1 grace=0
    kill -TERM -- "-$pgid" 2>/dev/null || return 0
    while kill -0 -- "-$pgid" 2>/dev/null && (( grace < 10 )); do
        sleep 1
        grace=$((grace + 1))
    done
    kill -KILL -- "-$pgid" 2>/dev/null || true
}

# run_with_timeout SECS CMD [ARGS...] — CMD may be a shell function.
# Returns CMD's exit status, or 124 when it ran longer than SECS.
#
# G9-3: CMD runs in its OWN process group (`set -m` while it is spawned), so
# a timeout — or Ctrl-C / SIGTERM on this script — stops CMD and everything
# it started (docker compose and its plugin processes), not only the
# subshell. Killing only $! would leave the real work running, still
# attached to our output. `timeout(1)` is not used: macOS has none by
# default. Bash 3.2 compatible (scripts/test/stack-lib.test.sh).
run_with_timeout() {
    local secs=$1 pid waited=0 rc=0 had_m=0
    shift
    [[ $- == *m* ]] && had_m=1
    set -m
    "$@" &
    pid=$!
    (( had_m )) || set +m
    _RWT_PGID=$pid
    # With CMD in its own group, a terminal Ctrl-C no longer reaches it —
    # forward INT/TERM to the group, then exit as the signal would.
    trap '_rwt_kill_group "$_RWT_PGID"; exit 130' INT
    trap '_rwt_kill_group "$_RWT_PGID"; exit 143' TERM
    while kill -0 "$pid" 2>/dev/null; do
        if (( waited >= secs )); then
            _rwt_kill_group "$pid"
            wait "$pid" 2>/dev/null || true
            trap - INT TERM
            _RWT_PGID=''
            return 124
        fi
        sleep 1
        waited=$((waited + 1))
    done
    wait "$pid" || rc=$?
    trap - INT TERM
    _RWT_PGID=''
    return "$rc"
}



# URL of the web service's published port on this host. Returns 1 (instead
# of killing a `set -e -o pipefail` caller before its `|| die` can report
# anything — G9-4) when compose cannot resolve the port.
published_web_url() {
    local hostport
    hostport=$(compose_full port web 3000 2>/dev/null | head -n 1 || true)
    [[ -n "$hostport" ]] || return 1
    printf 'http://localhost:%s' "${hostport##*:}"
}

# ─── Prerequisites ───────────────────────────────────────────────────────────

# Oldest Docker Compose that accepts docker-compose.yml: the app and
# embeddings builds set `build.provenance` / `build.sbom`, which Compose
# added in v2.39.0 (docker/compose#13067, compose-go v2.8.0). Compose 2.38.x
# (compose-go v2.7.1) rejects them — its schema has
# additionalProperties: false on `build` — so every compose call would fail.
STACK_COMPOSE_MIN_VERSION=2.39.0

# parse_compose_version VERSION → "MAJOR MINOR PATCH" on stdout, or return 1
# when VERSION is not a version. Accepts what `docker compose version
# --short` prints across distributions: 2.40.3, v2.39.0, v2.39.0-desktop.1,
# 2.39.0+build.1; a missing patch counts as 0. Bash 3.2 compatible.
parse_compose_version() {
    local v=$1 re='^([0-9]+)\.([0-9]+)(\.([0-9]+))?$'
    v="${v#"${v%%[![:space:]]*}"}"   # trim leading blanks
    v="${v%"${v##*[![:space:]]}"}"   # trim trailing blanks
    v=${v#v}
    v=${v%%[-+]*}                    # drop -desktop.1 / +build suffixes
    [[ "$v" =~ $re ]] || return 1
    printf '%s %s %s' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "${BASH_REMATCH[4]:-0}"
}

# compose_version_at_least VERSION MIN → 0 when VERSION >= MIN (numeric,
# per component: 2.100.0 > 2.39.0), 1 when older, 2 when unparseable.
compose_version_at_least() {
    local have want hm hn hp wm wn wp
    have=$(parse_compose_version "$1") || return 2
    want=$(parse_compose_version "$2") || return 2
    read -r hm hn hp <<< "$have"
    read -r wm wn wp <<< "$want"
    (( 10#$hm != 10#$wm )) && { (( 10#$hm > 10#$wm )); return; }
    (( 10#$hn != 10#$wn )) && { (( 10#$hn > 10#$wn )); return; }
    (( 10#$hp >= 10#$wp ))
}

check_docker() {
    command -v docker >/dev/null 2>&1 || die "docker not found.
    Install Docker Desktop (macOS/Windows): https://docs.docker.com/desktop/
    or Docker Engine (Linux):              https://docs.docker.com/engine/install/"

    local compose_version rc=0
    compose_version=$(docker compose version --short 2>/dev/null || true)
    [[ -n "$compose_version" ]] || die "Docker Compose plugin not found ('docker compose' failed).
    Docker Desktop ships it; on Linux install the plugin: https://docs.docker.com/compose/install/linux/
    (the legacy 'docker-compose' v1 binary is not supported; Compose $STACK_COMPOSE_MIN_VERSION or newer is required)"
    # Copilot 4129574025: v2.x alone is not enough — the MINOR version
    # decides whether docker-compose.yml parses at all.
    compose_version_at_least "$compose_version" "$STACK_COMPOSE_MIN_VERSION" || rc=$?
    if (( rc == 2 )); then
        die "could not read the Docker Compose version from 'docker compose version --short' (got '$compose_version').
    Compose $STACK_COMPOSE_MIN_VERSION or newer is required — check with: docker compose version"
    elif (( rc != 0 )); then
        die "Docker Compose $STACK_COMPOSE_MIN_VERSION or newer is required, found '$compose_version'.
    docker-compose.yml sets build.provenance / build.sbom, which older Compose rejects.
    Upgrade: Docker Desktop (macOS/Windows: Settings > Software updates, or https://docs.docker.com/desktop/)
             or the compose plugin (Linux: https://docs.docker.com/compose/install/linux/)
    then check with: docker compose version"
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
