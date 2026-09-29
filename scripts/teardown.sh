#!/usr/bin/env bash
# scripts/teardown.sh — stop the Pulse of AI stack started by scripts/standup.sh.
#
#   npm run teardown                      stop + remove containers, KEEP data volumes
#   npm run teardown -- --purge           also delete the project's volumes
#                                         (database, redis, model cache) — asks first
#   npm run teardown -- --purge --yes     non-interactive purge (CI / scripts)
#
# Without Node.js/npm on the host: bash scripts/teardown.sh [--purge] [--yes]
# (needs only Bash and Docker).
#
# Scope is exactly one compose project: COMPOSE_PROJECT_NAME if set, else the
# env file's value, else 'pulse-of-ai'. The step line says which one was
# used. Every service of the project (the default databases/redis AND the
# full/demo profiles) is stopped; containers compose does not know from this
# file (orphans) are left alone — they may belong to another app that
# shares the project name.
#
# Confirmation (typed project name, or --yes):
#   - --purge (volumes are deleted);
#   - a COMPOSE_PROJECT_NAME from the SHELL that differs from the env file's
#     project — even for a plain stop, since it may be another app's.
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

check_docker
STACK_PROJECT=$(stack_project)
PROJECT_SOURCE=$(stack_project_source)
FOREIGN=0
project_from_foreign_shell && FOREIGN=1
(( ASSUME_YES && ! PURGE && ! FOREIGN )) && warn "--yes has no effect here (nothing needs confirmation)"

# `down` matches containers by project label, so the password values are
# irrelevant — but compose still interpolates the file, and the services
# declare POSTGRES_PASSWORD / REDIS_PASSWORD as required. Supply a
# placeholder only when no env file provides one.
if [[ -z "$(effective POSTGRES_PASSWORD)" ]]; then
    export POSTGRES_PASSWORD=teardown-placeholder
fi
if [[ -z "$(effective REDIS_PASSWORD)" ]]; then
    export REDIS_PASSWORD=teardown-placeholder
fi

containers=$(project_containers | wc -l | tr -d ' ')
volumes=$(project_volumes | wc -l | tr -d ' ')

step "Tearing down compose project '$STACK_PROJECT' (from $PROJECT_SOURCE; $containers container(s), $volumes volume(s))"

if (( containers == 0 && (volumes == 0 || ! PURGE) )); then
    ok "nothing to stop"
    (( volumes > 0 )) && info "kept $volumes volume(s): $(project_volumes | tr '\n' ' ')"
    exit 0
fi

# P9-4: the default project is the SHARED dev stack (npm run docker:up /
# npm run dev), whose postgres_test is the database every jest run uses.
if [[ "$STACK_PROJECT" == "pulse-of-ai" ]]; then
    warn "'pulse-of-ai' is the shared dev project (npm run docker:up / npm run dev use it)."
    warn "Stopping it also stops postgres_test on port $(effective POSTGRES_TEST_PORT 5433) — the test database jest uses — and the dev postgres/redis."
fi

if (( FOREIGN )); then
    warn "COMPOSE_PROJECT_NAME='$STACK_PROJECT' comes from your shell env, but $STACK_ENV_FILE names '$(env_file_project)'."
    warn "'$STACK_PROJECT' may be another app's project. Unset COMPOSE_PROJECT_NAME to act on '$(env_file_project)'."
fi
if (( PURGE && volumes > 0 )); then
    info "volumes that will be DELETED (data cannot be recovered):"
    project_volumes | sed 's/^/      /'
fi
if (( (PURGE || FOREIGN) && ! ASSUME_YES )); then
    [[ -t 0 ]] || die "refusing to $( (( PURGE )) && echo 'purge' || echo 'stop') '$STACK_PROJECT' without confirmation: run interactively, or pass --yes"
    printf '    Type the project name (%s) to %s it: ' "$STACK_PROJECT" "$( (( PURGE )) && echo 'stop and PURGE' || echo 'stop')"
    read -r answer
    [[ "$answer" == "$STACK_PROJECT" ]] || die "confirmation did not match — nothing was stopped or deleted"
fi

# No --remove-orphans (F9-7): orphans are containers of this project name
# that this compose file does not define — not ours to remove.
if (( PURGE )); then
    compose_all down --volumes
else
    compose_all down
fi

left_containers=$(project_containers | wc -l | tr -d ' ')
left_volumes=$(project_volumes | wc -l | tr -d ' ')
(( left_containers == 0 )) || die "$left_containers container(s) of '$STACK_PROJECT' are still present (containers this compose file does not define are left alone)"
ok "all containers of '$STACK_PROJECT' removed"
if (( PURGE )); then
    (( left_volumes == 0 )) || die "$left_volumes volume(s) of '$STACK_PROJECT' are still present"
    ok "all volumes of '$STACK_PROJECT' deleted"
else
    info "kept $left_volumes volume(s) — data survives; '$(stack_cmd standup)' resumes from it"
fi
