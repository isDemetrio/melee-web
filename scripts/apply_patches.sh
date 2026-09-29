#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
checkout="$root/upstream/melee-unlocked"
shopt -s nullglob
patches=("$root"/patches/*.patch)
((${#patches[@]})) || { echo 'No patches found' >&2; exit 1; }
for patch in "${patches[@]}"; do
  if git -C "$checkout" apply --check "$patch"; then
    git -C "$checkout" apply "$patch"
  elif git -C "$checkout" apply --reverse --check "$patch"; then
    echo "Already applied: $(basename "$patch")"
  else
    echo "Stale or partially applied patch: $patch" >&2
    exit 1
  fi
done
