#!/usr/bin/env python3
"""docs/diagrams/png_mmd_hash.py: tie each rendered PNG to the exact .mmd it came from.

render.sh writes the SHA-256 of the source .mmd into every PNG it renders, as
a PNG tEXt chunk with the keyword ``mmd-sha256``. ``render.sh --check`` reads
it back: a PNG whose chunk is missing, or holds another hash than the current
.mmd, was not rendered from that .mmd. The pixel comparison in render.sh stays
for rendering drift only; this hash is what catches small .mmd edits (one
word, one number, one node's colour class) that change too few pixels for the
pixel tolerance to notice.

Usage:
  python3 png_mmd_hash.py embed <png> <mmd>   write or replace the chunk in <png>
  python3 png_mmd_hash.py check <png> <mmd>   exit 0 if the chunk matches <mmd>;
                                              else print png-stale-mmd-hash
                                              (with a reason) and exit 1
  python3 png_mmd_hash.py show  <png>         print the stored hash (or nothing)

Only the standard library is used. The chunk is ancillary (tEXt), so image
viewers and the IHDR/IDAT pixel data are unaffected.
"""

import hashlib
import struct
import sys
import zlib

KEYWORD = b"mmd-sha256"
# The committed diagram PNGs are well under 1 MB; a cap keeps a hostile or
# corrupt multi-GB file from being read into memory whole.
MAX_PNG_BYTES = 32 * 1024 * 1024
PNG_SIG = b"\x89PNG\r\n\x1a\n"


def mmd_sha256(mmd_path):
    """SHA-256 (hex) of the .mmd file's bytes."""
    with open(mmd_path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def read_png_file(path):
    """Read a PNG file's bytes, refusing one over MAX_PNG_BYTES."""
    with open(path, "rb") as fh:
        data = fh.read(MAX_PNG_BYTES + 1)
    if len(data) > MAX_PNG_BYTES:
        raise ValueError(f"PNG larger than {MAX_PNG_BYTES} bytes")
    return data


def read_chunks(data):
    """Split PNG bytes into [(type, payload)]; raise ValueError if malformed.

    The --hash-only gate reads nothing but IHDR and the hash chunk, so this
    is also the structural check on a committed PNG: every chunk's CRC must
    match, IEND must be present, and nothing may follow it. A truncated or
    corrupted file therefore fails instead of passing on an intact hash.
    """
    if data[:8] != PNG_SIG:
        raise ValueError("not a PNG")
    chunks, i = [], 8
    while i < len(data):
        if i + 8 > len(data):
            raise ValueError("truncated chunk header")
        (length,) = struct.unpack(">I", data[i:i + 4])
        ctype = data[i + 4:i + 8]
        payload = data[i + 8:i + 8 + length]
        if len(payload) != length or i + 12 + length > len(data):
            raise ValueError("truncated chunk")
        # Verify the stored CRC (over type + payload) for every chunk.
        (crc,) = struct.unpack(">I", data[i + 8 + length:i + 12 + length])
        if crc != zlib.crc32(ctype + payload) & 0xFFFFFFFF:
            raise ValueError(f"CRC mismatch in {ctype.decode('latin-1')} chunk")
        chunks.append((ctype, payload))
        i += 12 + length
        if ctype == b"IEND":
            # IEND must be the terminal chunk: reject any trailing bytes.
            if i != len(data):
                raise ValueError(f"{len(data) - i} trailing bytes after IEND")
            return chunks
    # The loop ran out of data without seeing IEND: the file is truncated.
    raise ValueError("missing IEND (truncated PNG)")


def write_chunks(chunks):
    """Serialise [(type, payload)] back to PNG bytes with fresh CRCs."""
    out = [PNG_SIG]
    for ctype, payload in chunks:
        crc = zlib.crc32(ctype + payload) & 0xFFFFFFFF
        out.append(struct.pack(">I", len(payload)) + ctype + payload + struct.pack(">I", crc))
    return b"".join(out)


def _is_hash_chunk(chunk):
    return chunk[0] == b"tEXt" and chunk[1].startswith(KEYWORD + b"\x00")


def stored_hash(png_path):
    """The hash in the PNG's mmd-sha256 tEXt chunk, or None."""
    chunks = read_chunks(read_png_file(png_path))
    for chunk in chunks:
        if _is_hash_chunk(chunk):
            return chunk[1][len(KEYWORD) + 1:].decode("latin-1")
    return None


def embed(png_path, mmd_path):
    """Write (or replace) the mmd-sha256 chunk, right after IHDR."""
    chunks = [c for c in read_chunks(read_png_file(png_path)) if not _is_hash_chunk(c)]
    payload = KEYWORD + b"\x00" + mmd_sha256(mmd_path).encode("ascii")
    at = 1 if chunks and chunks[0][0] == b"IHDR" else 0
    chunks.insert(at, (b"tEXt", payload))
    with open(png_path, "wb") as fh:
        fh.write(write_chunks(chunks))


def check(png_path, mmd_path):
    """(ok, problem) for a committed PNG against its current .mmd."""
    try:
        have = stored_hash(png_path)
    except (OSError, ValueError) as err:
        return False, f"png-stale-mmd-hash(unreadable: {err})"
    if have is None:
        return False, "png-stale-mmd-hash(no mmd-sha256 chunk; re-render)"
    want = mmd_sha256(mmd_path)
    if have != want:
        return False, f"png-stale-mmd-hash(png {have[:12]} != mmd {want[:12]}; re-render)"
    return True, ""


def main(argv):
    if len(argv) == 3 and argv[1] == "show":
        print(stored_hash(argv[2]) or "")
        return 0
    if len(argv) != 4 or argv[1] not in ("embed", "check"):
        print("usage: png_mmd_hash.py embed|check <png> <mmd> | show <png>", file=sys.stderr)
        return 2
    if argv[1] == "embed":
        embed(argv[2], argv[3])
        return 0
    ok, problem = check(argv[2], argv[3])
    if not ok:
        print(problem)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
