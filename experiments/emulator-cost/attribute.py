#!/usr/bin/env python3
"""Disjoint stack attribution, with explicit unresolved/inlined work.

Sampling cannot identify the destination of an mmio_write self sample or separate
an inlined FIFO append from gx_write. Such time is deliberately not relabelled GX.
CDP timeDeltas[i] is the elapsed time before samples[i], in microseconds.
"""
import collections
import json
import re
import subprocess
import sys
from pathlib import Path

BOUNDARIES = [
    ('renderer_excluded', r'submit_and_recycle|gxw::|WebGpuBackend|^gxw_|draw_segment|submit_frame'),
    ('gx_vertices', r'decode_vertices'),
    ('gx_texture_snapshot', r'TextureSnapshot|capture_texture|snapshot_texture'),
    ('gx_record_draw', r'record_draw'),
    ('gx_parse_command', r'parse_command'),
    ('gx_fifo_write_unresolved', r'write_fifo|gx_write|drain_fifo'),
    ('mmio_unresolved', r'mmio_write|mmio_read'),
    ('memory_mark_ram_write', r'mark_ram_write'),
    ('memory_helpers', r'ppc::(?:ld|st)(?:8|16|32|64)r?\b|ppc::psq_(?:load|store)|host::(?:ptr|rd\d+|wr\d+)\b'),
    ('entry_trace', r'trace_enter'),
    ('entry_other', r'ppc::enter\b'),
    ('guest_and_inlined_helpers', r'\bf_[0-9A-Fa-f]{8}\b'),
]
RULES = [(name, re.compile(pattern)) for name, pattern in BOUNDARIES]


def analyse(profile):
    samples, deltas = profile.get('samples', []), profile.get('timeDeltas', [])
    if not samples or len(samples) != len(deltas) or sum(deltas) <= 0:
        raise ValueError('profiler measured zero or malformed samples; no attribution available')
    nodes = {n['id']: n for n in profile['nodes']}
    parents = {c: n['id'] for n in nodes.values() for c in n.get('children', [])}
    raw = sorted({n['callFrame']['functionName'] for n in nodes.values()})
    names = dict(zip(raw, subprocess.run(['c++filt'], input='\n'.join(raw) + '\n',
                     text=True, capture_output=True, check=True).stdout.splitlines()))
    totals = collections.Counter()
    leaves = collections.defaultdict(collections.Counter)
    counts = collections.Counter()
    for node, us in zip(samples, deltas):
        stack = []
        while node in nodes:
            stack.append(names[nodes[node]['callFrame']['functionName']])
            node = parents.get(node)
        category = 'unclassified'
        # Resolve the host/guest zone before assigning a helper's self time.
        # E.g. ld32 under decode_vertices belongs to vertex decoding, not guest loads.
        for name in stack:
            if RULES[-1][1].search(name):
                category = next((key for key, rx in RULES[7:-1] if any(rx.search(n) for n in stack)),
                                'guest_and_inlined_helpers')
                break
            match = next((key for key, rx in RULES[:7] if rx.search(name)), None)
            if match:
                category = match
                break
        totals[category] += us
        counts[category] += 1
        leaves[category][stack[0] if stack else '<missing stack>'] += us
    total = sum(deltas)
    return {'total_sampled_ms': total / 1000, 'samples': len(samples),
            'ms_per_frame': total / 1000 / 762,
            'limitations': [
                'Zero samples means below visibility or inlined, never zero cost.',
                'FIFO buffer append is unresolved inside gx_write/write_fifo self time.',
                'mmio self time includes all destinations; it cannot be attributed wholly to GX.',
                'Helper self time does not separate call overhead from instructions.',
                'Console profile boundaries add profiler overhead; compare sampled and core elapsed time.',
                'Real WebGPU API/GPU costs are excluded; this is Chromium, not iPhone JSC.',
            ],
            'zones': {key: {'samples': counts[key], 'percent': totals[key] * 100 / total,
                            'ms_per_frame': totals[key] / 1000 / 762,
                            'visibility': 'sampled' if counts[key] else 'not observed (may be inlined)',
                            'top_self_us': leaves[key].most_common(20)}
                      for key in [k for k, _ in BOUNDARIES] + ['unclassified']}}


if __name__ == '__main__':
    source, target = map(Path, sys.argv[1:])
    target.write_text(json.dumps(analyse(json.loads(source.read_text())), indent=2) + '\n')
