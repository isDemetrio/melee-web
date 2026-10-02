"""T8 acceptance, using only a tiny generated disc in a temporary directory."""
import contextlib
import hashlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fixtures import make_fake_disc as fixture
from extract_fs import extract_fs
import make_manifest
import verify_iso


def load_tests(loader, tests, pattern):
    # The generator's existing parser/extraction tests must run in normal discovery.
    tests.addTests(loader.loadTestsFromTestCase(fixture.DiscTests))
    return tests


class DiscAcceptanceTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.iso = self.root / 'fake.iso'
        self.expected = fixture.make_fake_disc(self.iso)
        self.size = self.iso.stat().st_size
        self.digest = hashlib.sha1(self.iso.read_bytes()).hexdigest()

    def verify(self, expected_status, message):
        stdout, stderr = io.StringIO(), io.StringIO()
        # Real hashing/header reads on tiny bytes; no production bypass is added.
        with patch.object(verify_iso, 'EXPECTED_SIZE', self.size), \
                patch.object(verify_iso, 'EXPECTED_SHA1', self.digest), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(verify_iso.main([str(self.iso)]), expected_status)
        self.assertIn(message, stderr.getvalue() if expected_status else stdout.getvalue())
        if expected_status:
            self.assertEqual(stdout.getvalue(), '')

    def mutate(self, offset, data):
        with self.iso.open('r+b') as stream:
            stream.seek(offset)
            stream.write(data)

    def test_verifier_accepts_matching_fixture(self):
        self.verify(0, 'OK:')

    def test_verifier_rejects_wrong_size(self):
        with self.iso.open('ab') as stream:
            stream.write(b'!')
        self.verify(1, 'wrong size')

    def test_verifier_rejects_wrong_hash(self):
        self.mutate(self.expected[0][1], b'!')
        self.verify(1, 'wrong SHA-1')

    def test_verifier_rejects_wrong_game_id(self):
        self.mutate(0, b'XXXXXX')
        self.verify(1, 'wrong game id')

    def test_verifier_rejects_wrong_revision(self):
        self.mutate(7, b'\x01')
        self.verify(1, 'wrong revision')

    def test_fixture_to_manifest_is_deterministic_and_complete(self):
        assets = self.root / 'extracted'
        extract_fs(self.iso, assets)
        outputs = [self.root / name / 'manifest.json' for name in ('one', 'two')]
        for output in outputs:
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(make_manifest.main([
                    '--assets', str(assets), '--out', str(output)]), 0)
        self.assertEqual(outputs[0].read_bytes(), outputs[1].read_bytes())
        raw = outputs[0].read_text()
        manifest = json.loads(raw)
        self.assertEqual(raw, json.dumps(manifest, sort_keys=True, indent=2, ensure_ascii=True) + '\n')
        schema = json.loads(make_manifest.DEFAULT_SCHEMA.read_text())
        self.assertEqual(make_manifest.validate(manifest, schema), [])
        self.assertEqual(make_manifest.check_invariants(manifest), [])
        entries = manifest['entries']
        self.assertEqual([e['path'] for e in entries], sorted('files/' + p for p in fixture.PAYLOADS))
        expected_groups = {'root.dat': 'boot', 'tail.dat': 'boot',
                           'audio/tone.hps': 'music', 'audio/nested/empty': 'music'}
        for entry in entries:
            name = entry['path'].removeprefix('files/')
            payload = fixture.PAYLOADS[name]
            digest = hashlib.sha256(payload).hexdigest()
            self.assertEqual(entry['size'], len(payload))
            self.assertEqual(entry['sha256'], digest)
            self.assertEqual(entry['stored'], digest + '.bin')
            self.assertEqual(entry['group'], expected_groups[name])
            self.assertEqual((outputs[0].parent / 'store' / entry['stored']).read_bytes(),
                             (outputs[1].parent / 'store' / entry['stored']).read_bytes())

    def test_corrected_group_rules_on_synthetic_names(self):
        rules, default = make_manifest.load_group_rules(make_manifest.DEFAULT_GROUPS)
        cases = {'PlFxAJ.dat': 'character:Fx', 'PlKbBuCpDk.dat': 'character:Kb',
                 'PlCaRe.usd': 'character:Ca', 'GrEF1.dat': 'stage:EF1',
                 'GrTCa.dat': 'stage:TCa', 'GrPs1.dat': 'stage:Ps',
                 'GrPs4.dat': 'stage:Ps', 'GrPs.usd': 'stage:Ps',
                 'SdMenu.dat': 'menu', 'TyMnView.usd': 'menu',
                 'GmPause.usd': 'menu', 'MnSlChr.usd': 'menu',
                 'MvOpen.mth': 'movies', 'IfAll.usd': 'boot', 'usa.ini': 'other'}
        for name, group in cases.items():
            with self.subTest(name=name):
                self.assertEqual(make_manifest.group_for('files/' + name, rules, default), group)
