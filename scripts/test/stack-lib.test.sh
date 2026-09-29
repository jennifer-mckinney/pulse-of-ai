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

# Case code is passed to lib_run in SINGLE quotes on purpose: it expands
# inside the case's subshell, after the library is sourced.
# shellcheck disable=SC2016

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

# tmp_files DIR: standup's secrets temp files (.env.tmp.<pid>) left in DIR.
tmp_files() { find "$1" -maxdepth 1 -name '*.tmp.*' -print; }

# new_case: fresh scratch dir; prints its path.
new_case() {
    local d
    d=$(mktemp -d "$SCRATCH/case.XXXXXX")
    printf '%s' "$d"
}

# Stack variables the library lets the SHELL override (scripts/lib/stack.sh
# "Environment knobs"). The cases set them explicitly where they matter, so
# the caller's own values (e.g. a developer who exported COMPOSE_PROJECT_NAME
# or POSTGRES_TEST_PORT for another stack) are removed first: every case
# sees only what it sets.
HERMETIC_UNSET=(COMPOSE_PROJECT_NAME WEB_PORT POSTGRES_PORT POSTGRES_TEST_PORT REDIS_PORT
    PULSE_BIND_ADDR POSTGRES_PASSWORD REDIS_PASSWORD AUDIT_HASH_KEY CORRELATION_SALT)
HERMETIC_ENV_U=()
for v in "${HERMETIC_UNSET[@]}"; do HERMETIC_ENV_U+=(-u "$v"); done

# lib_run DIR CODE: run CODE in a subshell that sourced the library with
# PULSE_ENV_FILE=DIR/.env. Prints stdout; stderr goes to DIR/stderr.
lib_run() {
    local dir=$1 code=$2
    (
        export PULSE_ENV_FILE="$dir/.env"
        unset "${HERMETIC_UNSET[@]}"
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
assert_eq "ensure_env_file: no temp file left"             "" "$(tmp_files "$d")"

# F9-4: a failing secret generator must not leave the secrets temp file.
d=$(new_case); write_example "$d"
lib_run "$d" "$ENV_SETUP; gen_secret() { return 1; }; ensure_env_file" >/dev/null; rc=$?
assert_eq "ensure_env_file: generator failure exits non-zero" "1" "$rc"
assert_eq "ensure_env_file: generator failure leaves no temp" "" "$(tmp_files "$d")"
assert_eq "ensure_env_file: generator failure writes no .env" "no" "$([[ -e "$d/.env" ]] && echo yes || echo no)"

# F9-4: interrupted mid-write (TERM while generating) — temp file removed.
d=$(new_case); write_example "$d"
# MAIN is the case subshell's own pid ($BASHPID does not exist in bash 3.2):
# a DIRECT child `sh -c 'echo $PPID'` reports it (command substitution would
# add a subshell level, so it goes through a file).
lib_run "$d" "$ENV_SETUP; sh -c 'echo \$PPID' > \"$d/main.pid\"; MAIN=\$(cat \"$d/main.pid\"); gen_secret() { kill -TERM \"\$MAIN\"; sleep 1; echo x; }; ensure_env_file" >/dev/null; rc=$?

assert_eq "ensure_env_file: TERM exits 143"           "143" "$rc"
assert_eq "ensure_env_file: TERM leaves no temp file" "" "$(tmp_files "$d")"
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

# Copilot 4129574000: ensure_env_file ALONE hardens an existing file, and
# only then prints its success line.
d=$(new_case); write_example "$d"
printf 'POSTGRES_PASSWORD=a\nAUDIT_HASH_KEY=b\nCORRELATION_SALT=c\nWEB_PORT=1\n' > "$d/.env"; chmod 644 "$d/.env"
out=$(lib_run "$d" "$ENV_SETUP; ensure_env_file"); rc=$?
assert_eq "existing complete 0644 file: ensure_env_file succeeds" "0" "$rc"
assert_eq "existing complete 0644 file: mode 600 after ensure_env_file" "600" "$(file_mode "$d/.env")"
assert_eq "existing complete 0644 file: success line says mode 600" "yes" "$(grep -q 'kept existing.*mode 600' <<< "$out" && echo yes || echo no)"
d=$(new_case); write_example "$d"
printf 'POSTGRES_PASSWORD=abc\n' > "$d/.env"; chmod 644 "$d/.env"
lib_run "$d" "$ENV_SETUP; ensure_env_file" >/dev/null; rc=$?
assert_eq "existing 0644 file + appended keys: mode 600 after ensure_env_file" "600" "$(file_mode "$d/.env")"
# chmod failing (e.g. a file owned by someone else) → die, and NO success line.
d=$(new_case); write_example "$d"
printf 'POSTGRES_PASSWORD=a\nAUDIT_HASH_KEY=b\nCORRELATION_SALT=c\nWEB_PORT=1\n' > "$d/.env"; chmod 644 "$d/.env"
out=$(lib_run "$d" "$ENV_SETUP; chmod() { return 1; }; ensure_env_file"); rc=$?
assert_eq "chmod failure: ensure_env_file exits non-zero" "1" "$rc"
assert_eq "chmod failure: no success line printed" "" "$(grep 'kept existing' <<< "$out" || true)"
assert_eq "chmod failure: error names chmod 600" "yes" "$(grep -q 'could not chmod 600' "$d/stderr" && echo yes || echo no)"

# ─── G9-3: run_with_timeout kills the whole process group ────────────────────
alive() { kill -0 "$1" 2>/dev/null && echo alive || echo dead; }

d=$(new_case)
t0=$(date +%s)
out=$(lib_run "$d" "echo before; run_with_timeout 2 bash -c 'sleep 60 & echo \$! > \"$d/grandchild.pid\"; echo \$\$ > \"$d/child.pid\"; sleep 60'; echo \"rc=\$?\"")
t1=$(date +%s)
assert_eq "run_with_timeout: reports 124 on timeout"   "rc=124" "$(printf '%s\n' "$out" | tail -n 1)"
assert_eq "run_with_timeout: returns promptly"         "yes" "$( (( t1 - t0 <= 15 )) && echo yes || echo "no ($((t1 - t0))s)")"
sleep 1
assert_eq "run_with_timeout: direct child killed"      "dead" "$(alive "$(cat "$d/child.pid")")"
assert_eq "run_with_timeout: grandchild killed"        "dead" "$(alive "$(cat "$d/grandchild.pid")")"
assert_eq "run_with_timeout: no job-control noise"     "" "$(grep -E 'Terminated|Killed|Done|no job control' "$d/stderr" || true)"

# A shell FUNCTION (standup passes compose_full) is covered the same way.
d=$(new_case)
out=$(lib_run "$d" "slow() { sleep 60 & echo \$! > \"$d/grandchild.pid\"; wait; }; run_with_timeout 2 slow; echo \"rc=\$?\"")
assert_eq "run_with_timeout: function times out (124)" "rc=124" "$(printf '%s\n' "$out" | tail -n 1)"
sleep 1
assert_eq "run_with_timeout: function's child killed"  "dead" "$(alive "$(cat "$d/grandchild.pid")")"

# SIGTERM to the script while it waits: the watched group is stopped too.
d=$(new_case)
lib_run "$d" "sh -c 'echo \$PPID' > \"$d/main.pid\"; run_with_timeout 60 bash -c 'sleep 60 & echo \$! > \"$d/grandchild.pid\"; sleep 60'" >/dev/null &
case_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [[ -s "$d/grandchild.pid" ]] && break; sleep 0.5; done
kill -TERM "$(cat "$d/main.pid")"
wait "$case_pid"; rc=$?
assert_eq "run_with_timeout: SIGTERM exits 143"          "143" "$rc"
sleep 1
assert_eq "run_with_timeout: SIGTERM stops the group"    "dead" "$(alive "$(cat "$d/grandchild.pid")")"

d=$(new_case)
assert_eq "run_with_timeout: passes exit status through" "rc=7" "$(lib_run "$d" "run_with_timeout 5 bash -c 'exit 7'; echo \"rc=\$?\"")"
assert_eq "run_with_timeout: success is 0"               "rc=0" "$(lib_run "$d" "run_with_timeout 5 true; echo \"rc=\$?\"")"
assert_eq "run_with_timeout: command output passes"      "hello" "$(lib_run "$d" "run_with_timeout 5 echo hello")"
assert_eq "run_with_timeout: job control restored (off)" "off" "$(lib_run "$d" "run_with_timeout 5 true; [[ \$- == *m* ]] && echo on || echo off")"

# ─── G9-4: an unresolvable web port reaches `die` under set -e/pipefail ─────
d=$(new_case)
lib_run "$d" "set -euo pipefail; STACK_PROJECT=t; docker() { return 1; }; url=\$(published_web_url) || die 'could not resolve the published port of the web service'; echo \"url=\$url\"" >/dev/null; rc=$?
assert_eq "published_web_url: failing compose → die fires" "1" "$rc"
assert_eq "published_web_url: failing compose → message"   "yes" "$(grep -q 'could not resolve the published port' "$d/stderr" && echo yes || echo no)"
d=$(new_case)
assert_eq "published_web_url: host port → localhost URL" "url=http://localhost:3500" \
    "$(lib_run "$d" "set -euo pipefail; STACK_PROJECT=t; docker() { echo '127.0.0.1:3500'; }; url=\$(published_web_url) || die x; echo \"url=\$url\"")"

# ─── F9-1: placeholder or empty secrets stop standup ─────────────────────────
d=$(new_case); write_example "$d"
printf 'REDIS_PASSWORD=replace_with_random_64_hex_chars\n' >> "$d/.env.example"
lib_run "$d" "$ENV_SETUP; ensure_env_file" >/dev/null
assert_eq "REDIS_PASSWORD is a generated secret"      "64" "$(lib_run "$d" 'v=$(env_file_value REDIS_PASSWORD); [[ "$v" =~ ^[0-9a-f]{64}$ ]] && printf %s ${#v}')"
lib_run "$d" "$ENV_SETUP; check_env_secrets" >/dev/null; rc=$?
assert_eq "check_env_secrets: generated secrets pass" "0" "$rc"

for key in POSTGRES_PASSWORD REDIS_PASSWORD AUDIT_HASH_KEY CORRELATION_SALT; do
    d=$(new_case); write_example "$d"
    printf 'REDIS_PASSWORD=replace_with_random_64_hex_chars\n' >> "$d/.env.example"
    lib_run "$d" "$ENV_SETUP; ensure_env_file" >/dev/null
    placeholder=$(grep "^$key=" "$d/.env.example" | cut -d= -f2-)
    printf '%s=%s\n' "$key" "$placeholder" >> "$d/.env"
    lib_run "$d" "$ENV_SETUP; check_env_secrets" >/dev/null; rc=$?
    assert_eq "check_env_secrets: placeholder $key dies" "1" "$rc"
    printf '%s=\n' "$key" >> "$d/.env"
    lib_run "$d" "$ENV_SETUP; check_env_secrets" >/dev/null; rc=$?
    assert_eq "check_env_secrets: empty $key dies" "1" "$rc"
done
# A placeholder with an inline comment is still the placeholder.
d=$(new_case); write_example "$d"
lib_run "$d" "$ENV_SETUP; ensure_env_file" >/dev/null
printf 'POSTGRES_PASSWORD=changeme_before_production   # todo\n' >> "$d/.env"
lib_run "$d" "$ENV_SETUP; check_env_secrets" >/dev/null; rc=$?
assert_eq "check_env_secrets: commented placeholder dies" "1" "$rc"

# ─── F9-7: project-name source ───────────────────────────────────────────────
d=$(new_case)
assert_eq "stack_project_source: default"   "default"   "$(lib_run "$d" 'stack_project_source')"
printf 'COMPOSE_PROJECT_NAME=from-file\n' > "$d/.env"
assert_eq "stack_project_source: env file"  "env file"  "$(lib_run "$d" 'stack_project_source')"
assert_eq "stack_project_source: shell env" "shell env" "$(lib_run "$d" 'COMPOSE_PROJECT_NAME=from-shell; stack_project_source')"
assert_eq "project_from_foreign_shell: differs → yes" "yes" "$(lib_run "$d" 'COMPOSE_PROJECT_NAME=other; project_from_foreign_shell && echo yes || echo no')"
assert_eq "project_from_foreign_shell: same → no"    "no"  "$(lib_run "$d" 'COMPOSE_PROJECT_NAME=from-file; project_from_foreign_shell && echo yes || echo no')"
assert_eq "project_from_foreign_shell: file only → no" "no" "$(lib_run "$d" 'project_from_foreign_shell && echo yes || echo no')"
d=$(new_case)
assert_eq "project_from_foreign_shell: shell vs default" "yes" "$(lib_run "$d" 'COMPOSE_PROJECT_NAME=other; project_from_foreign_shell && echo yes || echo no')"

# ─── F9-7 / P9-4: teardown.sh against a fake docker ──────────────────────────
# The fake records every call in $FAKE_LOG; the project "has" one container
# until `down` runs.
FAKE_BIN="$SCRATCH/fakebin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/docker" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_LOG"
case "$1" in
    info) exit 0 ;;
    ps) [[ -e "$FAKE_STATE/down" ]] || echo c0ffee; exit 0 ;;
    volume) exit 0 ;;
    compose)
        [[ "$2" == "version" ]] && { echo 2.40.3; exit 0; }
        for a in "$@"; do [[ "$a" == down ]] && touch "$FAKE_STATE/down"; done
        exit 0 ;;
esac
exit 0
EOF
chmod +x "$FAKE_BIN/docker"
TEARDOWN="$(cd "$(dirname "$LIB")/.." && pwd)/teardown.sh"

# run_teardown DIR [ENV=VAL...] -- [ARGS...]: stdin is NOT a terminal.
run_teardown() {
    local dir=$1; shift
    local envs=()
    while (( $# )) && [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
    shift
    mkdir -p "$dir/state"; : > "$dir/docker.log"
    env "${HERMETIC_ENV_U[@]}" PATH="$FAKE_BIN:$PATH" FAKE_LOG="$dir/docker.log" FAKE_STATE="$dir/state" \
        PULSE_ENV_FILE="$dir/.env" ${envs[@]+"${envs[@]}"} bash "$TEARDOWN" "$@" < /dev/null > "$dir/out" 2>&1
}

d=$(new_case); printf 'COMPOSE_PROJECT_NAME=mystack\nPOSTGRES_PASSWORD=x\nREDIS_PASSWORD=y\n' > "$d/.env"
run_teardown "$d" --; rc=$?
assert_eq "teardown: plain stop succeeds"                "0" "$rc"
assert_eq "teardown: names the project source"           "yes" "$(grep -q "'mystack' (from env file" "$d/out" && echo yes || echo no)"
assert_eq "teardown: runs down"                          "yes" "$(grep -q ' down' "$d/docker.log" && echo yes || echo no)"
assert_eq "teardown: never --remove-orphans"             "no" "$(grep -q -- '--remove-orphans' "$d/docker.log" && echo yes || echo no)"

d=$(new_case); printf 'COMPOSE_PROJECT_NAME=mystack\nPOSTGRES_PASSWORD=x\nREDIS_PASSWORD=y\n' > "$d/.env"
run_teardown "$d" COMPOSE_PROJECT_NAME=otherapp --; rc=$?
assert_eq "teardown: foreign shell project, no tty → refused" "1" "$rc"
assert_eq "teardown: foreign shell project → nothing stopped" "no" "$(grep -q ' down' "$d/docker.log" && echo yes || echo no)"
assert_eq "teardown: foreign shell project → explains"        "yes" "$(grep -q "shell env" "$d/out" && grep -q "mystack" "$d/out" && echo yes || echo no)"

d=$(new_case); printf 'COMPOSE_PROJECT_NAME=mystack\nPOSTGRES_PASSWORD=x\nREDIS_PASSWORD=y\n' > "$d/.env"
run_teardown "$d" COMPOSE_PROJECT_NAME=otherapp -- --yes; rc=$?
assert_eq "teardown: foreign shell project + --yes proceeds"  "0" "$rc"
assert_eq "teardown: --yes stops the named project"           "yes" "$(grep -q -- '-p otherapp .* down' "$d/docker.log" && echo yes || echo no)"
assert_eq "teardown: --purge --yes still no --remove-orphans" "no" "$(run_teardown "$d" COMPOSE_PROJECT_NAME=otherapp -- --purge --yes; grep -q -- '--remove-orphans' "$d/docker.log" && echo yes || echo no)"

d=$(new_case); printf 'POSTGRES_PASSWORD=x\nREDIS_PASSWORD=y\n' > "$d/.env"
run_teardown "$d" --; rc=$?
assert_eq "teardown: shared dev project stops (plain)"        "0" "$rc"
assert_eq "teardown: warns about the shared dev project"      "yes" "$(grep -q "shared dev project" "$d/out" && echo yes || echo no)"
assert_eq "teardown: notes postgres_test on 5433"             "yes" "$(grep -q "postgres_test" "$d/out" && grep -q "5433" "$d/out" && echo yes || echo no)"

# ─── Copilot 4129574025: Compose minimum version (2.39.0) ────────────────────
d=$(new_case)
assert_eq "compose minimum is 2.39.0" "2.39.0" "$(lib_run "$d" 'printf %s "$STACK_COMPOSE_MIN_VERSION"')"
# VERSION|expected parse ("" = unparseable)
for c in "2.39.0|2 39 0" "v2.39.0-desktop.1|2 39 0" "2.40.3|2 40 3" "v2.39.0|2 39 0" \
         "2.39.0+build.7|2 39 0" "2.39|2 39 0" " 2.41.0 |2 41 0" "5.3.0|5 3 0" \
         "2.100.1|2 100 1" "garbage|" "|" "v|" "2|" "2.x.0|"; do
    v=${c%%|*}; want=${c#*|}
    assert_eq "parse_compose_version '$v'" "$want" "$(lib_run "$d" "parse_compose_version '$v' || true")"
done
# VERSION|expected verdict against 2.39.0 (0 new enough, 1 too old, 2 unparseable)
for c in "2.39.0|0" "v2.39.0-desktop.1|0" "2.40.3|0" "2.39.3|0" "2.100.0|0" "5.3.0|0" "3.0.0|0" \
         "2.38.2|1" "v2.38.9-desktop.1|1" "2.9.0|1" "2.3.99|1" "1.29.2|1" "2.39|0" \
         "garbage|2" "|2"; do
    v=${c%%|*}; want=${c#*|}
    assert_eq "compose_version_at_least '$v' 2.39.0 → $want" "$want" \
        "$(lib_run "$d" "compose_version_at_least '$v' 2.39.0; echo \$?")"
done
# check_docker against a fake docker reporting each version.
fake_docker_case() { # VERSION → prints rc; stderr in $d/stderr
    lib_run "$d" "docker() { case \"\$1\" in compose) echo '$1' ;; info) return 0 ;; esac; }; check_docker; echo rc=0" || echo "rc=$?"
}
d=$(new_case)
assert_eq "check_docker: 2.38.2 is refused"            "rc=1" "$(fake_docker_case 2.38.2 | tail -n 1)"
assert_eq "check_docker: refusal names 2.39.0"         "yes"  "$(grep -q 'Compose 2.39.0 or newer is required, found .2.38.2.' "$d/stderr" && echo yes || echo no)"
assert_eq "check_docker: refusal explains why"         "yes"  "$(grep -q 'build.provenance / build.sbom' "$d/stderr" && echo yes || echo no)"
assert_eq "check_docker: refusal says how to upgrade"  "yes"  "$(grep -q 'compose/install/linux' "$d/stderr" && echo yes || echo no)"
assert_eq "check_docker: v2.39.0-desktop.1 accepted"   "rc=0" "$(fake_docker_case v2.39.0-desktop.1 | tail -n 1)"
assert_eq "check_docker: 2.40.3 accepted"              "rc=0" "$(fake_docker_case 2.40.3 | tail -n 1)"
assert_eq "check_docker: unparseable version refused"  "rc=1" "$(fake_docker_case weird | tail -n 1)"
assert_eq "check_docker: unparseable → explains"       "yes"  "$(grep -q 'could not read the Docker Compose version' "$d/stderr" && echo yes || echo no)"

#@@CASES@@



# ─── Summary ─────────────────────────────────────────────────────────────────
printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
