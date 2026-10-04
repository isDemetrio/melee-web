#!/usr/bin/env python3
"""Audit the next operator report on one cohort; never replace missing values by zero.

Only aggregate output is emitted. No source report or game data is copied.
"""
import argparse
import csv
import hashlib
import io
import json
import math
from collections import Counter
from pathlib import Path
from statistics import mean

FIELDS = ('core_ms', 'sim_ms', 'previous_heartbeat_tail_ms', 'csv_write_ms',
          'heartbeat_read_ms', 'heartbeat_finish_ms', 'core_unattributed_ms',
          'native_pre_heartbeat_ms', 'previous_js_return_to_resume_probe_ms',
          'previous_bridge_outside_js_ms', 'bridge_entry_ms', 'residual_unexplained_ms',
          'previous_native_roundtrip_ms', 'previous_js_heartbeat_ms')

def audit(report):
    rows = list(csv.DictReader(io.StringIO(report.get('frames_csv', ''))))
    cohort, excluded = [], Counter()
    visible = 0
    for row in rows:
        if float(row.get('match_frame') or 0) <= 0 or row.get('hidden') == '1':
            continue
        visible += 1
        try:
            values = {k: float(row[k]) for k in FIELDS}
            if not all(math.isfinite(x) for x in values.values()):
                raise ValueError('nonfinite')
        except (KeyError, ValueError, TypeError):
            excluded['missing_or_nonfinite_paired_fields'] += 1
            continue
        cohort.append(values)
    out = {'visible_match_rows': visible, 'matched': len(cohort), 'excluded': dict(excluded),
           'availability': bool(cohort), 'closed': False}
    if not cohort:
        return out
    out['means_ms'] = {k: mean(r[k] for r in cohort) for k in FIELDS}
    r = sorted(abs(v['residual_unexplained_ms']) for v in cohort)
    out['unexplained_absolute_ms'] = {'mean': mean(r), 'p95': r[math.ceil(.95*len(r))-1], 'max': r[-1]}
    out['negative_unexplained_rows'] = sum(v['residual_unexplained_ms'] < 0 for v in cohort)
    errors = [abs(v['core_unattributed_ms'] - sum(v[k] for k in (
        'native_pre_heartbeat_ms', 'previous_js_return_to_resume_probe_ms',
        'previous_bridge_outside_js_ms', 'bridge_entry_ms', 'residual_unexplained_ms'))) for v in cohort]
    out['attribution_identity_max_error_ms'] = max(errors)
    out['closed'] = len(cohort)/visible >= .99 and mean(r) < .2 and r[math.ceil(.95*len(r))-1] < 1 and max(errors) < .02
    # Closure is timing reconciliation only; it does not establish removability or CPU work.
    return out

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report',type=Path)
    args=parser.parse_args()
    data=args.report.read_bytes()
    result=audit(json.loads(data))
    result['source_sha256']=hashlib.sha256(data).hexdigest()
    print(json.dumps(result,indent=2))
