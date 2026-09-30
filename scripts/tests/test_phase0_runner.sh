#!/usr/bin/env bash
#
# Guards for scripts/phase0/run_checkpoints.sh -- the one script in this repository that
# writes a game-derived trace.
#
# Nothing here launches a binary and nothing here reads a disc: every case ends in a refusal
# or in a --dry-run, which is why this suite can run in CI, where no ISO exists. What it
# proves is the part that decides whether a trace is trustworthy at all: which script the
# default picks, that a typo cannot silently fall back to it, that the disc gate refuses a
# wrong revision, and that a trace can never be written into the checkout.
#
# Deliberate gap: the "expected size, wrong SHA-1" refusal is not repeated here. It is only
# reachable with a 1,459,978,240-byte fixture, and that same gate over that same fixture is
# already exercised for scripts/phase0/upload_disc.sh in scripts/tests/test_deploy_guard.sh.
# What is checked here instead is that the two constants are the documented Redump values, so
# they cannot drift away from docs/OPEN_QUESTIONS.md without a failure.
#
# The fixture is a few tiny files in a mktemp directory.
#
# Run with:  bash scripts/tests/test_phase0_runner.sh
set -euo pipefail

# From the repository root, so that the relative-path case below means the same thing
# wherever the suite is invoked from.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
root=$(pwd)
runner="$root/scripts/phase0/run_checkpoints.sh"
upstream_scripts="$root/upstream/melee-unlocked/port/scripts"

test -f "$upstream_scripts/parity_vs_onett.txt" || {
  echo "the upstream submodule is not checked out: run git submodule update --init" >&2
  exit 2
}

tmp=$(mktemp -d)

failures=0
checks=0

fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }

# check_status <label> <expected status> <actual status> <captured output>
check_status() {
  if [ "$3" -ne "$2" ]; then
    fail "$1: exited $3, expected $2"
    sed -n "1,20p" "$4" >&2
    return 0
  fi
  checks=$((checks + 1))
  echo "ok: $1"
}

# check_has <label> <text the output must contain> <captured output>
check_has() {
  if ! grep -q -F -- "$2" "$3"; then
    fail "$1: the output does not mention $2"
    sed -n "1,20p" "$3" >&2
    return 0
  fi
  checks=$((checks + 1))
  echo "ok: $1"
}

# check_lacks <label> <text the output must not contain> <captured output>
check_lacks() {
  if grep -q -F -- "$2" "$3"; then
    fail "$1: the output mentions $2"
    return 0
  fi
  checks=$((checks + 1))
  echo "ok: $1"
}

# --- fixture ---------------------------------------------------------------------------------
# The executable is never launched: it only has to exist and be executable, so the system
# /bin/true does the job and nothing has to be made executable here.
exe=/bin/true
printf "not executable\n" > "$tmp/plain"
# An Emscripten Node module is a loader plus the module beside it.
printf "// loader\n" > "$tmp/melee_core_node.js"
printf "wasm\n" > "$tmp/melee_core_node.wasm"
printf "// loader without a module\n" > "$tmp/lonely.js"
# An image of the wrong size: it only has to be a file of some other length.
printf "not a disc image\n" > "$tmp/small.iso"
absent="$tmp/absent.iso"

# 1. The default script is the @scene-anchored parity script, and it is not vs_match.txt.
out="$tmp/out-default"
status=0
"$runner" --dry-run "$exe" "$tmp/small.iso" "$tmp/run-1" >"$out" 2>&1 || status=$?
check_status "a dry run succeeds" 0 "$status" "$out"
check_has "the default script is the @scene-anchored one" "$upstream_scripts/parity_vs_onett.txt" "$out"
check_lacks "the default is not vs_match.txt" "vs_match.txt" "$out"
check_has "the default is 2400 frames" "--frames 2400" "$out"
check_has "the dry run prints the timing path" "$tmp/run-1/sim_times.csv" "$out"
check_has "the dry run prints the state trace path" "$tmp/run-1/trace.csv" "$out"

# 2. A dry run resolves and prints; it writes nothing, not even the output directory.
if [ -e "$tmp/run-1" ]; then
  fail "the dry run created its output directory"
else
  checks=$((checks + 1))
  echo "ok: the dry run writes nothing"
fi

# 3. An explicit script and frame count are used as given, not silently replaced.
out="$tmp/out-explicit"
status=0
"$runner" --dry-run "$exe" "$tmp/small.iso" "$tmp/run-2" 120 "$upstream_scripts/boot_only.txt" >"$out" 2>&1 || status=$?
check_status "a dry run with an explicit script succeeds" 0 "$status" "$out"
check_has "an explicit script is used as given" "$upstream_scripts/boot_only.txt" "$out"
check_has "an explicit frame count is used as given" "--frames 120" "$out"

# 4. A typo in the script path is a refusal, never a fallback to the default.
out="$tmp/out-typo"
status=0
"$runner" --dry-run "$exe" "$tmp/small.iso" "$tmp/run-3" 2400 "$tmp/typo.txt" >"$out" 2>&1 || status=$?
check_status "a nonexistent script is refused" 1 "$status" "$out"
check_has "the refusal names the missing script" "no script at" "$out"
check_lacks "the refusal does not fall back to the default" "parity_vs_onett.txt" "$out"

# 5. The checkout is never an output directory. The ISO is absent on purpose: the refusal has
#    to happen before anything touches the disc.
out="$tmp/out-inside"
for inside in "$root" "$root/scripts/phase0" ./inside-the-checkout; do
  status=0
  "$runner" "$exe" "$absent" "$inside" >"$out" 2>&1 || status=$?
  check_status "an output directory inside the checkout is refused ($inside)" 1 "$status" "$out"
  check_has "the refusal names the output directory" "output directory is inside the repository" "$out"
done

# 5b. A path that merely starts like the checkout is not inside it.
out="$tmp/out-outside"
status=0
"$runner" --dry-run "$exe" "$tmp/small.iso" "$tmp/melee-web-outside" >"$out" 2>&1 || status=$?
check_status "a path that only starts like the checkout is accepted" 0 "$status" "$out"

# 6. The executable has to be one, and a Node module needs its module beside it.
out="$tmp/out-exe"
status=0
"$runner" --dry-run "$tmp/no-such-exe" "$tmp/small.iso" "$tmp/run-4" >"$out" 2>&1 || status=$?
check_status "a missing executable is refused" 1 "$status" "$out"
check_has "the refusal says it is not executable" "not executable" "$out"

status=0
"$runner" --dry-run "$tmp/plain" "$tmp/small.iso" "$tmp/run-4" >"$out" 2>&1 || status=$?
check_status "a non-executable file is refused" 1 "$status" "$out"
check_has "the refusal says it is not executable" "not executable" "$out"

status=0
"$runner" --dry-run "$tmp/absent.js" "$tmp/small.iso" "$tmp/run-4" >"$out" 2>&1 || status=$?
check_status "a missing .js loader is refused" 1 "$status" "$out"
check_has "the refusal names the missing loader" "no module at $tmp/absent.js" "$out"

status=0
"$runner" --dry-run "$tmp/lonely.js" "$tmp/small.iso" "$tmp/run-4" >"$out" 2>&1 || status=$?
check_status "a .js loader without its .wasm is refused" 1 "$status" "$out"
check_has "the refusal names the missing module" "no module at $tmp/lonely.wasm" "$out"

# 6b. A Node module is run with node, and NODE overrides the interpreter.
out="$tmp/out-node"
status=0
"$runner" --dry-run "$tmp/melee_core_node.js" "$tmp/small.iso" "$tmp/run-5" >"$out" 2>&1 || status=$?
check_status "a Node module is accepted" 0 "$status" "$out"
check_has "a Node module is run with node" "nice -n 10 node" "$out"
check_has "the command names the module" "$tmp/melee_core_node.js" "$out"

status=0
env NODE="$tmp/other-node" "$runner" --dry-run "$tmp/melee_core_node.js" "$tmp/small.iso" "$tmp/run-5" >"$out" 2>&1 || status=$?
check_status "a Node module with NODE set is accepted" 0 "$status" "$out"
check_has "NODE overrides the interpreter" "$tmp/other-node" "$out"

# 7. The disc gate: absent, and of the wrong size. Both refuse before the run.
out="$tmp/out-disc"
status=0
"$runner" "$exe" "$absent" "$tmp/run-6" >"$out" 2>&1 || status=$?
check_status "a missing disc image is refused" 1 "$status" "$out"
check_has "the refusal says the disc is missing" "no disc image at" "$out"

status=0
"$runner" "$exe" "$tmp/small.iso" "$tmp/run-6" >"$out" 2>&1 || status=$?
check_status "a disc image of the wrong size is refused" 1 "$status" "$out"
check_has "the refusal names the expected size" "expected 1459978240" "$out"

if [ -e "$tmp/run-6" ]; then
  fail "a refused run created its output directory"
else
  checks=$((checks + 1))
  echo "ok: a refused run writes nothing"
fi

# 8. The disc gate constants are the documented Redump values. A wrong constant would refuse
#    the copy of the disc the operator holds and blame that disc, so the two files are checked together.
if grep -q -F -- "EXPECTED_SIZE=1459978240" "$runner" && grep -q -F -- "EXPECTED_SHA1=d4e70c064cc714ba8400a849cf299dbd1aa326fc" "$runner"; then
  checks=$((checks + 1))
  echo "ok: the constants in the runner are the documented ones"
else
  fail "the disc constants in the runner are not the documented Redump values"
fi
if grep -q -F -- "1,459,978,240" "$root/docs/OPEN_QUESTIONS.md" && grep -q -F -- "d4e70c064cc714ba8400a849cf299dbd1aa326fc" "$root/docs/OPEN_QUESTIONS.md"; then
  checks=$((checks + 1))
  echo "ok: docs/OPEN_QUESTIONS.md states the same disc"
else
  fail "docs/OPEN_QUESTIONS.md no longer states the disc size and SHA-1"
fi

# 9. Missing arguments print the usage instead of running something.
out="$tmp/out-usage"
status=0
"$runner" >"$out" 2>&1 || status=$?
check_status "no arguments is a refusal" 1 "$status" "$out"
check_has "the refusal prints the usage" "usage: run_checkpoints.sh" "$out"

status=0
"$runner" "$exe" "$tmp/small.iso" >"$out" 2>&1 || status=$?
check_status "a missing output directory is a refusal" 1 "$status" "$out"
check_has "the refusal prints the usage" "usage: run_checkpoints.sh" "$out"

if [ "$failures" -ne 0 ]; then
  echo "$failures guard(s) failed" >&2
  exit 1
fi
echo "$checks checkpoint runner guards hold"
