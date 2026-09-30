#!/usr/bin/env bash
#
# Apply the port patch series to the pinned upstream submodule.
#
# Run this once. It is idempotent -- a second run on an already patched tree reports
# "Already applied" instead of failing -- but it is deliberately not silent, because a
# patch that is skipped without saying so makes the WASM probe measure an unpatched tree
# and every number it prints meaningless.
#
# Failures are loud and carry git's own explanation: a patch that neither applies nor
# reverse-applies is a hard error, and the tree must be dirty afterwards.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
checkout="$root/upstream/melee-unlocked"
shopt -s nullglob
patches=("$root"/patches/*.patch)
((${#patches[@]})) || { echo 'No patches found' >&2; exit 1; }

applied=0
for patch in "${patches[@]}"; do
  name=$(basename "$patch")
  if forward=$(git -C "$checkout" apply --check "$patch" 2>&1); then
    git -C "$checkout" apply "$patch"
    echo "Applied: $name"
    applied=$((applied + 1))
  elif git -C "$checkout" apply --reverse --check "$patch" 2>/dev/null; then
    echo "Already applied: $name"
  else
    echo "Stale or partially applied patch: $name" >&2
    echo "$forward" >&2
    exit 1
  fi
done

# The caller compiles the WASM side from this tree. An empty diff means the series is not
# in the checkout, whatever the messages above said, so refuse to continue.
if git -C "$checkout" diff --quiet; then
  echo "No patch changed $checkout: the port series is not applied" >&2
  exit 1
fi

echo "Port series present: $applied applied in this run, $(( ${#patches[@]} - applied )) already in place"
