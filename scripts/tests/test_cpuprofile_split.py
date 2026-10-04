"""The core-cost profile split assigns time by the stack, not by the leaf (docs/CORE_COST_BROWSER.md)."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'cpuprofile_split', Path(__file__).resolve().parents[1] / 'analysis' / 'cpuprofile_split.py')
split = importlib.util.module_from_spec(spec)
spec.loader.exec_module(split)


def node(i, name, children=(), url='wasm://wasm/x'):
    return {'id': i, 'callFrame': {'functionName': name, 'url': url}, 'children': list(children)}


GUEST = 'guest::f_803749B0(ppc::Context&, unsigned char*)'


class ZoneTest(unittest.TestCase):
    def test_fifo_store_under_a_guest_function_is_gpu_emulation(self):
        stack = ['gx::(anonymous namespace)::parse_command(unsigned char const*, unsigned long)',
                 'host::gx_write(unsigned int, int)', 'host::mmio_write(unsigned int, unsigned int, int)',
                 'ppc::st32(ppc::Context&, unsigned char*, unsigned int, unsigned int)', GUEST]
        self.assertEqual(split.zone_of(stack), ('gx_fifo_decode', None))

    def test_helpers_called_by_guest_code(self):
        self.assertEqual(split.zone_of(['fma', 'ppc::fmadd(double, double, double)', GUEST]),
                         ('guest', 'fp_emulation'))
        self.assertEqual(split.zone_of(['ppc::ld32(ppc::Context&, unsigned char*, unsigned int)', GUEST]),
                         ('guest', 'memory_helpers'))
        self.assertEqual(split.zone_of([GUEST, 'main']), ('guest', 'guest_body'))
        self.assertEqual(split.zone_of(['something_new', GUEST]), ('guest', 'other_helper'))

    def test_backend_js_and_no_guest(self):
        self.assertEqual(split.zone_of(['gxw_draw__inner', 'gxw_draw', 'wasm-to-js', GUEST]),
                         ('render_backend', None))
        self.assertEqual(split.zone_of(['(garbage collector)']), ('outside_guest', None))

    def test_totals_and_inclusive_split(self):
        # root -> guest -> st32 -> mmio_write -> gx_write (leaf), and root -> guest (leaf)
        nodes = [node(1, '(root)', [2], url=''), node(2, GUEST, [3]),
                 node(3, 'ppc::st32(ppc::Context&, unsigned char*, unsigned int, unsigned int)', [4]),
                 node(4, 'host::mmio_write(unsigned int, unsigned int, int)', [5]),
                 node(5, 'host::gx_write(unsigned int, int)')]
        profile = {'nodes': nodes, 'samples': [5, 2, 5, 2], 'timeDeltas': [0, 1000, 1000, 1000]}
        out = split.analyse(profile, 2, {'803749B0': 'HSD_JObjDisp'}, ['HSD_JObjDisp'], 10)
        self.assertEqual(out['window_ms'], 4.0)
        self.assertEqual(out['zones']['guest']['percent'], 50.0)
        self.assertEqual(out['zones']['gx_fifo_decode']['percent'], 50.0)
        self.assertEqual(out['watch_inclusive']['HSD_JObjDisp']['percent'], 100.0)
        self.assertEqual(out['watch_inclusive']['HSD_JObjDisp']['guest_zone_percent'], 50.0)


if __name__ == '__main__':
    unittest.main()
