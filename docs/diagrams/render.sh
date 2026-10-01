#!/usr/bin/env bash
# docs/diagrams/render.sh — keep every diagram's three artifacts in sync.
#
# For each Mermaid source docs/diagrams/**/<name>.mmd (the CANONICAL file):
#   <name>.html  is regenerated: it embeds the .mmd definition VERBATIM
#                (HTML-escaped inside <pre class="mermaid">; the browser
#                decodes it back to the identical text) and renders it with
#                Mermaid MERMAID_VERSION (pinned, with SRI) and the forest theme;
#   <name>.png   is regenerated from the .mmd with @mermaid-js/mermaid-cli
#                (mmdc) running the same MERMAID_VERSION, the forest theme
#                and mmdc-config.json (natural width, useMaxWidth false),
#                at scale 2, lowered to 1.5 or 1
#                if either dimension would reach 8000 px (the Claude API
#                image limit); the script fails if it still does. The PNG
#                carries the SHA-256 of the .mmd it was rendered from, in a
#                tEXt chunk with the keyword mmd-sha256 (png_mmd_hash.py).
#
#   bash docs/diagrams/render.sh            regenerate every .html and .png
#   bash docs/diagrams/render.sh a.mmd ...  only the given sources
#   bash docs/diagrams/render.sh --check    verify CONTENT only, change nothing:
#                                           every .html embeds its .mmd byte
#                                           for byte and loads only the
#                                           pinned mermaid (version + SRI);
#                                           every .png exists, is
#                                           under 8000 px, carries the SHA-256
#                                           of its CURRENT .mmd (a missing or
#                                           different mmd-sha256 chunk fails
#                                           as png-stale-mmd-hash: this is the
#                                           guard for small edits), and matches
#                                           a fresh re-render of its .mmd (same
#                                           scale ladder, into a temp dir): the
#                                           dimensions must be identical and
#                                           the pixels identical or within
#                                           PNG_TOLERANCE (default 0.0005:
#                                           at most 0.05% of pixels may differ
#                                           by more than 32 in a channel, which
#                                           absorbs anti-aliasing noise; a size
#                                           or layout change is caught, but a
#                                           one-word, one-number or one-node
#                                           colour edit can stay under it, so
#                                           the pixel check is for rendering
#                                           drift only). No file timestamps
#                                           are used, so the check means the
#                                           same on a fresh clone as in the
#                                           editor's tree.
#   bash docs/diagrams/render.sh --check --hash-only
#                                           the same without the re-render
#                                           (HTML sync, size and mmd-sha256
#                                           only; no Node or Chromium needed)
#
# Needs: bash, python3, and npx (Node) for mmdc. --check needs Pillow for the
# tolerance comparison: without it the decoded image data must be identical,
# and re-renders are not bit-identical, so a clean tree fails. Re-renders
# depend on the fonts Chromium finds, so run --check where the PNGs were
# rendered (same OS fonts). The first line of each .mmd is
# "%% Title: <title>"; the second is "%% Summary: <one sentence>".
# Test: bash scripts/test/render-hash.test.sh (npm run test:diagrams).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MMDC_VERSION="11.12.0"
# The ONE Mermaid version both artifacts use (Copilot review on PR #40): mmdc
# is run with this exact mermaid installed beside it (mermaid-cli's own
# dependency is the range ^11.0.2, so npx would otherwise resolve whatever
# 11.x is newest), and every .html loads the same release from jsDelivr,
# pinned and checked with Subresource Integrity. MERMAID_SRI is the sha384
# of mermaid@MERMAID_VERSION/dist/mermaid.min.js; recompute both together:
#   curl -sL https://cdn.jsdelivr.net/npm/mermaid@<v>/dist/mermaid.min.js \
#     | openssl dgst -sha384 -binary | openssl base64 -A
MERMAID_VERSION="11.12.1"
MERMAID_SRI="sha384-LlKSgo4Eo5GuF/ZrstLti44dE+GC5XAJ7TSu0Nw9Q3vIZF2QMnkRcK7BUoLabYLF"
MAX_PX=8000
PNG_TOLERANCE="${PNG_TOLERANCE:-0.0005}"
CHECK=0
HASH_ONLY=0
declare -a FILES=()

for arg in "$@"; do
    case "$arg" in
        --check) CHECK=1 ;;
        --hash-only) HASH_ONLY=1 ;;
        -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"; exit 0 ;;
        *) FILES+=("$arg") ;;
    esac
done

if (( HASH_ONLY && ! CHECK )); then
    echo "render.sh: --hash-only is a --check option" >&2
    exit 2
fi

if [[ ${#FILES[@]} -eq 0 ]]; then
    while IFS= read -r f; do FILES+=("$f"); done < <(find "$HERE" -name '*.mmd' | sort)
fi

# PNG width and height from the IHDR chunk.
png_size() {
    python3 -c 'import struct,sys; d=open(sys.argv[1],"rb").read(24); print(*struct.unpack(">II", d[16:24]))' "$1"
}

# Write <name>.html for <name>.mmd.
write_html() {
    python3 - "$1" "${1%.mmd}.html" "$MERMAID_VERSION" "$MERMAID_SRI" <<'PY'
import html, sys
src, out, version, sri = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = open(src, encoding="utf-8").read()
lines = text.splitlines()
title = lines[0].split("Title:", 1)[1].strip() if lines and "Title:" in lines[0] else src
summary = lines[1].split("Summary:", 1)[1].strip() if len(lines) > 1 and "Summary:" in lines[1] else ""
name = src.rsplit("/", 1)[-1]
page = f"""<!DOCTYPE html>
<!--
  SYNC CONTRACT: {name} is the CANONICAL Mermaid source of this diagram.
  The <pre class="mermaid"> block below embeds that file's definition
  VERBATIM (HTML-escaped; the browser decodes it to the identical text),
  and the .png beside it is rendered from the same .mmd with mermaid-cli
  and the forest theme. Do not edit this file: edit the .mmd, then run
  bash docs/diagrams/render.sh.
-->
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pulse of AI · {html.escape(title)}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@{version}/dist/mermaid.min.js" integrity="{sri}" crossorigin="anonymous"></script>
<style>
  body {{ margin: 0; padding: 32px 40px; background: #ffffff; color: #1b1f23;
         font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }}
  h1 {{ font-size: 22px; margin: 0 0 6px; }}
  p.summary {{ margin: 0 0 8px; color: #57606a; font-size: 14px; }}
  p.source {{ margin: 0 0 24px; color: #57606a; font-size: 12px; }}
  pre.mermaid {{ background: none; border: none; margin: 0; }}
</style>
</head>
<body>
<h1>{html.escape(title)}</h1>
<p class="summary">{html.escape(summary)}</p>
<p class="source">Canonical source: <code>{html.escape(name)}</code> · index: <code>docs/diagrams/README.md</code></p>
<pre class="mermaid">
{html.escape(text, quote=False)}</pre>
<script>mermaid.initialize({{ startOnLoad: true, theme: 'forest', securityLevel: 'strict', maxTextSize: 200000 }});</script>
</body>
</html>
"""
open(out, "w", encoding="utf-8").write(page)
PY
}

# Exit non-zero unless <name>.html embeds <name>.mmd exactly and loads the
# pinned Mermaid release (MERMAID_VERSION, with its SRI hash) as its only
# external script.
check_html() {
    python3 - "$1" "${1%.mmd}.html" "$MERMAID_VERSION" "$MERMAID_SRI" <<'PY'
import html, re, sys
src, out, version, sri = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
text = open(src, encoding="utf-8").read()
page = open(out, encoding="utf-8").read()
m = re.search(r'<pre class="mermaid">\n(.*?)</pre>', page, re.S)
pinned = (f'<script src="https://cdn.jsdelivr.net/npm/mermaid@{version}/dist/mermaid.min.js" '
          f'integrity="{sri}" crossorigin="anonymous"></script>')
scripts = re.findall(r'<script src="', page)
sys.exit(0 if m and html.unescape(m.group(1)) == text
         and page.count(pinned) == 1 and len(scripts) == 1 else 1)
PY
}

# Render <name>.mmd to <name>.png. $2 overrides the output path (--check
# re-renders into a temp dir); $3=quiet suppresses the size line.
render_png() {
    local src="$1" png="${2:-${1%.mmd}.png}" quiet="${3:-}" scale w h
    for scale in 2 1.5 1; do
        rm -f "$png"
        if ! npx -y -p "@mermaid-js/mermaid-cli@${MMDC_VERSION}" -p "mermaid@${MERMAID_VERSION}" mmdc -q -i "$src" -o "$png" -t forest -b white -s "$scale" -c "$HERE/mmdc-config.json" >/dev/null \
            || [[ ! -f "$png" ]]; then
            echo "  mmdc failed for $src" >&2
            return 1
        fi
        read -r w h < <(png_size "$png")
        if (( w < MAX_PX && h < MAX_PX )); then
            # Record which .mmd this PNG was rendered from (--check compares it).
            # A failed embed must fail the render (this runs under `if`/`||`,
            # where set -e is off): a PNG without its hash is stale by definition.
            python3 "$HERE/png_mmd_hash.py" embed "$png" "$src" \
                || { echo "  hash embed failed for $png" >&2; return 1; }
            [[ -n "$quiet" ]] || echo "  ${png#"$HERE"/}  ${w}x${h} (scale $scale)"
            return 0
        fi
    done
    echo "  $png is ${w}x${h}: over ${MAX_PX}px even at scale 1 — split the diagram" >&2
    return 1
}

# Compare a committed PNG with a fresh re-render of its .mmd. Silent and
# exit 0 when they match; otherwise prints the problem and exits 1.
compare_png() {
    python3 - "$1" "$2" "$PNG_TOLERANCE" <<'PY'
import struct, sys, zlib
a, b, tol = sys.argv[1], sys.argv[2], float(sys.argv[3])

def ihdr(path):
    d = open(path, "rb").read(26)
    return struct.unpack(">II", d[16:24]) + tuple(d[24:26])

def idat(path):
    d, i, out = open(path, "rb").read(), 8, []
    while i < len(d):
        n, = struct.unpack(">I", d[i:i + 4])
        if d[i + 4:i + 8] == b"IDAT":
            out.append(d[i + 8:i + 8 + n])
        i += 12 + n
    return zlib.decompress(b"".join(out))

ha, hb = ihdr(a), ihdr(b)
if ha[:2] != hb[:2]:
    print(f"png-{ha[0]}x{ha[1]}-but-rerender-{hb[0]}x{hb[1]}")
    sys.exit(1)
try:
    from PIL import Image, ImageChops
except ImportError:
    # Without Pillow the decoded image data must be identical.
    if ha == hb and idat(a) == idat(b):
        sys.exit(0)
    print("png-differs-from-rerender(install-Pillow-for-tolerance)")
    sys.exit(1)
ia, ib = Image.open(a).convert("RGB"), Image.open(b).convert("RGB")
r, g, bl = ImageChops.difference(ia, ib).split()
# Largest channel difference per pixel; count the pixels above 32.
worst = ImageChops.lighter(ImageChops.lighter(r, g), bl)
changed = sum(worst.histogram()[33:])
total = ia.size[0] * ia.size[1]
if changed > tol * total:
    print(f"png-differs-from-rerender({changed}/{total}px)")
    sys.exit(1)
PY
}

TMP=""
if (( CHECK )); then
    TMP="$(mktemp -d "${TMPDIR:-/tmp}/render-check.XXXXXX")"
    trap 'rm -rf "$TMP"' EXIT
fi

status=0
for src in "${FILES[@]}"; do
    [[ "$src" == /* ]] || src="$(pwd)/$src"
    rel="${src#"$HERE"/}"
    png="${src%.mmd}.png"
    if (( CHECK )); then
        problems=""
        check_html "$src" || problems+=" html-out-of-sync"
        if [[ ! -f "$png" ]]; then
            problems+=" png-missing"
        else
            read -r w h < <(png_size "$png")
            (( w < MAX_PX && h < MAX_PX )) || problems+=" png-${w}x${h}-too-large"
            verdict="$(python3 "$HERE/png_mmd_hash.py" check "$png" "$src")" || problems+=" $verdict"
            if (( ! HASH_ONLY )); then
                fresh="$TMP/$(printf '%s' "${rel%.mmd}" | tr '/' '_').png"
                if render_png "$src" "$fresh" quiet; then
                    verdict="$(compare_png "$png" "$fresh")" || problems+=" $verdict"
                else
                    problems+=" rerender-failed"
                fi
            fi
        fi
        if [[ -n "$problems" ]]; then echo "FAIL $rel:$problems"; status=1; else echo "ok   $rel (${w}x${h})"; fi
    else
        echo "$rel"
        write_html "$src"
        render_png "$src" || status=1
    fi
done
exit $status
