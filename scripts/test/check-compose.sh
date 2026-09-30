#!/usr/bin/env bash
# scripts/test/check-compose.sh — policy checks on the RESOLVED compose config.
#
#   bash scripts/test/check-compose.sh
#
# Resolves docker-compose.yml with every profile (full + demo) and asserts
# the security / operations policy the one-command standup relies on. It
# runs `docker compose config` only (no daemon calls, nothing started), in a
# clean environment with dummy secrets, so the shipped defaults are checked
# — never a developer's .env. Needs docker compose 2.39.0+ (checked first) and jq.
#
# Checks:
#   F9-1  every published port has an explicit host IP, and by default that
#         IP is the loopback address (nothing listens on 0.0.0.0)
#   F9-2  collector credential VALUES are set on `worker` only; web gets a
#         presence marker ("set") per credential, migrate and populate get
#         none; the base secrets (DB, Redis, AUDIT_HASH_KEY) go to every role
#         but the watchdog
#   L1    CORRELATION_SALT's VALUE is set on `worker` only (PR #22 security
#         L1); web gets the presence flag CORRELATION_SALT_SET, the other
#         roles nothing
#   #12   (PR #22 principal #12) SMTP_PASSWORD reaches the watchdog only —
#         the worker blanks its env-file copy, web gets no value or marker —
#         and the watchdog holds only the DB password and SMTP settings,
#         publishes no port and loads no env file
#   F9-8  the unauthenticated embeddings API publishes no host port
#   Q     the queue store is valkey/valkey 8.x (same digest in compose and CI)
#   F9-6  every pulled image (compose services, Dockerfile bases, CI service
#         containers) is pinned by @sha256 digest
#   P9-7  every service rotates json-file logs; the worker has a healthcheck
#         and a stop_grace_period of at least 150 s
#
# CI runs it in the docker-images job (.github/workflows/ci.yml);
# tests/integration/composeConfig.test.js runs it under jest.
#
# Exit code: 0 when every check passed, 1 otherwise.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
command -v jq >/dev/null 2>&1 || { echo "check-compose: jq is required" >&2; exit 2; }

# An older Compose rejects docker-compose.yml outright (build.provenance /
# build.sbom need 2.39.0+). Say so, instead of surfacing a schema error.
# shellcheck source=scripts/lib/stack.sh
source "$ROOT/scripts/lib/stack.sh"
compose_v=$(docker compose version --short 2>/dev/null || true)
if ! compose_version_at_least "$compose_v" "$STACK_COMPOSE_MIN_VERSION"; then
    echo "check-compose: Docker Compose $STACK_COMPOSE_MIN_VERSION or newer is required, found '${compose_v:-none}' (CI: scripts/test/ci-install-compose.sh)" >&2
    exit 2
fi

# Clean environment: only what the docker CLI itself needs, plus dummy
# values for the required secrets (never real ones).
cfg=$(env -i PATH="$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
    ${DOCKER_CONTEXT:+DOCKER_CONTEXT="$DOCKER_CONTEXT"} \
    POSTGRES_PASSWORD=compose-check REDIS_PASSWORD=compose-check PULSE_ENV_FILE=/dev/null \
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
# a collector credential. Its VALUE may reach `worker` only: web gets a
# presence marker ("set" when the credential is set, from
# ${NAME:+set} in x-collector-presence) so it can report source status, and
# migrate / populate get nothing. A second resolution with dummy credentials
# (CRED_PROBE) proves the marker, not the value, reaches web.
BASE_SECRETS='["POSTGRES_PASSWORD","REDIS_PASSWORD","AUDIT_HASH_KEY","PROVENANCE_KEY","REFRESH_TOKEN"]'
CRED_RE='(_TOKEN|_SECRET|_API_KEY|_KEY|_PASSWORD|_CLIENT_SECRET|_CLIENT_ID|_EMAIL|_IMAP_USER|_IMAP_HOST|_FEED_URL|_PATH|_DIR)$'
CRED_PROBE=(YOUTUBE_API_KEY GITHUB_TOKEN TIKTOK_RESEARCH_CLIENT_SECRET SCHOLAR_ALERTS_IMAP_PASSWORD
    NCBI_EMAIL CNN_FEED_URL JSTOR_DATASET_PATH REUTERS_CONNECT_CLIENT_ID)
probe_env=()
for k in "${CRED_PROBE[@]}"; do probe_env+=("$k=probe-secret-$k"); done
# PR #22 principal #12: the SMTP password is probed too; it must reach the
# watchdog ONLY (checked below), not the worker that loads the env file.
probe_env+=("SMTP_PASSWORD=probe-secret-SMTP_PASSWORD")
# P10-18: the worker gets credentials from its env_file (PULSE_ENV_FILE), so
# the probes are written to a throwaway env file as well as the process env
# (the latter drives web's ${NAME:+set} presence markers).
probe_file=$(mktemp "${TMPDIR:-/tmp}/compose-check-env.XXXXXX")
trap 'rm -f "$probe_file"' EXIT
printf '%s\n' "${probe_env[@]}" > "$probe_file"
cfg_probe=$(env -i PATH="$PATH" HOME="$HOME" ${DOCKER_HOST:+DOCKER_HOST="$DOCKER_HOST"} \
    ${DOCKER_CONTEXT:+DOCKER_CONTEXT="$DOCKER_CONTEXT"} \
    POSTGRES_PASSWORD=compose-check REDIS_PASSWORD=compose-check CORRELATION_SALT=probe-salt-value \
    PULSE_ENV_FILE="$probe_file" "${probe_env[@]}" \
    docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.yml" \
        --env-file /dev/null -p compose-check --profile full --profile demo \
        config --format json)
leaks=$(jq -r --argjson base "$BASE_SECRETS" --arg re "$CRED_RE" '.services | to_entries[]
    | select(.key != "worker") | .key as $s
    | (.value.environment // {}) | to_entries[]
    | select(.key | test($re)) | select(.key as $k | $base | index($k) | not)
    | select(($s != "watchdog") or (.key != "SMTP_PASSWORD"))
    | select(($s != "web") or ((.value // "") != "" and .value != "set"))
    | "\($s) receives collector credential \(.key)"' <<< "$cfg_probe")
check "collector credential values are passed to worker only" "$leaks"

# ─── Principal #12: the watchdog's secret split ──────────────────────────────
# SMTP_PASSWORD reaches the watchdog and nothing else: the worker loads the
# env file whole, so compose must blank it there; web gets neither the value
# nor a presence marker (the watchdog reports e-mail status via the DB). The
# watchdog itself gets the database password and the SMTP settings only — no
# Redis password, audit / correlation / provenance key, refresh token or
# collector credential — and publishes no port.
smtp_split=$(jq -r '.services | to_entries[] | .key as $s | (.value.environment // {}) as $e
    | if $s == "watchdog" then
          (if ($e.SMTP_PASSWORD // "") != "probe-secret-SMTP_PASSWORD" then "watchdog lacks SMTP_PASSWORD" else empty end)
      elif ($e.SMTP_PASSWORD // "") != "" then "\($s) receives SMTP_PASSWORD (\($e.SMTP_PASSWORD | if . == "set" then "presence marker" else "value" end))"
      else empty end' <<< "$cfg_probe")
check "SMTP_PASSWORD reaches the watchdog only (worker blanks its env-file copy)" "$smtp_split"
wd_extra=$(jq -r --arg re "$CRED_RE" '(.services.watchdog // {}) as $w
    | if ($w | length) == 0 then "no watchdog service in the full profile" else
      (($w.environment // {}) | to_entries[] | select(.key | test($re))
        | select(.key != "POSTGRES_PASSWORD" and .key != "SMTP_PASSWORD")
        | "watchdog receives \(.key)"),
      (($w.ports // [])[] | "watchdog publishes \(.published)->\(.target)"),
      (if ($w.env_file // null) != null then "watchdog loads an env_file" else empty end),
      (if ($w.profiles // []) | index("full") | not then "watchdog is not in the full profile" else empty end)
      end' <<< "$cfg_probe")
check "the watchdog holds only the DB password and SMTP settings, publishes no port" "$wd_extra"
probe_json=$(printf '%s\n' "${CRED_PROBE[@]}" | jq -R . | jq -s .)
missing_values=$(jq -r --argjson probe "$probe_json" '(.services.worker.environment // {}) as $w
    | $probe[] | select(. as $k | ($w[$k] // "") != "probe-secret-\($k)")
    | "worker lacks the value of \(.) (its env_file)"' <<< "$cfg_probe")
check "worker receives the collector credentials (env_file, P10-18)" "$missing_values"
# PR #22 grumpy L12: the worker's env_file is required (the resolved config
# inlines env_file values, so the source file is read).
env_optional=$(awk '/^  worker:/{w=1} w&&/^  [a-z_]+:$/&&!/^  worker:/{w=0} w&&/required:/{print}' "$ROOT/docker-compose.yml" \
    | { grep -v 'required: true' || true; } | sed 's/^ */worker env_file: /')
env_required=$(awk '/^  worker:/{w=1} w&&/^  [a-z_]+:$/&&!/^  worker:/{w=0} w&&/required: true/{print}' "$ROOT/docker-compose.yml")
[[ -z "$env_required" ]] && env_optional="${env_optional:-worker env_file has no required: true}"
check "the worker's env_file is required (a missing file fails loudly)" "$env_optional"
nomark=$(jq -r --argjson probe "$probe_json" '(.services.web.environment // {}) as $w
    | $probe[] | select(. as $k | ($w[$k] // "") != "set")
    | "web lacks the presence marker for \(.) (x-collector-presence)"' <<< "$cfg_probe")
check "web receives presence markers, never values (x-collector-presence)" "$nomark"
unset_mark=$(jq -r --argjson probe "$probe_json" '(.services.web.environment // {}) as $w
    | $probe[] | select(. as $k | ($w[$k] // "") != "")
    | "web marks \(.) as set while it is unset"' <<< "$cfg")
check "an unset credential has no presence marker on web" "$unset_mark"

# ─── L1: the correlation salt reaches the worker only ────────────────────────
salt_leaks=$(jq -r '.services | to_entries[] | select(.key != "worker") | .key as $s
    | (.value.environment // {}) | to_entries[]
    | select(.key == "CORRELATION_SALT" or ((.value // "") | tostring | contains("probe-salt-value")))
    | "\($s) receives the correlation salt (\(.key))"' <<< "$cfg_probe")
check "CORRELATION_SALT's value is passed to worker only (security L1)" "$salt_leaks"
salt_worker=$(jq -r '(.services.worker.environment.CORRELATION_SALT // "") as $v
    | if $v == "probe-salt-value" then empty else "worker lacks CORRELATION_SALT (got \"\($v)\")" end' <<< "$cfg_probe")
check "worker receives CORRELATION_SALT" "$salt_worker"
salt_flag=$(jq -r '(.services.web.environment.CORRELATION_SALT_SET // "") as $v
    | if $v == "set" then empty else "web lacks the CORRELATION_SALT_SET presence flag (got \"\($v)\")" end' <<< "$cfg_probe")
check "web receives only the CORRELATION_SALT_SET presence flag" "$salt_flag"
salt_flag_unset=$(jq -r '(.services.web.environment.CORRELATION_SALT_SET // "") as $v
    | if $v == "" then empty else "web flags the salt as set while it is unset (\"\($v)\")" end' <<< "$cfg")
check "an unset salt has no presence flag on web" "$salt_flag_unset"

# ─── F9-8: the embeddings API is never published ─────────────────────────────
emb_ports=$(jq -r '(.services.embeddings.ports // [])[]
    | "embeddings publishes \(.host_ip // "0.0.0.0"):\(.published)->\(.target)"' <<< "$cfg")
check "embeddings publishes no host port (compose network only)" "$emb_ports"

# ─── P9-7: log rotation everywhere; worker health + stop grace ──────────────
nolog=$(jq -r '.services | to_entries[] | .key as $s | .value.logging as $l
    | select(($l.driver // "") != "json-file" or ($l.options["max-size"] // "") == "" or ($l.options["max-file"] // "") == "")
    | "\($s): logging \($l // {} | tostring) (needs json-file with max-size and max-file)"' <<< "$cfg")
check "every service rotates its json-file logs (max-size, max-file)" "$nolog"
worker_hc=$(jq -r '.services.worker.healthcheck as $h
    | if ($h == null) or ($h.disable == true) or (($h.test // []) | length == 0)
      then "worker has no healthcheck" else empty end' <<< "$cfg")
check "worker has a healthcheck" "$worker_hc"
# stop_grace_period resolves to a Go duration string (e.g. 3m0s); convert.
grace=$(jq -r '.services.worker.stop_grace_period // ""' <<< "$cfg")
grace_s=$(awk -v d="$grace" 'BEGIN { s = 0; while (match(d, /^[0-9.]+(h|ms|m|s)/)) {
    tok = substr(d, 1, RLENGTH); d = substr(d, RLENGTH + 1); n = tok + 0
    if (tok ~ /ms$/) s += n / 1000; else if (tok ~ /h$/) s += n * 3600; else if (tok ~ /m$/) s += n * 60; else s += n }
    print int(s) }')
check "worker stop_grace_period >= 150s (a retrying run can finish)" \
    "$( (( grace_s >= 150 )) || echo "worker stop_grace_period is '${grace:-unset}' (${grace_s}s)")"

# ─── F9-6: pulled images are digest-pinned (compose, Dockerfiles, CI) ────────
# Locally built images (a build: section, or pull_policy never) are exempt.
unpinned=$(jq -r '.services | to_entries[]
    | select(.value.build == null and (.value.pull_policy // "") != "never")
    | select((.value.image // "") | test("@sha256:[0-9a-f]{64}$") | not)
    | "\(.key): image \(.value.image) is not pinned by digest"' <<< "$cfg")
check "every pulled compose image is pinned by @sha256 digest" "$unpinned"
unpinned_df=$(cd "$ROOT" && { grep -HnE '^ARG [A-Z_]+_IMAGE=' Dockerfile python/Dockerfile \
    | grep -vE '@sha256:[0-9a-f]{64}$' || true; })
check "Dockerfile base images are pinned by @sha256 digest" "$unpinned_df"
unpinned_ci=$(grep -nE '^[[:space:]]+image:' "$ROOT/.github/workflows/ci.yml" \
    | grep -vE '@sha256:[0-9a-f]{64}' | sed 's/^/ci.yml:/' || true)
check "CI service images are pinned by @sha256 digest" "$unpinned_ci"
# The queue store is Valkey (BSD-3-Clause), not the source-available Redis
# image, and CI tests against the exact image compose runs.
queue_img=$(jq -r '.services.redis.image // ""' <<< "$cfg")
ci_queue_img=$(awk '/^      redis:/ { f = 1; next } f && /image:/ { print $2; exit }' "$ROOT/.github/workflows/ci.yml")
check "the queue store is the pinned valkey/valkey 8.x image, in compose and CI alike" "$(
    [[ "$queue_img" =~ ^valkey/valkey:8\.[0-9.]+-alpine@sha256:[0-9a-f]{64}$ ]] \
        || echo "compose redis service image is '$queue_img', not valkey/valkey:8.x-alpine@sha256"
    [[ "$ci_queue_img" == "$queue_img" ]] \
        || echo "CI redis service image '$ci_queue_img' differs from compose '$queue_img'"
    grep -nE 'image:[[:space:]]*(docker\.io/)?(library/)?redis[:@]' "$ROOT/docker-compose.yml" "$ROOT/.github/workflows/ci.yml" || true)"

# F9-6: the embeddings image installs a hash-locked requirement set.
req="$ROOT/python/requirements-service.txt"
unhashed=$(awk '
    /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[^]]*\])?==/ { if (name != "" && !hashed) print name " has no --hash"; name = $1; hashed = 0; next }
    /^[A-Za-z0-9]/                              { print $1 " is not pinned with ==" }
    /--hash=sha256:[0-9a-f]{64}/                { hashed = 1 }
    END { if (name != "" && !hashed) print name " has no --hash"; if (name == "") print "no pinned requirements" }' "$req")
check "python/requirements-service.txt pins every package with --hash" "$unhashed"
check "torch is the CPU build from the lock" \
    "$(grep -qE '^torch==[0-9.]+\+cpu' "$req" || echo 'torch is not pinned to a +cpu build')"
check "python/Dockerfile installs with --require-hashes" \
    "$(grep -qE 'pip install --require-hashes -r requirements-service.txt' "$ROOT/python/Dockerfile" || echo 'no --require-hashes install')"

#@@CHECKS@@

printf '\ncheck-compose: %d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
