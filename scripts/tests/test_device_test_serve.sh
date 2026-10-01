#!/usr/bin/env bash
#
# Guards for scripts/phase0/device_test_serve.sh -- the one command that puts the spike page, its
# core, its disc and an HTTPS address in front of a phone, and the only script under
# scripts/phase0/ that had no test at all. docs/PROGRESS.md recorded that gap twice: it needs
# cloudflared and a real tunnel, and no runner has either.
#
# How this runs in CI without a tunnel. cloudflared is a stub on PATH that prints an address of the
# shape the script greps for and then stays alive. The disc is a sparse zero file of the size the
# server insists on, outside the repository -- the fixture trick scripts/tests/test_deploy_guard.sh
# already uses -- so no ISO and no game data is involved. curl is a stub that delegates to the real
# curl everywhere except the stub tunnel address, which no certificate can exist for. Everything
# else is real: the server is the real scripts/phase0/serve_spike.py on an ephemeral port, so the
# readiness loop, the manifest handover, the basic-auth user, the printed block and the cleanup
# after Ctrl-C are exercised for real.
#
# Run with:  bash scripts/tests/test_device_test_serve.sh
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
root=$(pwd)
script="$root/scripts/phase0/device_test_serve.sh"
url="https://stub-tunnel.trycloudflare.com"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

failures=0
cases=0

fail() { echo "FAIL: $1" >&2; failures=$((failures + 1)); }
ok() { echo "ok: $1"; }

# --- fixture -----------------------------------------------------------------------------------

dist="$tmp/dist"
iso="$tmp/disc.iso"
chunks="$tmp/disc-chunks.json"
bin="$tmp/bin"
mkdir -p "$dist/spike-core" "$bin"
printf "<!doctype html><title>fixture</title>\n" >"$dist/spike.html"
printf "not a real module\n" >"$dist/spike-core/melee_core_web.wasm"

# A sparse zero file of the disc size the server insists on: 1,459,978,240 bytes, no blocks on disk.
truncate -s 1459978240 "$iso"

# The manifest is the one the real generator writes, not a hand-made object.
python3 "$root/scripts/phase0/disc_chunks.py" "$iso" --out "$chunks" >/dev/null

# The tunnel stub: an address of the shape the script greps for, then it stays alive so the script
# sees a live tunnel process.
printf "%s\n" \
  "#!/usr/bin/env bash" \
  "echo INF Requesting new quick Tunnel on trycloudflare.com" \
  "echo INF https://stub-tunnel.trycloudflare.com" \
  "sleep 900" >"$bin/cloudflared"
chmod +x "$bin/cloudflared"

# The curl stub: the tunnel address is answered from here, because the real curl could only fail on
# it -- no certificate for a stub hostname exists, and no resolver points it at this machine. The
# manifest status is an input, so the branch where the route answers something else is reachable.
real_curl=$(command -v curl)
printf "%s\n" \
  "#!/usr/bin/env bash" \
  "real=$real_curl" \
  "for arg in \"\$@\"; do" \
  "  case \"\$arg\" in https://stub-tunnel.trycloudflare.com*) tunnel=yes ;; esac" \
  "done" \
  "if [ \"\${tunnel:-}\" = yes ]; then" \
  "  for arg in \"\$@\"; do" \
  "    case \"\$arg\" in *disc-chunks*) printf %s \"\${STUB_MANIFEST_CODE:-200}\"; exit 0 ;; esac" \
  "  done" \
  "  printf \"HTTP/1.1 200 OK\r\nCross-Origin-Opener-Policy: same-origin\r\n\r\n\"" \
  "  exit 0" \
  "fi" \
  "exec \"\$real\" \"\$@\"" >"$bin/curl"
chmod +x "$bin/curl"

# --- helpers -----------------------------------------------------------------------------------

# A refusal: the script must exit with the expected status and say why.
refuse() {
  label=$1; want=$2; text=$3; shift 3
  set +e
  out=$("$@" 2>&1)
  status=$?
  set -e
  if [ "$status" -ne "$want" ]; then
    fail "$label: exited $status, expected $want"
    printf "%s\n" "$out" | sed "s/^/    /" >&2
    return
  fi
  if printf "%s\n" "$out" | grep -qF -- "$text"; then
    ok "$label"
  else
    fail "$label: the message does not mention $text"
    printf "%s\n" "$out" | sed "s/^/    /" >&2
  fi
}

# Wait until a file holds a literal string, or give up after a bounded number of polls.
await_text() {
  file=$1; text=$2; tries=${3:-200}
  for _ in $(seq 1 "$tries"); do
    grep -qF -- "$text" "$file" 2>/dev/null && return 0
    sleep 0.2
  done
  return 1
}

# One run of the script in the background, its two streams in files of their own.
start_run() {
  out="$tmp/out.txt"; err="$tmp/err.txt"
  : >"$out"; : >"$err"
  env PATH="$bin:$PATH" bash "$script" "$@" >"$out" 2>"$err" &
  runner=$!
}

# Ctrl-C, as the operator sends it. If the script survives it the case fails: that is the cleanup
# being broken, not a reason to hang the suite.
stop_run() {
  kill -TERM "$runner" 2>/dev/null || true
  for _ in $(seq 1 100); do
    kill -0 "$runner" 2>/dev/null || return 0
    sleep 0.1
  done
  fail "the script was still running ten seconds after Ctrl-C"
  return 1
}

# A port nothing is listening on. bash can open a TCP connection to it and fail, which is all this
# needs; the window between the check and the script binding it is a few milliseconds.
free_port() {
  candidate=0
  for _ in $(seq 1 20); do
    candidate=$((20000 + RANDOM % 20000))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$candidate") 2>/dev/null; then
      echo "$candidate"
      return 0
    fi
  done
  echo "no free port found" >&2
  return 1
}

# --- 1. the usage text -------------------------------------------------------------------------
cases=$((cases + 1))
set +e
usage=$(PATH="$bin:$PATH" bash "$script" --help 2>&1)
usage_status=$?
set -e
if [ "$usage_status" -ne 0 ]; then
  fail "--help exited $usage_status"
elif printf "%s\n" "$usage" | grep -qF -- "Usage:" && printf "%s\n" "$usage" | grep -qF -- "--chunks is optional"; then
  ok "--help prints the usage block"
else
  fail "--help does not print the usage block: the sed line range in the script may have drifted"
fi

# --- 2. the refusals ---------------------------------------------------------------------------
cases=$((cases + 1))
refuse "an unknown argument" 2 "unknown argument: --nope" \
  env PATH="$bin:$PATH" bash "$script" --nope
refuse "a missing dist" 2 "no spike dist at" \
  env PATH="$bin:$PATH" bash "$script" --dist "$tmp/nothing" --iso "$iso"
refuse "a missing disc image" 2 "no disc image at" \
  env PATH="$bin:$PATH" bash "$script" --dist "$dist" --iso "$tmp/nothing.iso"

# A dist with no core in it is the shell, not the spike build: the run would serve a page that
# cannot load its module.
shell_dist="$tmp/shell"
mkdir -p "$shell_dist"
printf "<!doctype html><title>shell</title>\n" >"$shell_dist/index.html"
refuse "a dist without the spike core" 2 "that is the shell, not the spike build" \
  env PATH="$bin:$PATH" bash "$script" --dist "$shell_dist" --iso "$iso"

# cloudflared nowhere: neither on PATH nor in the per-user bin directory, which is where this VPS
# keeps it. HOME is emptied for this case, so the check is about the script and not about the
# machine the suite runs on.
refuse "no cloudflared anywhere" 2 "cloudflared not found" \
  env -i HOME="$tmp/empty-home" PATH=/usr/bin:/bin bash "$script" --dist "$dist" --iso "$iso"

# --- 3. the run with the manifest: the block, the password, the cleanup -------------------------
cases=$((cases + 1))
port=$(free_port)
start_run --dist "$dist" --iso "$iso" --chunks "$chunks" --port "$port"
if await_text "$out" "password"; then
  ok "the script printed its block with the manifest served"
  reached=yes
else
  fail "the script never printed its block"
  sed "s/^/    /" "$out" "$err" >&2
  reached=no
fi
if [ "$reached" = yes ]; then
  grep -qF -- "  spike page   $url/spike.html" "$out" || fail "the block does not name the page over the tunnel"
  grep -qF -- "  disc         $url/disc.iso" "$out" || fail "the block does not name the disc over the tunnel"
  grep -qE "^  manifest +$url/phase0/disc-chunks" "$out" || fail "the block does not name the manifest over the tunnel"
  grep -qE "^  user +fabri$" "$out" || fail "the user line is not on a line of its own"
  password=$(sed -n "s/^  password *//p" "$out" | head -1)
  if printf "%s" "$password" | grep -qE "^[a-z0-9]{10}$"; then
    ok "the generated password is ten lowercase alphanumeric characters"
  else
    fail "the generated password is not ten lowercase alphanumeric characters: $password"
  fi
  if grep -qF -- "warning" "$err"; then
    fail "a run with a live tunnel and a served manifest warned about something"
    sed "s/^/    /" "$err" >&2
  fi
  code=$(curl -sS -o /dev/null -w "%{http_code}" -u "fabri:$password" "http://127.0.0.1:$port/phase0/disc-chunks" || true)
  [ "$code" = 200 ] || fail "the local server answered $code to the manifest route, so the manifest never reached it"
  curl -sS -f -o /dev/null -u "fabri:$password" "http://127.0.0.1:$port/spike.html" || fail "the page is not served with the generated password"
fi
stop_run || true
if curl -sS -o /dev/null --max-time 2 "http://127.0.0.1:$port/spike.html" 2>/dev/null; then
  fail "the server still answers on 127.0.0.1:$port after the script was stopped"
else
  ok "the server stopped with the script"
fi
if pgrep -f "tunnel --no-autoupdate" >/dev/null 2>&1; then
  fail "the tunnel stub survived the script"
else
  ok "the tunnel stub stopped with the script"
fi

# --- 4. the run without the manifest, and a password given on the command line ------------------
cases=$((cases + 1))
port=$(free_port)
start_run --dist "$dist" --iso "$iso" --chunks "$tmp/no-manifest.json" --port "$port" --password devpass1234
if await_text "$out" "password"; then
  ok "the script printed its block without a manifest"
  reached=yes
else
  fail "the script never printed its block without a manifest"
  sed "s/^/    /" "$out" "$err" >&2
  reached=no
fi
if [ "$reached" = yes ]; then
  grep -qF -- "  password     devpass1234" "$out" || fail "the password given on the command line is not the one printed"
  grep -qE "^  user +fabri$" "$out" || fail "the user line is not on a line of its own"
  if grep -qE "^  manifest +" "$out"; then fail "the block names a manifest that was never served"; fi
  grep -qF -- "warning: no piece manifest at" "$err" || fail "a missing manifest did not warn"
fi
stop_run || true

# --- 5. the manifest route answering something other than 200 ----------------------------------
cases=$((cases + 1))
port=$(free_port)
export STUB_MANIFEST_CODE=500
start_run --dist "$dist" --iso "$iso" --chunks "$chunks" --port "$port"
unset STUB_MANIFEST_CODE
if await_text "$out" "password"; then
  grep -qF -- "warning: /phase0/disc-chunks answered 500, not 200" "$err" || fail "a manifest route answering 500 did not warn"
  if grep -qE "^  manifest +" "$out"; then fail "the block names a manifest that answered 500"; fi
  ok "the manifest route is reported when it answers 500"
else
  fail "the script never printed its block when the manifest route answered 500"
  sed "s/^/    /" "$out" "$err" >&2
fi
stop_run || true

# --- 6. a dist that never answers the readiness probe ------------------------------------------
# The script waits for the page before it opens a tunnel. A dist with no spike.html never answers,
# and the run has to stop with that named rather than put a tunnel in front of a 404.
cases=$((cases + 1))
nopage="$tmp/no-page"
mkdir -p "$nopage/spike-core"
printf "not a real module\n" >"$nopage/spike-core/melee_core_web.wasm"
port=$(free_port)
set +e
out=$(env PATH="$bin:$PATH" bash "$script" --dist "$nopage" --iso "$iso" --port "$port" 2>&1)
status=$?
set -e
if [ "$status" -eq 1 ] && printf "%s\n" "$out" | grep -qF -- "the server never answered on 127.0.0.1:$port"; then
  ok "a dist that never answers stops the run"
else
  fail "a dist that never answers exited $status without naming the readiness probe"
  printf "%s\n" "$out" | sed "s/^/    /" >&2
fi

# --- summary -----------------------------------------------------------------------------------

if [ "$failures" -ne 0 ]; then
  echo "$failures assertions failed" >&2
  exit 1
fi
echo "the device tunnel script passed $cases cases"
