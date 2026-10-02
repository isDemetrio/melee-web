#!/usr/bin/env python3
"""Generate a tiny synthetic GameCube disc; no copyrighted bytes or binary fixture.

Run with OUTPUT to generate it, or --test for the parser/verifier/extractor tests.
Tests live here to keep T8 changes inside the requested file allowlist.
"""
import argparse
import hashlib
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from disc.gcdisc import DiscError, read_disc
from extract_fs import extract_fs
import verify_iso

PAYLOADS = {'root.dat': b'synthetic root\n', 'audio/tone.hps': b'fake audio' * 17,
            'audio/nested/empty': b'', 'tail.dat': b'end'}


def make_fake_disc(path):
    """Write an image and return independently recorded (path, offset, size) tuples."""
    image = bytearray(0x3000)
    image[:6] = b'GALE01'
    image[7] = 2
    struct.pack_into('>I', image, 0x1c, 0xc2339f3d)
    names = bytearray(b'\0')
    records = [(0x01000000, 0, 7)]
    expected = []
    cursor = 0x2000
    layout = [('root.dat', None), ('audio', (0, 6)), ('audio/tone.hps', None),
              ('audio/nested', (2, 6)), ('audio/nested/empty', None), ('tail.dat', None)]
    for name, directory in layout:
        name_offset = len(names)
        names.extend(name.rsplit('/', 1)[-1].encode('ascii') + b'\0')
        if directory:
            records.append((0x01000000 | name_offset, *directory))
        else:
            payload = PAYLOADS[name]
            records.append((name_offset, cursor, len(payload)))
            expected.append((name, cursor, len(payload)))
            image[cursor:cursor + len(payload)] = payload
            cursor += (len(payload) + 31) // 32 * 32
    fst = b''.join(struct.pack('>III', *r) for r in records) + names
    struct.pack_into('>III', image, 0x420, 0x800, 0x1000, len(fst))
    image[0x1000:0x1000 + len(fst)] = fst
    Path(path).write_bytes(image)
    return expected


class DiscTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.iso = self.root / 'fake.iso'
        self.expected = make_fake_disc(self.iso)

    def mutate(self, offset, data):
        with self.iso.open('r+b') as stream:
            stream.seek(offset)
            stream.write(data)

    def test_round_trip_and_extraction(self):
        header, entries = read_disc(self.iso)
        self.assertEqual((header.game_id, header.revision, header.dol_offset), ('GALE01', 2, 0x800))
        self.assertEqual([(e.path, e.offset, e.size) for e in entries], self.expected)
        out = self.root / 'assets-extracted'
        extract_fs(self.iso, out)
        actual = {p.relative_to(out / 'files').as_posix(): p.read_bytes()
                  for p in out.rglob('*') if p.is_file()}
        self.assertEqual(actual, PAYLOADS)
        with self.assertRaises(FileExistsError):
            extract_fs(self.iso, out)

    def test_verification(self):
        with self.assertRaisesRegex(DiscError, 'wrong size'):
            verify_iso.verify_iso(self.iso)
        # Only test expectations are patched; production CLI has no bypass flags.
        digest = hashlib.sha1(self.iso.read_bytes()).hexdigest()
        with patch.object(verify_iso, 'EXPECTED_SIZE', self.iso.stat().st_size), patch.object(verify_iso, 'EXPECTED_SHA1', digest):
            verify_iso.verify_iso(self.iso)
            self.mutate(0, b'XXXXXX')
            with self.assertRaisesRegex(DiscError, 'game id'):
                verify_iso.verify_iso(self.iso)
            self.mutate(0, b'GALE01')
            self.mutate(7, b'\x01')
            with self.assertRaisesRegex(DiscError, 'revision'):
                verify_iso.verify_iso(self.iso)
            self.mutate(7, b'\x02')
            self.mutate(0x2000, b'!')
            with self.assertRaisesRegex(DiscError, 'SHA-1'):
                verify_iso.verify_iso(self.iso)

    def test_invalid_structures(self):
        cases = [(0x1c, b'\0' * 4, 'magic'),
                 (0x428, struct.pack('>I', 0xffffffff), 'FST range'),
                 (0x1008, struct.pack('>I', 0xffffffff), 'root'),
                 (0x1010, struct.pack('>I', 0xffffffff), 'file range'),
                 (0x101c, struct.pack('>I', 1), 'directory'),
                 (0x100c, struct.pack('>I', 0xffffff), 'entry'),
                 (0x1000 + 7 * 12 + 1, b'../x.dat', 'unsafe')]
        for offset, data, message in cases:
            with self.subTest(message=message):
                make_fake_disc(self.iso)
                self.mutate(offset, data)
                with self.assertRaisesRegex(DiscError, message):
                    read_disc(self.iso)

    def test_truncated_header(self):
        self.iso.write_bytes(b'GALE01')
        with self.assertRaisesRegex(DiscError, 'truncated'):
            read_disc(self.iso)


if __name__ == '__main__':
    if sys.argv[1:] == ['--test']:
        unittest.main(argv=[sys.argv[0]])
    else:
        parser = argparse.ArgumentParser(description=__doc__)
        parser.add_argument('output', type=Path)
        print(make_fake_disc(parser.parse_args().output))
