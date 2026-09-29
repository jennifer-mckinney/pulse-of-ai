#!/usr/bin/env bash
# scripts/test/stack-lib.test.sh — behaviour tests for scripts/lib/stack.sh.
#
#   bash scripts/test/stack-lib.test.sh            (any bash >= 3.2)
#   /bin/bash scripts/test/stack-lib.test.sh       (macOS: bash 3.2.57)
#
# Written for bash 3.2 semantics on purpose: macOS ships bash 3.2 as
# /bin/bash, and scripts/standup.sh / teardown.sh must work there. CI runs
# this file under the bash:3.2 image as well as the runner's bash
# (.github/workflows/ci.yml); tests/unit/pure/stackLib.test.js runs it from
# jest with the local bash so `npm run verify` covers it.
#
# Every case runs in its own subshell with a scratch directory, so a `die`
# (exit 1) inside the library is observable as an exit status.
#
# Exit code: 0 when every case passed, 1 otherwise.

set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")/../lib" && pwd)/stack.sh"
PASSED=0
FAILED=0
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/stack-lib-test.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSED=$((PASSED + 1)); printf 'ok   %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# assert_eq NAME EXPECTED ACTUAL
assert_eq() {
    if [[ "$2" == "$3" ]]; then pass "$1"; else fail "$1" "expected [$2], got [$3]"; fi
}

# new_case: fresh scratch dir; prints its path.
new_case() {
    local d
    d=$(mktemp -d "$SCRATCH/case.XXXXXX")
    printf '%s' "$d"
}

# lib_run DIR CODE: run CODE in a subshell that sourced the library with
# PULSE_ENV_FILE=DIR/.env. Prints stdout; stderr goes to DIR/stderr.
lib_run() {
    local dir=$1 code=$2
    (
        export PULSE_ENV_FILE="$dir/.env"
        unset COMPOSE_PROJECT_NAME
        # shellcheck source=scripts/lib/stack.sh
        source "$LIB"
        eval "$code"
    ) 2> "$dir/stderr"
}

echo "stack-lib tests under bash ${BASH_VERSION}"

# ─── F9-5: env_file_value ────────────────────────────────────────────────────
d=$(new_case)
cat > "$d/.env" <<'EOF'
PLAIN=abc123
COMMENTED=changeme_before_production #note
HASH_IN_VALUE=abc#def
DQ="pass word # not a comment"
SQ='it # stays'
DQ_TRAIL="quoted" # trailing comment
SQ_TRAIL='single'   # trailing comment
DQ_ESC="say \"hi\" \\ back"
SPACED=  padded value   
export EXPORTED=yes
EMPTY=
EMPTY_DQ=""
LAST=first
LAST=second
EOF
assert_eq "env_file_value: plain value"                 "abc123"                     "$(lib_run "$d" 'env_file_value PLAIN')"
assert_eq "env_file_value: unquoted inline comment"     "changeme_before_production" "$(lib_run "$d" 'env_file_value COMMENTED')"
assert_eq "env_file_value: '#' without space is data"   "abc#def"                    "$(lib_run "$d" 'env_file_value HASH_IN_VALUE')"
assert_eq "env_file_value: double-quoted keeps ' #'"    "pass word # not a comment"  "$(lib_run "$d" 'env_file_value DQ')"
assert_eq "env_file_value: single-quoted keeps ' #'"    "it # stays"                 "$(lib_run "$d" 'env_file_value SQ')"
assert_eq "env_file_value: double-quoted + comment"     "quoted"                     "$(lib_run "$d" 'env_file_value DQ_TRAIL')"
assert_eq "env_file_value: single-quoted + comment"     "single"                     "$(lib_run "$d" 'env_file_value SQ_TRAIL')"
assert_eq "env_file_value: escaped quote and backslash" 'say "hi" \ back'            "$(lib_run "$d" 'env_file_value DQ_ESC')"
assert_eq "env_file_value: surrounding blanks trimmed"  "padded value"               "$(lib_run "$d" 'env_file_value SPACED')"
assert_eq "env_file_value: export prefix"               "yes"                        "$(lib_run "$d" 'env_file_value EXPORTED')"
assert_eq "env_file_value: empty"                       ""                           "$(lib_run "$d" 'env_file_value EMPTY')"
assert_eq "env_file_value: empty double quotes"         ""                           "$(lib_run "$d" 'env_file_value EMPTY_DQ')"
assert_eq "env_file_value: last assignment wins"        "second"                     "$(lib_run "$d" 'env_file_value LAST')"
assert_eq "env_file_value: absent key"                  ""                           "$(lib_run "$d" 'env_file_value MISSING')"

#@@CASES@@

# ─── Summary ─────────────────────────────────────────────────────────────────
printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
