# melee-web — Super Smash Bros. Melee in the browser

Private project. Goal: Melee (NTSC-U 1.02, GALE01) playable in a browser on desktop and
mobile, 1v1 online between friends, with no self-managed server: Cloudflare
(Pages, R2, Access, TURN) plus Supabase (Realtime) only.

**Status: pre-build, infrastructure.** There is no disc image yet, so there is no DOL, no
recompiled game and no `melee.wasm`: nothing here is playable. What exists is the shell, the
networking layer, the input layer, the asset pipeline and the WASM toolchain probe, all
verified by CI. Current state, measured numbers and the next step:
[`docs/PROGRESS.md`](docs/PROGRESS.md). Full specification:
[`docs/SPEC_PIANO.md`](docs/SPEC_PIANO.md).

## Hard constraints

- No game data in this repository — ever. No ISO, no DOL, no `port/generated/`, no
  extracted disc filesystem. See `.gitignore`; the build pulls game data from the
  operator's own disc.
- The upstream port is pinned as a submodule (`upstream/melee-unlocked`), commit
  recorded in `docs/UPSTREAM_PIN.md`. Upstream is never modified in place from this
  repo: changes to port code go through a patch series or a fork.
- Everything is built in CI (GitHub Actions), never on the operator's VPS. The VPS is
  a file-editing workspace only: 2 vCPU, 3.7 GB RAM, no compiler toolchain.
- Single supported game version: NTSC-U 1.02, Game ID `GALE01`.

## Layout

| Path | Contents |
| --- | --- |
| `docs/` | Spec, technical maps, decisions, deploy notes, progress log, open questions |
| `upstream/melee-unlocked` | Pinned submodule: recompiler, HLE runtime, Slippi netcode |
| `patches/` | The patch series applied to upstream in CI only; reasons in `docs/PORT_CHANGES.md` |
| `web/` | TypeScript + Vite shell: boot, settings, lobby, input, asset client |
| `web/src/net/` | Signalling, WebRTC transport, session negotiation |
| `web/src/input/` | Keyboard, Gamepad API and touch overlay, all writing one PAD state |
| `web/src/assets/` | Manifest reader and the OPFS content-addressed asset cache |
| `functions/` | Cloudflare Pages Functions (TURN credentials, asset manifest) |
| `wasm/` | Portable-intrinsic FMA shim and the CI-only toolchain probe |
| `scripts/` | Build, manifest, upload and deploy scripts; `scripts/tests/` covers them |
| `.github/workflows/` | `ci.yml` (hygiene, shell, browser tests, deploy-if-configured), `functions.yml`, `wasm-probe.yml` |

## Documents an agent must read before touching code

1. `docs/SPEC_PIANO.md` — the specification, phase by phase, with exit criteria.
2. `docs/PLAN_BREAKDOWN.md` — the reviewed breakdown and the static-recomp-vs-source-port decision.
3. `docs/RUNTIME_MAP.md`, `docs/RENDERER_MAP.md`, `docs/NETCODE_MAP.md` — how the upstream runtime works.
4. `docs/PROGRESS.md` — what is done, what is next.
5. `docs/AGENT_RULES.md` — working rules for AI agents in this repo.
6. `docs/OPEN_QUESTIONS.md` — what is waiting on the operator, so it is not redone.

## Scripts

```
scripts/check_no_game_data.py  # repo hygiene gate: refuses game data, runs in CI
scripts/build_web.sh           # typecheck, unit tests, Vite build, _headers and size budget
scripts/make_manifest.py       # extracted asset directory -> content-addressed manifest.json
scripts/upload_assets.sh       # manifest entries -> R2 (dry run by default)
scripts/deploy.sh              # web/dist -> Cloudflare Pages (dry run by default)
scripts/apply_patches.sh       # patches/*.patch onto the CI checkout of the submodule
```

There is no `scripts/build_game.sh` yet: the game build needs the DOL, so it starts with
Phase 0 (`docs/OPEN_QUESTIONS.md` Q1). `docs/DEPLOY.md` describes the deploy path that is
written but not yet executed — there are no Cloudflare credentials in CI, and the deploy
job skips itself with a notice until there are.

Licence: GPL-2.0-or-later, inherited from upstream. Generated code derived from the
Nintendo DOL is never published.
