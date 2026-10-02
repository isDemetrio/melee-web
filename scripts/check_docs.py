#!/usr/bin/env python3
"""The technical maps' citations, checked against the pinned upstream submodule.

`docs/PLAN_BREAKDOWN.md` T1 makes this script one of its deliverables and gives it four machine
acceptance criteria. Two of them describe the maps as they were planned rather than as they were
written, so they are recorded in `docs/PROGRESS.md` instead of enforced here:

* "every file matched by the glob `port/runtime/{ppc,hle,host,gx,abi}/*.{cpp,h}` appears exactly
  once in RUNTIME_MAP's table" and "every disposition cell is in the fixed vocabulary" -- the maps
  were written as narrative documents: `docs/RUNTIME_MAP.md` groups files into rows and its columns
  are responsibility, dependencies, Windows APIs and browser replacement, so there is no
  `keep`/`shim`/`replace`/`stub`/`drop` cell to read. The 139 files that glob matches are covered by
  group, which is what the document's own header says it does.

The other two are implemented, and they are the ones with teeth:

1. every backticked path under `port/`, `tools/` or `sourceport/` exists in the submodule checkout;
2. every `path:N` or `path:N-M` citation is within the file's line count.

Criterion 1 is scoped to those prefixes for a reason worth keeping: `docs/PLAN_BREAKDOWN.md` is a
plan, so it names files this repository is supposed to grow (`web/src/lobby/signaling.ts`,
`.github/workflows/deploy.yml`) and shapes that are not files at all (`*.iso`, `windows.h`). A path
without a line is a claim about the pinned upstream only when it is an upstream path. A citation
with a line is a claim wherever it points, so criterion 2 is checked for every form below.

Three shorthands the maps' own headers define, or that a bare name needs:

* `ppc/`, `hle/`, `host/`, `gx/`, `abi/` mean `port/runtime/...` (`docs/RUNTIME_MAP.md`, header);
* a bare file name (`gx_core.cpp:457`) is resolved by name in the submodule -- the one file with
  that name, or, when several share it, satisfied by any of them;
* a citation to this repository's own files (`wasm/render/gx_webgpu.cpp:12`) resolves at the
  repository root.

A brace glob is satisfied by at least one file it matches, and a line range on a glob by at least
one of them. Not checked, with the reason, and counted in the summary so nothing is skipped in
silence:

* `port/generated*` -- the recompiler's output, not in the checkout (`.gitignore`;
  `docs/PLAN_BREAKDOWN.md` section 1, "Upstream tree anomaly");
* a token that is not a source file (`mm.slippi.gg:43113`, `stun.cloudflare.com:3478`, `Atomics.store`);
* a path with no line that is not under `port/`, `tools/` or `sourceport/`.

Exit codes: 0 clean, 1 a violation, 2 the check could not run (no submodule checkout, no document).
"""

import argparse
import re
import sys
from pathlib import Path

DOCUMENTS = ('RUNTIME_MAP.md', 'RENDERER_MAP.md', 'NETCODE_MAP.md', 'PLAN_BREAKDOWN.md')
SUBMODULE = Path('upstream/melee-unlocked')
SUBMODULE_ROOTS = ('port/', 'tools/', 'sourceport/')
ABBREVIATED = ('ppc', 'hle', 'host', 'gx', 'abi')
# A bare name is a file citation only if it looks like one; `mm.slippi.gg:43113` does not.
SOURCE_SUFFIXES = frozenset((
    'c', 'cc', 'cmake', 'cpp', 'def', 'h', 'hpp', 'inc', 'inl', 'js', 'json', 'md', 'mjs', 'py',
    'sh', 'toml', 'ts', 'txt', 'wgsl', 'yaml', 'yml',
))
GENERATED = re.compile(r'^port/generated')
BACKTICK = re.compile(r'`([^`\n]+)`')
GLOB = re.compile(r'[{}*?]')
# A path, and the line or range that follows it when there is one: `port/tests/a.cpp:12-20`. The
# trailing character class matters: without it the greedy first class stops at the last dot of a
# brace glob (`port/runtime/{ppc,hle}/*.{cpp,h}`) and cites half of it.
CITATION = re.compile(
    r'(?P<path>[A-Za-z0-9_./{},*+-]+\.[A-Za-z0-9_]+[A-Za-z0-9_./{},*+-]*)'
    r'(?::(?P<ranges>[0-9][0-9,\-\u2013+]*))?')
RANGE = re.compile(r'^(?P<a>[0-9]+)(?:[-\u2013](?P<b>[0-9]+))?(?P<open>\+)?$')


class Violation:
    def __init__(self, document, line, citation, reason):
        self.document = document
        self.line = line
        self.citation = citation
        self.reason = reason

    def __str__(self):
        return f'{self.document}:{self.line}: `{self.citation}` -- {self.reason}'


def expand_braces(token):
    """Expand one brace group per call, so `{a,b}/{c,d}` yields all four combinations."""
    match = re.search(r'\{([^{}]*)\}', token)
    if match is None:
        return [token]
    out = []
    for part in match.group(1).split(','):
        out.extend(expand_braces(token[:match.start()] + part + token[match.end():]))
    return out


def is_submodule_path(cited):
    """True for a path the pinned upstream is expected to have, whatever form it takes."""
    return cited.startswith(SUBMODULE_ROOTS) or cited.split('/')[0] in ABBREVIATED


def line_count(path):
    return len(path.read_text(encoding='utf-8', errors='replace').splitlines())


def range_reason(ranges, count):
    """None when every range in the citation fits the file, else the reason it does not."""
    for token in ranges.split(','):
        match = RANGE.match(token.strip())
        if match is None:
            return f'`{token}` is not a line or a line range'
        first = int(match.group('a'))
        last = int(match.group('b')) if match.group('b') else first
        if first < 1:
            return f'line {first} is before the first line'
        if match.group('b') and last < first:
            return f'`{token}` runs backwards'
        if first > count:
            return f'line {first} is past the end of a {count}-line file'
        if not match.group('open') and last > count:
            return f'line {last} is past the end of a {count}-line file'
    return None


class Checker:
    """Resolves citations against the submodule and the repository, one name index per root."""

    def __init__(self, repo, submodule):
        self.repo = repo
        self.submodule = submodule
        self.roots = (submodule, repo)
        self._by_name = {}

    def by_name(self, name):
        if name not in self._by_name:
            self._by_name[name] = sorted(
                p for root in self.roots for p in root.rglob(name) if p.is_file())
        return self._by_name[name]

    def describe(self, path):
        """The path as a reader of the documents sees it: relative to the repository."""
        for root in (self.repo, self.submodule):
            try:
                return str(path.relative_to(root))
            except ValueError:
                continue
        return str(path)

    def candidates(self, cited):
        """The existing files the citation could mean, or None if it is not a file citation."""
        expanded = expand_braces(cited)
        parts = cited.split('/')
        if len(parts) > 1 and parts[0] in ABBREVIATED:
            bases = (self.submodule / 'port' / 'runtime',)
        elif len(parts) > 1:
            bases = self.roots
        elif Path(cited).suffix.lstrip('.').lower() in SOURCE_SUFFIXES:
            return self.by_name(cited)
        else:
            return None
        found = []
        for base in bases:
            for e in expanded:
                if GLOB.search(e):
                    found.extend(p for p in base.glob(e) if p.is_file())
                elif (base / e).is_file():
                    found.append(base / e)
        return sorted(set(found))

    def document(self, path):
        text = path.read_text(encoding='utf-8')
        counts = {'citations': 0, 'generated': 0, 'not a source file': 0, 'no line': 0}
        violations = []
        for span in BACKTICK.finditer(text):
            for match in CITATION.finditer(span.group(1)):
                cited, ranges = match.group('path'), match.group('ranges')
                token = cited if ranges is None else f'{cited}:{ranges}'
                line = text.count('\n', 0, span.start()) + 1
                if GENERATED.match(cited):
                    counts['generated'] += 1
                    continue
                if ranges is None and not is_submodule_path(cited):
                    counts['no line'] += 1
                    continue
                found = self.candidates(cited)
                if found is None:
                    counts['not a source file'] += 1
                    continue
                counts['citations'] += 1
                if not found:
                    why = ('no file matches this glob' if GLOB.search(cited)
                           else f'no file at {cited}')
                    violations.append(Violation(path.name, line, token, why))
                    continue
                if ranges is None:
                    continue  # the claim is the file, and it is there
                reasons = [range_reason(ranges, line_count(f)) for f in found]
                if all(reasons):
                    violations.append(Violation(
                        path.name, line, token,
                        f'{self.describe(found[0])} has {line_count(found[0])} lines, '
                        f'and {reasons[0]}'))
        return violations, counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[1],
                        help='repository root (default: the parent of this script)')
    parser.add_argument('--submodule', type=Path, default=SUBMODULE,
                        help='the pinned upstream checkout, inside the repository')
    args = parser.parse_args(argv)
    repo = args.repo.resolve()
    submodule = args.submodule if args.submodule.is_absolute() else repo / args.submodule
    submodule = submodule.resolve()
    if not submodule.is_dir() or not any(submodule.iterdir()):
        print(f'check_docs: no submodule checkout at {submodule}; run '
              f'`git submodule update --init upstream/melee-unlocked`', file=sys.stderr)
        return 2
    documents = [repo / 'docs' / name for name in DOCUMENTS]
    missing = [d for d in documents if not d.is_file()]
    if missing:
        print(f'check_docs: missing document(s): {", ".join(str(d) for d in missing)}',
              file=sys.stderr)
        return 2
    checker = Checker(repo, submodule)
    violations = []
    totals = {'citations': 0, 'generated': 0, 'not a source file': 0, 'no line': 0}
    for document in documents:
        found, counts = checker.document(document)
        violations.extend(found)
        for key, value in counts.items():
            totals[key] += value
    for violation in violations:
        print(violation)
    print(f'{totals["citations"]} citations in {len(documents)} documents, '
          f'{len(violations)} violation(s); not checked: {totals["generated"]} generated-output '
          f'path(s), {totals["not a source file"]} token(s) that are not source files, '
          f'{totals["no line"]} path(s) outside the submodule cited without a line')
    return 1 if violations else 0


if __name__ == '__main__':
    sys.exit(main())
