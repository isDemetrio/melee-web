#!/usr/bin/env bash
#
# Build the browser shell into web/dist, the directory scripts/deploy.sh uploads.
#
# Run this where Node exists: the operator's laptop, a Codespace, or CI. Never on the VPS,
# which has no compiler and 3.7 GB of RAM (docs/AGENT_RULES.md rules 2 and 3).
#
# It refuses to leave behind a dist that cannot be deployed: Pages needs the `_headers`
# file (COOP/COEP, which SharedArrayBuffer and the ring buffer depend on), and the shell
# budget is checked after the build so a regression fails here rather than in the browser.
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
web="$root/web"
dist="$web/dist"
budget_kb="${SHELL_BUDGET_KB:-1024}"

command -v npm >/dev/null || {
  echo "build refused: npm is not on PATH; build where Node is installed (docs/DEPLOY.md)" >&2
  exit 2
}

cd "$web"
if [ -f package-lock.json ]; then
  npm ci --no-audit --no-fund
else
  echo "no package-lock.json: installing without one. Commit the lockfile CI uploads." >&2
  npm install --no-audit --no-fund
fi

npx tsc --noEmit
npx vitest run
npx vite build

[ -f "$dist/_headers" ] || {
  echo "build failed: $dist/_headers is missing, so the shell would deploy without COOP/COEP" >&2
  exit 3
}
[ -f "$dist/index.html" ] || {
  echo "build failed: $dist/index.html is missing" >&2
  exit 3
}

node scripts/check-bundle-size.mjs --dir "$dist" --budget-kb "$budget_kb"
echo "built $dist (first-load shell budget: ${budget_kb} KB)"
