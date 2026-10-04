#!/usr/bin/env python3
"""CI-only experimental mutations; generated guest and builds stay in RUNNER_TEMP."""
import os, re, sys
from pathlib import Path
assert os.environ.get('GITHUB_ACTIONS') == 'true'
variant = sys.argv[1]
root = Path.cwd()
header = root / 'upstream/melee-unlocked/port/runtime/ppc/ppc.h'
if variant == 'inline':
    text = header.read_text()
    text, n = re.subn(r'inline (uint(?:8|16|32|64)_t\*?|void) (fast|slowptr|ld8|ld16|ld32|ld64|st8|st16|st32|st64|mark_ram_write)\(', r'__attribute__((always_inline)) inline \1 \2(', text)
    assert n == 11, n
    header.write_text(text)
elif variant == 'hot':
    # Keep guest semantics and cold size policy; optimize TUs containing measured hot functions.
    gen = Path(os.environ['RUNNER_TEMP']) / 'generated'
    hot = []
    for p in gen.glob('guest_*.cpp'):
        if re.search(r'^void f_(803749B0|8036E4C4|80342204)\(', p.read_text(), re.M):
            hot.append(p)
    assert hot
    cmake = root / 'wasm/core/CMakeLists.txt'
    with cmake.open('a') as f:
        for p in hot:
            f.write(f'\nset_source_files_properties("{p}" PROPERTIES COMPILE_OPTIONS "-O2")\n')
    print('hot translation units:', len(hot), [p.name for p in hot])
elif variant == 'rgba8':
    p = root / 'upstream/melee-unlocked/port/runtime/gx/gx_texture.cpp'
    s=p.read_text()
    assert s.count('void decode_texture(')==1
    s=s.replace('void decode_texture(', 'void decode_reference(')
    s += '\n#define decode_texture decode_reference\n#include "experiments/kernels/rgba8.h"\n#undef decode_texture\nnamespace gx {\nvoid decode_texture(const uint8_t* src,uint32_t w,uint32_t h,uint32_t fmt,const uint8_t* pal,uint32_t pf,std::vector<uint8_t>& out) { decode_candidate(src,w,h,fmt,pal,pf,out); }\n}\n'
    p.write_text(s)
elif variant not in ('baseline', 'simd'):
    raise ValueError(variant)
