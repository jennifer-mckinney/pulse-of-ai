#!/usr/bin/env bash
# scripts/test/render-hash.test.sh: tests for the diagram PNG hash guard
# (docs/diagrams/png_mmd_hash.py and `render.sh --check`, docs audit R2-7).
#
#   bash scripts/test/render-hash.test.sh      (npm run test:diagrams)
#
# render.sh writes the SHA-256 of each .mmd into its PNG (tEXt chunk
# mmd-sha256) and --check fails with png-stale-mmd-hash when the chunk is
# missing or differs. The round-2 docs audit showed the pixel tolerance alone
# let small edits through (its mutations M2, S1, S3 and S4); each is replayed
# here on a scratch copy and must now FAIL. The committed tree must PASS.
# Needs bash and python3 only: every render.sh run here uses --hash-only, so
# no Node, mmdc or Chromium is started. tests/unit/pure/renderHash.test.js
# runs this file from jest.
#
# Exit code: 0 when every case passed, 1 otherwise.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIAGRAMS="$ROOT/docs/diagrams"
HASH="$DIAGRAMS/png_mmd_hash.py"
RENDER="$DIAGRAMS/render.sh"
PASSED=0
FAILED=0
SCRATCH=$(mktemp -d "${TMPDIR:-/tmp}/render-hash-test.XXXXXX")
trap 'rm -rf "$SCRATCH"' EXIT

pass() { PASSED=$((PASSED + 1)); printf 'ok   %s\n' "$1"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL %s\n     %s\n' "$1" "$2"; }

# copy_diagram NAME: copy states/retention-lifecycle (.mmd, .png, .html) to
# $SCRATCH/NAME/ and print the .mmd path.
copy_diagram() {
    local dir="$SCRATCH/$1"
    mkdir -p "$dir"
    cp "$DIAGRAMS/states/retention-lifecycle.mmd" "$DIAGRAMS/states/retention-lifecycle.png" \
       "$DIAGRAMS/states/retention-lifecycle.html" "$dir/"
    printf '%s\n' "$dir/retention-lifecycle.mmd"
}

# expect_stale NAME MMD: render.sh --check --hash-only must fail on MMD with
# png-stale-mmd-hash. The HTML is regenerated from the mutated .mmd first, so
# the only thing that can fail is the PNG.
expect_stale() {
    local name="$1" mmd="$2" out rc
    python3 - "$mmd" <<'PY'
import html, re, sys
src = sys.argv[1]
page_path = src[:-4] + ".html"
text = open(src, encoding="utf-8").read()
page = open(page_path, encoding="utf-8").read()
page = re.sub(r'(<pre class="mermaid">\n).*?(</pre>)',
              lambda m: m.group(1) + html.escape(text, quote=False) + m.group(2), page, flags=re.S)
open(page_path, "w", encoding="utf-8").write(page)
PY
    out="$(bash "$RENDER" --check --hash-only "$mmd" 2>&1)"; rc=$?
    if (( rc != 0 )) && [[ "$out" == *png-stale-mmd-hash* ]] && [[ "$out" != *html-out-of-sync* ]]; then
        pass "$name"
    else
        fail "$name" "expected a png-stale-mmd-hash FAIL, got rc=$rc: $out"
    fi
}

# 1. The committed tree passes: every PNG carries its current .mmd's hash.
out="$(bash "$RENDER" --check --hash-only 2>&1)"; rc=$?
n_ok="$(printf '%s\n' "$out" | grep -c '^ok ')"
n_mmd="$(find "$DIAGRAMS" -name '*.mmd' | wc -l | tr -d ' ')"
if (( rc == 0 )) && [[ "$n_ok" == "$n_mmd" ]]; then
    pass "committed tree: all $n_mmd diagrams pass --check --hash-only"
else
    fail "committed tree passes" "rc=$rc ok=$n_ok of $n_mmd: $out"
fi

# 2. A pristine copy passes the helper and render.sh.
mmd="$(copy_diagram pristine)"
if python3 "$HASH" check "${mmd%.mmd}.png" "$mmd" >/dev/null \
   && bash "$RENDER" --check --hash-only "$mmd" >/dev/null 2>&1; then
    pass "pristine copy passes"
else
    fail "pristine copy passes" "$(bash "$RENDER" --check --hash-only "$mmd" 2>&1)"
fi

# 3. The audit's mutations, each on its own copy, must FAIL.
# M2: one word of a drawn label (round-2 M2 was a rendered edit): "hour" in
# the Tier 1 state label becomes "day", which changes the text in the PNG.
mmd="$(copy_diagram m2)"
python3 - "$mmd" <<'PY'
import sys; p = sys.argv[1]; s = open(p, encoding="utf-8").read()
old = "shown on the page for its trailing hour"
line = next((l for l in s.splitlines() if old in l), "")
assert s.count(old) == 1 and not line.startswith("%%"), \
    "fixture drifted: update mutation M2 in render-hash.test.sh (retention-lifecycle.mmd label reworded)"
s2 = s.replace(old, "shown on the page for its trailing day", 1)
assert s2 != s; open(p, "w", encoding="utf-8").write(s2)
PY
expect_stale "M2 one-word rendered label edit fails" "$mmd"
# S1: one number (the first digit run in the file, which is in the %% Sources comment; the hash guard must fail any byte change, rendered or not).
mmd="$(copy_diagram s1)"
python3 - "$mmd" <<'PY'
import re, sys; p = sys.argv[1]; s = open(p, encoding="utf-8").read()
s2 = re.sub(r"\d+", lambda m: str(int(m.group(0)) + 1), s, count=1)
assert s2 != s; open(p, "w", encoding="utf-8").write(s2)
PY
expect_stale "S1 one-number edit fails" "$mmd"
# S3: one node's colour changed: detail is taken out of the done class line
# and given the planned class (grey fill, dashed border), so its drawn
# colour changes.
mmd="$(copy_diagram s3)"
python3 - "$mmd" <<'PY'
import sys; p = sys.argv[1]; s = open(p, encoding="utf-8").read()
old = "  class detail, blanked, removed, purged, compacted done\n"
assert s.count(old) == 1, \
    "fixture drifted: update mutation S3 in render-hash.test.sh (retention-lifecycle.mmd class line changed)"
s2 = s.replace(old, "  class blanked, removed, purged, compacted done\n"
               "  classDef planned fill:#f2f2f2,stroke:#8a8a8a,color:#4a4a4a,stroke-dasharray:2 3\n"
               "  class detail planned\n", 1)
assert s2 != s; open(p, "w", encoding="utf-8").write(s2)
PY
expect_stale "S3 one-node colour edit fails" "$mmd"
# S4: one extra node.
mmd="$(copy_diagram s4)"
printf '  detail --> extra_state : one more edge\n' >> "$mmd"
expect_stale "S4 one extra node fails" "$mmd"
# Whitespace-only edit: still a different .mmd, so it fails too.
mmd="$(copy_diagram ws)"
printf '\n' >> "$mmd"
expect_stale "trailing-newline edit fails" "$mmd"

# 4. A PNG with no chunk (rendered before the guard existed) fails.
mmd="$(copy_diagram nochunk)"
python3 - "$HASH" "${mmd%.mmd}.png" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("h", sys.argv[1]); h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
p = sys.argv[2]
chunks = [c for c in h.read_chunks(open(p, "rb").read()) if not h._is_hash_chunk(c)]
open(p, "wb").write(h.write_chunks(chunks))
PY
out="$(python3 "$HASH" check "${mmd%.mmd}.png" "$mmd")"; rc=$?
if (( rc == 1 )) && [[ "$out" == *"no mmd-sha256 chunk"* ]]; then pass "PNG without the chunk fails"; else fail "PNG without the chunk fails" "rc=$rc: $out"; fi

# 5. embed is idempotent (one chunk) and leaves the image data untouched.
mmd="$(copy_diagram embed)"
png="${mmd%.mmd}.png"
out="$(python3 - "$HASH" "$png" "$mmd" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location("h", sys.argv[1]); h = importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
png, mmd = sys.argv[2], sys.argv[3]
def pixels(path):
    return [c for c in h.read_chunks(open(path, "rb").read()) if c[0] in (b"IHDR", b"IDAT", b"IEND")]
before = pixels(png)
h.embed(png, mmd); h.embed(png, mmd)
chunks = h.read_chunks(open(png, "rb").read())
n = sum(1 for c in chunks if h._is_hash_chunk(c))
print("ok" if n == 1 and pixels(png) == before and h.check(png, mmd)[0] else f"chunks={n} same_pixels={pixels(png) == before}")
PY
)"
if [[ "$out" == ok ]]; then pass "embed is idempotent and keeps the pixels"; else fail "embed is idempotent and keeps the pixels" "$out"; fi

# 6. A file that is not a PNG fails cleanly (no traceback).
mmd="$(copy_diagram notpng)"
printf 'not a png' > "${mmd%.mmd}.png"
out="$(python3 "$HASH" check "${mmd%.mmd}.png" "$mmd" 2>&1)"; rc=$?
if (( rc == 1 )) && [[ "$out" == *"png-stale-mmd-hash(unreadable"* ]] && [[ "$out" != *Traceback* ]]; then
    pass "a non-PNG fails with a clear message"
else
    fail "a non-PNG fails with a clear message" "rc=$rc: $out"
fi

# 6b. Structurally damaged PNGs fail even though the hash chunk is intact
# (Copilot r4151336164): the --hash-only gate reads only IHDR and the hash
# chunk, so read_chunks itself must require a terminal IEND and verify every
# chunk CRC. Each case must fail in the helper AND in render.sh --check.
# damage_png MODE PNG: rewrite PNG in place.
#   no-iend    drop the IEND chunk (file truncated on a chunk boundary)
#   bad-crc    flip one byte of the first IDAT payload, CRC left as is
#   trailing   append bytes after IEND
damage_png() {
    python3 - "$1" "$2" <<'PY'
import struct, sys
mode, p = sys.argv[1], sys.argv[2]
data = bytearray(open(p, "rb").read())
assert data[-8:-4] == b"IEND", "fixture PNG must end with IEND"
if mode == "no-iend":
    data = data[:-12]
elif mode == "bad-crc":
    i = 8
    while data[i + 4:i + 8] != b"IDAT":
        (length,) = struct.unpack(">I", bytes(data[i:i + 4]))
        i += 12 + length
    data[i + 8] ^= 0xFF
elif mode == "trailing":
    data += b"junk"
elif mode == "oversize":
    data += b"\0" * (33 * 1024 * 1024)
open(p, "wb").write(bytes(data))
PY
}
expect_damaged() {
    local name="$1" mode="$2" want="$3" mmd out rc out2 rc2
    mmd="$(copy_diagram "dmg-$mode")"
    damage_png "$mode" "${mmd%.mmd}.png"
    out="$(python3 "$HASH" check "${mmd%.mmd}.png" "$mmd" 2>&1)"; rc=$?
    out2="$(bash "$RENDER" --check --hash-only "$mmd" 2>&1)"; rc2=$?
    if (( rc == 1 )) && [[ "$out" == *"png-stale-mmd-hash(unreadable"*"$want"* ]] && [[ "$out" != *Traceback* ]] \
       && (( rc2 != 0 )) && [[ "$out2" == *png-stale-mmd-hash* ]]; then
        pass "$name"
    else
        fail "$name" "helper rc=$rc: $out | render.sh rc=$rc2: $out2"
    fi
}
expect_damaged "a PNG truncated before IEND fails" no-iend "missing IEND"
expect_damaged "a PNG with a corrupted chunk CRC fails" bad-crc "CRC mismatch"
expect_damaged "a PNG with bytes after IEND fails" trailing "after IEND"
expect_damaged "a PNG over the size cap fails before it is parsed" oversize "larger than"

# 6c. The HTML must load the pinned Mermaid release (render.sh
# MERMAID_VERSION + MERMAID_SRI) and nothing else (Copilot review on PR #40:
# a floating mermaid@11 lets the HTML drift from the PNG renderer).
# expect_html_fail NAME MODE: damage the copy's .html (MODE floating | sri |
# extra), then --check --hash-only must fail with html-out-of-sync.
expect_html_fail() {
    local name="$1" mode="$2" mmd out rc
    mmd="$(copy_diagram "html-$mode")"
    python3 - "${mmd%.mmd}.html" "$mode" <<'PY'
import re, sys
path, mode = sys.argv[1], sys.argv[2]
page = open(path, encoding="utf-8").read()
if mode == "floating":
    page = re.sub(r"mermaid@[0-9.]+/", "mermaid@11/", page)
elif mode == "sri":
    page = re.sub(r'integrity="sha384-[^"]+"', 'integrity="sha384-AAAA"', page)
elif mode == "no-csp":
    page = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>\n', "", page)
elif mode == "loose-csp":
    page = page.replace("style-src 'unsafe-inline'", "script-src 'unsafe-inline'; style-src 'unsafe-inline'")
elif mode == "inline-extra":
    page = page.replace("</body>", "<script>alert(1)</script>\n</body>")
elif mode == "extra":
    page = page.replace("</head>", '<script src="https://example.org/x.js"></script>\n</head>')
open(path, "w", encoding="utf-8").write(page)
PY
    out="$(bash "$RENDER" --check --hash-only "$mmd" 2>&1)"; rc=$?
    if (( rc != 0 )) && [[ "$out" == *html-out-of-sync* ]]; then
        pass "$name"
    else
        fail "$name" "expected an html-out-of-sync FAIL, got rc=$rc: $out"
    fi
}
expect_html_fail "an HTML loading the floating mermaid@11 fails" floating
expect_html_fail "an HTML whose SRI hash does not match the pin fails" sri
expect_html_fail "an HTML that loads a second external script fails" extra
expect_html_fail "an HTML without its Content-Security-Policy fails" no-csp
expect_html_fail "an HTML with a loosened Content-Security-Policy fails" loose-csp
expect_html_fail "an HTML with a second inline script fails" inline-extra
mmd="$(copy_diagram html-pinned)"
if grep -q 'mermaid@[0-9]*\.[0-9]*\.[0-9]*/dist/mermaid.min.js" integrity="sha384-' "${mmd%.mmd}.html"; then
    pass "the committed HTML loads an exact mermaid version with SRI"
else
    fail "the committed HTML loads an exact mermaid version with SRI" "$(grep -n 'script src' "${mmd%.mmd}.html")"
fi

# 7. --hash-only is refused without --check.
bash "$RENDER" --hash-only >/dev/null 2>&1; rc=$?
if (( rc == 2 )); then pass "--hash-only without --check is refused"; else fail "--hash-only without --check is refused" "rc=$rc"; fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
(( FAILED == 0 ))
