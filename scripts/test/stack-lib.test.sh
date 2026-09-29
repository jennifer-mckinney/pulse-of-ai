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

# ─── F9-3 / F9-4: env file creation and merge ────────────────────────────────
# file_mode PATH → octal permission bits (GNU stat, else BSD stat).
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# A minimal .env.example beside each case's .env (STACK_EXAMPLE_FILE is
# overridden after sourcing, so the real one is never touched).
write_example() {
    cat > "$1/.env.example" <<'EOF'
# comment line
POSTGRES_PASSWORD=changeme_before_production
AUDIT_HASH_KEY=replace_with_random_64_hex_chars
CORRELATION_SALT=replace_with_random_64_hex_chars
WEB_PORT=3000
EOF
}
ENV_SETUP='STACK_EXAMPLE_FILE="$(dirname "$STACK_ENV_FILE")/.env.example"'

d=$(new_case); write_example "$d"
lib_run "$d" "$ENV_SETUP; ensure_env_file" >/dev/null; rc=$?
assert_eq "ensure_env_file: creates the env file"          "0" "$rc"
assert_eq "ensure_env_file: new file is mode 600"          "600" "$(file_mode "$d/.env")"
assert_eq "ensure_env_file: non-secret line kept verbatim" "3000" "$(lib_run "$d" 'env_file_value WEB_PORT')"
assert_eq "ensure_env_file: secret generated (64 hex)"     "64" "$(lib_run "$d" 'v=$(env_file_value POSTGRES_PASSWORD); [[ "$v" =~ ^[0-9a-f]{64}$ ]] && printf %s ${#v}')"
assert_eq "ensure_env_file: no temp file left"             "" "$(ls -A "$d" | grep '\.tmp\.' || true)"

# F9-4: a failing secret generator must not leave the secrets temp file.
d=$(new_case); write_example "$d"
lib_run "$d" "$ENV_SETUP; gen_secret() { return 1; }; ensure_env_file" >/dev/null; rc=$?
assert_eq "ensure_env_file: generator failure exits non-zero" "1" "$rc"
assert_eq "ensure_env_file: generator failure leaves no temp" "" "$(ls -A "$d" | grep '\.tmp\.' || true)"
assert_eq "ensure_env_file: generator failure writes no .env" "no" "$([[ -e "$d/.env" ]] && echo yes || echo no)"

# F9-4: interrupted mid-write (TERM while generating) — temp file removed.
d=$(new_case); write_example "$d"
# MAIN is the case subshell's own pid ($BASHPID does not exist in bash 3.2):
# a DIRECT child `sh -c 'echo $PPID'` reports it (command substitution would
# add a subshell level, so it goes through a file).
lib_run "$d" "$ENV_SETUP; sh -c 'echo \$PPID' > \"$d/main.pid\"; MAIN=\$(cat \"$d/main.pid\"); gen_secret() { kill -TERM \"\$MAIN\"; sleep 1; echo x; }; ensure_env_file" >/dev/null; rc=$?

assert_eq "ensure_env_file: TERM exits 143"           "143" "$rc"
assert_eq "ensure_env_file: TERM leaves no temp file" "" "$(ls -A "$d" | grep '\.tmp\.' || true)"
assert_eq "ensure_env_file: TERM writes no .env"      "no" "$([[ -e "$d/.env" ]] && echo yes || echo no)"


# F9-3: the merge path appends missing secrets, then secure_env_file → 600.
d=$(new_case); write_example "$d"
printf 'POSTGRES_PASSWORD=abc\nWEB_PORT=3000\n' > "$d/.env"; chmod 644 "$d/.env"
lib_run "$d" "$ENV_SETUP; ensure_env_file && secure_env_file" >/dev/null; rc=$?
assert_eq "merge: 0644 file with missing secrets succeeds" "0" "$rc"
assert_eq "merge: file is mode 600 afterwards"             "600" "$(file_mode "$d/.env")"
assert_eq "merge: existing value untouched"                "abc" "$(lib_run "$d" 'env_file_value POSTGRES_PASSWORD')"
assert_eq "merge: missing secret appended"                 "64" "$(lib_run "$d" 'v=$(env_file_value AUDIT_HASH_KEY); printf %s ${#v}')"

# F9-3: refuse to append secrets to a group- or world-writable file.
for m in 664 646; do
    d=$(new_case); write_example "$d"
    printf 'POSTGRES_PASSWORD=abc\n' > "$d/.env"; chmod "$m" "$d/.env"
    before=$(cat "$d/.env")
    lib_run "$d" "$ENV_SETUP; ensure_env_file" >/dev/null; rc=$?
    assert_eq "merge: mode $m file with missing secrets is refused" "1" "$rc"
    assert_eq "merge: mode $m file left unchanged" "$before" "$(cat "$d/.env")"
    assert_eq "merge: mode $m refusal names the fix" "yes" "$(grep -q 'chmod 600' "$d/stderr" && echo yes || echo no)"
done

# F9-3: nothing to append → a group-writable file is simply tightened.
d=$(new_case); write_example "$d"
printf 'POSTGRES_PASSWORD=a\nAUDIT_HASH_KEY=b\nCORRELATION_SALT=c\nWEB_PORT=1\n' > "$d/.env"; chmod 664 "$d/.env"
lib_run "$d" "$ENV_SETUP; ensure_env_file && secure_env_file" >/dev/null; rc=$?
assert_eq "merge: complete group-writable file is accepted" "0" "$rc"
assert_eq "merge: complete file tightened to 600"           "600" "$(file_mode "$d/.env")"

#@@CASES@@


# ─── Summary ─────────────────────────────────────────────────────────────────
printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
