#!/usr/bin/env python3
"""Fail the build if game data or oversized files are staged in the git index.

Why this exists: visibility is a policy, not a technical control. The repository
is public (verified 2026-10-04, `docs/OPEN_QUESTIONS.md` Q11), which makes the
control below matter more, not less. One `git add -A` in a tired moment is enough
to commit an ISO, a DOL, or 67 MB of recompiler output derived from the Nintendo
disc, and after that
it is in the history forever. This script is the technical control.

It reads the index, not the working tree, so it catches exactly what a commit would
contain. Sizes come from the staged blob, so an uncommitted edit cannot hide a big
file behind a small one on disk.

Usage:
    python scripts/check_no_game_data.py            # check the staged index
    python scripts/check_no_game_data.py --all      # check every tracked file
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from typing import NamedTuple
from pathlib import PurePosixPath

# Extensions that are always game data or build output derived from game data.
FORBIDDEN_SUFFIXES = (
    ".iso",
    ".gcm",
    ".rvz",
    ".wbfs",
    ".dol",
    ".gci",
    ".gct",
    ".hps",
    ".thp",
    ".ssm",
    ".wasm",
    ".o",
    ".obj",
    ".a",
    ".lib",
    ".exe",
    ".dll",
    ".pdb",
)

# Path prefixes that must never be tracked, whatever the extension.
FORBIDDEN_PREFIXES = (
    "port/generated",
    "upstream/melee-unlocked/port/generated",
    "assets-extracted/",
    # The generated manifest and the content-addressed blob store: derived from the disc,
    # so they belong in R2. Root-anchored, so it cannot shadow the shell's own dist/assets.
    "assets/",
    "private/",
    "upstream/melee-unlocked/Sys/",
    "wasm-probe/out/",
)

# Files whose content is a secret rather than game data.
FORBIDDEN_NAMES = (
    ".dev.vars",
    ".env",
    ".env.local",
    ".env.production",
)

# 5 MB: comfortably above every legitimate source file in this repository (the
# largest is well under 200 KB) and far below any disc asset.
MAX_FILE_BYTES = 5 * 1024 * 1024


class Violation(NamedTuple):
    path: str
    reason: str


def tracked_files(check_all: bool) -> list[str]:
    """List files that a commit would include."""
    command = ["git", "ls-files"] if check_all else ["git", "ls-files", "--cached"]
    result = subprocess.run(command, capture_output=True, text=True, check=True)
    return [line for line in result.stdout.splitlines() if line]


def staged_sizes(paths: list[str]) -> dict[str, int]:
    """Staged blob sizes, in one git call rather than one per file."""
    if not paths:
        return {}
    result = subprocess.run(
        ["git", "cat-file", "--batch-check=%(objectsize) %(objectname)"],
        input="\n".join(f":{path}" for path in paths),
        capture_output=True,
        text=True,
    )
    sizes: dict[str, int] = {}
    for path, line in zip(paths, result.stdout.splitlines()):
        parts = line.split()
        if parts and parts[0].isdigit():
            sizes[path] = int(parts[0])
    return sizes


def find_violations(paths: list[str], sizes: dict[str, int] | None = None) -> list[Violation]:
    """Pure predicate: given paths (and their sizes), return every violation."""
    if sizes is None:
        sizes = staged_sizes(paths)

    violations: list[Violation] = []
    for path in paths:
        name = PurePosixPath(path).name
        lower = path.lower()

        if name in FORBIDDEN_NAMES:
            violations.append(Violation(path, "secret file must not be tracked"))
            continue

        if any(lower.startswith(prefix.lower()) for prefix in FORBIDDEN_PREFIXES):
            violations.append(Violation(path, "path is game data or generated from game data"))
            continue

        if lower.endswith(FORBIDDEN_SUFFIXES):
            violations.append(Violation(path, "extension is game data or native build output"))
            continue

        size = sizes.get(path, 0)
        if size > MAX_FILE_BYTES:
            violations.append(
                Violation(path, f"{size} bytes exceeds the {MAX_FILE_BYTES} byte limit")
            )
    return violations


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="reject game data in the git index")
    parser.add_argument(
        "--all",
        action="store_true",
        help="check every tracked file instead of only the staged index",
    )
    args = parser.parse_args(argv)

    paths = tracked_files(check_all=args.all)
    violations = find_violations(paths)

    if violations:
        print(f"FAIL: {len(violations)} violation(s) in the git index", file=sys.stderr)
        for violation in violations:
            print(f"  {violation.path}: {violation.reason}", file=sys.stderr)
        print(
            "\nGame data never enters this repository, private or not. "
            "See docs/AGENT_RULES.md rule 1.",
            file=sys.stderr,
        )
        return 1

    print(f"OK: {len(paths)} tracked file(s) checked, no game data, no oversized files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
