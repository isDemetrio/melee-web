#!/usr/bin/env bash
# Shared private-DOL pipeline. Outputs stay outside the checkout; no artifact upload.
set -euo pipefail
mode=${1:?offline, release or both}
out=${2:?external output directory}
case "$mode" in offline|release|both) ;; *) exit 2 ;; esac
: "${RUNNER_TEMP:?}" "${GITHUB_WORKSPACE:?}" "${GH_TOKEN:?DOL_REPO_TOKEN is required}"
case "$(realpath -m "$out")" in
  "$(realpath "$GITHUB_WORKSPACE")"/*) echo 'generated tree inside checkout' >&2; exit 1 ;;
esac
test "$(git -C upstream/melee-unlocked rev-parse HEAD)" = 3aab7172db243c159afa76ecb2c564b3de8e4c0a
mkdir -p "$RUNNER_TEMP/dol" "$out"
gh api repos/isDemetrio/melee-orig-dol/contents/main.dol \
  -H 'Accept: application/vnd.github.raw' > "$RUNNER_TEMP/dol/main.dol"
test "$(stat -c%s "$RUNNER_TEMP/dol/main.dol")" = 4425184
echo "08e0bf20134dfcb260699671004527b2d6bb1a45  $RUNNER_TEMP/dol/main.dol" | sha1sum -c -
scripts/apply_patches.sh
if [[ "$mode" == both ]]; then
  python3 upstream/melee-unlocked/port/recomp/recomp.py \
    --dol "$RUNNER_TEMP/dol/main.dol" --out "$out-release" --gct-base 0x8065CC80 \
    | tee "$RUNNER_TEMP/recomp-release.log"
  ! grep -q 'skipped: pass --gct-base' "$RUNNER_TEMP/recomp-release.log"
  test "$(find "$out-release" -maxdepth 1 -name 'guest_*.cpp' ! -name guest_table.cpp | wc -l)" = 144
  test "$(grep -h -c '^void f_' "$out-release"/guest_*.cpp | awk '{s+=$1} END {print s}')" = 20076
  grep -q 'image 7883e197ff19' "$RUNNER_TEMP/recomp-release.log"
  mode=offline
fi
args=(--gct-base 0x8065CC80)
if [[ "$mode" == offline ]]; then args=(--no-slippi); fi
python3 upstream/melee-unlocked/port/recomp/recomp.py \
  --dol "$RUNNER_TEMP/dol/main.dol" --out "$out" "${args[@]}" | tee "$RUNNER_TEMP/recomp.log"
test -f "$out/guest_sources.cmake"
if [[ "$mode" == release ]]; then
  ! grep -q 'skipped: pass --gct-base' "$RUNNER_TEMP/recomp.log"
fi
