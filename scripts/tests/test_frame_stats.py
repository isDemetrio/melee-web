import importlib.util
import io
import json
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'frame_stats', Path(__file__).parents[1] / 'phase0/frame_stats.py')
frame_stats = importlib.util.module_from_spec(spec)
spec.loader.exec_module(frame_stats)


class FrameStatsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name

    def write(self, text, name='durations.csv'):
        path = Path(self.tmp) / name
        path.write_text(text)
        return str(path)

    def run_main(self, path):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = frame_stats.main(['frame_stats.py', path])
        return status, out.getvalue(), err.getvalue()

    def test_known_answer_percentiles_are_nearest_rank(self):
        # 1..100 ascending: p95 is the 95th value, p99 the 99th, and both actually occurred.
        durations = [float(value) for value in range(1, 101)]
        result = frame_stats.stats(durations)
        self.assertEqual(result['count'], 100)
        self.assertEqual(result['p95_ms'], 95.0)
        self.assertEqual(result['p99_ms'], 99.0)
        self.assertEqual(result['max_ms'], 100.0)
        self.assertEqual(result['slowest_index'], 99)
        self.assertEqual(result['percentile'], 'nearest-rank')
        self.assertAlmostEqual(result['mean_ms'], 50.5)

    def test_nearest_rank_is_never_an_interpolation(self):
        # 1..10: p95 must be a value from the list, not 9.55.
        result = frame_stats.stats([float(value) for value in range(1, 11)])
        self.assertEqual(result['p95_ms'], 10.0)
        self.assertEqual(result['p99_ms'], 10.0)

    def test_slowest_index_points_at_the_maximum(self):
        result = frame_stats.stats([3.0, 9.5, 1.0, 4.0])
        self.assertEqual(result['slowest_index'], 1)
        self.assertEqual(result['max_ms'], 9.5)

    def test_headerless_one_per_line(self):
        self.assertEqual(frame_stats.parse_durations('1.5\n2.5\n\n3.0\n'), [1.5, 2.5, 3.0])

    def test_named_column_wins_over_the_last(self):
        text = 'frame,sim_ms,other\n1,10,99\n2,20,98\n'
        self.assertEqual(frame_stats.parse_durations(text), [10.0, 20.0])

    def test_header_without_sim_ms_uses_the_last_column(self):
        text = 'frame,ms\n1,10\n2,20\n'
        self.assertEqual(frame_stats.parse_durations(text), [10.0, 20.0])

    def test_whitespace_is_tolerated(self):
        self.assertEqual(frame_stats.parse_durations(' 1.5 \n 2.5\n'), [1.5, 2.5])

    def test_not_numeric_is_an_error(self):
        with self.assertRaises(ValueError):
            frame_stats.parse_durations('1.5\nlater\n')

    def test_empty_is_an_error(self):
        with self.assertRaises(ValueError):
            frame_stats.parse_durations('\n\n')

    def test_main_prints_json_and_exits_zero(self):
        path = self.write('1.0\n2.0\n3.0\n')
        status, out, _ = self.run_main(path)
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(out)['count'], 3)

    def test_main_on_a_bad_value_exits_two(self):
        path = self.write('sim_ms\n1.0\nnot a number\n')
        status, _, err = self.run_main(path)
        self.assertEqual(status, 2)
        self.assertIn('not a number', err)

    def test_main_on_a_single_junk_line_exits_two(self):
        # One non-numeric line is read as a header, so the complaint is that no durations follow.
        path = self.write('not a number\n')
        status, _, err = self.run_main(path)
        self.assertEqual(status, 2)
        self.assertIn('no durations', err)

    def test_main_on_a_missing_file_exits_two(self):
        status, _, err = self.run_main(str(Path(self.tmp) / 'nope.csv'))
        self.assertEqual(status, 2)
        self.assertIn('nope.csv', err)

    # --in-match: the runtime's --sim-times CSV, filtered to the frames of a real match.

    SIM_TIMES = 'retrace,sim_ms,match_frame\n1,5.0,0\n2,6.0,0\n3,7.0,1\n4,8.0,2\n5,9.0,3\n'

    def test_in_match_keeps_only_positive_match_frame(self):
        self.assertEqual(frame_stats.parse_durations(self.SIM_TIMES, in_match=True), [7.0, 8.0, 9.0])

    def test_without_in_match_the_whole_file_is_measured(self):
        self.assertEqual(frame_stats.parse_durations(self.SIM_TIMES), [5.0, 6.0, 7.0, 8.0, 9.0])

    def test_in_match_without_the_column_is_an_error(self):
        with self.assertRaises(ValueError) as raised:
            frame_stats.parse_durations('frame,sim_ms\n1,5.0\n', in_match=True)
        self.assertIn('no match_frame column', str(raised.exception))

    def test_in_match_without_a_header_is_an_error(self):
        with self.assertRaises(ValueError) as raised:
            frame_stats.parse_durations('5.0\n6.0\n', in_match=True)
        self.assertIn('no match_frame column', str(raised.exception))

    def test_in_match_with_no_match_frames_is_an_error(self):
        with self.assertRaises(ValueError) as raised:
            frame_stats.parse_durations('retrace,sim_ms,match_frame\n1,5.0,0\n2,6.0,0\n', in_match=True)
        self.assertIn('no in-match rows', str(raised.exception))

    def test_in_match_rejects_a_non_numeric_match_frame(self):
        with self.assertRaises(ValueError) as raised:
            frame_stats.parse_durations('retrace,sim_ms,match_frame\n1,5.0,later\n', in_match=True)
        self.assertIn('not a match frame', str(raised.exception))

    def test_main_in_match_flag_reports_rows(self):
        path = self.write(self.SIM_TIMES)
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = frame_stats.main(['frame_stats.py', '--in-match', path])
        self.assertEqual(status, 0)
        result = json.loads(out.getvalue())
        self.assertEqual(result['rows'], 'in-match')
        self.assertEqual(result['count'], 3)

    def test_main_without_the_flag_reports_all_rows(self):
        path = self.write(self.SIM_TIMES)
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = frame_stats.main(['frame_stats.py', path])
        self.assertEqual(status, 0)
        self.assertEqual(json.loads(out.getvalue())['rows'], 'all')


if __name__ == '__main__':
    unittest.main()
