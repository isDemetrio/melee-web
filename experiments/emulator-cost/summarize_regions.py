#!/usr/bin/env python3
"""Report instrumented region costs and the perturbation, never a speedup claim."""
import json
import statistics
import sys
from pathlib import Path


def summarize(baseline, measured):
    out = {'interpretation': 'Timers perturb code and add clock/call overhead. Region shares belong '
           'to the instrumented run, not production; inclusive regions overlap.', 'modes': {}}
    for mode in ('attached', 'headless'):
        def select(data, kind):
            return [r for r in data['runs'] if r['mode'].startswith(f'{mode}-{kind}-')]
        base = select(baseline, 'control')
        control = select(measured, 'control')
        timed = select(measured, 'regions')
        if not base or len(control) != 3 or len(timed) != 3:
            raise ValueError('missing unprofiled control/region runs')
        mean = lambda rows: statistics.mean(r['sim_ms'] for r in rows)
        regions = {}
        for r in timed:
            if r['frames'] != 762 or not r['regions']:
                raise ValueError('missing 762-frame region report')
            for v in r['regions']['regions']:
                if v['exclusive_ms'] < -0.001 or v['inclusive_ms'] < v['exclusive_ms']:
                    raise ValueError('invalid region accounting')
                regions.setdefault(v['name'], []).append(v)
        required = ('mmio_gx', 'fifo', 'fifo_append', 'parse', 'vertex_descriptor',
                    'vertices', 'record', 'texture_snapshot', 'command_append')
        if any(not all(r['calls'] for r in regions.get(name, [])) or name not in regions for name in required):
            raise ValueError('a required region measured zero calls; no attribution available')
        values = {}
        for name, rows in regions.items():
            calls = [r['calls'] for r in rows]
            if len(set(calls)) != 1:
                raise ValueError(f'nondeterministic region invocation count: {name}: {calls}')
            exclusive = statistics.mean(r['exclusive_ms'] for r in rows) / 762
            values[name] = {'calls_per_frame': calls[0] / 762,
                'exclusive_ms_per_frame': exclusive,
                'inclusive_ms_per_frame': statistics.mean(r['inclusive_ms'] for r in rows) / 762,
                'percent_instrumented_frame': 100 * exclusive / mean(timed),
                'visibility': 'not invoked' if not calls[0] else
                    ('below timer resolution' if exclusive == 0 else 'timed; includes probe overhead')}
        out['modes'][mode] = {'baseline_ms': mean(base), 'instrumented_disabled_ms': mean(control),
            'instrumented_enabled_ms': mean(timed),
            'disabled_over_baseline': mean(control) / mean(base),
            'enabled_over_disabled': mean(timed) / mean(control),
            'paired_enabled_over_disabled': [b['sim_ms'] / a['sim_ms'] for a, b in zip(control, timed)],
            'regions': values}
    return out


if __name__ == '__main__':
    baseline, measured, target = map(Path, sys.argv[1:])
    target.write_text(json.dumps(summarize(json.loads(baseline.read_text()),
        json.loads(measured.read_text())), indent=2) + '\n')
