#!/usr/bin/env python3
"""Compare two runtime state traces, cell by cell.

The runtime writes one row per retrace with the header
``retrace,cpu,ram,aram,events`` (``port/runtime/host/host.cpp``). Two builds of the same
sources and patches that agree on guest state must produce identical rows, so this tool
answers the only question Phase 0 asks of them: do they agree, and if not, where do they
stop agreeing. The first differing retrace and column is the useful output; the total count
is context.

Exit status:
  0  identical
  1  a difference (header, row count, or any cell)
  2  an input could not be read or parsed

Deliberately not reusing the two upstream pieces that look similar: ``tools/validate_native.py``
diffs checkpoints across renderer modes of one executable, and ``tools/lockstep_compare.py``
compares per-frame CSVs keyed on a ``frame`` column, a different schema.
"""

from __future__ import annotations

import csv
import sys

EXPECTED_HEADER = ['retrace', 'cpu', 'ram', 'aram', 'events']


class TraceError(Exception):
    """The file is not a state trace."""


def load(path):
    """Read a state trace and return (header, rows). Raises TraceError on anything malformed."""
    try:
        with open(path, newline='') as handle:
            reader = csv.reader(handle)
            try:
                header = next(reader)
            except StopIteration:
                raise TraceError(f'{path}: empty file, expected the header {EXPECTED_HEADER}')
            rows = [row for row in reader if row]
    except OSError as exc:
        raise TraceError(f'{path}: {exc.strerror or exc}')
    if header != EXPECTED_HEADER:
        raise TraceError(f'{path}: header is {header}, expected {EXPECTED_HEADER}')
    for index, row in enumerate(rows, start=2):
        if len(row) != len(EXPECTED_HEADER):
            raise TraceError(f'{path}: line {index} has {len(row)} columns, expected {len(EXPECTED_HEADER)}')
    return header, rows


def compare(left_path, right_path):
    """Compare two traces. Returns a dict; see main() for how it is reported."""
    left_header, left = load(left_path)
    right_header, right = load(right_path)

    result = {
        'left': left_path,
        'right': right_path,
        'left_rows': len(left),
        'right_rows': len(right),
        'first_difference': None,
        'differences': 0,
        'identical': False,
    }

    for index in range(min(len(left), len(right))):
        for column, name in enumerate(EXPECTED_HEADER):
            if left[index][column] != right[index][column]:
                if result['first_difference'] is None:
                    result['first_difference'] = {
                        'retrace': left[index][0],
                        'row': index + 2,  # 1-based, counting the header
                        'column': name,
                        'left': left[index][column],
                        'right': right[index][column],
                    }
                result['differences'] += 1

    if len(left) != len(right):
        # Every extra row is a difference in itself: one build stopped early.
        result['differences'] += abs(len(left) - len(right))

    result['identical'] = result['differences'] == 0
    return result


def main(argv):
    if len(argv) != 3:
        print(f'usage: {argv[0]} <left.csv> <right.csv>', file=sys.stderr)
        return 2
    try:
        result = compare(argv[1], argv[2])
    except TraceError as exc:
        print(f'ERROR: {exc}', file=sys.stderr)
        return 2

    if result['identical']:
        print(f'identical: {result["left_rows"]} retraces, {EXPECTED_HEADER} all equal')
        return 0

    print(f'DIFFERENT: {result["differences"]} differing cell(s)')
    print(f'  rows: {result["left"]}={result["left_rows"]}  {result["right"]}={result["right_rows"]}')
    first = result['first_difference']
    if first is not None:
        print(f'  first: retrace {first["retrace"]} column {first["column"]} '
              f'(line {first["row"]}): {first["left"]} != {first["right"]}')
    else:
        print(f'  first: no cell differs; the row counts do ({result["left_rows"]} vs {result["right_rows"]})')
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
