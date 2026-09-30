#!/usr/bin/env python3
"""Read WASM imports/code sizes without dependencies; reject host libm imports."""
import json
from pathlib import Path
import re
import sys

LIBM = re.compile(r'^(?:emscripten_math_.*|(?:acos|acosh|asin|asinh|atan|atanh|atan2|cbrt|ceil|copysign|cos|cosh|erf|erfc|exp|exp2|expm1|fabs|fdim|floor|fma|fmax|fmin|fmod|frexp|hypot|ilogb|ldexp|lgamma|log|log10|log1p|log2|logb|modf|nearbyint|nextafter|pow|remainder|remquo|rint|round|scalbn|sin|sinh|sqrt|tan|tanh|tgamma|trunc)[fl]?)$')

class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def take(self, count):
        if count < 0 or self.pos + count > len(self.data):
            raise ValueError('truncated WASM')
        result = self.data[self.pos:self.pos + count]
        self.pos += count
        return result

    def byte(self):
        return self.take(1)[0]

    def uint(self):
        result = 0
        for shift in range(0, 70, 7):
            value = self.byte()
            result |= (value & 127) << shift
            if value < 128:
                return result
        raise ValueError('invalid LEB128')

    def name(self):
        return self.take(self.uint()).decode('utf-8')

    def limits(self):
        flags = self.uint()
        self.uint()
        if flags & 1:
            self.uint()


def inspect(data):
    r = Reader(data)
    if r.take(8) != b'\0asm\x01\0\0\0':
        raise ValueError('not a WASM v1 module')
    imports, bodies = [], []
    function_imports = 0
    while r.pos < len(data):
        section = r.byte()
        s = Reader(r.take(r.uint()))
        if section == 2:
            for _ in range(s.uint()):
                module, name, kind = s.name(), s.name(), s.byte()
                imports.append({'module': module, 'name': name, 'kind': kind})
                if kind == 0:
                    s.uint()
                    function_imports += 1
                elif kind == 1:
                    s.byte()
                    s.limits()
                elif kind == 2:
                    s.limits()
                elif kind == 3:
                    s.byte()
                    s.byte()
                elif kind == 4:
                    s.byte()
                    s.uint()
                else:
                    raise ValueError(f'unsupported import kind {kind}')
        elif section == 10:
            for index in range(s.uint()):
                size = s.uint()
                body = Reader(s.take(size))
                locals_count = 0
                for _ in range(body.uint()):
                    locals_count += body.uint()
                    body.byte()
                bodies.append({'function_index': function_imports + index,
                               'body_bytes': size, 'locals': locals_count})
    forbidden = [i for i in imports if i['kind'] == 0 and LIBM.fullmatch(i['name'].lstrip('_'))]
    return {'wasm_bytes': len(data), 'pages_limit_bytes': 25 * 1024 * 1024,
            'within_pages_limit': len(data) <= 25 * 1024 * 1024,
            'imports': imports, 'forbidden_libm_imports': forbidden,
            'function_bodies': len(bodies),
            'largest_bodies': sorted(bodies, key=lambda b: b['body_bytes'], reverse=True)[:10]}


def main():
    report = inspect(Path(sys.argv[1]).read_bytes())
    print(json.dumps(report, indent=2))
    return 1 if report['forbidden_libm_imports'] else 0

if __name__ == '__main__':
    sys.exit(main())
