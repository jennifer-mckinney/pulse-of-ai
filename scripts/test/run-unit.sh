#!/usr/bin/env bash
# Fast feedback loop: unit tests only (no DB), plus a warn-only black check.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$(repo_root)"

start=$(date +%s)
status=0

npx jest tests/unit || status=$?

# Python formatting check is advisory here — the venv or black may not be
# installed on every machine, and unit-loop speed matters more than lint.
if [[ -d python/.venv ]]; then
    if [[ -x python/.venv/bin/black ]]; then
        if ! python/.venv/bin/black --check python/; then
            echo "WARNING: black --check found formatting issues (not failing unit run)."
        fi
    else
        echo "WARNING: python/.venv exists but black is not installed — skipping format check."
    fi
fi

summary "UNIT" "$status" "$start"
exit "$status"
