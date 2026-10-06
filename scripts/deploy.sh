#!/usr/bin/env bash
#
# Deploy the built browser shell to Cloudflare Pages.
#
# This is the only script in the repository that publishes something to the internet, so it
# fails closed: it refuses to run without credentials, with a dirty working tree, or with a
# dist directory that is missing the Pages `_headers` file (the COOP/COEP headers the
# shared-memory ring buffer depends on). Every refusal names what is missing and where it is
# documented.
#
# The credentials are read from the environment and are never echoed: `wrangler` takes them
# from CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID itself, so they do not appear on a
# command line, in a log, or in `--dry-run` output.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CF_PAGES_PROJECT=melee-web \
#     scripts/deploy.sh [--dry-run] [--branch <name>] [--repo-dir <dir>] [--dist-dir <dir>]
#
# --dry-run prints the command it would run and exits 0. It is what CI and
# scripts/tests/test_deploy_guard.sh exercise; nothing here has ever been run against a real
# Cloudflare account (docs/OPEN_QUESTIONS.md Q3).
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
dry_run=false
branch=""
repo_dir="$root"
dist_dir="$root/web/dist"
wrangler_package="wrangler@4"

while (($#)); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --branch) branch="${2:?--branch needs a value}"; shift ;;
    --repo-dir) repo_dir="${2:?--repo-dir needs a value}"; shift ;;
    --dist-dir) dist_dir="${2:?--dist-dir needs a value}"; shift ;;
    -h | --help) sed -n '2,22p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 64 ;;
  esac
  shift
done

refuse() {
  echo "deploy refused: $1" >&2
  exit "$2"
}

# 1. Credentials. A missing one is a configuration fault, not a reason to deploy anyway.
missing=()
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || missing+=("CLOUDFLARE_API_TOKEN")
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || missing+=("CLOUDFLARE_ACCOUNT_ID")
[ -n "${CF_PAGES_PROJECT:-}" ] || missing+=("CF_PAGES_PROJECT")
if ((${#missing[@]})); then
  echo "deploy refused: not set: ${missing[*]}" >&2
  echo "  They are GitHub secrets/variables in CI and local environment variables for a" >&2
  echo "  manual deploy. Nothing is deployed without them: docs/DEPLOY.md, Q3." >&2
  exit 2
fi

# 2. Working tree. A deploy has to correspond to a commit, otherwise the published shell
#    cannot be reproduced or rolled back to. The question is put to git rather than to the
#    filesystem: in a linked worktree -- and this repository is worked in worktrees -- `.git`
#    is a file, not a directory, so `[ -d "$repo_dir/.git" ]` refused a clean worktree with
#    "is not a git checkout", while accepting a clone. `git -C` answers for both.
if ! git -C "$repo_dir" rev-parse --git-dir >/dev/null 2>&1; then
  refuse "$repo_dir is not a git checkout" 3
fi
dirty=$(git -C "$repo_dir" status --porcelain)
if [ -n "$dirty" ]; then
  echo "deploy refused: $repo_dir has uncommitted changes" >&2
  echo "$dirty" >&2
  echo "  Commit or stash them first: the deployed shell must be a commit." >&2
  exit 3
fi

# 3. The artifact itself. web/dist without _headers would deploy a shell that cannot use
#    SharedArrayBuffer, and the failure would only show up in the browser.
if [ ! -f "$dist_dir/_headers" ]; then
  refuse "$dist_dir/_headers is missing; run scripts/build_web.sh first" 4
fi
if [ ! -f "$dist_dir/index.html" ]; then
  refuse "$dist_dir/index.html is missing; run scripts/build_web.sh first" 4
fi

# 4. Branch name: Pages uses it to decide production (the project's production branch)
#    versus preview.
if [ -z "$branch" ]; then
  branch=$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [ -n "$branch" ] && [ "$branch" != "HEAD" ] || branch=main
fi

command=(npx --yes --package="$wrangler_package" wrangler pages deploy "$dist_dir"
  --project-name "$CF_PAGES_PROJECT" --branch "$branch")

if [ "$dry_run" = true ]; then
  echo "dry run: nothing is deployed"
  echo "  project: $CF_PAGES_PROJECT (branch: $branch)"
  echo "  dist:    $dist_dir"
  printf '  command:'
  printf ' %q' "${command[@]}"
  printf '\n'
  exit 0
fi

command -v npx >/dev/null || refuse "npx is not on PATH; deploy from a machine with Node" 5

echo "deploying $dist_dir to Pages project $CF_PAGES_PROJECT on branch $branch"
"${command[@]}"
echo "deployed. Check the deployment in the Cloudflare dashboard; rollback steps: docs/DEPLOY.md"
