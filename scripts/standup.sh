#!/usr/bin/env bash
# scripts/standup.sh — stand up the whole Pulse of AI solution with one command.
#
#   npm run standup              (or: bash scripts/standup.sh)
#   npm run standup -- --help
#
# What it does, in order (safe to re-run — every step is idempotent):
#   1. checks prerequisites: docker, compose v2+, a running daemon
#   2. creates .env from .env.example if missing, generating strong random
#      POSTGRES_PASSWORD / AUDIT_HASH_KEY / CORRELATION_SALT (never printed);
#      an existing .env keeps every value — only missing keys are appended
#   3. builds the app + embeddings images
#   4. starts compose profile "full": postgres, postgres_test, redis, the
#      one-shot migrate job (migrations + seed), web, worker, embeddings
#   5. waits for health (timeouts; the failing service's logs on timeout)
#   6. populates data: fictional DEMO posts through the real pipeline, then
#      starts the demo feed that keeps the trailing hour populated
#      (live collectors are not implemented yet — see scripts/populate.js)
#   7. smoke-checks the running stack and prints a population summary
#
# Flags:
#   --demo       add a fresh demo batch even if the trailing hour already has one
#   --no-build   skip image builds (images must already exist)
#   -h, --help   this help
#
# Environment (optional): PULSE_ENV_FILE, COMPOSE_PROJECT_NAME, WEB_PORT,
# EMBEDDINGS_PORT, POSTGRES_PORT, POSTGRES_TEST_PORT, REDIS_PORT,
# STANDUP_TIMEOUT (core services, default 300 s),
# STANDUP_EMBEDDINGS_TIMEOUT (model download on first start, default 900 s).

set -euo pipefail

# shellcheck source=scripts/lib/stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/stack.sh"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

DO_BUILD=1
FORCE_DEMO=0
for arg in "$@"; do
    case "$arg" in
        --demo)     FORCE_DEMO=1 ;;
        --no-build) DO_BUILD=0 ;;
        -h|--help)  usage; exit 0 ;;
        *)          usage >&2; die "unknown option '$arg'" ;;
    esac
done

CORE_TIMEOUT=${STANDUP_TIMEOUT:-300}
EMBED_TIMEOUT=${STANDUP_EMBEDDINGS_TIMEOUT:-900}
T_START=$(date +%s)

elapsed() { echo $(( $(date +%s) - $1 )); }

# ─── 1. Prerequisites ────────────────────────────────────────────────────────
step "Checking prerequisites"
check_docker
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null), compose $COMPOSE_VERSION, daemon running"
command -v curl >/dev/null 2>&1 || die "curl not found — needed for the smoke check (brew install curl / apt-get install curl)"
[[ -f "$STACK_EXAMPLE_FILE" ]] || die "$STACK_EXAMPLE_FILE is missing — run from a complete checkout"

# ─── 2. Environment file ─────────────────────────────────────────────────────
# ensure_env_file / secure_env_file / check_env_secrets live in
# scripts/lib/stack.sh (tested by scripts/test/stack-lib.test.sh).
step "Preparing environment file"
ensure_env_file
secure_env_file
check_env_secrets
[[ -n "$(effective POSTGRES_PASSWORD)" ]] || die "POSTGRES_PASSWORD is empty in $STACK_ENV_FILE"

STACK_PROJECT=$(stack_project)
APP_IMAGE=$(effective PULSE_APP_IMAGE pulse-of-ai/app:local)
EMB_IMAGE=$(effective PULSE_EMBEDDINGS_IMAGE pulse-of-ai/embeddings:local)
info "compose project: $STACK_PROJECT"

# ─── 3. Build ────────────────────────────────────────────────────────────────
if (( DO_BUILD )); then
    step "Building images ($APP_IMAGE, $EMB_IMAGE)"
    t_build=$(date +%s)
    # No default provenance attestations: they carry per-build metadata, so a
    # cached rebuild would get a new image ID and recreate running containers.
    BUILDX_NO_DEFAULT_ATTESTATIONS=1 compose_full build || die "image build failed (see the output above)"
    ok "images built in $(elapsed "$t_build")s"
else
    step "Skipping image build (--no-build)"
    for img in "$APP_IMAGE" "$EMB_IMAGE"; do
        docker image inspect "$img" >/dev/null 2>&1 \
            || die "image $img does not exist — run without --no-build"
    done
    ok "images present"
fi

# ─── 4. Start the full profile ───────────────────────────────────────────────
# `up -d` blocks while it waits for postgres health and the migrate job, so it
# runs under a watchdog: a hung start becomes a reported timeout, not a hang.
run_with_timeout() {
    local secs=$1; shift
    "$@" &
    local pid=$! waited=0
    while kill -0 "$pid" 2>/dev/null; do
        if (( waited >= secs )); then
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
            return 124
        fi
        sleep 1
        waited=$((waited + 1))
    done
    wait "$pid"
}

# "state|health|exitcode" for a service's container (empty when none).
svc_status() {
    compose_all ps -a --format '{{.Service}}|{{.State}}|{{.Health}}|{{.ExitCode}}' 2>/dev/null \
        | awk -F'|' -v s="$1" '$1 == s { print $2 "|" $3 "|" $4; exit }'
}

show_failure() {
    local svc
    printf '\n' >&2
    compose_all ps -a >&2 || true
    for svc in "$@"; do
        printf '\n----- last 60 log lines: %s -----\n' "$svc" >&2
        compose_all logs --no-color --tail 60 "$svc" >&2 || true
    done
}

port_hint="If a host port is taken, override it: WEB_PORT, EMBEDDINGS_PORT, POSTGRES_PORT, POSTGRES_TEST_PORT, REDIS_PORT (shell env or $STACK_ENV_FILE)."

step "Starting services (profile full)"
t_up=$(date +%s)
set +e
run_with_timeout "$CORE_TIMEOUT" compose_full up -d --no-build --remove-orphans
up_rc=$?
set -e
if (( up_rc == 124 )); then
    show_failure postgres migrate
    die "services did not start within ${CORE_TIMEOUT}s (STANDUP_TIMEOUT). $port_hint"
elif (( up_rc != 0 )); then
    show_failure postgres migrate web worker
    die "docker compose up failed (exit $up_rc). $port_hint"
fi

# ─── 5. Wait for health ──────────────────────────────────────────────────────
step "Waiting for web, worker and the migrate job (timeout ${CORE_TIMEOUT}s)"
deadline=$(( t_up + CORE_TIMEOUT ))
while :; do
    IFS='|' read -r m_state _ m_exit <<< "$(svc_status migrate)"
    IFS='|' read -r w_state w_health _ <<< "$(svc_status web)"
    IFS='|' read -r k_state _ _ <<< "$(svc_status worker)"

    if [[ "$m_state" == "exited" && "$m_exit" != "0" ]]; then
        show_failure migrate
        die "the migrate job failed (exit $m_exit) — migrations or seed did not apply"
    fi
    if [[ "$m_state" == "exited" && "$m_exit" == "0" && "$w_health" == "healthy" && "$k_state" == "running" ]]; then
        break
    fi
    if (( $(date +%s) >= deadline )); then
        show_failure migrate web worker
        die "timed out after ${CORE_TIMEOUT}s: migrate=${m_state:-missing}/${m_exit:-?} web=${w_state:-missing}/${w_health:-?} worker=${k_state:-missing}"
    fi
    sleep 2
done
ok "migrate job completed (migrations + seed), web healthy, worker running ($(elapsed "$t_up")s)"

step "Waiting for the embeddings service (first start downloads the model; timeout ${EMBED_TIMEOUT}s)"
t_emb=$(date +%s)
EMBEDDINGS_OK=0
emb_container=$(compose_full ps -q embeddings 2>/dev/null || true)
last_note=0
while :; do
    IFS='|' read -r e_state e_health _ <<< "$(svc_status embeddings)"
    if [[ "$e_health" == "healthy" ]]; then
        EMBEDDINGS_OK=1
        break
    fi
    restarts=0
    [[ -n "$emb_container" ]] && restarts=$(docker inspect -f '{{.RestartCount}}' "$emb_container" 2>/dev/null || echo 0)
    # Crash-looping (e.g. the model download fails offline): stop waiting.
    if (( restarts >= 3 )) || [[ "$e_state" == "exited" || "$e_state" == "dead" ]]; then
        break
    fi
    if (( $(date +%s) - t_emb >= EMBED_TIMEOUT )); then
        break
    fi
    if (( $(date +%s) - last_note >= 30 )); then
        info "embeddings: ${e_state:-starting}/${e_health:-starting} after $(elapsed "$t_emb")s (downloading/loading the model)..."
        last_note=$(date +%s)
    fi
    sleep 3
done
if (( EMBEDDINGS_OK )); then
    ok "embeddings healthy, model loaded ($(elapsed "$t_emb")s)"
else
    warn "the embeddings service is NOT ready (state ${e_state:-unknown}, health ${e_health:-unknown}, restarts ${restarts:-0}) after $(elapsed "$t_emb")s."
    warn "Most likely the sentence-transformers model could not be downloaded (offline, proxy, or Hugging Face unreachable)."
    warn "Continuing WITHOUT embeddings: posts are scored and audited, but vector search stays empty."
    warn "Fix the network, then re-run 'npm run standup' (the model is cached in the hf_cache volume once downloaded)."
    compose_full logs --no-color --tail 25 embeddings >&2 || true
fi

# ─── 6. Populate ─────────────────────────────────────────────────────────────
step "Populating data (DEMO: fictional posts through the real pipeline)"
populate_args=(--once)
(( EMBEDDINGS_OK )) || populate_args+=(--no-embed)
(( FORCE_DEMO )) && populate_args+=(--force)
compose_all run --rm --no-deps -T populate node scripts/populate.js "${populate_args[@]}" \
    || { show_failure web worker; die "data population failed"; }

compose_all up -d --no-build --no-deps populate >/dev/null 2>&1 \
    || { show_failure populate; die "could not start the demo feed (service populate)"; }
ok "demo feed running: a new fictional batch every $(( $(effective DEMO_FEED_INTERVAL_MS 150000) / 1000 ))s keeps the trailing hour populated"

# ─── 7. Smoke check ──────────────────────────────────────────────────────────
step "Smoke check"
web_hostport=$(compose_full port web 3000 2>/dev/null | head -n 1)
[[ -n "$web_hostport" ]] || die "could not resolve the published port of the web service"
WEB_URL="http://localhost:${web_hostport##*:}"
emb_hostport=$(compose_full port embeddings 8000 2>/dev/null | head -n 1 || true)
EMB_URL="http://localhost:${emb_hostport##*:}"

host_fail=0
health_body=$(curl -fsS --max-time 10 "$WEB_URL/api/health" 2>/dev/null || true)
if [[ "$health_body" == *'"db_connected":true'* ]]; then
    ok "host → $WEB_URL/api/health: 200, db_connected true"
else
    warn "host → $WEB_URL/api/health did not return db_connected true"; host_fail=1
fi
page_code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$WEB_URL/" || true)
if [[ "$page_code" == "200" ]]; then
    ok "host → $WEB_URL/: 200"
else
    warn "host → $WEB_URL/ returned ${page_code:-no response}"; host_fail=1
fi
if (( EMBEDDINGS_OK )); then
    emb_body=$(curl -fsS --max-time 10 "$EMB_URL/health" 2>/dev/null || true)
    if [[ "$emb_body" == *'"model_loaded":true'* ]]; then
        ok "host → $EMB_URL/health: model loaded"
    else
        warn "host → $EMB_URL/health did not report model_loaded true"; host_fail=1
    fi
else
    info "host → embeddings: SKIPPED (service not ready)"
fi

smoke_args=()
(( EMBEDDINGS_OK )) && smoke_args+=(--expect-embeddings)
set +e
compose_full exec -T web node scripts/smoke-check.js ${smoke_args[@]+"${smoke_args[@]}"}
smoke_rc=$?
set -e
if (( smoke_rc != 0 || host_fail != 0 )); then
    show_failure web worker populate
    die "smoke check failed — the stack is up but not healthy (see above)"
fi

# ─── Done ────────────────────────────────────────────────────────────────────
# Copy-pasteable compose prefix for this exact project (and env file, when it
# is not the default one compose would find in the repo root).
DC="docker compose -p $STACK_PROJECT"
[[ "$STACK_ENV_FILE" == "$STACK_ROOT/.env" ]] || DC+=" --env-file $STACK_ENV_FILE"
# teardown must target the same project/env file this run used.
TD="npm run teardown"
[[ "$STACK_ENV_FILE" == "$STACK_ROOT/.env" ]] || TD="PULSE_ENV_FILE=$STACK_ENV_FILE $TD"
[[ "$STACK_PROJECT" == "$(env_file_value COMPOSE_PROJECT_NAME)" || ( "$STACK_PROJECT" == "pulse-of-ai" && -z "$(env_file_value COMPOSE_PROJECT_NAME)" ) ]] \
    || TD="COMPOSE_PROJECT_NAME=$STACK_PROJECT $TD"

cat <<EOF

${_G}${_B}Pulse of AI is up${_N}  (project '$STACK_PROJECT', $(elapsed "$T_START")s)

  Open:        $WEB_URL
  API health:  $WEB_URL/api/health
  Embeddings:  $( (( EMBEDDINGS_OK )) && echo "$EMB_URL/health" || echo "not ready — vector search disabled (see warnings above)")

  Data is DEMO: fictional posts scored by the real pipeline, refreshed by the
  'populate' service. Live collection is not implemented yet.

Next steps
  Status:      $DC --profile full --profile demo ps
  Logs:        $DC --profile full --profile demo logs -f web worker populate
  Replay:      $DC --profile full exec web npm run replay -- --post <post_id>
  Stop:        $TD             (keeps data volumes)
  Reset:       $TD -- --purge  (deletes data volumes, asks first)
EOF
