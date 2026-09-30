#!/usr/bin/env python3
"""Per-frame duration statistics, as JSON.

Phase 0 needs one number to decide whether a phone can hold 60 Hz: the slow frame, not the
average one. The runtime's ``--fast`` mode simulates as quickly as the host allows, so its
durations are a lower bound on cost, not a frame budget.

**Percentiles are nearest-rank**, so the value printed is always a duration that actually
occurred and never an interpolation: ``p95`` is the element at index ``ceil(0.95 * n) - 1``
of the ascending list. That definition is written down here because a device number is only
comparable if both sides mean the same thing by "p95".

Input: a per-frame duration CSV. Either with a header — the column named ``sim_ms`` is used,
or else the last column — or with no header, one duration per line. Whitespace is stripped;
blank lines are skipped. With ``--in-match`` the CSV must be the runtime's ``--sim-times``
output (``retrace,sim_ms,match_frame``) and only the rows whose ``match_frame`` is positive are
measured, because the frames of a menu are not frames of the game.

Output: one JSON object on stdout:
  {"count": N, "mean_ms": …, "p95_ms": …, "p99_ms": …, "max_ms": …, "slowest_index": I,
   "percentile": "nearest-rank", "unit": "ms", "rows": "all" | "in-match"}

Exit status: 0 printed, 2 unreadable or not numeric.
"""

from __future__ import annotations

import csv
import json
import math
import sys


def parse_durations(text, in_match=False):
    """Return the list of durations in a per-frame CSV, header or not.

    With ``in_match`` the CSV is the ``--sim-times`` one (``retrace,sim_ms,match_frame``) and
    only rows whose ``match_frame`` is a positive integer are kept: the frames of a menu are
    not frames of the game anyone is trying to measure.
    """
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ValueError('no rows')
    rows = list(csv.reader(lines))

    first = [cell.strip() for cell in rows[0]]
    start = 0
    column = len(first) - 1
    match_column = -1
    if not _is_number(first[-1]):
        # A header: prefer the named column, fall back to the last one.
        start = 1
        if 'sim_ms' in first:
            column = first.index('sim_ms')
        if in_match:
            if 'match_frame' not in first:
                raise ValueError('no match_frame column: --in-match needs a --sim-times CSV')
            match_column = first.index('match_frame')
    elif in_match:
        raise ValueError('no match_frame column: --in-match needs a --sim-times CSV')

    durations = []
    for index, row in enumerate(rows[start:], start=start + 1):
        if in_match:
            if match_column < 0 or match_column >= len(row):
                raise ValueError(f'line {index}: no match_frame column')
            frame = row[match_column].strip()
            try:
                in_a_match = int(frame) > 0
            except ValueError:
                raise ValueError(f'line {index}: {frame!r} is not a match frame')
            if not in_a_match:
                continue
        if column >= len(row):
            raise ValueError(f'line {index}: no column {column}')
        cell = row[column].strip()
        if not _is_number(cell):
            raise ValueError(f'line {index}: {cell!r} is not a number')
        durations.append(float(cell))
    if not durations:
        raise ValueError('no in-match rows' if in_match else 'no durations')
    return durations


def _is_number(text):
    try:
        float(text)
    except ValueError:
        return False
    return True


def nearest_rank(values, fraction):
    """The nearest-rank percentile: a value that actually occurred, never an interpolation."""
    ordered = sorted(values)
    index = max(0, math.ceil(fraction * len(ordered)) - 1)
    return ordered[index]


def stats(durations):
    slowest = max(range(len(durations)), key=lambda index: durations[index])
    return {
        'count': len(durations),
        'mean_ms': sum(durations) / len(durations),
        'p95_ms': nearest_rank(durations, 0.95),
        'p99_ms': nearest_rank(durations, 0.99),
        'max_ms': durations[slowest],
        'slowest_index': slowest,
        'percentile': 'nearest-rank',
        'unit': 'ms',
    }


def main(argv):
    arguments = list(argv[1:])
    in_match = '--in-match' in arguments
    if in_match:
        arguments = [argument for argument in arguments if argument != '--in-match']
    if len(arguments) != 1:
        print(f'usage: {argv[0]} [--in-match] <durations.csv>', file=sys.stderr)
        return 2
    try:
        with open(arguments[0]) as handle:
            durations = parse_durations(handle.read(), in_match=in_match)
    except (OSError, ValueError) as exc:
        print(f'ERROR: {arguments[0]}: {exc}', file=sys.stderr)
        return 2
    result = stats(durations)
    result['rows'] = 'in-match' if in_match else 'all'
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
