#!/usr/bin/env bash
# Upload the verified NTSC 1.02 ISO and freshly generated chunk JSON to private R2.
# Dry run by default; --apply is required for network writes.
# Usage: upload_disc.sh --iso PATH --out /outside/repo/disc-chunks.json [--apply]
# Options: --bucket NAME (default melee-phase0-disc), --dry-run.
# Required even in dry run: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID,
# R2_SECRET_ACCESS_KEY. No Cloudflare API token is used for S3 authentication.
# Fixed object keys: melee-ntsc102.iso, disc-chunks.json (uploaded last).
# Keep the ISO unchanged during validation/upload. No chunk files are written.
# curl is the plan's fallback: rclone was absent on the implementation VPS.
# R2 supports single-part uploads up to 5 GiB (verified 2026-09-30):
# https://developers.cloudflare.com/r2/platform/limits/
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
iso="/home/hermes/incoming/melee-ntsc102.iso"
manifest="/home/hermes/incoming/phase0/disc-chunks.json"
bucket="melee-phase0-disc"
apply=false
while (($#)); do
  case "$1" in
    --apply) apply=true ;;
    --dry-run) apply=false ;;
    --iso) iso="${2:?--iso needs a value}"; shift ;;
    --out) manifest="${2:?--out needs a value}"; shift ;;
    --bucket) bucket="${2:?--bucket needs a value}"; shift ;;
    -h | --help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done
refuse() {
  echo "upload refused: $1" >&2
  exit "$2"
}
missing=()
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || missing+=("CLOUDFLARE_ACCOUNT_ID")
[ -n "${R2_ACCESS_KEY_ID:-}" ] || missing+=("R2_ACCESS_KEY_ID")
[ -n "${R2_SECRET_ACCESS_KEY:-}" ] || missing+=("R2_SECRET_ACCESS_KEY")
((${#missing[@]} == 0)) || refuse "not set: ${missing[*]}" 2
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[a-zA-Z0-9]+$ ]] || refuse "invalid account ID" 2
[[ "$bucket" =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || refuse "invalid bucket name" 2
command -v python3 >/dev/null || refuse "python3 is needed" 2
[ -f "$iso" ] || refuse "ISO not found: $iso" 3
# Recompute the JSON from the actual ISO; never trust a supplied/stale manifest.
python3 "$root/scripts/phase0/disc_chunks.py" "$iso" --out "$manifest" --verify-disc ||
  refuse "ISO verification or JSON generation failed" 3
endpoint="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/$bucket"
if [ "$apply" != true ]; then
  echo "dry run: nothing is uploaded"
  echo "  PUT $iso -> $endpoint/melee-ntsc102.iso"
  echo "  PUT $manifest -> $endpoint/disc-chunks.json"
  echo "  run with --apply to upload"
  exit 0
fi
command -v curl >/dev/null || refuse "curl with --aws-sigv4 is needed" 5
curl --disable --help all | grep -q -- '--aws-sigv4' || refuse "curl lacks --aws-sigv4" 5
put() {
  local key="$1" file="$2" content_type="$3"
  echo "  put $key"
  # Supply credentials over stdin, not argv or a persistent config file.
  python3 - <<'PY' | curl --disable --config - --fail --silent --show-error \
    --aws-sigv4 'aws:amz:auto:s3' --proto '=https' \
    --header 'x-amz-content-sha256: UNSIGNED-PAYLOAD' \
    --header "Content-Type: $content_type" --header 'Cache-Control: no-store' \
    --upload-file "$file" --url "$endpoint/$key"
import json
import os
print("user = " + json.dumps(os.environ["R2_ACCESS_KEY_ID"] + ":" +
                             os.environ["R2_SECRET_ACCESS_KEY"]))
PY
}
put melee-ntsc102.iso "$iso" application/octet-stream
put disc-chunks.json "$manifest" application/json
echo "uploaded ISO and chunk JSON to $bucket"
