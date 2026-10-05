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

    def test_out_of_line_arithmetic_is_not_guest_body(self):
        self.assertEqual(self.category(['fma', 'f_80000000']), 'fp_emulation')
        self.assertEqual(self.category(['unknown_helper', 'f_80000000']), 'guest_other_helpers')

    def test_dispatch_below_guest_does_not_own_guest_body(self):
        self.assertEqual(self.category(['f_80000000', 'ppc::call', 'f_80000004']),
                         'guest_and_inlined_helpers')
        self.assertEqual(self.category(['ppc::trace_enter', 'ppc::enter', 'f_80000000',
                                        'ppc::call', 'f_80000004']), 'entry_trace')

    def test_missing_boundary_is_not_free(self):
        result = module.analyse(profile(['f_80000000']))
        self.assertEqual(result['zones']['gx_vertices']['visibility'], 'not observed (may be inlined)')


region_spec = importlib.util.spec_from_file_location('emulator_regions',
    Path(__file__).resolve().parents[2] / 'experiments/emulator-cost/summarize_regions.py')
region_module = importlib.util.module_from_spec(region_spec)
region_spec.loader.exec_module(region_module)


class RegionAccountingTest(unittest.TestCase):
    def inputs(self):
        baseline, measured = {'runs': []}, {'runs': []}
        names = ('mmio_gx', 'fifo', 'fifo_append', 'parse', 'vertex_descriptor',
                 'vertices', 'record', 'texture_snapshot', 'command_append')
        for mode in ('attached', 'headless'):
            for i in range(3):
                baseline['runs'].append({'mode': f'{mode}-control-{i}', 'sim_ms': 10})
                measured['runs'].append({'mode': f'{mode}-control-{i}', 'sim_ms': 11})
                measured['runs'].append({'mode': f'{mode}-regions-{i}', 'sim_ms': 22, 'frames': 762,
                    'regions': {'regions': [{'name': n, 'calls': 762, 'inclusive_ms': 762,
                                            'exclusive_ms': 381} for n in names]}})
        return baseline, measured

    def test_probe_overhead_is_explicit_and_not_a_speedup(self):
        result = region_module.summarize(*self.inputs())['modes']['attached']
        self.assertEqual(result['disabled_over_baseline'], 1.1)
        self.assertEqual(result['enabled_over_disabled'], 2)
        self.assertEqual(result['regions']['vertices']['exclusive_ms_per_frame'], 0.5)

    def test_required_probe_that_never_fires_fails(self):
        baseline, measured = self.inputs()
        measured['runs'][1]['regions']['regions'][0]['calls'] = 0
        with self.assertRaisesRegex(ValueError, 'zero calls'):
            region_module.summarize(baseline, measured)

memory_spec = importlib.util.spec_from_file_location('emulator_memory',
    Path(__file__).resolve().parents[2] / 'experiments/emulator-cost/summarize_memory.py')
memory_module = importlib.util.module_from_spec(memory_spec)
memory_spec.loader.exec_module(memory_module)


class MemoryAccountingTest(unittest.TestCase):
    def inputs(self):
        base, measured, profiles = {'runs': []}, {'runs': []}, {}
        for mode in ('attached', 'headless'):
            for i in range(3):
                base['runs'].append({'mode': f'{mode}-control-{i}', 'sim_ms': 10})
                measured['runs'].append({'mode': f'{mode}-control-{i}', 'sim_ms': 12})
            measured['runs'].append({'mode': mode + '-count', 'memory': {
                'calls': 100, 'zero_bytes': 0, 'out_of_range': 0, 'single_block': 99,
                'multi_block': 1, 'block_checks': 101, 'watched_hits': 20}})
            profiles[mode] = {'ms_per_frame': 13, 'zones': {
                'memory_helpers': {'samples': 10}, 'memory_mark_ram_write': {'samples': 10}}}
        return base, measured, profiles

    def test_reports_perturbation_and_watched_fraction(self):
        out = memory_module.summarize(*self.inputs())['modes']['attached']
        self.assertEqual(out['outlined_over_baseline'], 1.2)
        self.assertEqual(out['watched_fraction_of_block_checks'], 20 / 101)

    def test_invisible_mark_boundary_fails_instead_of_reporting_zero_cost(self):
        base, measured, profiles = self.inputs()
        profiles['attached']['zones']['memory_mark_ram_write']['samples'] = 0
        with self.assertRaisesRegex(ValueError, 'zero samples'):
            memory_module.summarize(base, measured, profiles)
