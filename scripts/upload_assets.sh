#!/usr/bin/env bash
#
# Upload the generated asset manifest and its content-addressed blob store to R2.
#
# Dry run by default: it prints what it would upload and, when given a listing of the
# bucket, exactly which objects are missing. The real upload path (`--apply`) refuses to run
# without CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, because a half-finished upload of
# disc-derived files is worse than none: the client would see a manifest naming objects that
# are not there.
#
# Objects are content-addressed (`<sha256 of the uncompressed bytes>.bin`), so a re-run
# uploads nothing new and nothing has to be invalidated. The blobs are stored gzip-encoded
# only when the manifest says so, and the gzip stream is decoded by the client
# (`DecompressionStream('gzip')`), which is why no Content-Encoding is set on the object:
# the HTTP layer must hand the stored bytes over untouched or the hash check fails.
#
# Usage:
#   scripts/upload_assets.sh                                   # dry run, prints the plan
#   scripts/upload_assets.sh --listing objects.txt             # dry run, names what is missing
#   scripts/upload_assets.sh --apply                           # upload (needs credentials)
#
# Options: --manifest <path> (default assets/manifest.json), --store <dir> (default
# assets/store), --bucket <name> (default melee-web-assets), --listing <file>,
# --limit <n> (keys printed per group in a dry run, default 10).
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
manifest="$root/assets/manifest.json"
store="$root/assets/store"
bucket="${R2_BUCKET:-melee-web-assets}"
listing=""
limit=10
apply=false

while (($#)); do
  case "$1" in
    --apply) apply=true ;;
    --manifest) manifest="${2:?--manifest needs a value}"; shift ;;
    --store) store="${2:?--store needs a value}"; shift ;;
    --bucket) bucket="${2:?--bucket needs a value}"; shift ;;
    --listing) listing="${2:?--listing needs a value}"; shift ;;
    --limit) limit="${2:?--limit needs a value}"; shift ;;
    -h | --help) sed -n '2,25p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

refuse() {
  echo "upload refused: $1" >&2
  exit "$2"
}

command -v python3 >/dev/null || refuse "python3 is needed to read the manifest" 2
[ -f "$manifest" ] || refuse "$manifest not found; run scripts/make_manifest.py first" 2

# The manifest is the contract the client fetches, so it is checked before anything is
# uploaded. A manifest that fails its own schema means the generator and the client disagree.
if ! python3 "$root/scripts/make_manifest.py" --check "$manifest" >/dev/null; then
  python3 "$root/scripts/make_manifest.py" --check "$manifest" >&2 || true
  refuse "$manifest is not a valid manifest" 2
fi

# One `key<TAB>path<TAB>size` line per object, plus a final line for the manifest itself.
plan=$(python3 - "$manifest" "$store" <<'PY'
import json, pathlib, sys

manifest = json.loads(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))
store = pathlib.Path(sys.argv[2])
seen: set[str] = set()
total = 0
for entry in manifest["entries"]:
    key = entry["stored"]
    if key in seen:
        continue
    seen.add(key)
    path = store / key
    if not path.is_file():
        print(f"MISSING\t{key}\t{path}\t{entry['size']}")
        continue
    print(f"OBJECT\t{key}\t{path}\t{path.stat().st_size}")
    total += path.stat().st_size
print(f"MANIFEST\tmanifest.json\t{sys.argv[1]}\t0")
print(f"TOTAL\t{len(seen)}\t{total}\t0")
PY
)

if grep -q '^MISSING' <<<"$plan"; then
  echo "upload refused: the store does not hold every object the manifest names" >&2
  grep '^MISSING' <<<"$plan" | awk -F'\t' '{print "  missing: " $2 " (expected at " $3 ")"}' >&2
  echo "  Re-run scripts/make_manifest.py without --no-store." >&2
  exit 3
fi

if [ -n "$listing" ]; then
  [ -f "$listing" ] || refuse "$listing not found" 2
  to_upload=$(awk -F'\t' 'NR==FNR {have[$1]; next} $1=="OBJECT" && !($2 in have) {n++} END {print n+0}' "$listing" <<<"$plan")
else
  to_upload="unknown"
fi

if [ "$apply" != true ]; then
  objects=$(grep -c '^OBJECT' <<<"$plan" || true)
  bytes=$(grep '^TOTAL' <<<"$plan" | cut -f3 || true)
  echo "dry run: nothing is uploaded"
  echo "  manifest: $manifest"
  echo "  bucket:   $bucket"
  echo "  objects:  $objects distinct blob(s), $bytes bytes stored"
  echo "  to upload: $to_upload (\"unknown\" means no --listing was given, so the bucket was not compared)"
  grep '^OBJECT' <<<"$plan" | head -n "$limit" | awk -F'\t' '{print "    " $2}'
  if [ "$objects" -gt "$limit" ]; then
    echo "    ... and $((objects - limit)) more"
  fi
  echo "  run with --apply to upload (needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID)"
  exit 0
fi

missing=()
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || missing+=("CLOUDFLARE_API_TOKEN")
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || missing+=("CLOUDFLARE_ACCOUNT_ID")
if ((${#missing[@]})); then
  echo "upload refused: not set: ${missing[*]}" >&2
  echo "  docs/DEPLOY.md, Q3. Nothing is uploaded without them." >&2
  exit 2
fi
command -v npx >/dev/null || refuse "npx is not on PATH; upload from a machine with Node" 5

put() {
  local key="$1" file="$2" content_type="$3" cache_control="$4"
  echo "  put $key"
  npx --yes --package=wrangler@4 wrangler r2 object put "$bucket/$key" \
    --file "$file" --content-type "$content_type" --cache-control "$cache_control" --remote
}

while IFS=$'\t' read -r kind key file _size; do
  case "$kind" in
    OBJECT) put "$key" "$file" "application/octet-stream" "public, max-age=31536000, immutable" ;;
    MANIFEST) put "$key" "$file" "application/json" "public, max-age=300" ;;
  esac
done <<<"$plan"

echo "uploaded to $bucket. The Function reads the manifest at key manifest.json."
