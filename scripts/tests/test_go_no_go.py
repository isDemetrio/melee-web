"""Tests for scripts/phase0/go_no_go.py -- the Phase 0 verdict, over synthetic results.

Nothing here is game data and nothing here reads a disc: a result JSON is a handful of fields plus
two CSVs, so a test can build the whole input. The reference trace is synthetic too, which is what
makes the "a trace that differs is NO-GO" case reachable at all -- the real reference lives outside
the repository (`docs/AGENT_RULES.md` rule 1).

The verdicts asserted here are the rows of `docs/PHASE0_DEVICE_PLAN.md` section 6: GO, NO-GO for
correctness, NO-GO for performance, the middle band the specification calls "desktop only", the
band it does not cover (REVIEW), and no verdict. One deliberate deviation from
`docs/PHASE0_NEXT.md` S8's older table is asserted rather than hidden: a coarse clock
(`timer_resolution_ms > 0.1`) is **not** an input error here. Section 6 of the device plan says C2
"vale solo la regola del NO-GO netto", so a coarse clock forbids a GO and leaves the net NO-GO
rule standing -- the case is tested as `NOT-DECIDABLE`, not as exit 2.

Run with:  python3 -m unittest discover -s scripts/tests -v
"""

import hashlib
import importlib.util
import io
import json
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location(
    'go_no_go', Path(__file__).parents[1] / 'phase0/go_no_go.py')
go_no_go = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(go_no_go)

FRAME_STATS_SPEC = importlib.util.spec_from_file_location(
    'frame_stats_for_tests', Path(__file__).parents[1] / 'phase0/frame_stats.py')
frame_stats = importlib.util.module_from_spec(FRAME_STATS_SPEC)
FRAME_STATS_SPEC.loader.exec_module(frame_stats)

COMMIT = '4fba3a080af6f205cc6107ada7baefeb0315cae0'
OTHER_COMMIT = 'f0d76a2816eceefb7ec98b5b4a78a55edfa537c0'
ISO_BYTES = 1459978240
FINAL_SCENE = 'final scene: mode=2 state=2 match_frame=762 (retraces=2400)'
TRACE_HEADER = 'retrace,cpu,ram,aram,events'


def trace(rows=2400, flip_row=None):
    """A state trace of `rows` rows, or the same trace with one cell changed."""
    lines = [TRACE_HEADER]
    for index in range(rows):
        cpu = f'{index + 1:016X}'
        ram = f'{(index * 2654435761) % (16 ** 16):016X}'
        aram = 'F' * 16
        if flip_row is not None and index == flip_row:
            cpu = '0' * 16
        lines.append(f'{index + 1},{cpu},{ram},{aram},{"0" * 16}')
    return '\n'.join(lines) + '\n'


def sim_times(mean_ms=3.0, in_match=762, menu=1638, menu_ms=1.0, peak_ms=None, peak_rows=8):
    """The per-frame CSV: `menu` rows outside the match, then `in_match` rows inside it.

    `peak_ms` raises the last `peak_rows` in-match rows, which is where the nearest-rank p99 lands
    for 762 rows (index 754 of 762), so p99 and max can be set without moving the mean much.
    """
    lines = ['retrace,sim_ms,match_frame']
    for index in range(menu):
        lines.append(f'{index + 1},{menu_ms},0')
    for index in range(in_match):
        value = mean_ms
        if peak_ms is not None and index >= in_match - peak_rows:
            value = peak_ms
        lines.append(f'{menu + index + 1},{value},{(index % 762) + 1}')
    return '\n'.join(lines) + '\n'


class VerdictTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.reference = self.write('native-1.trace.csv', trace())

    def write(self, name, text):
        path = self.tmp / name
        path.write_text(text)
        return str(path)

    def result(self, name, mean_ms=3.0, peak_ms=None, trace_text=None, trace_flip=None,
               core_commit=COMMIT, frames=2400, exit_code=0, iso_bytes=ISO_BYTES,
               final_scene=FINAL_SCENE, timer=0.02, coi=True, wall_ms=None, in_match=762,
               declared=None, sim_text=None):
        """One result JSON, with the statistics the page would have declared for its own CSV."""
        sim = sim_text if sim_text is not None else sim_times(mean_ms, in_match=in_match, peak_ms=peak_ms)
        values = frame_stats.parse_durations(sim, in_match=True)
        computed = frame_stats.stats(values)
        if wall_ms is None:
            wall_ms = sum(frame_stats.parse_durations(sim, in_match=False)) + 1000.0
        report = {
            'schema': 'melee-spike-result/1',
            'created': '2026-10-01T00:00:00.000Z',
            'core_commit': core_commit,
            'core_opt': '-Oz',
            'user_agent': 'synthetic',
            'cross_origin_isolated': coi,
            'timer_resolution_ms': timer,
            'frames': frames,
            'iso_bytes': iso_bytes,
            'exit_code': exit_code,
            'final_scene': final_scene,
            'wall_ms': wall_ms,
            'trace_csv': trace() if trace_text is None else trace_text,
            'sim_times_csv': sim,
            'stats_in_match': computed if declared is None else declared,
        }
        if trace_flip is not None:
            report['trace_csv'] = trace(flip_row=trace_flip)
        return self.write(name, json.dumps(report))

    def verdict(self, *args):
        out = io.StringIO()
        with redirect_stdout(out):
            code = go_no_go.run(['--reference', self.reference,
                                 '--reference-commit', COMMIT, *args])
        lines = out.getvalue().strip().splitlines()
        return code, lines[-1], json.loads('\n'.join(lines[:-1]))

    def repeats(self, count, **kwargs):
        return [self.result(f'run{index}.json', **kwargs) for index in range(count)]

    # --- the verdict rows -------------------------------------------------

    def test_go_needs_both_classes_inside_the_band(self):
        code, last, payload = self.verdict(
            '--phone', *self.repeats(3, mean_ms=2.0),
            '--desktop', *self.repeats(3, mean_ms=1.0))
        self.assertEqual(code, 0)
        self.assertEqual(last, 'VERDICT: GO')
        self.assertEqual(payload['verdict'], 'GO')
        self.assertEqual(payload['classes']['phone']['count'], 3)

    def test_phone_above_the_nogo_line_is_no_go(self):
        code, last, _ = self.verdict('--phone', *self.repeats(3, mean_ms=7.0))
        self.assertEqual(code, 1)
        self.assertEqual(last, 'VERDICT: NO-GO')

    def test_phone_p99_above_the_nogo_line_is_no_go(self):
        code, last, payload = self.verdict(
            '--phone', *self.repeats(3, mean_ms=4.0, peak_ms=13.0))
        self.assertEqual(code, 1)
        self.assertEqual(last, 'VERDICT: NO-GO')
        self.assertGreater(payload['classes']['phone']['worst_p99_ms'], go_no_go.PHONE_P99_NOGO)

    def test_the_clock_is_subtracted_before_a_nogo_is_declared(self):
        # 6.5 ms with a 0.6 ms clock: 6.5 - 0.6 = 5.9, inside the band, so this is not a NO-GO.
        code, last, _ = self.verdict('--phone', *self.repeats(3, mean_ms=6.5, timer=0.6))
        self.assertEqual(last, 'VERDICT: NOT-DECIDABLE')
        self.assertEqual(code, 4)

    def test_the_middle_band_is_desktop_only(self):
        code, last, payload = self.verdict(
            '--phone', *self.repeats(3, mean_ms=3.2442, peak_ms=5.64))
        self.assertEqual(code, 3)
        self.assertEqual(last, 'VERDICT: DESKTOP-ONLY')
        self.assertAlmostEqual(payload['classes']['phone']['worst_p99_ms'], 5.64, places=6)

    def test_a_desktop_row_in_an_uncovered_band_is_review(self):
        code, last, _ = self.verdict(
            '--phone', *self.repeats(3, mean_ms=2.0),
            '--desktop', *self.repeats(3, mean_ms=2.0))
        self.assertEqual(code, 4)
        self.assertEqual(last, 'VERDICT: REVIEW')

    def test_a_coarse_clock_forbids_a_go(self):
        code, last, payload = self.verdict('--phone', *self.repeats(3, mean_ms=2.0, timer=0.5))
        self.assertEqual(code, 4)
        self.assertEqual(last, 'VERDICT: NOT-DECIDABLE')
        self.assertFalse(payload['classes']['phone']['clock_ok'])

    def test_scattered_repeats_are_not_decidable(self):
        runs = [self.result('a.json', mean_ms=2.0), self.result('b.json', mean_ms=2.0),
                self.result('c.json', mean_ms=3.0)]
        code, last, payload = self.verdict('--phone', *runs)
        self.assertEqual(last, 'VERDICT: NOT-DECIDABLE')
        self.assertGreater(payload['classes']['phone']['spread'], go_no_go.SPREAD_TOLERANCE)

    def test_a_trace_that_differs_is_no_go_whatever_the_timings_say(self):
        runs = [self.result(f'run{index}.json', mean_ms=1.0) for index in range(3)]
        runs[1] = self.result('run1.json', mean_ms=1.0, trace_flip=17)
        code, last, payload = self.verdict('--phone', *runs)
        self.assertEqual(code, 1)
        self.assertEqual(last, 'VERDICT: NO-GO')
        self.assertIn('differs', ' '.join(payload['reasons']))

    def test_a_node_trace_that_differs_is_no_go(self):
        node = self.write('wasm-node-1.trace.csv', trace(flip_row=5))
        code, last, _ = self.verdict('--phone', *self.repeats(3, mean_ms=1.0),
                                     '--node-trace', node)
        self.assertEqual(code, 1)
        self.assertEqual(last, 'VERDICT: NO-GO')

    def test_a_node_trace_that_agrees_changes_nothing(self):
        node = self.write('wasm-node-1.trace.csv', trace())
        code, last, _ = self.verdict('--phone', *self.repeats(3, mean_ms=2.0), '--node-trace', node)
        self.assertEqual(code, 0)
        self.assertEqual(last, 'VERDICT: GO')

    def test_the_worst_repeat_decides(self):
        runs = [self.result('a.json', mean_ms=2.0), self.result('b.json', mean_ms=7.5),
                self.result('c.json', mean_ms=2.5)]
        code, last, payload = self.verdict('--phone', *runs)
        self.assertEqual(code, 1)
        self.assertEqual(payload['classes']['phone']['worst_mean_ms'],
                         payload['classes']['phone']['runs'][1]['stats_in_match_recomputed']['mean_ms'])

    def on_o1(self, runs):
        """The same results, declaring the `-O1` core S11 was written about."""
        for path in runs:
            report = json.loads(Path(path).read_text())
            report['core_opt'] = '-O1'
            Path(path).write_text(json.dumps(report))
        return runs

    def test_a_non_go_on_the_o1_core_is_provisional(self):
        code, last, payload = self.verdict('--phone', *self.on_o1(self.repeats(3, mean_ms=7.0)))
        self.assertEqual(last, 'VERDICT: NO-GO')
        self.assertTrue(payload['provisional'])

    def test_a_go_on_the_o1_core_is_not_provisional(self):
        _, last, payload = self.verdict('--phone', *self.on_o1(self.repeats(3, mean_ms=2.0)),
                                        '--desktop', *self.repeats(3, mean_ms=1.0))
        self.assertEqual(last, 'VERDICT: GO')
        self.assertFalse(payload['provisional'])

    # --- C3's cross-commit rule (docs/PHASE0_DEVICE_PLAN.md section 5) -----

    def recorded_sha1(self, text):
        """Point the module's recorded reference hash at `text`, restoring it afterwards.

        The real recorded value is the SHA-1 of a trace that lives outside the repository
        (`docs/AGENT_RULES.md` rule 1), so a synthetic trace can only stand in for it if the
        constant is told what to expect. That is the point of the test: the rule is about the trace
        being identical *and* hashing to the recorded value, and both halves are exercised.
        """
        original = go_no_go.EXPECTED_TRACE_SHA1
        self.addCleanup(setattr, go_no_go, 'EXPECTED_TRACE_SHA1', original)
        go_no_go.EXPECTED_TRACE_SHA1 = hashlib.sha1(text.encode('utf-8')).hexdigest()

    def test_a_different_commit_is_accepted_against_an_identical_recorded_trace(self):
        # The native trace in hand is from an earlier commit than the core the browser ran -- which
        # is the real state of the iPhone row, whose core is 4fba3a08 while the reference is
        # f0d76a28. With the trace identical cell by cell and hashing to the recorded value, section
        # 5 accepts the parity: the run stays evidence, and the annotation names both commits.
        self.recorded_sha1(trace())
        code, last, payload = self.verdict(
            '--phone', *self.repeats(3, mean_ms=3.2442, peak_ms=5.64, core_commit=OTHER_COMMIT))
        self.assertEqual(code, 3)
        self.assertEqual(last, 'VERDICT: DESKTOP-ONLY')
        run = payload['classes']['phone']['runs'][0]
        self.assertTrue(run['core_commit_accepted'])
        self.assertIn('cross-commit rule', ' '.join(payload['reasons']))
        self.assertEqual(payload['classes']['phone']['problems'], [])

    def test_a_different_commit_is_refused_when_the_trace_differs(self):
        # Same mismatch, but the trace is not the reference one: the exception does not apply, and
        # the JSON is discarded before any verdict -- not averaged in, not called NO-GO.
        self.recorded_sha1(trace())
        payload = self.assert_input_error(
            '--phone', *self.repeats(3, trace_flip=17, core_commit=OTHER_COMMIT))
        self.assertIn('core_commit', ' '.join(payload['reasons']))

    def test_a_different_commit_is_refused_when_the_trace_hashes_to_another_value(self):
        # Identical cells, but the trace does not hash to the recorded value: this is the state a
        # JSON from an unrelated core would produce, and it stays an input error.
        payload = self.assert_input_error(
            '--phone', *self.repeats(3, mean_ms=2.0, core_commit=OTHER_COMMIT))
        self.assertIn('core_commit', ' '.join(payload['reasons']))

    # --- input errors (exit 2) --------------------------------------------

    def assert_input_error(self, *args):
        code, last, payload = self.verdict(*args)
        self.assertEqual(code, 2)
        self.assertEqual(last, 'VERDICT: INPUT-ERROR')
        return payload

    def test_no_results_at_all_is_an_input_error(self):
        self.assert_input_error()

    def test_two_repeats_are_an_input_error(self):
        self.assert_input_error('--phone', *self.repeats(2, mean_ms=2.0))

    def test_a_failed_run_is_an_input_error(self):
        payload = self.assert_input_error('--phone', *self.repeats(3, exit_code=1))
        self.assertIn('exit_code', ' '.join(payload['reasons']))

    def test_the_wrong_frame_count_is_an_input_error(self):
        payload = self.assert_input_error('--phone', *self.repeats(3, frames=1200))
        self.assertIn('frames', ' '.join(payload['reasons']))

    def test_the_wrong_disc_is_an_input_error(self):
        payload = self.assert_input_error('--phone', *self.repeats(3, iso_bytes=1))
        self.assertIn('iso_bytes', ' '.join(payload['reasons']))

    def test_a_run_that_did_not_reach_the_match_is_an_input_error(self):
        payload = self.assert_input_error(
            '--phone', *self.repeats(3, final_scene='final scene: mode=0 state=1'))
        self.assertIn('final_scene', ' '.join(payload['reasons']))

    def test_a_commit_that_is_not_the_reference_is_an_input_error(self):
        # The synthetic trace does not hash to the recorded reference SHA-1, so C3's cross-commit
        # exception does not apply and the mismatch is refused (see the C3 tests above).
        payload = self.assert_input_error(
            '--phone', *self.repeats(3, core_commit=OTHER_COMMIT))
        self.assertIn('core_commit', ' '.join(payload['reasons']))

    def test_too_few_in_match_rows_is_an_input_error(self):
        payload = self.assert_input_error('--phone', *self.repeats(3, in_match=100))
        self.assertIn('rows', ' '.join(payload['reasons']))

    def test_statistics_that_disagree_with_the_csv_are_an_input_error(self):
        declared = {'count': 762, 'mean_ms': 1.0, 'p95_ms': 1.0, 'p99_ms': 1.0, 'max_ms': 1.0}
        payload = self.assert_input_error('--phone', *self.repeats(3, declared=declared))
        self.assertIn('mean_ms', ' '.join(payload['reasons']))

    def test_a_run_whose_frames_do_not_fit_the_wall_clock_is_an_input_error(self):
        payload = self.assert_input_error('--phone', *self.repeats(3, wall_ms=100.0))
        self.assertIn('wall clock', ' '.join(payload['reasons']))

    def test_a_suspended_tab_is_an_input_error(self):
        payload = self.assert_input_error('--phone', *self.repeats(3, peak_ms=5000.0))
        self.assertIn('suspension', ' '.join(payload['reasons']))

    def test_a_missing_reference_is_an_input_error(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = go_no_go.run(['--reference', str(self.tmp / 'nope.csv'),
                                 '--reference-commit', COMMIT,
                                 '--phone', *self.repeats(3, mean_ms=2.0)])
        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue().strip().splitlines()[-1], 'VERDICT: INPUT-ERROR')

    def test_a_short_proof_run_is_judged_on_the_prefix_not_the_full_scene(self):
        runs = [self.result(f'run{index}.json', mean_ms=2.0, frames=60, in_match=30,
                            final_scene='final scene: mode=2 state=2 match_frame=12 (retraces=60)')
                for index in range(3)]
        code, last, payload = self.verdict('--phone', *runs)
        # The 60-frame run passes C1 and C4 -- the full final scene belongs to the 2400-frame run --
        # but 30 in-match rows is under MIN_IN_MATCH_ROWS, so it is refused rather than averaged
        # in: the short proof is for the page, not for a verdict.
        self.assertEqual(code, 2)
        self.assertEqual(last, 'VERDICT: INPUT-ERROR')
        reasons = ' '.join(payload['reasons'])
        self.assertIn('rows', reasons)
        self.assertNotIn('final_scene', reasons)
        self.assertNotIn('frames is', reasons)


if __name__ == '__main__':
    unittest.main()
