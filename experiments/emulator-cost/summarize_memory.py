#!/usr/bin/env python3
"""Report the outlined invalidator, its perturbation, and separately counted paths."""
import json
import statistics
import sys
from pathlib import Path


def summarize(baseline, measured, profiles):
    out = {'interpretation': 'mark_ram_write is forced out of line for attribution. '
        'The call and disabled counter branches perturb timings; these are not production shares. '
        'Counter runs are separate from timing/profiling runs.', 'modes': {}}
    for mode in ('attached', 'headless'):
        base = [r['sim_ms'] for r in baseline['runs'] if r['mode'].startswith(mode + '-control-')]
        control = [r['sim_ms'] for r in measured['runs'] if r['mode'].startswith(mode + '-control-')]
        if len(base) != 3 or len(control) != 3:
            raise ValueError('missing unprofiled controls')
        counters = next(r['memory'] for r in measured['runs'] if r['mode'] == mode + '-count')
        if not counters or not counters['calls'] or not counters['block_checks']:
            raise ValueError('memory path counters measured zero')
        if counters['calls'] != counters['zero_bytes'] + counters['out_of_range'] + counters['single_block'] + counters['multi_block']:
            raise ValueError('memory path counters do not partition calls')
        if counters['block_checks'] < counters['watched_hits']:
            raise ValueError('more watched hits than checks')
        zones = profiles[mode]['zones']
        if not zones['memory_mark_ram_write']['samples']:
            raise ValueError('outlined mark_ram_write has zero samples; attribution failed')
        out['modes'][mode] = {'baseline_ms': statistics.mean(base),
            'outlined_disabled_counters_ms': statistics.mean(control),
            'outlined_over_baseline': statistics.mean(control) / statistics.mean(base),
            'counter_totals': counters,
            'counter_per_frame': {k: v / 762 for k, v in counters.items()},
            'watched_fraction_of_block_checks': counters['watched_hits'] / counters['block_checks'],
            'outlined_sampled_regions': {k: zones[k] for k in ('memory_helpers', 'memory_mark_ram_write')},
            'sampled_ms_per_frame': profiles[mode]['ms_per_frame']}
    return out


if __name__ == '__main__':
    base, measured, target = map(Path, sys.argv[1:])
    load = lambda p: json.loads(p.read_text())
    profiles = {mode: load(measured.parent / f'{mode}.json') for mode in ('attached', 'headless')}
    target.write_text(json.dumps(summarize(load(base), load(measured), profiles), indent=2) + '\n')
