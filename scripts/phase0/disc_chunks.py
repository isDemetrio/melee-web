#!/usr/bin/env python3
"""Hash a disc in 16 MiB chunks without copying game data.

Usage: disc_chunks.py ISO --out /path/outside/repo/disc-chunks.json
The ordered chunks array contains SHA-256 hex digests, indexed from zero.
--verify-disc additionally requires the known Melee NTSC 1.02 size and SHA-1.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

CHUNK_SIZE = 16 * 1024 * 1024
EXPECTED_SIZE = 1_459_978_240
EXPECTED_SHA1 = "d4e70c064cc714ba8400a849cf299dbd1aa326fc"


def disc_chunks(path, verify=False):
    total = 0
    chunks = []
    sha1 = hashlib.sha1()
    with path.open("rb") as disc:
        if verify and path.stat().st_size != EXPECTED_SIZE:
            raise ValueError(f"ISO size must be {EXPECTED_SIZE} bytes")
        while block := disc.read(CHUNK_SIZE):
            total += len(block)
            sha1.update(block)
            chunks.append(hashlib.sha256(block).hexdigest())
    digest = sha1.hexdigest()
    if verify and total != EXPECTED_SIZE:
        raise ValueError(f"ISO size must be {EXPECTED_SIZE} bytes")
    if verify and digest != EXPECTED_SHA1:
        raise ValueError(f"ISO SHA-1 mismatch: {digest}; expected {EXPECTED_SHA1}")
    return {"size_bytes": total, "chunk_size_bytes": CHUNK_SIZE,
            "sha1": digest, "chunks": chunks}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("iso", type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--verify-disc", action="store_true")
    args = parser.parse_args()
    try:
        output = args.out.resolve()
        repo = Path(__file__).resolve().parents[2]
        if output == repo or repo in output.parents:
            raise ValueError("JSON output must be outside the repository")
        if output == args.iso.resolve() or (
            output.exists() and output.samefile(args.iso)
        ):
            raise ValueError("JSON output must not overwrite the ISO")
        result = disc_chunks(args.iso, args.verify_disc)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(f"{result['size_bytes']} bytes; {len(result['chunks'])} chunks; "
              f"SHA-1 {result['sha1']}; JSON: {output}")
    except (OSError, ValueError) as error:
        print(f"disc refused: {error}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main())
