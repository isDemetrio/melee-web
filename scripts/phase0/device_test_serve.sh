#!/usr/bin/env bash
# One command for a device run: the spike page with its core, the disc, its piece manifest, and an
# HTTPS address the phone can open.
#
# Why a tunnel. Cross-origin isolation is a secure-context feature, so over plain HTTP on the
# tailnet IP the page's COOP/COEP headers are ignored, `crossOriginIsolated` stays false, and
# `performance.now()` stays coarsened by the browser's timer clamp -- every `sim_ms` in the trace
# would be quantised and the timing verdict worthless (`scripts/phase0/serve_spike.py` explains
# this at length). `tailscale serve` would be the tidy way and needs sudo, which this box does not
# have; the quick tunnel is the route that works. It is a public address guarded by basic auth and
# it exists only while this script runs.
#
# Usage:
#   scripts/phase0/device_test_serve.sh [--dist DIR] [--iso FILE] [--chunks FILE] [--port N]
#                                       [--password PW]
#
# --chunks is optional: it is the manifest `scripts/phase0/disc_chunks.py` writes, and serving it
# is what lets the page's "Disc cache" section download the disc into OPFS from this origin. A
# device run without it still works -- the disc comes from the file picker -- but the page then
# reports its cache as unavailable, and the OPFS path stays untested.
#
# Then, on the phone, open the printed address and follow the run protocol in
# docs/PHASE0_DEVICE_PLAN.md. Ctrl-C stops the server and the tunnel together.
set -euo pipefail

dist=/home/hermes/incoming/phase0/spike-dist
iso=/home/hermes/incoming/melee-ntsc102.iso
chunks=/home/hermes/incoming/phase0/disc-chunks.json
port=8092
password=""

while [ $# -gt 0 ]; do
  case "$1" in
    --dist) dist=$2; shift 2 ;;
    --iso) iso=$2; shift 2 ;;
    --chunks) chunks=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --password) password=$2; shift 2 ;;
    -h|--help) sed -n '2,23p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

[ -d "$dist" ] || { echo "no spike dist at $dist (build it, or pass --dist)" >&2; exit 2; }
[ -f "$iso" ] || { echo "no disc image at $iso (pass --iso)" >&2; exit 2; }
[ -f "$dist/spike-core/melee_core_web.wasm" ] || {
  echo "$dist has no spike-core/melee_core_web.wasm: that is the shell, not the spike build" >&2; exit 2; }

# The manifest is optional on purpose: it is what the page's disc cache downloads the disc
# against, but the M1/M2 procedure takes the disc from the file picker, so a missing manifest must
# warn rather than stop a device run.
chunks_arg=()
if [ -f "$chunks" ]; then
  chunks_arg=(--chunks "$chunks")
else
  echo "warning: no piece manifest at $chunks; the page will report its disc cache as unavailable" >&2
  echo "         (write one with scripts/phase0/disc_chunks.py --out "$chunks")" >&2
fi

cloudflared=$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")
[ -x "$cloudflared" ] || { echo "cloudflared not found; see docs/PHASE0_DEVICE_PLAN.md" >&2; exit 2; }

# A password a phone keyboard can type: lowercase letters and digits only. Punctuation is what
# makes these logins fail on a phone, and the address is public for as long as this runs.
# Ten characters exactly, drawn from /dev/urandom. The earlier version filtered a single 64-byte
# read, which averages about eight usable characters and once produced two: measured over 200
# draws, 110 were shorter than ten and the shortest was two, so the public address could be
# guarded by a two-character password. The truncation is done in the shell rather than by a
# second head in the pipeline, so no stage can be killed by SIGPIPE under pipefail.
if [ -z "$password" ]; then
  password=$(head -c 4096 /dev/urandom | LC_ALL=C tr -dc "a-z0-9")
  password=${password:0:10}
  [ ${#password} -eq 10 ] || { echo "could not draw a password from /dev/urandom" >&2; exit 2; }
fi

work=$(mktemp -d)
server_log="$work/server.log"
tunnel_log="$work/tunnel.log"
server_pid=""
tunnel_pid=""

cleanup() {
  [ -n "$tunnel_pid" ] && kill "$tunnel_pid" 2>/dev/null || true
  [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

python3 "$here/serve_spike.py" --dist "$dist" --iso "$iso" ${chunks_arg[@]+"${chunks_arg[@]}"} \
  --host 127.0.0.1 --port "$port" --password "$password" > "$server_log" 2>&1 &
server_pid=$!

# The server has to answer before a tunnel in front of it is worth opening.
ready=""
for _ in $(seq 1 50); do
  if curl -fsS -u "fabri:$password" -o /dev/null "http://127.0.0.1:$port/spike.html" 2>/dev/null; then
    ready=yes; break
  fi
  kill -0 "$server_pid" 2>/dev/null || { echo "the server died:" >&2; tail -20 "$server_log" >&2; exit 1; }
  sleep 0.2
done
[ -n "$ready" ] || { echo "the server never answered on 127.0.0.1:$port:" >&2; tail -20 "$server_log" >&2; exit 1; }

"$cloudflared" tunnel --no-autoupdate --url "http://127.0.0.1:$port" > "$tunnel_log" 2>&1 &
tunnel_pid=$!

url=""
for _ in $(seq 1 150); do
  url=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$tunnel_log" 2>/dev/null | head -1 || true)
  [ -n "$url" ] && break
  kill -0 "$tunnel_pid" 2>/dev/null || { echo "the tunnel died:" >&2; tail -20 "$tunnel_log" >&2; exit 1; }
  sleep 0.2
done
[ -n "$url" ] || { echo "the tunnel never printed an address:" >&2; tail -20 "$tunnel_log" >&2; exit 1; }

# The address is public, so this is the check that the guard is on and that the page arrives with
# the header the measurement needs. Two things make a single attempt a false alarm: a HEAD response
# does not carry COOP here (so ask with GET), and the tunnel prints its address a moment before it
# is connected, so the first request can come back without the headers. Retry, and warn only if it
# never appears; a missing COOP is a warning and not a stop, because the page reports
# `cross_origin_isolated` in its own result JSON and a run without isolation is visible there.
coop=no
for _ in $(seq 1 20); do
  headers=$(curl -sS -D- -o /dev/null -u "fabri:$password" "$url/spike.html" 2>/dev/null || true)
  if printf '%s\n' "$headers" | grep -qi 'cross-origin-opener-policy'; then coop=yes; break; fi
  sleep 0.5
done
[ "$coop" = yes ] || echo "warning: no COOP header after 10s; cross-origin isolation will be false" >&2

# The manifest is the one thing a device run needs only for the OPFS download, so it is checked
# and reported rather than assumed: a page that cannot read it reports the cache as unavailable.
manifest_line=""
if [ ${#chunks_arg[@]} -gt 0 ]; then
  code=$(curl -sS -o /dev/null -w '%{http_code}' -u "fabri:$password" "$url/phase0/disc-chunks" 2>/dev/null || true)
  if [ "$code" = 200 ]; then
    manifest_line="  manifest     $url/phase0/disc-chunks"
  else
    echo "warning: /phase0/disc-chunks answered $code, not 200; the disc cache will be unavailable" >&2
  fi
fi

cat <<EOF

  spike page   $url/spike.html
  disc         $url/disc.iso
EOF
# The manifest line goes on a line of its own, and only when the route answered. It used to be
# interpolated into the heredoc line that prints the user field, so a run with a manifest printed
# "manifest ... user ..." on one line.
if [ -n "$manifest_line" ]; then printf "%s\n" "$manifest_line"; fi
cat <<EOF
  user         fabri
  password     $password

  On the phone: open the page, let it take the disc from the server, run the three runs and send
  back the JSON. The protocol and the checks are in docs/PHASE0_DEVICE_PLAN.md, and the page
  reports cross_origin_isolated plus the timer resolution in that JSON.
  With the manifest above, the page's "Disc cache" section can also download the disc into OPFS
  from this origin: that is the only way to exercise the OPFS path before Cloudflare exists.

  Ctrl-C stops the server and the tunnel.
EOF

wait "$server_pid"
