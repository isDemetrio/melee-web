# Deploy

How the three deployable pieces of this project get to Cloudflare, what the operator has to
set up once, and how to undo a deploy.

**The deployment commands below have not been executed by this implementation agent.** There is no Cloudflare account login and no API
token in this repository's CI, so every command below is written from the documentation and
reviewed, not run (`docs/OPEN_QUESTIONS.md` Q3). What *is* verified by CI is the part that
decides whether an unattended run can publish anything: the guard tests in
`scripts/tests/test_deploy_guard.sh` prove that `scripts/deploy.sh` and
`scripts/upload_assets.sh` refuse to act without credentials, with a dirty tree, with an
incomplete dist, or with a manifest naming objects that are not in the store.

## 1. What gets deployed, and where it lives

| Piece | Where | Built by |
| --- | --- | --- |
| Browser shell (HTML/CSS/JS) | Cloudflare Pages project `melee-web`, static | `scripts/build_web.sh` |
| Pages Functions (`/api/*`) | Same Pages project, `functions/` directory | Pages build, no separate step |
| Asset manifest + blob store | R2 bucket `melee-web-assets`, key `manifest.json` and `<sha256>.bin` | `scripts/make_manifest.py`, uploaded by `scripts/upload_assets.sh` |
| The game core (`melee.wasm`) | Nothing to deploy yet | Does not exist: no disc image, no DOL (`docs/OPEN_QUESTIONS.md` Q1) |

`wrangler.toml` names the project, points Pages at `web/dist`, and binds the R2 bucket as
`ASSETS_R2`. The Function `functions/api/asset-manifest.ts` reads the key `manifest.json`
from that binding; the blobs themselves are **not** served through Pages.

## 2. One-time setup (operator, in the dashboard)

1. **Pages project** `melee-web`, production branch `main`. Either created in the dashboard
   or by the first `wrangler pages deploy`; the first deploy of a new project name creates it.
2. **R2 bucket** `melee-web-assets`, private (no `r2.dev` public access).
3. **R2 custom domain** for that bucket, e.g. `assets.<your-domain>`, plus a CORS rule
   allowing `GET` from the Pages domain. The shell is served with COOP/COEP
   (`web/public/_headers`), so cross-origin responses also need
   `Cross-Origin-Resource-Policy: cross-origin` — Cloudflare's "Response Header Transform
   Rule" is the place for that. This is the URL that becomes the manifest's `baseUrl`.
4. **Pages project settings**: bind the R2 bucket to `ASSETS_R2`, and set the environment
   variables the Functions read (`functions/types.ts`): `TURN_KEY_ID`,
   `TURN_KEY_API_TOKEN`, `TURN_TTL_SECONDS`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`.
   `.dev.vars.example` lists the same names for local development.
5. **Cloudflare Access**: an Access application covering both the Pages domain and the R2
   custom domain, so nothing is reachable by anyone who is not on the allow-list. The
   Functions validate the Access JWT against `ACCESS_AUD` / `ACCESS_TEAM_DOMAIN`.
6. **TURN**: a Cloudflare Realtime TURN key ID and API token, for
   `/api/turn-credentials`.
7. **Supabase**: project URL, anon key (client) and service key (server only), with RLS on
   the signalling tables. Signalling falls back to `BroadcastChannel` between two tabs when
   Supabase is not configured, which is how the browser tests run.
8. **GitHub**: repository secrets `CLOUDFLARE_API_TOKEN` (Pages + R2 + Realtime TURN
   permissions) and `CLOUDFLARE_ACCOUNT_ID`; repository variable `CF_PAGES_PROJECT`
   (`melee-web`). The deploy job in `.github/workflows/ci.yml` skips itself with a notice
   while they are absent, so the workflow is green before they exist.

## 3. The deploy path, in order

```bash
# 1. Build the shell. Never on the VPS: it has no Node and 3.7 GB of RAM.
scripts/build_web.sh                       # -> web/dist, checks _headers and the 1 MB budget

# 2. Assets. Requires the operator's own ISO; the extraction scripts of
#    docs/PLAN_BREAKDOWN.md T8 are not written yet, so this step is documented only.
#    python scripts/extract_fs.py ~/private/melee.iso assets-extracted
python scripts/make_manifest.py --assets assets-extracted --out assets/manifest.json \
  --base-url https://assets.<your-domain>

# 3. Look before uploading: the dry run is the default and needs no credentials.
scripts/upload_assets.sh --listing objects.txt
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... scripts/upload_assets.sh --apply

# 4. Publish the shell. Refuses a dirty tree, a missing dist/_headers, missing credentials.
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... CF_PAGES_PROJECT=melee-web \
  scripts/deploy.sh --branch main
```

`scripts/deploy.sh --dry-run` prints the exact wrangler command without running it; the
token is read from the environment by wrangler and never appears on a command line or in the
dry-run output.

In CI the same deploy job runs after `web` and `e2e` on the same workflow, so a shell that
CI has not verified is never published.

### Manifest and blob format (what the uploader assumes)

- One JSON document, `assets/manifest.json`, validated against `scripts/manifest_schema.json`
  by `python scripts/make_manifest.py --check assets/manifest.json`. Byte-identical between
  runs: sorted keys, ASCII, LF, no timestamp unless `--generated-at` is passed.
- Each entry: `path`, `sha256` and `size` of the **uncompressed** file, `group`, `stored`
  (`<sha256>.bin`, the R2 key) and `encoding`.
- `encoding` is `gzip` or `identity`. The plan (`docs/SPEC_PIANO.md` §2.3) allows Brotli or
  gzip; only gzip is implemented, because gzip is the one Python's standard library can
  produce and the browser can decode in the client (`DecompressionStream('gzip')`) while
  still hashing exactly the bytes the manifest describes. A Brotli encoder would be a new
  dependency or an external tool, and the choice is worth revisiting when the pipeline first
  runs against a real disc.
- Blobs are uploaded **without** `Content-Encoding`: the client decodes them itself and
  checks the SHA-256 of the uncompressed bytes, so the HTTP layer must hand the stored bytes
  over untouched.
- Content-addressed keys mean a re-run uploads nothing new and nothing is ever invalidated;
  `wrangler r2 object put` takes one object at a time and is limited to 315 MB per object,
  which is enough for every file class in the plan except possibly the movies (`.thp`), for
  which `rclone` against the S3 endpoint is the documented fallback.

## 4. Rollback

- **Shell**: the Pages dashboard, *Workers & Pages* → `melee-web` → *Deployments* → the
  three-dot menu on the previous deployment → *Rollback*. This is the documented Pages path;
  the `wrangler rollback` command that exists in the CLI rolls back a **Worker version**, and
  whether it applies to a Pages project has not been verified here. The equivalent,
  reproducible alternative is to check out the commit whose shell was good and run
  `scripts/deploy.sh` again — the shell is a build of a commit and nothing else.
- **Assets**: nothing to roll back. Objects are content-addressed and immutable; a wrong
  manifest is replaced by re-running `scripts/make_manifest.py` and
  `scripts/upload_assets.sh --apply`, and the previous manifest can be fetched from the
  bucket before overwriting it if needed.
- **Functions**: deployed with the shell, so the same rollback applies.

## 5. What is not verified

- Every command in section 3: no account, no token, no ISO. The guard tests cover the
  refusal paths only, plus `--dry-run` output.
- The R2 custom domain, the CORS rule and the CORP transform rule: described from the
  documentation, never applied to an account.
- The client side of the asset path (fetch by manifest, cache in OPFS, hand bytes to the
  core) is not written yet. `web/src/types.ts` types the manifest; nothing fetches it.
- The Pages Functions bundle and their tests are green in CI; the deployed behaviour with a
  real Access JWT, a real TURN key and a real R2 binding is untested.

## 6. The Phase 0 spike preview (a separate Pages branch)

The Phase 0 spike page is published as a **preview** of the same Pages project, on the branch
`phase0-spike`, so it gets its own address and inherits nothing from the production shell (no
service worker, no site data). It is not the product: `docs/PHASE0_DEPLOY_PLAN.md` section 3 says
why, and section 5 PR 5 is the change that added the step.

### Access configuration and “consenso, poi Error Forbidden”

Operator report (2026-10-02): the preview at
`https://phase0-spike.melee-web.pages.dev/spike.html` shows **“consenso, poi Error Forbidden”**
after a successful Access login. The old middleware returned `403 {"error":"Forbidden"}`
even when its trust configuration was missing; the login alone does not configure the Function.

In **Cloudflare → Workers & Pages → `melee-web` → Settings → Variables and Secrets**,
select the **Preview (anteprima)** environment and set both:

| Variable | Format | Preview value reported on 2026-10-02 |
| --- | --- | --- |
| `ACCESS_AUD` | Access application's audience tag, a nonempty string (one AUD, no JSON array or quotes) | `a3079f1bb92f23c5299cc29d4436377594caa9cfc3b655c3571206548028906d` |
| `ACCESS_TEAM_DOMAIN` | Team hostname only, `<team>.cloudflareaccess.com`, no `https://`, path or trailing slash | `jolly-frost-8cc9.cloudflareaccess.com` |

These are dated operator-provided values, not values independently checked by this change.
To recheck the AUD, inspect the `kid` parameter in the Access **login URL** and the `aud`
claim of the `meta` token in that login flow; compare with the intended application's
Application Audience (AUD) tag in the Access dashboard. The login URL's `kid` is not the
JWT header's signing-key `kid`. Recheck the team hostname against the Access dashboard too.
Decoded token data is only an operator diagnostic, never a trusted runtime configuration
source; do not copy tokens into logs or issues. The middleware uses only the configured
team's certificate endpoint and verifies the JWT signature, issuer, audience and lifetime.

**Changes apply from the next deployment: republish the preview after saving the variables.**
Use the existing workflow below once publication is authorized; changing settings does not
repair an already published deployment. Do not enable `ACCESS_DEV_BYPASS` to fix this failure.

With the updated middleware, a request carrying a token gets these deployment diagnostics:

| HTTP | Exact JSON response | Meaning / action |
| --- | --- | --- |
| 503 | `{"error":"Service Unavailable","reason":"access_configuration_missing"}` | AUD missing/empty or team domain missing/invalid; correct Preview settings and republish. |
| 503 | `{"error":"Service Unavailable","reason":"access_jwks_unavailable"}` | Configured team's certificate endpoint failed (network or non-success HTTP); check team configuration and endpoint availability. |
| 503 | `{"error":"Service Unavailable","reason":"access_jwks_invalid"}` | Certificate response is not valid JSON/JWKS structure; check the configured endpoint. |
| 403 | `{"error":"Forbidden"}` | Missing or rejected token; no token-specific details are exposed. |

All these responses have `Cache-Control: no-store`. The 503 reasons also appear in Function
logs as `Access verification unavailable: <reason>`, without tokens, key IDs or upstream
error bodies. With valid trust configuration, token checks happen before fetching certificates, so malformed tokens
receive the generic 403 without probing JWKS. Unknown/ambiguous signing-key IDs and failed
key import/signature checks also remain generic 403 responses.

From the CI:

    gh workflow run phase0-build.yml --ref main \
      -f upload_spike=true -f deploy_spike=true

The step is the last one in `phase0-build.yml`, and it:

- **skips with a warning** when `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (repository
  secrets) or `CF_PAGES_PROJECT` (repository variable, `melee-web`) are missing, so the job stays
  green without an account — the same shape as the `deploy` job of `ci.yml`;
- **removes `sw.js`** from the spike dist: a service worker registered by an earlier visit keeps
  serving the cached shell;
- **appends a `/spike-core/*` rule to the dist `_headers`** that detaches `Cache-Control` and sets
  `no-store`. The module keeps a fixed file name while the site-wide rule for `*.wasm` is
  `immutable`, so a phone that cached the previous module would run the old core while `core.json`
  announces the new commit;
- publishes with the existing `scripts/deploy.sh --branch phase0-spike --dist-dir …`, and writes
  the preview address into the run summary.

Three things this cannot settle on its own:

- **The decision (O1).** The dist contains the game-derived module. Publishing it, even behind
  Access, is a step the operator decides: the dispatch input and the credentials are the two locks,
  not a permission. Do not set those credentials before O1 is answered.
- **The header rules.** Whether Pages merges two matching `_headers` rules or lets the later one win
  is unverified. After the first deploy, check
  `curl -sI https://phase0-spike.<project>.pages.dev/spike-core/melee_core_web.wasm`: it must not
  show `immutable`. Same for `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` on
  `spike.html`, and `Content-Type: application/wasm` on the module.
- **The address format.** `https://phase0-spike.<project>.pages.dev` is expected, not verified; the
  run summary carries whatever wrangler reports.

The deployment procedure was not run by this implementation agent; the dated operator report
above records a live preview and its Access failure.

**Verified while writing this** (on the VPS, 2026-09-30):

    CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… CF_PAGES_PROJECT=melee-web \
      scripts/deploy.sh --dry-run --branch phase0-spike --dist-dir /home/hermes/incoming/phase0/spike-dist

prints the command it would run and exits 0, so a dist outside `web/dist` is accepted — the
open question `docs/PHASE0_DEPLOY_PLAN.md` section 5 left to the first dispatch. One caveat
found while doing it: `scripts/deploy.sh` tests `[ -d "$repo_dir/.git" ]`, and in a git
**worktree** `.git` is a file, so a dry run from a worktree is refused with
`not a git checkout`. In CI (`actions/checkout`) `.git` is a directory and the check passes;
locally, pass `--repo-dir` pointing at the main checkout.
