#!/usr/bin/env python3
"""Replays both builds over the 2400 checkpoints; writes digests and timings only, never guest data.

baseline  = renderer decoder forced to the reference (GXW_TEXTURE_DECODE_REFERENCE)
candidate = renderer decoder as shipped (SIMD kernels, C4/C8 palette table)
Each build: one plain replay (trace gate, sim_ms), then oracle replays. The oracle times the
reference and the renderer's decoder on every simulated pool miss, alternating order, so one
candidate run is a paired before/after; the baseline run is the control (both sides reference).
"""
import csv, hashlib, json, os, statistics, subprocess
from pathlib import Path
root = Path(os.environ['GITHUB_WORKSPACE'])
tmp = Path(os.environ['RUNNER_TEMP'])
res = tmp / 'results'
TRACE = 'c79c53b9cdf81426fa0277e7497a69e55bc5f571'
ORACLE_RUNS = {'baseline': 1, 'candidate': 3}

def replay(variant, env=None):
    out = tmp / 'replay'
    subprocess.run(['bash', str(root/'scripts/phase0/run_checkpoints.sh'), str(tmp/variant/'melee_core_node.js'),
                    str(tmp/'disc.iso'), str(out), '2400'], env=env, check=True)
    digest = hashlib.sha1((out/'trace.csv').read_bytes()).hexdigest()
    assert digest == TRACE, (variant, digest)
    return out

def pct(v, q):
    v = sorted(v); return v[min(len(v)-1, int(q*len(v)))] if v else 0.0

def summarize(rows):
    out = {}
    for name, keep in (('match', lambda r: r['in_match']), ('menus', lambda r: not r['in_match']), ('all', lambda r: True)):
        sel = [r for r in rows if keep(r)]
        ref = [r['ref_ms'] for r in sel]; cand = [r['cand_ms'] for r in sel]
        saved = [a-b for a, b in zip(ref, cand)]
        out[name] = {
            'frames': len(sel), 'frames_with_decode': sum(1 for r in sel if r['misses']),
            'frames_with_simd': sum(1 for r in sel if r['simd_levels']),
            'frames_with_table': sum(1 for r in sel if r['table_levels']),
            'frames_with_fast': sum(1 for r in sel if r['simd_levels'] or r['table_levels']), 'misses': sum(r['misses'] for r in sel),
            'ref_total_ms': sum(ref), 'cand_total_ms': sum(cand),
            'ref_mean_ms': statistics.mean(ref) if ref else 0, 'cand_mean_ms': statistics.mean(cand) if cand else 0,
            'ref_p95_ms': pct(ref, .95), 'cand_p95_ms': pct(cand, .95),
            'ref_p99_ms': pct(ref, .99), 'cand_p99_ms': pct(cand, .99),
            'ref_max_ms': max(ref, default=0), 'cand_max_ms': max(cand, default=0),
            'saved_mean_ms': statistics.mean(saved) if saved else 0, 'saved_max_ms': max(saved, default=0),
            # Frames that decode at all, and the frame the reference spends most on (the load hitch).
            'saved_mean_decode_frames_ms': statistics.mean([s for s, r in zip(saved, sel) if r['misses']] or [0]),
            'worst_ref_frame': max(({'ref_ms': x, 'cand_ms': y} for x, y in zip(ref, cand)), key=lambda d: d['ref_ms'], default=None),
        }
    return out

results = {'engine': subprocess.check_output(['node', '--version'], text=True).strip(), 'trace_sha1': TRACE, 'builds': {}}
res.mkdir(parents=True, exist_ok=True)
oracle = {}
for variant in ('baseline', 'candidate'):
    b = results['builds'][variant] = {'wasm_bytes': (tmp/variant/'melee_core_node.wasm').stat().st_size}
    out = replay(variant)
    with (out/'sim_times.csv').open() as f:
        sim = [float(r['sim_ms']) for r in csv.DictReader(f) if int(r['match_frame']) > 0]
    b['plain'] = {'match_frames': len(sim), 'sim_mean_ms': statistics.mean(sim), 'sim_p95_ms': pct(sim, .95)}
    b['oracle_runs'] = []
    for run in range(ORACLE_RUNS[variant]):
        g, t = tmp/f'{variant}-{run}-graphics.csv', tmp/f'{variant}-{run}-times.csv'
        out = replay(variant, dict(os.environ, MELEE_GFX_ORACLE=str(g), MELEE_TEX_TIMES=str(t)))
        line = next(s for s in (out/'stdout.log').read_text().splitlines() if s.startswith('texsimd summary: '))
        with t.open() as f:
            rows = [{'in_match': int(r['scene_major']) == 2 and int(r['scene_minor']) == 2, 'misses': int(r['misses']),
                     'simd_levels': int(r['simd_levels']), 'table_levels': int(r['table_levels']), 'ref_ms': float(r['ref_ms']), 'cand_ms': float(r['cand_ms'])}
                    for r in csv.DictReader(f)]
        b['oracle_runs'].append({'oracle': json.loads(line.removeprefix('texsimd summary: ')), 'per_frame': summarize(rows)})
        oracle.setdefault(variant, g.read_bytes())
        assert g.read_bytes() == oracle[variant], f'{variant}: oracle differs between runs'
        (res/'texture-simd.json').write_text(json.dumps(results, indent=2)+'\n')
a, b = oracle['baseline'], oracle['candidate']
assert a and a == b, 'ordered graphics output differs between baseline and candidate'
results['graphics'] = {'equal': True, 'frames': len(a.splitlines()), 'sha256': hashlib.sha256(a).hexdigest()}
(res/'texture-simd.json').write_text(json.dumps(results, indent=2)+'\n')
print(json.dumps(results, indent=2))
