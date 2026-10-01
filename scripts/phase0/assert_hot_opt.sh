#!/usr/bin/env bash
#
# Assert that the two "hot" translation units really are compiled at -O2.
#
# Why this exists: wasm/core/CMakeLists.txt moves ppc_runtime.cpp and interp.cpp to -O2 with a
# source property, which CMake appends after the target's own and interface options. That ordering
# is the whole mechanism -- if it ever changes, -Oz would come last, the per-file experiment would
# quietly compile at the default level and the measurements would say "no effect" for a reason that
# has nothing to do with the code. The build cannot tell the difference, so this reads the real
# compile commands instead of trusting the intention.
#
# Usage: scripts/phase0/assert_hot_opt.sh <compile_commands.json> [expected-level] [generated-dir]
#
# With a generated-dir fragment, every compile command under it must also carry the expected level.
# The guest translation units are generated outside the checkout, so they cannot be listed here by
# name, and a check that silently found none of them would pass without testing anything — hence the
# empty-result guard.
#
# The file is produced by configuring with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON.

set -euo pipefail

commands=${1:?usage: assert_hot_opt.sh <compile_commands.json> [expected-level]}
expected=${2:--O2}

test -f "$commands" || { echo "no compile commands at $commands" >&2; exit 1; }

python3 - "$commands" "$expected" "${3:-}" <<'PY'
import json, re, sys

path, expected, generated = sys.argv[1], sys.argv[2], sys.argv[3]
wanted = ("runtime/ppc/ppc_runtime.cpp", "runtime/ppc/interp.cpp")
entries = json.load(open(path))
found, problems, seen_generated = {}, [], 0
for entry in entries:
    source = entry.get("file", "")
    argv = entry.get("command") or " ".join(entry.get("arguments", []))
    levels = re.findall(r"-O[a-z0-9]+", argv)
    last = levels[-1] if levels else "(none)"
    if any(source.endswith(w) for w in wanted):
        found[source.split("/")[-1]] = last
    if generated and generated in source:
        seen_generated += 1
        if last != expected:
            problems.append(f"{source}: last optimisation flag is {last}, expected {expected}")
for w in wanted:
    name = w.split("/")[-1]
    if name not in found:
        problems.append(f"{name}: no compile command in {path}")
    elif found[name] != expected:
        problems.append(f"{name}: last optimisation flag is {found[name]}, expected {expected}")
if generated and seen_generated == 0:
    problems.append(f"no compile command under {generated}: the check would pass vacuously")
if problems:
    for p in problems:
        print(f"hot-opt assertion failed: {p}", file=sys.stderr)
    sys.exit(1)
for name, level in sorted(found.items()):
    print(f"hot-opt: {name} compiled at {level}")
if generated:
    print(f"hot-opt: {seen_generated} generated guest translation unit(s) compiled at {expected}")
PY
