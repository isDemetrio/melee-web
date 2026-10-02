"""Tests for scripts/check_docs.py -- the maps' citations, over a synthetic submodule.

Nothing here reads the pinned upstream: the fixture builds a miniature submodule (files with known
line counts) and a miniature `docs/`, so every rule the checker implements is reachable without the
67 MB checkout -- which is also what makes the negative cases (a path that is not there, a range
past the end of its file) testable at all.

The rules asserted are `docs/PLAN_BREAKDOWN.md` T1's acceptance criteria 3 and 4, plus the two
shorthands the maps' own headers define: a bare file name resolved by name, and the abbreviated
`gx/`, `hle/`, `ppc/`, `host/`, `abi/` meaning `port/runtime/...`. T1's other two criteria (one
table row per file matched by the `port/runtime` glob, a disposition cell in the fixed vocabulary)
describe the maps as they were planned, not as they were written -- they are narrative documents --
so the checker does not enforce them and the last test asserts that a file the narrative covers by
group rather than by name is not reported. That deviation is recorded in `docs/PROGRESS.md`.

Run with:  python3 -m unittest discover -s scripts/tests -v
"""

import importlib.util
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    'check_docs', Path(__file__).parents[1] / 'check_docs.py')
check_docs = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(check_docs)

ROOT = Path(__file__).parents[2]
SUBMODULE = ROOT / 'upstream/melee-unlocked'

# The fixture's files and how many lines each one has. `gx/ppc.h` exists twice on purpose: the
# ambiguous-name rule needs two files sharing a name and disagreeing about their length.
SUBMODULE_FILES = {
    'port/runtime/gx/gx_core.cpp': 40,
    'port/runtime/gx/ppc.h': 2,
    'port/runtime/ppc/ppc.h': 30,
    'port/runtime/hle/slippi_net.cpp': 20,
    'port/CMakeLists.txt': 10,
    'tools/validate_native.py': 7,
}
REPOSITORY_FILES = {'wasm/render/gx_webgpu.cpp': 12}


class CheckDocsTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        (self.root / 'docs').mkdir()
        for name in check_docs.DOCUMENTS:
            (self.root / 'docs' / name).write_text(f'# {name}\n', encoding='utf-8')
        self.submodule = self.root / 'upstream/melee-unlocked'
        self.write(self.submodule, SUBMODULE_FILES)
        self.write(self.root, REPOSITORY_FILES)

    @staticmethod
    def write(base, files):
        for relative, lines in files.items():
            path = base / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(''.join(f'line {n}\n' for n in range(1, lines + 1)), encoding='utf-8')

    def check(self, text, document='NETCODE_MAP.md'):
        (self.root / 'docs' / document).write_text(text, encoding='utf-8')
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = check_docs.main(['--repo', str(self.root)])
        return code, out.getvalue(), err.getvalue()

    # --- the positive case -------------------------------------------------------------

    def test_a_clean_document_passes_and_counts_its_citations(self):
        code, out, _ = self.check(
            '| a | `port/runtime/gx/gx_core.cpp:5–40` |\n'
            '| b | `gx/gx_core.cpp:1` |\n'
            '| c | `gx_core.cpp:2` |\n')
        self.assertEqual(code, 0)
        self.assertIn('3 citations in 4 documents, 0 violation(s)', out)

    # --- rule 1: the path exists -------------------------------------------------------

    def test_a_path_that_is_not_there_is_a_violation_that_names_document_and_line(self):
        code, out, _ = self.check('# title\n| a | `port/runtime/gx/nope.cpp:1` |\n')
        self.assertEqual(code, 1)
        self.assertIn('NETCODE_MAP.md:2: `port/runtime/gx/nope.cpp:1`', out)
        self.assertIn('no file at port/runtime/gx/nope.cpp', out)

    def test_an_unknown_bare_name_is_a_violation(self):
        code, out, _ = self.check('| a | `nothing_here.cpp:1` |\n')
        self.assertEqual(code, 1)
        self.assertIn('no file at nothing_here.cpp', out)

    def test_an_empty_glob_is_a_violation(self):
        code, out, _ = self.check('| a | `port/runtime/{nope,alsonope}/thing.cpp` |\n')
        self.assertEqual(code, 1)
        self.assertIn('no file matches this glob', out)

    def test_a_submodule_path_without_a_line_must_still_exist(self):
        self.assertEqual(self.check('| a | `port/runtime/gx/gx_core.cpp` |\n')[0], 0)
        code, out, _ = self.check('| a | `port/runtime/gx/missing.cpp` |\n')
        self.assertEqual(code, 1)
        self.assertIn('no file at port/runtime/gx/missing.cpp', out)

    def test_an_abbreviated_glob_is_matched_under_port_runtime(self):
        self.assertEqual(self.check('| a | `gx/*.cpp` |\n')[0], 0)
        self.assertEqual(self.check('| a | `gx/*.rs` |\n')[0], 1)

    def test_a_path_outside_the_submodule_without_a_line_is_not_a_claim_about_it(self):
        # PLAN_BREAKDOWN is a plan: `web/src/lobby/signaling.ts` is a file this repository is meant
        # to grow, so its absence is not a violation, while a range on it would be a claim.
        code, out, _ = self.check('| a | `web/src/lobby/signaling.ts` | `*.iso` |\n')
        self.assertEqual(code, 0)
        self.assertIn('2 path(s) outside the submodule cited without a line', out)
        code, out, _ = self.check('| a | `web/src/lobby/signaling.ts:5` |\n')
        self.assertEqual(code, 1)
        self.assertIn('no file at web/src/lobby/signaling.ts', out)

    # --- rule 2: the range is inside the file ------------------------------------------

    def test_a_range_past_the_end_is_a_violation(self):
        code, out, _ = self.check('| a | `port/runtime/hle/slippi_net.cpp:1–21` |\n')
        self.assertEqual(code, 1)
        self.assertIn('has 20 lines', out)

    def test_a_single_line_past_the_end_is_a_violation(self):
        code, _, _ = self.check('| a | `port/CMakeLists.txt:11` |\n')
        self.assertEqual(code, 1)

    def test_every_range_of_a_comma_separated_citation_is_checked(self):
        self.assertEqual(self.check('| a | `gx/gx_core.cpp:1–20,30–40` |\n')[0], 0)
        self.assertEqual(self.check('| a | `gx/gx_core.cpp:1–20,39–41` |\n')[0], 1)

    def test_an_open_ended_range_needs_only_its_start_inside_the_file(self):
        self.assertEqual(self.check('| a | `gx/gx_core.cpp:40+` |\n')[0], 0)
        self.assertEqual(self.check('| a | `gx/gx_core.cpp:41+` |\n')[0], 1)

    def test_a_range_that_runs_backwards_is_a_violation(self):
        code, out, _ = self.check('| a | `gx/gx_core.cpp:9–4` |\n')
        self.assertEqual(code, 1)
        self.assertIn('runs backwards', out)

    # --- the two shorthands the maps' headers define ------------------------------------

    def test_an_abbreviated_directory_means_port_runtime(self):
        self.assertEqual(self.check('| a | `gx/gx_core.cpp:40` |\n')[0], 0)
        self.assertEqual(self.check('| a | `gx/gx_core.cpp:41` |\n')[0], 1)

    def test_an_ambiguous_bare_name_is_satisfied_by_any_file_with_that_name(self):
        # `ppc/ppc.h` has 30 lines and `gx/ppc.h` has 2; the citation is true of the first.
        self.assertEqual(self.check('| a | `ppc.h:1–30` |\n')[0], 0)
        self.assertEqual(self.check('| a | `ppc.h:3–4` |\n')[0], 0)
        self.assertEqual(self.check('| a | `ppc.h:31` |\n')[0], 1)

    def test_a_glob_is_checked_against_the_files_it_matches(self):
        # `gx/gx_core.cpp` has 40 lines and `hle/slippi_net.cpp` 20: one of them satisfies 1–20.
        self.assertEqual(self.check('| a | `port/runtime/{gx,hle}/*.cpp:1–20` |\n')[0], 0)
        self.assertEqual(self.check('| a | `port/runtime/{gx,hle}/*.cpp:1–60` |\n')[0], 1)

    def test_a_repository_path_is_resolved_at_the_repository_root(self):
        self.assertEqual(self.check('| a | `wasm/render/gx_webgpu.cpp:12` |\n')[0], 0)
        self.assertEqual(self.check('| a | `wasm/render/gx_webgpu.cpp:13` |\n')[0], 1)

    # --- what is deliberately not a citation -------------------------------------------

    def test_a_host_and_a_port_is_not_a_citation(self):
        code, out, _ = self.check('| a | `mm.slippi.gg:43113` | `stun.cloudflare.com:3478` |\n')
        self.assertEqual(code, 0)
        self.assertIn('2 token(s) that are not source files', out)

    def test_generated_output_is_not_required_to_exist(self):
        code, out, _ = self.check('| a | `port/generated/guest_000.cpp:1–999` |\n')
        self.assertEqual(code, 0)
        self.assertIn('1 generated-output path(s)', out)

    def test_a_file_the_narrative_groups_rather_than_names_is_not_a_violation(self):
        # T1's first criterion would require a row per file; the maps group them, so a document
        # that names none of the 139 files is clean rather than 139 violations.
        code, out, _ = self.check('# Runtime map\n\n| `gx/gx_core.*` | grouped row |\n')
        self.assertEqual(code, 0)
        self.assertIn('0 violation(s)', out)

    # --- the check cannot run ----------------------------------------------------------

    def test_no_submodule_checkout_is_exit_2(self):
        for child in sorted(self.submodule.rglob('*'), reverse=True):
            child.unlink() if child.is_file() else child.rmdir()
        self.submodule.rmdir()
        code, _, err = self.check('| a | `gx/gx_core.cpp:1` |\n')
        self.assertEqual(code, 2)
        self.assertIn('no submodule checkout', err)

    def test_a_missing_document_is_exit_2(self):
        (self.root / 'docs' / 'RENDERER_MAP.md').unlink()
        code, _, err = self.check('| a | `gx/gx_core.cpp:1` |\n')
        self.assertEqual(code, 2)
        self.assertIn('missing document', err)

    @unittest.skipUnless(SUBMODULE.is_dir() and any(SUBMODULE.iterdir()),
                         'the pinned submodule is not checked out here')
    def test_the_repositorys_own_documents_are_clean(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = check_docs.main(['--repo', str(ROOT)])
        self.assertEqual(code, 0, out.getvalue())
        self.assertIn('0 violation(s)', out.getvalue())


if __name__ == '__main__':
    unittest.main()
