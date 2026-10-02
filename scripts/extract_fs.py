#!/usr/bin/env python3
"""Extract GameCube FST files into <out>/files/, without system/DOL data.

The output must not already exist, preventing stale files or symlink traversal.
"""
import argparse
from pathlib import Path
import sys
from disc.gcdisc import DiscError, read_disc


def extract_fs(iso, out):
    header, entries = read_disc(iso)
    out = Path(out)
    out.mkdir(parents=True, exist_ok=False)
    with Path(iso).open('rb') as stream:
        for entry in entries:
            target = out / 'files' / entry.path
            target.parent.mkdir(parents=True, exist_ok=True)
            stream.seek(entry.offset)
            with target.open('xb') as dest:
                remaining = entry.size
                while remaining:
                    chunk = stream.read(min(remaining, 1024 * 1024))
                    if not chunk:
                        raise DiscError(f'truncated file: {entry.path}')
                    dest.write(chunk)
                    remaining -= len(chunk)
    return entries


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('iso', type=Path)
    parser.add_argument('--out', type=Path, default=Path('assets-extracted'))
    args = parser.parse_args(argv)
    try:
        entries = extract_fs(args.iso, args.out)
    except (OSError, DiscError) as error:
        print(f'FAIL: {error}', file=sys.stderr)
        return 1
    print(f'extracted {len(entries)} files, {sum(e.size for e in entries)} bytes to {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
