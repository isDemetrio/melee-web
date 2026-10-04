#!/usr/bin/env python3
"""Separate four-port workload: compare full traces, never demand the two-player digest."""
import csv,hashlib,json,os,statistics,subprocess
from pathlib import Path
root=Path(os.environ['GITHUB_WORKSPACE']);tmp=Path(os.environ['RUNNER_TEMP'])
result={'script_sha256':hashlib.sha256((root/'experiments/beyond-core/four-player.txt').read_bytes()).hexdigest(),'pairs':[]}
for trial in range(3):
 pair={}
 for variant in (('baseline','candidate') if trial%2==0 else ('candidate','baseline')):
  out=tmp/'four-replay'
  subprocess.run(['bash',str(root/'scripts/phase0/run_checkpoints.sh'),str(tmp/variant/'melee_core_node.js'),str(tmp/'disc.iso'),str(out),'3600',str(root/'experiments/beyond-core/four-player.txt')],check=True)
  trace=(out/'trace.csv').read_bytes();digest=hashlib.sha1(trace).hexdigest()
  with (out/'sim_times.csv').open() as f:values=[float(r['sim_ms']) for r in csv.DictReader(f) if int(r['match_frame'])>300]
  assert len(values)>600,'no stable match'
  pair[variant]={'mean_ms':statistics.mean(values),'p95_ms':sorted(values)[int(.95*len(values))],'frames':len(values),'sha1':digest}
 assert pair['baseline']['sha1']==pair['candidate']['sha1'],'four-player divergence'
 pair['speedup']=pair['baseline']['mean_ms']/pair['candidate']['mean_ms'];result['pairs'].append(pair)
 (tmp/'results/four-player.json').write_text(json.dumps(result,indent=2)+'\n')
# Four connected input ports alone are not proof of four fighters. Check rendered HUD slots.
for variant in ('baseline','candidate'):
 out=tmp/'four-replay';env=dict(os.environ,MELEE_GFX_ORACLE=str(tmp/f'four-{variant}.csv'))
 subprocess.run(['bash',str(root/'scripts/phase0/run_checkpoints.sh'),str(tmp/variant/'melee_core_node.js'),str(tmp/'disc.iso'),str(out),'3600',str(root/'experiments/beyond-core/four-player.txt')],env=env,check=True)
 line=next(s for s in (out/'stdout.log').read_text().splitlines() if s.startswith('graphics decode: '))
 stats=json.loads(line.removeprefix('graphics decode: '));result[variant+'_graphics']=stats
 assert stats['four_hud_frames']>600,'four fighters not certified'
a=(tmp/'four-baseline.csv').read_bytes();b=(tmp/'four-candidate.csv').read_bytes();assert a and a==b
result['graphics_equal']=True;result['graphics_sha256']=hashlib.sha256(a).hexdigest()
(tmp/'results/four-player.json').write_text(json.dumps(result,indent=2)+'\n')
