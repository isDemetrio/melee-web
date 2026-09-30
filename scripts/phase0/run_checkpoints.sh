#!/usr/bin/env bash
#
# Run the Linux headless reference for a fixed number of frames and capture its state trace.
#
# The binary must already exist: this machine (the editing VPS) cannot compile it, and CI has
# no disc image, so the executable is built in GitHub Actions and carried over. This script
# only runs it, against the operator's own disc image.
#
# Usage: scripts/phase0/run_checkpoints.sh [--dry-run] <exe> <iso> <outdir> [frames] [script]
#
# <exe> is either a native executable or an Emscripten Node module ending in `.js`, which is
# run with `${NODE:-node}` and needs its `.wasm` beside it. The ISO is verified before anything
# is executed: a wrong revision produces a trace that looks plausible and means nothing.
#
# `--dry-run` resolves everything, prints the command a real run would execute, verifies
# nothing about the disc and runs nothing. It is what `scripts/tests/test_phase0_runner.sh`
# exercises in CI, where no ISO exists.
#
# The default script is the project's own @scene-anchored parity script, never
# `port/scripts/vs_match.txt`. That one assumes Slippi boot timing, this translation is built
# `--no-slippi`, and it ends at `mode=1 state=0 match_frame=0`: 2400 deterministic retraces of a
# menu, measured on 2026-09-30 (docs/PHASE0_TASKS.md P0-08). Pass a different script explicitly
# if that is what you mean to run.

set -euo pipefail

usage='usage: run_checkpoints.sh [--dry-run] <exe> <iso> <outdir> [frames] [script]'

dry_run=false
if [ "${1:-}" = --dry-run ]; then
  dry_run=true
  shift
fi

exe=${1:?$usage}
iso=${2:?$usage}
out=${3:?$usage}
frames=${4:-2400}

EXPECTED_SIZE=1459978240
EXPECTED_SHA1=d4e70c064cc714ba8400a849cf299dbd1aa326fc

# Resolved from this file, not from the caller's directory: the default script below and the
# "not inside the checkout" guard have to work from anywhere.
repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
script=${5:-"$repo/upstream/melee-unlocked/port/scripts/parity_vs_onett.txt"}

# A native build is the executable itself; a WASM build is a .js loader plus its .wasm, so it
# has to be handed to node. The loader sits beside the module, which is why the path is used
# as given rather than copied anywhere.
if [ "${exe##*.}" = js ]; then
  test -f "$exe" || { echo "no module at $exe" >&2; exit 1; }
  test -f "${exe%.js}.wasm" || { echo "no module at ${exe%.js}.wasm" >&2; exit 1; }
  runner=("${NODE:-node}" "$exe")
else
  test -x "$exe" || { echo "not executable: $exe" >&2; exit 1; }
  runner=("$exe")
fi

# A typo must not silently fall back to the default script.
test -f "$script" || { echo "no script at $script" >&2; exit 1; }

# Never write a trace into the checkout. The output directory is removed and recreated below,
# so a path inside the repository would delete tracked files, and the traces and card image it
# then writes are game-derived: `scripts/check_no_game_data.py` rejects them and they must never
# be staged. Traces belong under /home/hermes/incoming/phase0/.
case "$(realpath -m -- "$out")" in
  "$repo" | "$repo"/*)
    echo "output directory is inside the repository: $out" >&2
    exit 1
    ;;
esac

test -f "$iso" || { echo "no disc image at $iso" >&2; exit 1; }

# Assembled once, so a dry run prints the command a real run executes rather than a
# description of it.
argv=(nice -n 10 "${runner[@]}"
  --iso "$iso" --headless --fast --frames "$frames" --time-base 1 --volume 0
  --script "$script" --card-dir "$out/card"
  --state-trace "$out/trace.csv" --sim-times "$out/sim_times.csv")

if [ "$dry_run" = true ]; then
  echo "dry run: nothing is executed, and the disc is neither read nor verified"
  echo "exe:     $exe"
  echo "iso:     $iso"
  echo "script:  $script"
  echo "out:     $out"
  echo "frames:  $frames"
  printf 'command:'; printf ' %q' "${argv[@]}"; echo
  exit 0
fi

size=$(stat -c%s "$iso")
if [ "$size" != "$EXPECTED_SIZE" ]; then
  echo "disc image is $size bytes, expected $EXPECTED_SIZE: refusing to run" >&2
  exit 1
fi
digest=$(sha1sum "$iso" | cut -d' ' -f1)
if [ "$digest" != "$EXPECTED_SHA1" ]; then
  echo "disc image SHA-1 is $digest, expected $EXPECTED_SHA1: refusing to run" >&2
  exit 1
fi
echo "disc image verified: $size bytes, sha1 $digest"

# A fresh card directory per trial, and its parent: upstream persists sram.bin beside the
# card, so boot differs with and without a save (tools/validate_native.py:38-39).
rm -rf "$out"
mkdir -p "$out/card"

start=$(date +%s)
set +e
# A hard ceiling: a boot that deadlocks on a DVD worker would otherwise sit there for ever.
# 2400 frames with --fast should take minutes; the ceiling is deliberately generous.
timeout "${RUN_TIMEOUT:-1800}" "${argv[@]}" > "$out/stdout.log" 2>&1
status=$?
set -e
end=$(date +%s)
if [ "$status" = 124 ]; then
  echo "TIMED OUT after ${RUN_TIMEOUT:-1800}s (status 124): the run did not finish" >&2
fi

rows=$(wc -l < "$out/trace.csv" 2>/dev/null || echo 0)
echo "exit status: $status"
echo "wall clock:  $((end - start))s for $frames requested frames"
echo "trace rows:  $rows (header included)"
echo "trace sha1:  $(sha1sum "$out/trace.csv" 2>/dev/null | cut -d' ' -f1)"
head -2 "$out/trace.csv" 2>/dev/null || true
# The scene line is what tells a checkpoint count apart from "a match was played": 2400
# retraces of a menu hash just as convincingly as 2400 retraces of a match (P0-08).
grep -h '^final scene:' "$out/stdout.log" || echo 'final scene: MISSING'
grep -h '^FPSCR requests:' "$out/stdout.log" || echo 'FPSCR requests: MISSING'
echo "stdout tail:"
tail -5 "$out/stdout.log" 2>/dev/null || true

exit "$status"
