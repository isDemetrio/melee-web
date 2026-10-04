#!/usr/bin/env python3
import os
from pathlib import Path
assert os.environ.get('GITHUB_ACTIONS') == 'true'
p=Path('native/real_fifo.cpp')
s=p.read_text().replace('#include "gx_core.h"', '#include "gx_core.h"\n#include "experiments/beyond-core/graphics_oracle.h"')
s=s.replace('    if (target) target->submit_frame(frame);','    experiment::graphics_oracle(frame);\n    if (target) target->submit_frame(frame);')
s=s.replace('    if (target) target->submit_and_recycle(frame);','    experiment::graphics_oracle(frame);\n    if (target) target->submit_and_recycle(frame);')
assert s.count('experiment::graphics_oracle(frame)') == 2
p.write_text(s)
