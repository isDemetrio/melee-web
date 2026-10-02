#!/usr/bin/env bash
#
# Assert that the "hot" translation units really are compiled at -O2.
#
# Why this exists: wasm/core/CMakeLists.txt moves the PowerPC and GX hot files to -O2 with a
# source property, which CMake appends after the target's own and interface options. That ordering
# is the whole mechanism -- if it ever changes, -Oz would come last, the per-file experiment would
# quietly compile at the default level and the measurements would say "no effect" for a reason that
# has nothing to do with the code. The build cannot tell the difference, so this reads the real
# compile commands instead of trusting the intention.
#
# Usage: scripts/phase0/assert_hot_opt.sh <compile_commands.json> [expected-level]
#
# The file is produced by configuring with -DCMAKE_EXPORT_COMPILE_COMMANDS=ON.

set -euo pipefail

commands=${1:?usage: assert_hot_opt.sh <compile_commands.json> [expected-level]}
expected=${2:--O2}

test -f "$commands" || { echo "no compile commands at $commands" >&2; exit 1; }

python3 - "$commands" "$expected" <<'PY'
import json, re, sys

path, expected = sys.argv[1], sys.argv[2]
wanted = ("runtime/ppc/ppc_runtime.cpp", "runtime/ppc/interp.cpp",
          "runtime/gx/gx_core.cpp", "runtime/gx/gx_texture.cpp")
entries = json.load(open(path))
found, problems = {}, []
for entry in entries:
    source = entry.get("file", "")
    if any(source.endswith(w) for w in wanted):
        argv = entry.get("command") or " ".join(entry.get("arguments", []))
        levels = re.findall(r"-O[a-z0-9]+", argv)
        found[source.split("/")[-1]] = levels[-1] if levels else "(none)"
for w in wanted:
    name = w.split("/")[-1]
    if name not in found:
        problems.append(f"{name}: no compile command in {path}")
    elif found[name] != expected:
        problems.append(f"{name}: last optimisation flag is {found[name]}, expected {expected}")
if problems:
    for p in problems:
        print(f"hot-opt assertion failed: {p}", file=sys.stderr)
    sys.exit(1)
for name, level in sorted(found.items()):
    print(f"hot-opt: {name} compiled at {level}")
PY
