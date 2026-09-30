#!/usr/bin/env bash
# Compiler launcher; serialize only CSV writes, never compiler processes.
set -euo pipefail
: "${MELEE_COMPILE_CSV:?}"
source_file=unknown
object_file=
previous=
for arg in "$@"; do
  if [[ "$previous" == -o ]]; then object_file=$arg; fi
  case "$arg" in *.cpp) source_file=$(basename "$arg") ;; esac
  previous=$arg
done
metrics=$(mktemp)
trap 'rm -f "$metrics"' EXIT
status=0
/usr/bin/time -f '%e,%M' -o "$metrics" "$@" || status=$?
bytes=0
if [[ "$status" == 0 && -f "$object_file" ]]; then bytes=$(stat -c%s "$object_file"); fi
# GNU time adds a status line on failure; its final line always holds the metrics.
{
  flock 9
  printf '%s,%s,%s,%s\n' "$source_file" "$(tail -n 1 "$metrics")" "$bytes" "$status" >&9
} 9>>"$MELEE_COMPILE_CSV"
exit "$status"
