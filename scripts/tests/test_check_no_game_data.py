#!/usr/bin/env python3
"""Tests for scripts/check_no_game_data.py.

Run with:  python -m unittest discover -s scripts/tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from check_no_game_data import (  # noqa: E402
    find_violations,
    MAX_FILE_BYTES,
)


class FindViolationsTest(unittest.TestCase):
    def test_clean_tree_has_no_violations(self) -> None:
        paths = [
            "README.md",
            "web/src/main.ts",
            "docs/PROGRESS.md",
            "scripts/check_no_game_data.py",
            "upstream/melee-unlocked",
        ]
        self.assertEqual(find_violations(paths, sizes={}), [])

    def test_rejects_disc_images_and_dol(self) -> None:
        paths = ["private/melee.iso", "build/main.dol", "rip/GameCube.gcm", "x/y.rvz"]
        reasons = {v.path for v in find_violations(paths, sizes={})}
        self.assertEqual(reasons, set(paths))

    def test_rejects_generated_recompiler_output_under_any_name(self) -> None:
        paths = [
            "port/generated/functions.h",
            "upstream/melee-unlocked/port/generated/guest_000.cpp",
            "upstream/melee-unlocked/port/generated.before-pal/functions.h",
        ]
        violations = find_violations(paths, sizes={})
        self.assertEqual(len(violations), len(paths))

    def test_rejects_native_build_output_and_wasm(self) -> None:
        paths = ["build/melee_port.exe", "out/melee.wasm", "lib/runtime.a", "x.obj"]
        self.assertEqual(len(find_violations(paths, sizes={})), len(paths))

    def test_rejects_secret_files(self) -> None:
        paths = [".dev.vars", "functions/.env", "web/.env.local"]
        violations = find_violations(paths, sizes={})
        self.assertEqual(len(violations), 3)
        self.assertTrue(all("secret" in v.reason for v in violations))

    def test_rejects_oversized_files_but_allows_the_boundary(self) -> None:
        paths = ["big.bin", "exactly-at-limit.bin"]
        sizes = {"big.bin": MAX_FILE_BYTES + 1, "exactly-at-limit.bin": MAX_FILE_BYTES}
        violations = find_violations(paths, sizes=sizes)
        self.assertEqual([v.path for v in violations], ["big.bin"])

    def test_case_insensitive_extension_match(self) -> None:
        self.assertEqual(len(find_violations(["Melee.ISO"], sizes={})), 1)


if __name__ == "__main__":
    unittest.main()
