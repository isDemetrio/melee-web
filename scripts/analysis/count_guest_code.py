#!/usr/bin/env python3
"""Static source counts, not executed instructions or compiler/WASM stores.

Pass an external recomp.py output directory. Emits aggregate JSON only; never
copies game source. Patterns target the pinned melee-unlocked emitter format.
"""
import argparse
import collections
import json
from pathlib import Path
import re

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('generated', type=Path)
args = parser.parse_args()
files = sorted(args.generated.glob('guest_[0-9][0-9][0-9].cpp'))
if not files:
    parser.error('no guest translation units found')
patterns = {
    'functions': r'^void f_',
    'instruction_comments': r'// [0-9a-f]{8}(?:\s|$)',
    'enter_sites': r'ppc::enter\(',
    'explicit_pc_assignments': r'\bc\.(?:pc|last_pc)\s*=',
    'entry_assignments': r'\bc\.entry\s*=',
    'lr_assignments': r'\bc\.lr\s*=',
    'local_labels': r'^L_[0-9A-F]+:',
    'local_gotos': r'\bgoto L_',
    'return_statements': r'\breturn\s*;',
    'direct_guest_calls': r'\bf_[0-9A-F]+\(c, m\)',
    'dispatch_calls': r'ppc::call\(',
    'backedge_sites': r'ppc::backedge\(',
}
counts = collections.Counter()
for path in files:
    source = path.read_text()
    counts['source_bytes'] += path.stat().st_size
    for key, pattern in patterns.items():
        counts[key] += len(re.findall(pattern, source, re.MULTILINE))
counts['translation_units'] = len(files)
table = (args.generated / 'guest_table.cpp').read_text()
counts['table_entry_assignments'] = len(re.findall(r'\bc\.entry\s*=', table))
print(json.dumps(dict(sorted(counts.items())), indent=2))
