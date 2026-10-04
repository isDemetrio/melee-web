#!/usr/bin/env python3
"""CI-only: hooks oracle.h into the runner's copy of native/real_fifo.cpp. Never committed."""
import os
from pathlib import Path
assert os.environ.get('GITHUB_ACTIONS') == 'true'
p = Path('native/real_fifo.cpp')
s = p.read_text().replace('#include "gx_core.h"', '#include "gx_core.h"\n#include "experiments/texture-simd/oracle.h"', 1)
for call in ('submit_frame(frame);', 'submit_and_recycle(frame);'):
    s = s.replace(f'    if (target) target->{call}', f'    texsimd::graphics_oracle(frame);\n    if (target) target->{call}')
assert s.count('texsimd::graphics_oracle(frame)') == 2
p.write_text(s)
