#!/usr/bin/env python3
"""Verify the exact NTSC 1.02 disc; never load the full ISO into memory."""
import argparse
import hashlib
from pathlib import Path
import sys
from disc.gcdisc import DiscError, read_header

EXPECTED_SIZE = 1_459_978_240
EXPECTED_SHA1 = 'd4e70c064cc714ba8400a849cf299dbd1aa326fc'


def verify_iso(path):
    with Path(path).open('rb') as stream:
        stream.seek(0, 2)
        size = stream.tell()
        if size != EXPECTED_SIZE:
            raise DiscError(f'wrong size: {size} bytes; expected {EXPECTED_SIZE}')
        header = read_header(stream)
        if header.game_id != 'GALE01':
            raise DiscError(f'wrong game id: {header.game_id!r}; expected GALE01')
        if header.revision != 2:
            raise DiscError(f'wrong revision: {header.revision}; expected 2')
        stream.seek(0)
        digest = hashlib.sha1()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
        if digest.hexdigest() != EXPECTED_SHA1:
            raise DiscError(f'wrong SHA-1: {digest.hexdigest()}; expected {EXPECTED_SHA1}')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso', type=Path)
    args = parser.parse_args(argv)
    try:
        verify_iso(args.iso)
    except (OSError, DiscError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        return 1
    print('OK: NTSC 1.02, GALE01 revision 2, size and SHA-1 verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
