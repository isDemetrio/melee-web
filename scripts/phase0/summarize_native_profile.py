#!/usr/bin/env python3
"""Aggregate perf samples within match simulation intervals; never publish stacks."""
import bisect
import collections
import csv
import json
import re
import statistics
import sys
from pathlib import Path

samples_path, log_path, times_path = map(Path, sys.argv[1:])
intervals = [(int(a), int(b)) for _, a, b in re.findall(
    r'^PROFILE_INTERVAL (\d+) (\d+) (\d+)$', log_path.read_text(), re.M)]
assert len(intervals) == 762, f'Expected 762 match intervals, got {len(intervals)}'
starts = [a for a, _ in intervals]
assert starts == sorted(starts)
leaf = collections.Counter()
inclusive = collections.Counter()
areas = collections.Counter()
count = outside = unknown = 0

def classify(stack):
    # First matching scope owns the sample; disjoint groups, innermost first.
    for name in stack:
        if 'snapshot_textures' in name or 'TextureSnapshot' in name:
            return 'GX texture snapshot'
        if 'observ' in name.lower() or 'authored' in name.lower():
            return 'observer/pose'
        if 'record_draw' in name:
            return 'GX draw recording'
        if 'decode_vertices' in name or 'read_component' in name:
            return 'GX vertex decode'
        # A vector<gx::Vertex> allocator is not a GX scope: keep walking to
        # decode_vertices/record_draw so its allocation gets the right owner.
        if name.startswith('gx::') and 'std::' not in name:
            return 'GX other'
        if name.startswith('hle::') or 'ax::' in name:
            return 'HLE/audio/OS'
        if re.search(r'\bf_[0-9A-Fa-f]{8}\b', name):
            return 'translated guest/PPC helpers'
    return 'other/unknown'

# Perf prints a timestamped header and indented IP/symbol/DSO frames.
with samples_path.open() as stream:
    for block in re.split(r'\n\s*\n', stream.read()):
        match = re.search(r'(\d+)\.(\d+):\s+cpu-clock', block)
        if not match:
            continue
        stamp = int(match[1]) * 10**9 + int(match[2].ljust(9, '0'))
        i = bisect.bisect_right(starts, stamp) - 1
        if i < 0 or stamp > intervals[i][1]:
            outside += 1
            continue
        stack = []
        for line in block.splitlines():
            m = re.search(r'\b[0-9a-f]+\s+(.+?)\s+\([^)]*\)\s*$', line)
            if m:
                stack.append(re.sub(r'\+0x[0-9a-f]+$', '', m[1]))
        count += 1
        if not stack:
            unknown += 1
            stack = ['[unparsed]']
        leaf[stack[0]] += 1
        inclusive.update(set(stack))
        areas[classify(stack)] += 1
assert count > 500, f'Insufficient samples: {count}'
assert unknown == 0, f'Unparsed samples: {unknown}'
rows = [float(r['sim_ms']) for r in csv.DictReader(times_path.open()) if int(r['match_frame']) > 0]
assert len(rows) == 762

def table(counter, limit=1000):
    return [{'symbol': k, 'samples': n, 'percent': round(100*n/count, 3)}
            for k, n in counter.most_common(limit)]
print(json.dumps({'match_frames': len(rows), 'match_mean_ms': statistics.mean(rows),
                  'match_p99_ms': sorted(rows)[int(.99*len(rows))],
                  'samples': count, 'excluded_samples': outside,
                  'areas_exclusive': table(areas), 'leaf': table(leaf),
                  'inclusive_do_not_sum': table(inclusive)}, indent=2))
