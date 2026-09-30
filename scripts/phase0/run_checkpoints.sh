#!/usr/bin/env bash
#
# Run the Linux headless reference for a fixed number of frames and capture its state trace.
#
# The binary must already exist: this machine (the editing VPS) cannot compile it, and CI has
# no disc image, so the executable is built in GitHub Actions and carried over. This script
# only runs it, against the operator's own disc image.
#
# Usage: scripts/phase0/run_checkpoints.sh <exe> <iso> <outdir> [frames] [script]
#
# The ISO is verified before anything is executed: a wrong revision produces a trace that
# looks plausible and means nothing.

set -euo pipefail

exe=${1:?usage: run_checkpoints.sh <exe> <iso> <outdir> [frames] [script]}
iso=${2:?}
out=${3:?}
frames=${4:-2400}
script=${5:-upstream/melee-unlocked/port/scripts/vs_match.txt}

EXPECTED_SIZE=1459978240
EXPECTED_SHA1=d4e70c064cc714ba8400a849cf299dbd1aa326fc

test -x "$exe" || { echo "not executable: $exe" >&2; exit 1; }
test -f "$iso" || { echo "no disc image at $iso" >&2; exit 1; }

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
timeout "${RUN_TIMEOUT:-1800}" nice -n 10 "$exe" \
  --iso "$iso" --headless --fast --frames "$frames" --time-base 1 --volume 0 \
  --script "$script" --card-dir "$out/card" \
  --state-trace "$out/trace.csv" > "$out/stdout.log" 2>&1
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
head -2 "$out/trace.csv" 2>/dev/null || true
echo "stdout tail:"
tail -5 "$out/stdout.log" 2>/dev/null || true

exit "$status"
