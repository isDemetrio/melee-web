import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('wasm_report', Path(__file__).parents[1] / 'phase0/wasm_report.py')
report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(report)

class WasmReportTest(unittest.TestCase):
    def test_import_and_body(self):
        # One function import env.sin; one code body with 3 i32 locals and end.
        imports = b'\x01\x03env\x03sin\x00\x00'
        code = b'\x01\x04\x01\x03\x7f\x0b'
        data = b'\0asm\x01\0\0\0' + b'\x02' + bytes([len(imports)]) + imports + b'\x0a' + bytes([len(code)]) + code
        r = report.inspect(data)
        self.assertEqual(r['forbidden_libm_imports'][0]['name'], 'sin')
        self.assertEqual(r['largest_bodies'], [{'function_index': 1, 'body_bytes': 4, 'locals': 3}])

    def test_libm_names(self):
        for name in ['sin', 'cosf', 'pow', 'emscripten_math_log', 'fmodl', 'sqrt']:
            self.assertIsNotNone(report.LIBM.fullmatch(name))
        self.assertIsNone(report.LIBM.fullmatch('clock_time_get'))

    def test_truncated(self):
        with self.assertRaises(ValueError):
            report.inspect(b'\0asm\x01\0\0\0\x02\x08\x01')
