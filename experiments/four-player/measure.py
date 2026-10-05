#!/usr/bin/env python3
"""Four-player load test: the same match with two and with four human controllers, in CI.

The module is already built (the workflow builds it with experiments/four-player/oracle.h spliced
into the runner's native/real_fifo.cpp). This script runs three workloads against the private disc
and writes counts and timings only -- never guest data:

  reference   upstream/melee-unlocked/port/scripts/parity_vs_onett.txt, the project's reference
              match and the one the iPhone number came from. Its 2400-retrace trace is gated
              against c79c53b9cdf81426fa0277e7497a69e55bc5f571, so a core change -- or an oracle
              that perturbed the guest -- fails here. The two new workloads have their own traces
              and are not gated against the reference: they are different inputs, so a different
              trace is the expected result, not a failure.
  two-player  experiments/four-player/two-player.txt, two human ports.
  four-player experiments/four-player/four-player.txt, four human ports.

Two instruments, two clocks, reported separately rather than joined frame by frame:

  --sim-times        one row per retrace: the core's own sim_ms, the same timer the phone reports
                     as core_ms. In-match rows are the ones with match_frame > 0, exactly as
                     scripts/phase0/frame_stats.py --in-match defines them.
  the oracle         one row per *submitted* frame, which is not the same clock: the headless host
                     only finishes a frame when the guest copies EFB to XFB, so 2400 retraces
                     produce fewer frames. It carries draws, vertices, segments and how many HUD
                     slots are present -- hud_players[].present is the number of characters on
                     screen, which is what certifies the four-player workload really put four
                     characters in the match.

The browser-only parts of the phone's play report -- cycle_ms, webgpu_ms, bitmap_ms, ack_ms -- do
not exist in the headless host and are not invented here; docs/FOUR_PLAYER_LOAD.md says so.
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
# Only the reference script is the project's gate; the two new workloads are new inputs.
GATED = {'reference'}


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
    frames_rows = [{'sequence': int(r['sequence']), 'scene_major': int(r['scene_major']),
                    'scene_minor': int(r['scene_minor']), 'hud_present': int(r['hud_present']),
                    'draws': int(r['draws']), 'vertices': int(r['vertices'])}
                   for r in csv.DictReader(frame_times.open())]
    final = next((s for s in log.splitlines() if s.startswith('final scene:')), 'MISSING')
    return {'name': name, 'trace_sha1': trace, 'oracle': oracle, 'sim': sim, 'frames': frames_rows, 'final_scene': final}


def core_stats(run_result):
    """The core's own timer, one row per retrace, in-match by match_frame > 0."""
    sim = run_result['sim']
    out = {}
    for label, keep in (('match', lambda r: r['match_frame'] > 0), ('menus', lambda r: r['match_frame'] == 0), ('all', lambda r: True)):
        sel = [r['sim_ms'] for r in sim if keep(r)]
        out[label] = {'retraces': len(sel), 'sim_mean_ms': statistics.mean(sel) if sel else 0.0,
                      'sim_p95_ms': pct(sel, .95), 'sim_p99_ms': pct(sel, .99), 'sim_max_ms': max(sel, default=0.0)}
    return out


def render_stats(run_result):
    """The oracle's per-frame row, in-match by the scene words."""
    rows = run_result['frames']
    out = {}
    for label, keep in (('match', lambda r: r['scene_major'] == 2 and r['scene_minor'] == 2),
                        ('menus', lambda r: not (r['scene_major'] == 2 and r['scene_minor'] == 2)), ('all', lambda r: True)):
        sel = [r for r in rows if keep(r)]
        draws = [r['draws'] for r in sel]
        vertices = [r['vertices'] for r in sel]
        hud = [r['hud_present'] for r in sel]
        out[label] = {'frames': len(sel), 'draws_mean': statistics.mean(draws) if draws else 0.0,
                      'draws_p95': pct(draws, .95), 'draws_max': max(draws, default=0),
                      'vertices_mean': statistics.mean(vertices) if vertices else 0.0,
                      'hud_present_max': max(hud, default=0), 'hud_present_mean': statistics.mean(hud) if hud else 0.0}
    return out


def main():
    RES.mkdir(parents=True, exist_ok=True)
    results = {'trace_reference_sha1': TRACE, 'node': subprocess.check_output(['node', '--version'], text=True).strip(),
               'workloads': {}}
    for name, script in WORKLOADS.items():
        got = run(name, script)
        if name in GATED:
            assert got['trace_sha1'] == TRACE, f'{name}: trace {got["trace_sha1"]} != reference'
        results['workloads'][name] = {'script': str(script.relative_to(ROOT)), 'gated': name in GATED,
                                      'trace_sha1': got['trace_sha1'], 'final_scene': got['final_scene'],
                                      'oracle': got['oracle'], 'core': core_stats(got), 'render': render_stats(got)}
        print(f"{name}: trace {got['trace_sha1']} {'(gate ok)' if name in GATED else ''}; {got['final_scene']}; "
              f"oracle {json.dumps(got['oracle'])}")
        (RES / 'four-player.json').write_text(json.dumps(results, indent=2) + '\n')

    ref = results['workloads']['reference']
    two = results['workloads']['two-player']
    four = results['workloads']['four-player']
    ratios = {}
    for label in ('match', 'all'):
        for key, base, top in (('sim_mean_ms', two, four), ('draws_mean', two, four), ('sim_mean_ms', ref, four), ('draws_mean', ref, four)):
            b = base['core'][label][key] if key.startswith('sim') else base['render'][label][key]
            t = top['core'][label][key] if key.startswith('sim') else top['render'][label][key]
            ratios[f'four_over_{"two" if base is two else "reference"}_{key}_{label}'] = (t / b) if b else None
    results['ratios'] = ratios
    (RES / 'four-player.json').write_text(json.dumps(results, indent=2) + '\n')
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
