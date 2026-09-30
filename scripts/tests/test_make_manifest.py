#!/usr/bin/env python3
"""Tests for scripts/make_manifest.py.

Run with:  python -m unittest discover -s scripts/tests -v

Everything runs against synthetic trees in a temporary directory: no disc, no ISO, no
game data, and no compiler.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from make_manifest import (  # noqa: E402
    DEFAULT_SCHEMA,
    ManifestError,
    check_invariants,
    gzip_bytes,
    load_group_rules,
    main,
    sha256_bytes,
    validate,
)

SCHEMA = json.loads(DEFAULT_SCHEMA.read_text(encoding="utf-8"))

# Highly compressible, and 4 KB of data that DEFLATE cannot shrink by 5%. Repeating one
# random block would not do: DEFLATE matches the repetition and shrinks it by ~99%, so the
# test would assert the gzip branch while claiming to test the identity one. Distinct blocks
# give the compressor nothing to match.
COMPRESSIBLE = b"GALE01" * 2048
INCOMPRESSIBLE = b"".join(hashlib.sha256(f"seed{index}".encode()).digest() for index in range(128))


def write_tree(root: Path, files: dict[str, bytes]) -> None:
    for name, payload in files.items():
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(payload)


class ManifestTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.assets = self.tmp / "assets-extracted"
        self.assets.mkdir()
        self.out = self.tmp / "assets" / "manifest.json"

    def build(self, *extra: str, assets: Path | None = None, out: Path | None = None) -> int:
        arguments = [
            "--assets", str(assets or self.assets),
            "--out", str(out or self.out),
            *extra,
        ]
        return main(arguments)

    def manifest(self, path: Path | None = None) -> dict:
        return json.loads((path or self.out).read_text(encoding="utf-8"))

    def entries(self, path: Path | None = None) -> dict[str, dict]:
        return {entry["path"]: entry for entry in self.manifest(path)["entries"]}


class DeterminismTest(ManifestTestCase):
    def test_two_runs_over_the_same_tree_are_byte_identical(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE, "files/audio/x.hps": INCOMPRESSIBLE})
        first, second = self.tmp / "one.json", self.tmp / "two.json"
        self.assertEqual(self.build("--no-store", out=first), 0)
        self.assertEqual(self.build("--no-store", out=second), 0)
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_output_is_sorted_ascii_json_with_a_trailing_newline(self) -> None:
        write_tree(self.assets, {"files/b.dat": b"b", "files/a.dat": b"a", "files/ü.dat": b"u"})
        self.assertEqual(self.build("--no-store"), 0)
        text = self.out.read_text(encoding="utf-8")
        self.assertTrue(text.endswith("}\n"))
        self.assertEqual(text, json.dumps(json.loads(text), sort_keys=True, indent=2, ensure_ascii=True) + "\n")
        self.assertNotIn("ü", text, "non-ASCII path must be escaped, not locale-dependent")
        paths = [entry["path"] for entry in self.manifest()["entries"]]
        self.assertEqual(paths, sorted(paths))

    def test_no_timestamp_unless_one_is_asked_for(self) -> None:
        write_tree(self.assets, {"files/a.dat": b"a"})
        self.assertEqual(self.build("--no-store"), 0)
        self.assertEqual(self.manifest()["generatedAt"], "")
        stamped = self.tmp / "stamped.json"
        self.assertEqual(self.build("--no-store", "--generated-at", "2026-09-30T01:00:00Z", "--base-url", "https://assets.test", out=stamped), 0)
        manifest = self.manifest(stamped)
        self.assertEqual(manifest["generatedAt"], "2026-09-30T01:00:00Z")
        self.assertEqual(manifest["baseUrl"], "https://assets.test")
        self.assertEqual(manifest["version"], "1")

    def test_gzip_stream_is_reproducible_and_valid(self) -> None:
        self.assertEqual(gzip_bytes(COMPRESSIBLE), gzip_bytes(COMPRESSIBLE))
        self.assertEqual(gzip.decompress(gzip_bytes(COMPRESSIBLE)), COMPRESSIBLE)
        # mtime and OS bytes are pinned, so the same bytes never produce a different header.
        self.assertEqual(gzip_bytes(COMPRESSIBLE)[4:10], b"\x00\x00\x00\x00\x00\xff")


class ContentAddressingTest(ManifestTestCase):
    def test_hash_size_and_object_key_describe_the_uncompressed_bytes(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE, "files/audio/x.hps": INCOMPRESSIBLE})
        self.assertEqual(self.build(), 0)
        for path, entry in self.entries().items():
            raw = (self.assets / path).read_bytes()
            self.assertEqual(entry["sha256"], sha256_bytes(raw))
            self.assertEqual(entry["size"], len(raw))
            self.assertEqual(entry["stored"], entry["sha256"] + ".bin")

    def test_gzip_is_used_only_when_it_shrinks_by_at_least_five_percent(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE, "files/audio/x.hps": INCOMPRESSIBLE})
        self.assertEqual(self.build(), 0)
        entries = self.entries()
        self.assertEqual(entries["files/a.dat"]["encoding"], "gzip")
        self.assertEqual(entries["files/audio/x.hps"]["encoding"], "identity")

    def test_stored_blobs_decode_to_the_source_bytes(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE, "files/audio/x.hps": INCOMPRESSIBLE})
        self.assertEqual(self.build(), 0)
        store = self.tmp / "assets" / "store"
        for path, entry in self.entries().items():
            blob = (store / entry["stored"]).read_bytes()
            if entry["encoding"] == "gzip":
                blob = gzip.decompress(blob)
            self.assertEqual(blob, (self.assets / path).read_bytes())
        self.assertEqual(sorted(p.name for p in store.iterdir()), sorted({e["stored"] for e in self.entries().values()}))

    def test_identical_content_is_stored_once_under_one_key(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE, "files/copy.dat": COMPRESSIBLE})
        self.assertEqual(self.build(), 0)
        entries = self.entries()
        self.assertEqual(entries["files/a.dat"]["stored"], entries["files/copy.dat"]["stored"])
        self.assertEqual(len(list((self.tmp / "assets" / "store").iterdir())), 1)

    def test_no_store_switch_writes_only_the_manifest(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE})
        self.assertEqual(self.build("--no-store"), 0)
        self.assertTrue(self.out.is_file())
        self.assertFalse((self.tmp / "assets" / "store").exists())

    def test_store_can_be_placed_explicitly(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE})
        store = self.tmp / "elsewhere"
        self.assertEqual(self.build("--store", str(store)), 0)
        self.assertEqual(len(list(store.iterdir())), 1)


class GroupRulesTest(ManifestTestCase):
    def test_unmatched_files_take_the_default_group(self) -> None:
        # `files/a.dat` is claimed by the shipped `files/*.dat` rule, so it is not the
        # unmatched case. Use a name no shipped rule matches.
        write_tree(self.assets, {"files/unknown.bin": b"u"})
        self.assertEqual(self.build("--no-store"), 0)
        self.assertEqual(self.entries()["files/unknown.bin"]["group"], "other")

    def test_rules_come_from_the_file_and_first_match_wins(self) -> None:
        write_tree(self.assets, {"files/opening.bnr": b"m", "files/other.dat": b"o"})
        rules = self.tmp / "rules.json"
        rules.write_text(
            json.dumps(
                {
                    "default": "other",
                    "rules": [
                        {"glob": "files/*.bnr", "group": "movies"},
                        {"glob": "files/*", "group": "boot"},
                    ],
                }
            ),
            encoding="utf-8",
        )
        self.assertEqual(self.build("--no-store", "--groups", str(rules)), 0)
        entries = self.entries()
        self.assertEqual(entries["files/opening.bnr"]["group"], "movies")
        self.assertEqual(entries["files/other.dat"]["group"], "boot")

    def test_regex_rule_substitutes_a_named_capture(self) -> None:
        write_tree(self.assets, {"files/PlFx.dat": b"p", "files/GrSh.dat": b"g"})
        rules = self.tmp / "rules.json"
        rules.write_text(
            json.dumps(
                {
                    "default": "other",
                    "rules": [
                        {"regex": r"files/Pl(?P<name>[A-Za-z]{2})\.dat$", "group": "character:{name}"},
                        {"regex": r"files/Gr(?P<name>[A-Za-z0-9]{2})\.dat$", "group": "stage:{name}"},
                    ],
                }
            ),
            encoding="utf-8",
        )
        self.assertEqual(self.build("--no-store", "--groups", str(rules)), 0)
        entries = self.entries()
        self.assertEqual(entries["files/PlFx.dat"]["group"], "character:Fx")
        self.assertEqual(entries["files/GrSh.dat"]["group"], "stage:Sh")

    def test_shipped_rules_classify_the_paths_the_plan_expects(self) -> None:
        write_tree(
            self.assets,
            {
                "files/opening.bnr": b"m",
                "files/audio/us/12.hps": b"a",
                "files/PlFx.dat": b"p",
                "files/GrSh.dat": b"g",
                "files/GmMenu.dat": b"n",
                "files/unknown.bin": b"u",
            },
        )
        self.assertEqual(self.build("--no-store"), 0)
        entries = self.entries()
        self.assertEqual(entries["files/opening.bnr"]["group"], "movies")
        self.assertEqual(entries["files/audio/us/12.hps"]["group"], "music")
        self.assertEqual(entries["files/PlFx.dat"]["group"], "character:Fx")
        self.assertEqual(entries["files/GrSh.dat"]["group"], "stage:Sh")
        self.assertEqual(entries["files/GmMenu.dat"]["group"], "menu")
        self.assertEqual(entries["files/unknown.bin"]["group"], "other")

    def test_invalid_group_string_is_rejected(self) -> None:
        write_tree(self.assets, {"files/a.dat": b"a"})
        rules = self.tmp / "rules.json"
        rules.write_text(json.dumps({"default": "other", "rules": [{"glob": "*", "group": "characters"}]}), encoding="utf-8")
        self.assertEqual(self.build("--no-store", "--groups", str(rules)), 1)

    def test_rule_needs_exactly_one_matcher_and_a_known_capture(self) -> None:
        for rule in ({"glob": "*"}, {"glob": "*", "regex": ".*", "group": "boot"},
                     {"regex": r"(?P<name>x)", "group": "stage:{missing}"}):
            rules = self.tmp / "rules.json"
            rules.write_text(json.dumps({"default": "other", "rules": [rule]}), encoding="utf-8")
            with self.assertRaises(ManifestError):
                load_group_rules(rules)


class TreeTest(ManifestTestCase):
    def test_nested_paths_use_posix_separators(self) -> None:
        write_tree(self.assets, {"files/audio/us/12.hps": b"a"})
        self.assertEqual(self.build("--no-store"), 0)
        self.assertEqual([entry["path"] for entry in self.manifest()["entries"]], ["files/audio/us/12.hps"])

    def test_empty_tree_yields_an_empty_entry_list(self) -> None:
        self.assertEqual(self.build("--no-store"), 0)
        self.assertEqual(self.manifest()["entries"], [])

    def test_missing_asset_directory_fails(self) -> None:
        self.assertEqual(self.build("--no-store", assets=self.tmp / "absent"), 1)

    def test_symlinked_file_is_refused(self) -> None:
        write_tree(self.assets, {"files/a.dat": b"a"})
        os.symlink(self.assets / "files/a.dat", self.assets / "files/link.dat")
        self.assertEqual(self.build("--no-store"), 1)

    def test_symlinked_directory_is_refused(self) -> None:
        write_tree(self.assets, {"files/a.dat": b"a"})
        os.symlink(self.assets / "files", self.assets / "elsewhere")
        self.assertEqual(self.build("--no-store"), 1)


class CheckModeTest(ManifestTestCase):
    def test_generated_manifest_validates_against_the_shipped_schema(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE})
        self.assertEqual(self.build(), 0)
        manifest = self.manifest()
        self.assertEqual(validate(manifest, SCHEMA), [])
        self.assertEqual(check_invariants(manifest), [])
        self.assertEqual(main(["--check", str(self.out)]), 0)

    def test_check_rejects_a_tampered_manifest(self) -> None:
        write_tree(self.assets, {"files/a.dat": COMPRESSIBLE})
        self.assertEqual(self.build(), 0)
        good = self.manifest()
        tampered = {
            "extra key": {"version": "1", "generatedAt": "", "baseUrl": "", "entries": [], "surprise": 1},
            "bad hash": {**good, "entries": [{**good["entries"][0], "sha256": "abc"}]},
            "bad encoding": {**good, "entries": [{**good["entries"][0], "encoding": "br"}]},
            "missing field": {**good, "entries": [{k: v for k, v in good["entries"][0].items() if k != "group"}]},
            "wrong stored key": {**good, "entries": [{**good["entries"][0], "stored": "0" * 64 + ".bin"}]},
            "duplicate path": {**good, "entries": good["entries"] * 2},
            "wrong size type": {**good, "entries": [{**good["entries"][0], "size": "1"}]},
        }
        for name, manifest in tampered.items():
            path = self.tmp / f"{name.replace(' ', '-')}.json"
            path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.subTest(name=name):
                self.assertEqual(main(["--check", str(path)]), 1, f"{name} should have been rejected")

    def test_check_reports_a_missing_file(self) -> None:
        self.assertEqual(main(["--check", str(self.tmp / "absent.json")]), 1)

    def test_check_reports_malformed_json(self) -> None:
        broken = self.tmp / "broken.json"
        broken.write_text("{not json", encoding="utf-8")
        self.assertEqual(main(["--check", str(broken)]), 1)


if __name__ == "__main__":
    unittest.main()
