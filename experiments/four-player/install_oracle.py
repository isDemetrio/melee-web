#!/usr/bin/env python3
"""CI-only: hook experiments/four-player/oracle.h into the runner's copy of native/real_fifo.cpp.

Never committed to a source change: the oracle lives in experiments/ and is spliced into the
runner's checkout for the length of one job, exactly as experiments/texture-simd/install_oracle.py
does. wasm/ and native/ are untouched in git, so the module under test is the shipped core.
"""
import os
from pathlib import Path

assert os.environ.get('GITHUB_ACTIONS') == 'true', 'this splices the runner checkout, not a workstation'
p = Path('native/real_fifo.cpp')
s = p.read_text()
s = s.replace('#include "gx_core.h"', '#include "gx_core.h"\n#include "experiments/four-player/oracle.h"', 1)
for call in ('submit_frame(frame);', 'submit_and_recycle(frame);'):
    s = s.replace(f'    if (target) target->{call}', f'    fourplayer::graphics_oracle(frame);\n    if (target) target->{call}')
assert s.count('fourplayer::graphics_oracle(frame)') == 2, 'splice points moved: expected two submit calls'
p.write_text(s)
print('spliced four-player oracle into native/real_fifo.cpp')
