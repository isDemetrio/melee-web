#!/usr/bin/env python3
"""Paired replay; output contains timings and digests only, never guest state."""
import csv, hashlib, json, os, platform, statistics, subprocess
from pathlib import Path
root = Path(os.environ['GITHUB_WORKSPACE'])
tmp = Path(os.environ['RUNNER_TEMP'])
results = {'engine': subprocess.check_output(['node', '--version'], text=True).strip(),
           'platform': platform.platform(), 'pairs': []}
for trial in range(0 if os.environ.get('ORACLE_ONLY') == '1' else 3):
    pair = {}
    for variant in (('baseline', 'candidate') if trial % 2 == 0 else ('candidate', 'baseline')):
        out = tmp / 'replay'
        subprocess.run(['bash', str(root/'scripts/phase0/run_checkpoints.sh'), str(tmp/variant/'melee_core_node.js'), str(tmp/'disc.iso'), str(out), '2400'], check=True)
        digest = hashlib.sha1((out/'trace.csv').read_bytes()).hexdigest()
        assert digest == 'c79c53b9cdf81426fa0277e7497a69e55bc5f571', digest
        with (out/'sim_times.csv').open() as f:
            values = [float(r['sim_ms']) for r in csv.DictReader(f) if int(r['match_frame']) > 0]
        assert len(values) == 762
        pair[variant] = {'mean_ms': statistics.mean(values), 'p95_ms': sorted(values)[int(.95*len(values))], 'frames': len(values), 'trace_sha1': digest,
                         'wasm_bytes': (tmp/variant/'melee_core_node.wasm').stat().st_size}
    pair['speedup'] = pair['baseline']['mean_ms']/pair['candidate']['mean_ms']
    results['pairs'].append(pair)
    (tmp/'results/replay.json').write_text(json.dumps(results, indent=2)+'\n')
print(json.dumps(results, indent=2))

# Separate instrumented runs: hashing/decoding is deliberately outside performance trials.
results['texture_decode']={}
for variant in ('baseline', 'candidate'):
    out=tmp/'replay'
    env=dict(os.environ, MELEE_GFX_ORACLE=str(tmp/f'{variant}-graphics.csv'))
    subprocess.run(['bash', str(root/'scripts/phase0/run_checkpoints.sh'), str(tmp/variant/'melee_core_node.js'), str(tmp/'disc.iso'), str(out), '2400'], env=env, check=True)
    assert hashlib.sha1((out/'trace.csv').read_bytes()).hexdigest() == 'c79c53b9cdf81426fa0277e7497a69e55bc5f571'
    line=next(s for s in (out/'stdout.log').read_text().splitlines() if s.startswith('graphics decode: '))
    results['texture_decode'][variant]=json.loads(line.removeprefix('graphics decode: '))
(tmp/'results/replay.json').write_text(json.dumps(results,indent=2)+'\n')
a=(tmp/'baseline-graphics.csv').read_bytes()
b=(tmp/'candidate-graphics.csv').read_bytes()
assert a and a==b, 'ordered graphics output differs'
results['graphics']={'equal':True,'frames':len(a.splitlines()),'sha256':hashlib.sha256(a).hexdigest()}
(tmp/'results/replay.json').write_text(json.dumps(results,indent=2)+'\n')
