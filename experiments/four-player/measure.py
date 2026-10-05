#!/usr/bin/env python3
"""Four-player load test: the same match with two and with four human controllers, in CI.

The module is already built (the workflow builds it with experiments/four-player/oracle.h spliced
into the runner's native/real_fifo.cpp). This script runs three workloads against the private disc
and writes counts and timings only -- never guest data:

  reference   upstream/melee-unlocked/port/scripts/parity_vs_onett.txt, the project's reference
              match and the one the iPhone number came from. Its 2400-retrace trace is gated
              against c79c53b9cdf81426fa0277e7497a69e55bc5f571, so a core change would fail here.
  two-player  experiments/four-player/two-player.txt, two human ports.
  four-player experiments/four-player/four-player.txt, four human ports.

Per-frame columns come from the two instruments the project already has: --sim-times (the core's
own sim_ms, the same timer the phone reports as core_ms) and the graphics oracle's per-frame row
(draws, vertices, segments and how many HUD slots are present, i.e. how many characters are on
screen). The browser-only parts of the phone's play report -- cycle_ms, webgpu_ms, bitmap_ms,
ack_ms -- do not exist in the headless host and are not invented here; docs/FOUR_PLAYER_LOAD.md
says so.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import statistics
import subprocess
from pathlib import Path

ROOT = Path(os.environ['GITHUB_WORKSPACE'])
TMP = Path(os.environ['RUNNER_TEMP'])
RES = TMP / 'results'
TRACE = 'c79c53b9cdf81426fa0277e7497a69e55bc5f571'
WORKLOADS = {
    'reference': ROOT / 'upstream/melee-unlocked/port/scripts/parity_vs_onett.txt',
    'two-player': ROOT / 'experiments/four-player/two-player.txt',
    'four-player': ROOT / 'experiments/four-player/four-player.txt',
}


def pct(values, fraction):
    ordered = sorted(values)
    if not ordered:
        return 0.0
    return ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]


def run(name, script, frames=2400):
    out = TMP / f'run-{name}'
    gfx = TMP / f'{name}-graphics.csv'
    frame_times = TMP / f'{name}-frames.csv'
    env = dict(os.environ, MELEE_GFX_ORACLE=str(gfx), MELEE_FRAME_TIMES=str(frame_times))
    subprocess.run(['bash', str(ROOT / 'scripts/phase0/run_checkpoints.sh'),
                    str(TMP / 'module' / 'melee_core_node.js'), str(TMP / 'disc.iso'),
                    str(out), str(frames), str(script)], env=env, check=True)
    log = (out / 'stdout.log').read_text()
    line = next(s for s in log.splitlines() if s.startswith('four-player oracle: '))
    oracle = json.loads(line.removeprefix('four-player oracle: '))
    trace = hashlib.sha1((out / 'trace.csv').read_bytes()).hexdigest()
    sim = [{'retrace': int(r['retrace']), 'sim_ms': float(r['sim_ms']), 'match_frame': int(r['match_frame'])}
           for r in csv.DictReader((out / 'sim_times.csv').open())]
    frames_rows = {}
    with frame_times.open() as handle:
        for r in csv.DictReader(handle):
            frames_rows[int(r['sequence'])] = {k: int(v) for k, v in r.items()}
    return {'name': name, 'trace_sha1': trace, 'oracle': oracle, 'sim': sim, 'frames': frames_rows}


def summarize(run_result):
    """Join the core timer with the oracle's per-frame row, retrace by retrace."""
    sim, frames = run_result['sim'], run_result['frames']
    joined = []
    for row in sim:
        frame = frames.get(row['retrace'])
        joined.append({'sim_ms': row['sim_ms'], 'match_frame': row['match_frame'],
                       'in_match': bool(frame) and frame['scene_major'] == 2 and frame['scene_minor'] == 2,
                       'hud_present': frame['hud_present'] if frame else None,
                       'draws': frame['draws'] if frame else None,
                       'vertices': frame['vertices'] if frame else None})
    out = {}
    for label, keep in (('match', lambda r: r['in_match']), ('menus', lambda r: not r['in_match']), ('all', lambda r: True)):
        sel = [r for r in joined if keep(r)]
        sim_ms = [r['sim_ms'] for r in sel]
        draws = [r['draws'] for r in sel if r['draws'] is not None]
        vertices = [r['vertices'] for r in sel if r['vertices'] is not None]
        hud = [r['hud_present'] for r in sel if r['hud_present'] is not None]
        out[label] = {
            'frames': len(sel),
            'sim_mean_ms': statistics.mean(sim_ms) if sim_ms else 0.0,
            'sim_p95_ms': pct(sim_ms, .95),
            'sim_p99_ms': pct(sim_ms, .99),
            'sim_max_ms': max(sim_ms, default=0.0),
            'draws_mean': statistics.mean(draws) if draws else 0.0,
            'draws_p95': pct(draws, .95),
            'vertices_mean': statistics.mean(vertices) if vertices else 0.0,
            'hud_present_max': max(hud, default=0),
            'hud_present_mean': statistics.mean(hud) if hud else 0.0,
        }
    return out


def main():
    RES.mkdir(parents=True, exist_ok=True)
    results = {'trace_reference_sha1': TRACE, 'node': subprocess.check_output(['node', '--version'], text=True).strip(),
               'workloads': {}}
    for name, script in WORKLOADS.items():
        got = run(name, script)
        assert got['trace_sha1'] == TRACE, f'{name}: trace {got["trace_sha1"]} != reference'
        entry = results['workloads'][name] = {'script': str(script.relative_to(ROOT)),
                                              'trace_sha1': got['trace_sha1'], 'oracle': got['oracle'],
                                              'per_frame': summarize(got)}
        print(f"{name}: trace {got['trace_sha1']} ok; oracle {json.dumps(got['oracle'])}")
        (RES / 'four-player.json').write_text(json.dumps(results, indent=2) + '\n')

    ref = results['workloads']['reference']['per_frame']['match']
    four = results['workloads']['four-player']['per_frame']['match']
    two = results['workloads']['two-player']['per_frame']['match']
    results['ratios'] = {
        'four_over_two_sim_mean': four['sim_mean_ms'] / two['sim_mean_ms'] if two['sim_mean_ms'] else None,
        'four_over_reference_sim_mean': four['sim_mean_ms'] / ref['sim_mean_ms'] if ref['sim_mean_ms'] else None,
        'four_over_two_draws_mean': four['draws_mean'] / two['draws_mean'] if two['draws_mean'] else None,
        'four_over_reference_draws_mean': four['draws_mean'] / ref['draws_mean'] if ref['draws_mean'] else None,
    }
    (RES / 'four-player.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
