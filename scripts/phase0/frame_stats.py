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
blank lines are skipped.

Output: one JSON object on stdout:
  {"count": N, "mean_ms": …, "p95_ms": …, "p99_ms": …, "max_ms": …, "slowest_index": I,
   "percentile": "nearest-rank", "unit": "ms"}

Exit status: 0 printed, 2 unreadable or not numeric.
"""

from __future__ import annotations

import csv
import json
import math
import sys


def parse_durations(text):
    """Return the list of durations in a per-frame CSV, header or not."""
    lines = [line for line in text.splitlines() if line.strip()]
    if not lines:
        raise ValueError('no rows')
    rows = list(csv.reader(lines))

    first = [cell.strip() for cell in rows[0]]
    start = 0
    column = len(first) - 1
    if not _is_number(first[-1]):
        # A header: prefer the named column, fall back to the last one.
        start = 1
        if 'sim_ms' in first:
            column = first.index('sim_ms')

    durations = []
    for index, row in enumerate(rows[start:], start=start + 1):
        if column >= len(row):
            raise ValueError(f'line {index}: no column {column}')
        cell = row[column].strip()
        if not _is_number(cell):
            raise ValueError(f'line {index}: {cell!r} is not a number')
        durations.append(float(cell))
    if not durations:
        raise ValueError('no durations')
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
    if len(argv) != 2:
        print(f'usage: {argv[0]} <durations.csv>', file=sys.stderr)
        return 2
    try:
        with open(argv[1]) as handle:
            durations = parse_durations(handle.read())
    except (OSError, ValueError) as exc:
        print(f'ERROR: {argv[1]}: {exc}', file=sys.stderr)
        return 2
    print(json.dumps(stats(durations)))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
