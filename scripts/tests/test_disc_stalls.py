import importlib.util
import io
import json
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'disc_stalls', Path(__file__).parents[1] / 'analysis/disc_stalls.py')
disc_stalls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disc_stalls)

HEADER = 'retrace,match_frame,cycle_ms,core_ms,disc_ms,disc_bytes'


def report(rows, notes=()):
    """A synthetic report: only the columns the script reads, timing and byte counts, no game data."""
    return {'schema': 'melee-play-report/1', 'core_commit': 'x', 'notes': list(notes),
            'frames_csv': '\n'.join([HEADER, *(','.join(str(cell) for cell in row) for row in rows)]) + '\n'}


class DiscStallsTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def run_main(self, data):
        path = Path(self._tmp.name) / 'report.json'
        path.write_text(json.dumps(data))
        out = io.StringIO()
        with redirect_stdout(out):
            status = disc_stalls.main(['disc_stalls.py', str(path)])
        return status, out.getvalue()

    def test_gap_is_measured_from_the_last_reading_frame(self):
        # Frame 1 reads; 2 and 3 do not (100 ms each); frame 4 reads 1055 bytes in 1000 ms.
        rows = [(1, 0, 50, 40, 5, 17407), (2, 0, 100, 90, 0, 0), (3, 0, 100, 90, 0, 0), (4, 97, 1050, 1040, 1000, 1055)]
        frames = disc_stalls.disc_frames(report(rows))
        self.assertEqual([frame[0] for frame in frames], [1, 4])
        self.assertIsNone(frames[0][5])
        # Frame 4 starts at 250 ms; frame 1's core part ended at 40 ms.
        self.assertAlmostEqual(frames[1][5], 0.21)

    def test_a_stall_fails_and_is_bucketed_by_gap(self):
        rows = [(1, 0, 50, 40, 5, 17407), (2, 0, 2500, 2490, 0, 0), (3, 97, 1050, 1040, 1000, 1055),
                (4, 98, 20, 18, 2, 17407)]
        status, out = self.run_main(report(rows))
        self.assertEqual(status, 1)
        self.assertIn('retrace 3 match_frame 97: 1000.0 ms for 1055 bytes', out)
        self.assertIn('gap 2 s or more: 1 reading frames, 1 slow', out)
        self.assertIn('gap under 1 s: 1 reading frames, 0 slow', out)
        self.assertIn('before the OPFS handle', out)

    def test_no_stall_passes_and_names_the_read_path(self):
        rows = [(1, 0, 50, 40, 5, 17407), (2, 0, 2500, 2490, 0, 0), (3, 97, 30, 25, 0.02, 1055)]
        status, out = self.run_main(report(rows, ['disc read through an OPFS sync access handle']))
        self.assertEqual(status, 0)
        self.assertIn('0 took 250 ms or more', out)
        self.assertIn('disc read through an OPFS sync access handle', out)

    def test_refuses_a_file_that_is_not_a_play_report(self):
        status, _ = self.run_main({'schema': 'something-else'})
        self.assertEqual(status, 2)


if __name__ == '__main__':
    unittest.main()
