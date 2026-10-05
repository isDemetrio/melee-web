#!/usr/bin/env python3
"""Keep only emulator ld32/st32/mark_ram_write bodies from wasm-dis output.

Never emit translated guest functions, globals or data sections. Run on Actions;
the full disassembly remains in RUNNER_TEMP and is removed with the build.
"""
import re
import sys
from pathlib import Path

wanted = re.compile(r'\$[^\s]*(?:_ZN3ppc(?:4ld32|4st32|14mark_ram_write)|ppc::(?:ld32|st32|mark_ram_write))')
source, target = map(Path, sys.argv[1:])
found = []
keep = False
with source.open() as src, target.open('w') as dst:
    for line in src:
        if line.startswith(' ('):
            keep = line.startswith(' (func ') and bool(wanted.search(line))
            if keep:
                found.append(line.strip().split(' ', 2)[1])
        if keep:
            dst.write(line)
if not found:
    raise SystemExit('no named emulator memory helper bodies; no instruction evidence')
print('extracted emulator helpers:', ', '.join(found))
