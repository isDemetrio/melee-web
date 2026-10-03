"""Tests for `scripts/phase0/compare_wasm_arch.py`.

Why this file exists: the arm64 job in `.github/workflows/wasm-probe.yml` runs the module
the x86 job built on a second architecture and compares the two digests of the FMA corpus.
That comparison is the browser-to-browser determinism question (`wasm/README.md`, "Next
measurements" 2; `docs/OPEN_QUESTIONS.md` Q7), and it is the only place in CI where the
answer is decided. What it must never do is pass when the two digests differ, or when the
two runs used different engines: either would report a parity that was not measured.

The cases below are the ones that decide that. Identical digests pass and say so; one
flipped hex digit fails and says the architectures differ; the same digests under two Node
versions are refused, because then the comparison is between two engines and not between
two architectures; a digest that is not 64 hex characters is refused rather than compared;
and the report names both digests, the engine and the reference, so a reader can check the
claim without the run.
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "compare_wasm_arch", Path(__file__).parents[1] / "phase0/compare_wasm_arch.py")
compare_wasm_arch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(compare_wasm_arch)

X86_DIGEST = "1f" * 32
ARM64_DIGEST = "2e" * 32
NATIVE_DIGEST = "3d" * 32


class Base(unittest.TestCase):
    def setUp(self):
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.root = Path(holder.name)

    def write(self, name, text):
        path = self.root / name
        path.write_text(text)
        return path

    def inputs(self, x86_digest=X86_DIGEST, arm64_digest=ARM64_DIGEST,
               x86_node="v22.20.0", arm64_node="v22.20.0"):
        measured = {"fmadd_ns_per_op": 21.256, "ld32_st32_ns_per_roundtrip": 1.0}
        # The shape the workflow writes: the engine version at the top level and the
        # measurement under "wasm", which is the sub-object the script compares.
        x86_bench = {"node": x86_node, "wasm": measured}
        arm64_bench = {"node": arm64_node, "wasm": measured}
        return [
            "--x86-wasm", str(self.write("x86-wasm.sha256", x86_digest + "\n")),
            "--x86-native", str(self.write("x86-native.sha256", NATIVE_DIGEST + "\n")),
            "--x86-bench", str(self.write("x86-bench.json", json.dumps(x86_bench))),
            "--arm64-wasm", str(self.write("arm64-wasm.sha256", arm64_digest + "\n")),
            "--arm64-bench", str(self.write("arm64-bench.json", json.dumps(arm64_bench))),
            "--out", str(self.root / "arm64-parity.txt"),
        ]


class CompareTests(Base):
    def test_identical_digests_pass_and_say_so(self):
        summary = self.root / "summary.md"
        with patch.dict(os.environ, {"GITHUB_STEP_SUMMARY": str(summary)}):
            # The same digest on both sides: that is what "identical" means here. The
            # default fixture has two different digests, which is the failing case below.
            self.assertEqual(
                compare_wasm_arch.main(self.inputs(arm64_digest=X86_DIGEST)), 0)
        report = (self.root / "arm64-parity.txt").read_text()
        self.assertIn("identical", report)
        self.assertIn(X86_DIGEST, report)
        self.assertIn(NATIVE_DIGEST, report)
        self.assertIn("Node v22.20.0", report)
        self.assertIn("WASM-x86 vs WASM-arm64 parity", summary.read_text())

    def test_a_flipped_digit_fails_and_says_the_architectures_differ(self):
        # One hex digit: the smallest difference two architectures can show.
        arm64 = "2e" * 31 + "2f"
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(SystemExit) as caught:
                compare_wasm_arch.main(self.inputs(arm64_digest=arm64))
        self.assertIn("different bits", str(caught.exception))
        self.assertIn("DIFFERENT", (self.root / "arm64-parity.txt").read_text())

    def test_two_engine_versions_are_refused_even_when_the_digests_match(self):
        with self.assertRaises(SystemExit) as caught:
            compare_wasm_arch.main(self.inputs(arm64_node="v22.21.0"))
        self.assertIn("not one engine version", str(caught.exception))
        self.assertFalse((self.root / "arm64-parity.txt").exists())

    def test_a_digest_that_is_not_a_sha256_is_refused(self):
        for bad in ("", "2e" * 31, "2e" * 32 + "ff", "ZZ" * 32):
            with self.subTest(bad=bad):
                with self.assertRaises(SystemExit) as caught:
                    compare_wasm_arch.main(self.inputs(x86_digest=bad))
                self.assertIn("malformed digest", str(caught.exception))

    def test_the_report_carries_the_numbers_a_reader_can_check(self):
        equal, text = compare_wasm_arch.build_report(
            X86_DIGEST, X86_DIGEST, NATIVE_DIGEST, "v22.20.0",
            {"fmadd_ns_per_op": 21.256}, {"fmadd_ns_per_op": 3.4})
        self.assertTrue(equal)
        self.assertIn("8,000,000 results", text)
        self.assertIn("x86 21.26, arm64 3.4", text)


if __name__ == "__main__":
    unittest.main()
