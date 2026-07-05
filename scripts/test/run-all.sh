#!/usr/bin/env bash
# Full green-baseline gate: complete Jest suite with coverage (>=80% lines,
# enforced by jest.config.js coverageThreshold) plus Python tests + formatting.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$(repo_root)"

start=$(date +%s)

# Full suite includes tests/integration, so the test DB must be up.
ensure_test_db

# --coverage runs unit + integration together; coverageThreshold in
# jest.config.js makes jest exit non-zero if lines fall below 80%.
jest_status=0
npx jest --coverage || jest_status=$?

pytest_result="SKIPPED"
black_result="SKIPPED"
python_failed=0
if [[ -d python/.venv ]]; then
    if [[ -x python/.venv/bin/pytest ]]; then
        # Invoke pytest via the venv python from the repo root so the tests'
        # `python.*` package imports resolve (the bare pytest binary cannot).
        if python/.venv/bin/python -m pytest python/tests; then
            pytest_result="PASS"
        else
            pytest_result="FAIL"
            python_failed=1
        fi
    else
        echo "WARNING: python/.venv exists but pytest is not installed — skipping Python tests."
    fi
    if [[ -x python/.venv/bin/black ]]; then
        if python/.venv/bin/black --check python/; then
            black_result="PASS"
        else
            black_result="FAIL"
            python_failed=1
        fi
    else
        echo "WARNING: python/.venv exists but black is not installed — skipping format check."
    fi
fi

if (( jest_status == 0 )); then
    jest_result="PASS"
else
    jest_result="FAIL"
fi

elapsed=$(( $(date +%s) - start ))
echo ""
echo "==================== SUMMARY ===================="
printf '%-28s %s\n' "Jest suite (unit + int)"   "$jest_result"
printf '%-28s %s\n' "Coverage gate (>=80% lines)" "$jest_result"
printf '%-28s %s\n' "Python pytest"             "$pytest_result"
printf '%-28s %s\n' "Python black --check"      "$black_result"
echo "================================================="
echo "Total elapsed: ${elapsed}s"

if (( jest_status != 0 || python_failed != 0 )); then
    echo "RESULT: FAIL"
    exit 1
fi
echo "RESULT: PASS"
