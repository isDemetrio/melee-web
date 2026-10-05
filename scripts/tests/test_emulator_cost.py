import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('emulator_cost',
    Path(__file__).resolve().parents[2] / 'experiments/emulator-cost/attribute.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def profile(stack):
    nodes = [{'id': i + 1, 'callFrame': {'functionName': name},
              'children': [i + 2] if i + 1 < len(stack) else []}
             for i, name in enumerate(reversed(stack))]
    return {'nodes': nodes, 'samples': [len(stack)], 'timeDeltas': [100]}


class AttributionTest(unittest.TestCase):
    def category(self, stack):
        result = module.analyse(profile(stack))
        return next(k for k, v in result['zones'].items() if v['samples'])

    def test_guest_store_does_not_own_fifo_time(self):
        self.assertEqual(self.category(['memcpy', 'gx::parse_command', 'gx_write',
                                        'mmio_write', 'ppc::st32', 'f_80000000']), 'gx_parse_command')

    def test_vertex_helper_belongs_to_vertices(self):
        self.assertEqual(self.category(['ppc::ld32', 'gx::decode_vertices',
                                        'gx::parse_command', 'f_80000000']), 'gx_vertices')

    def test_renderer_excluded(self):
        self.assertEqual(self.category(['memcmp', 'draw_segment', 'submit_and_recycle',
                                        'gx::parse_command', 'f_80000000']), 'renderer_excluded')

    def test_mmio_destination_is_unknown(self):
        self.assertEqual(self.category(['mmio_write', 'ppc::st32', 'f_80000000']), 'mmio_unresolved')

    def test_write_tracking_separated(self):
        self.assertEqual(self.category(['ppc::mark_ram_write', 'ppc::st32', 'f_80000000']),
                         'memory_mark_ram_write')

    def test_empty_profile_fails(self):
        with self.assertRaisesRegex(ValueError, 'zero'):
            module.analyse({'nodes': [], 'samples': [], 'timeDeltas': []})

    def test_missing_boundary_is_not_free(self):
        result = module.analyse(profile(['f_80000000']))
        self.assertEqual(result['zones']['gx_vertices']['visibility'], 'not observed (may be inlined)')
