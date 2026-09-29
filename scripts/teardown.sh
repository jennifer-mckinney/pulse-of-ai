#!/usr/bin/env bash
# scripts/teardown.sh — stop the Pulse of AI stack started by scripts/standup.sh.
#
#   npm run teardown                      stop + remove containers, KEEP data volumes
#   npm run teardown -- --purge           also delete the project's volumes
#                                         (database, redis, model cache) — asks first
#   npm run teardown -- --purge --yes     non-interactive purge (CI / scripts)
#
# Scope is exactly one compose project: COMPOSE_PROJECT_NAME if set, else the
# env file's value, else 'pulse-of-ai'. Every service of the project (the
# default databases/redis AND the full/demo profiles) is stopped.
#
# Environment (optional): PULSE_ENV_FILE, COMPOSE_PROJECT_NAME.

set -euo pipefail

# shellcheck source=scripts/lib/stack.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/stack.sh"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; }

PURGE=0
ASSUME_YES=0
for arg in "$@"; do
    case "$arg" in
        --purge)   PURGE=1 ;;
        --yes|-y)  ASSUME_YES=1 ;;
        -h|--help) usage; exit 0 ;;
        *)         usage >&2; die "unknown option '$arg'" ;;
    esac
done
(( ASSUME_YES && ! PURGE )) && warn "--yes has no effect without --purge"

check_docker
STACK_PROJECT=$(stack_project)

# `down` matches containers by project label, so the password values are
# irrelevant — but compose still interpolates the file, and the services
# declare POSTGRES_PASSWORD / REDIS_PASSWORD as required. Supply a
# placeholder only when no env file provides one.
if [[ -z "$(effective POSTGRES_PASSWORD)" ]]; then
    export POSTGRES_PASSWORD=teardown-placeholder
fi
# Same for the Redis password (required by the redis service and x-app).
if [[ -z "$(effective REDIS_PASSWORD)" ]]; then
    export REDIS_PASSWORD=teardown-placeholder
fi

containers=$(project_containers | wc -l | tr -d ' ')
volumes=$(project_volumes | wc -l | tr -d ' ')

step "Tearing down compose project '$STACK_PROJECT' ($containers container(s), $volumes volume(s))"

if (( containers == 0 && (volumes == 0 || ! PURGE) )); then
    ok "nothing to stop"
    (( volumes > 0 )) && info "kept $volumes volume(s): $(project_volumes | tr '\n' ' ')"
    exit 0
fi

if (( PURGE )); then
    if (( volumes > 0 )); then
        info "volumes that will be DELETED (data cannot be recovered):"
        project_volumes | sed 's/^/      /'
    fi
    if (( ! ASSUME_YES )); then
        [[ -t 0 ]] || die "--purge needs confirmation: run interactively, or pass --yes"
        printf '    Type the project name (%s) to delete its volumes: ' "$STACK_PROJECT"
        read -r answer
        [[ "$answer" == "$STACK_PROJECT" ]] || die "confirmation did not match — nothing was deleted"
    fi
    compose_all down --volumes --remove-orphans
else
    compose_all down --remove-orphans
fi

left_containers=$(project_containers | wc -l | tr -d ' ')
left_volumes=$(project_volumes | wc -l | tr -d ' ')
(( left_containers == 0 )) || die "$left_containers container(s) of '$STACK_PROJECT' are still present"
ok "all containers of '$STACK_PROJECT' removed"
if (( PURGE )); then
    (( left_volumes == 0 )) || die "$left_volumes volume(s) of '$STACK_PROJECT' are still present"
    ok "all volumes of '$STACK_PROJECT' deleted"
else
    info "kept $left_volumes volume(s) — data survives; 'npm run standup' resumes from it"
fi
