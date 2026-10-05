#!/usr/bin/env python3
"""gxw_draw's own JavaScript, split by statement, from a V8 sampling profile of the web core.

The bench that writes the input is not in the repository (it runs the private core): it is
~/incoming/phase0/renderjs/lines.mjs, the corecost profiler (PR #119) plus one patch that puts
gxw_draw__inner's body one statement per line (a newline after each ';' and '{', whitespace only)
and writes those lines to gxw_draw.lines.json. V8's positionTicks then give self samples per line.

usage: cpuprofile_draw_lines.py <run dir>
  reads <run dir>/inmatch.cpuprofile, gxw_draw.lines.json, frames.csv (draws per retrace),
  summary.json (profile window); prints each group's share of all samples, of gxw_draw's self
  time, and microseconds per draw on the profiled clock (the profiler adds ~15-20%).
"""
import collections
import csv
import json
import re
import sys

# First match wins, in this order. The patterns read the minified statement text of the core.
GROUPS = [
    ('uniform dedup compare', r'same=|same&&i<n|let offset=batch.lastUniform|for\(let i=0,at=offset|const words=|if\(!same\)'),
    ('uniform copy to staging', r'uniformStaging.set|offset=batch.uniformBytes|batch.uniformBytes\+=|lastUniform=offset|lastRows=rows'),
    ('bind group key string + LRU Map', r'groupKey|bindGroups'),
    ('pipeline key string + Map', r'const key=\[|pipelines.get|if\(!pipeline\)'),
    ('vertex/index copy to staging', r'vertexStaging.set|indexStaging.set|vertexBytes\+=|indexBytes\+=|baseVertex='),
    ('raster read + scissor string', r'HEAPF32.slice|const scissor|state.scissor!=='),
    ('pass state checks + WebGPU calls', r'pass\.|state\.|drawIndexed|openBatch|if\(!batch.pass'),
    ('BP reads, arena checks, rest', r'.*'),
]
FIRST, LAST = 1639, 2400  # in-match retraces


def split(run):
    profile = json.load(open(f'{run}/inmatch.cpuprofile'))
    lines = json.load(open(f'{run}/gxw_draw.lines.json'))
    total = sum(n.get('hitCount', 0) for n in profile['nodes'])
    rows = [r for r in csv.DictReader(open(f'{run}/frames.csv')) if FIRST <= int(r['retrace']) <= LAST]
    frames = len(rows)
    draws = sum(int(r['draws']) for r in rows) / frames
    window = json.load(open(f'{run}/summary.json'))['profWindow']
    ms = (window['stop_us'] - window['start_us']) / 1000 / frames
    ticks, self_ticks, unmapped = collections.Counter(), 0, 0
    for node in profile['nodes']:
        if node['callFrame']['functionName'] != 'gxw_draw__inner':
            continue
        self_ticks += node.get('hitCount', 0)
        for t in node.get('positionTicks', []):
            k = t['line'] - 1 - lines['firstLine']
            if not 0 <= k < len(lines['lines']):
                unmapped += t['ticks']  # inlined code from another file (the bench's mocks)
                continue
            text = lines['lines'][k]
            ticks[next(name for name, rx in GROUPS if re.search(rx, text))] += t['ticks']
    return {'frames': frames, 'draws_per_frame': draws, 'profiled_ms_per_frame': ms, 'samples': total,
            'self_samples': self_ticks, 'unmapped_samples': unmapped,
            'groups': {name: {'percent_frame': 100 * ticks[name] / total,
                              'percent_draw_js': 100 * ticks[name] / self_ticks if self_ticks else 0.0,
                              'us_per_draw': ticks[name] / total * ms * 1000 / draws}
                       for name, _ in GROUPS}}


def main():
    s = split(sys.argv[1])
    if not s['self_samples']:
        print('no gxw_draw__inner samples: this profile has no attached renderer, or a core without the patch')
        sys.exit(1)
    print(f"in-match frames {s['frames']}, draws/frame {s['draws_per_frame']:.0f}, profiled ms/frame "
          f"{s['profiled_ms_per_frame']:.2f}; gxw_draw__inner self {100 * s['self_samples'] / s['samples']:.2f}% "
          f"({s['unmapped_samples']} samples on lines outside it)")
    print(f"{'part':36s} {'%frame':>7s} {'%drawJS':>8s} {'us/draw':>8s}")
    for name, g in s['groups'].items():
        print(f"{name:36s} {g['percent_frame']:7.2f} {g['percent_draw_js']:8.1f} {g['us_per_draw']:8.2f}")


if __name__ == '__main__':
    main()
