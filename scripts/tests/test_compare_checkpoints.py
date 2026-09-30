import importlib.util
import io
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'compare_checkpoints', Path(__file__).parents[1] / 'phase0/compare_checkpoints.py')
compare_checkpoints = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare_checkpoints)

HEADER = 'retrace,cpu,ram,aram,events\n'


def write(directory, name, text):
    path = Path(directory) / name
    path.write_text(text)
    return str(path)


def trace(rows):
    return HEADER + ''.join(
        f'{retrace},{cpu},{ram},{aram},{events}\n'
        for retrace, cpu, ram, aram, events in rows)


ROWS = [
    (1, 'A2A2D2B62D5DA601', '9BF7DAC743487597', '5FF605A57EAE5AC2', '0000000000000000'),
    (2, '0575E817F566F39D', '2CB3C8B0B1519A70', '5FF605A57EAE5AC2', '0000000000000000'),
    (3, 'C33459EF1CBD9D93', '81A6D4BE8E6D9821', '5FF605A57EAE5AC2', '0000000000000000'),
]


class CompareCheckpointsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = self._tmp.name

    def run_main(self, left, right):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = compare_checkpoints.main(['compare_checkpoints.py', left, right])
        return status, out.getvalue(), err.getvalue()

    def test_identical_traces(self):
        left = write(self.tmp, 'a.csv', trace(ROWS))
        right = write(self.tmp, 'b.csv', trace(ROWS))
        status, out, _ = self.run_main(left, right)
        self.assertEqual(status, 0)
        self.assertIn('identical', out)

    def test_one_cell_changed_reports_the_first_difference(self):
        changed = list(ROWS)
        changed[1] = (2, '0575E817F566F39D', 'FFFFFFFFFFFFFFFF', '5FF605A57EAE5AC2', '0000000000000000')
        left = write(self.tmp, 'a.csv', trace(ROWS))
        right = write(self.tmp, 'b.csv', trace(changed))
        status, out, _ = self.run_main(left, right)
        self.assertEqual(status, 1)
        self.assertIn('retrace 2 column ram', out)
        self.assertIn('2CB3C8B0B1519A70 != FFFFFFFFFFFFFFFF', out)

    def test_truncated_trace_is_a_difference(self):
        left = write(self.tmp, 'a.csv', trace(ROWS))
        right = write(self.tmp, 'b.csv', trace(ROWS[:2]))
        result = compare_checkpoints.compare(left, right)
        self.assertFalse(result['identical'])
        self.assertEqual(result['differences'], 1)
        self.assertIsNone(result['first_difference'])  # no cell differs; the count does
        status, out, _ = self.run_main(left, right)
        self.assertEqual(status, 1)
        self.assertIn('row counts do (3 vs 2)', out)

    def test_wrong_header_is_an_input_error(self):
        left = write(self.tmp, 'a.csv', 'frame,cpu\n1,AA\n')
        right = write(self.tmp, 'b.csv', trace(ROWS))
        status, _, err = self.run_main(left, right)
        self.assertEqual(status, 2)
        self.assertIn('expected', err)

    def test_short_row_is_an_input_error(self):
        left = write(self.tmp, 'a.csv', HEADER + '1,AA,BB\n')
        right = write(self.tmp, 'b.csv', trace(ROWS))
        status, _, err = self.run_main(left, right)
        self.assertEqual(status, 2)
        self.assertIn('3 columns', err)

    def test_missing_file_is_an_input_error(self):
        right = write(self.tmp, 'b.csv', trace(ROWS))
        status, _, err = self.run_main(str(Path(self.tmp) / 'nope.csv'), right)
        self.assertEqual(status, 2)
        self.assertIn('nope.csv', err)

    def test_empty_file_is_an_input_error(self):
        left = write(self.tmp, 'a.csv', '')
        right = write(self.tmp, 'b.csv', trace(ROWS))
        status, _, err = self.run_main(left, right)
        self.assertEqual(status, 2)
        self.assertIn('empty file', err)

    def test_usage_without_two_arguments(self):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            status = compare_checkpoints.main(['compare_checkpoints.py'])
        self.assertEqual(status, 2)
        self.assertIn('usage', err.getvalue())


if __name__ == '__main__':
    unittest.main()
