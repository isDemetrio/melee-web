"""Tests for scripts/analysis/cpuprofile_draw_lines.py over a synthetic profile (no core, no game data).

Run with:  python3 -m unittest discover -s scripts/tests -v
"""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'cpuprofile_draw_lines', Path(__file__).parents[1] / 'analysis/cpuprofile_draw_lines.py')
mod = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(mod)


def run_dir(tmp, ticks, other=0):
    """gxw_draw's body starts on (0-based) line 10; `ticks` maps body line index -> samples."""
    body = ['{', 'let offset=batch.lastUniform,same=offset>=0;', 'const groupKey=gpu.slots.map(s=>s.id).join(",");',
            'const key=[lines,cull].join(":");', 'gpu.vertexStaging.set(x,0);', 'zmode&=31;']
    nodes = [{'id': 1, 'callFrame': {'functionName': '(root)', 'url': ''}, 'hitCount': other, 'children': [2]},
             {'id': 2, 'callFrame': {'functionName': 'gxw_draw__inner', 'url': 'file:///core.js'},
              'hitCount': sum(ticks.values()),
              'positionTicks': [{'line': 10 + k + 1, 'ticks': t} for k, t in ticks.items()]}]
    (tmp / 'inmatch.cpuprofile').write_text(json.dumps({'nodes': nodes}))
    (tmp / 'gxw_draw.lines.json').write_text(json.dumps({'firstLine': 10, 'lines': body}))
    rows = ['retrace,draws'] + [f'{r},{100}' for r in range(1639, 1649)]
    (tmp / 'frames.csv').write_text('\n'.join(rows) + '\n')
    (tmp / 'summary.json').write_text(json.dumps({'profWindow': {'start_us': 0, 'stop_us': 10 * 20000}}))
    return str(tmp)


class DrawLines(unittest.TestCase):
    def test_groups_by_statement_and_scales_per_draw(self):
        with tempfile.TemporaryDirectory() as t:
            s = mod.split(run_dir(Path(t), {1: 40, 2: 20, 3: 10, 4: 10, 5: 20}, other=100))
        self.assertEqual(s['frames'], 10)
        self.assertEqual(s['draws_per_frame'], 100)
        g = s['groups']
        self.assertAlmostEqual(g['uniform dedup compare']['percent_frame'], 20.0)
        self.assertAlmostEqual(g['uniform dedup compare']['percent_draw_js'], 40.0)
        self.assertAlmostEqual(g['bind group key string + LRU Map']['percent_frame'], 10.0)
        self.assertAlmostEqual(g['pipeline key string + Map']['percent_frame'], 5.0)
        self.assertAlmostEqual(g['vertex/index copy to staging']['percent_frame'], 5.0)
        self.assertAlmostEqual(g['BP reads, arena checks, rest']['percent_frame'], 10.0)
        # 20 ms per frame, 20% of it over 100 draws = 40 us per draw.
        self.assertAlmostEqual(g['uniform dedup compare']['us_per_draw'], 40.0)

    def test_ticks_outside_the_body_are_counted_not_grouped(self):
        with tempfile.TemporaryDirectory() as t:
            s = mod.split(run_dir(Path(t), {1: 5, 50: 7}))
        self.assertEqual(s['unmapped_samples'], 7)
        self.assertEqual(sum(round(g['percent_draw_js'] * s['self_samples'] / 100) for g in s['groups'].values()), 5)

    def test_no_draw_samples_is_reported(self):
        with tempfile.TemporaryDirectory() as t:
            s = mod.split(run_dir(Path(t), {}, other=10))
        self.assertEqual(s['self_samples'], 0)
        self.assertEqual(s['groups']['uniform dedup compare']['percent_draw_js'], 0.0)


if __name__ == '__main__':
    unittest.main()
