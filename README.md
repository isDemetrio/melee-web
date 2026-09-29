# melee-web — Super Smash Bros. Melee in the browser

Private project. Goal: Melee (NTSC-U 1.02, GALE01) playable in a browser on desktop and
mobile, 1v1 online between friends, with no self-managed server: Cloudflare
(Pages, R2, Access, TURN) plus Supabase (Realtime) only.

**Status: pre-build.** The full specification is in [`docs/SPEC_PIANO.md`](docs/SPEC_PIANO.md).
Current state and next step: [`docs/PROGRESS.md`](docs/PROGRESS.md).

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
| `docs/` | Spec, technical maps, decisions, progress log |
| `upstream/melee-unlocked` | Pinned submodule: recompiler, HLE runtime, Slippi netcode |
| `web/` | TypeScript + Vite UI shell: boot, settings, lobby, touch overlay, PWA |
| `functions/` | Cloudflare Pages Functions (TURN credentials, asset manifest) |
| `scripts/` | Build, asset extraction, manifest generation, upload, deploy |
| `.github/workflows/` | CI: typecheck + unit + browser tests; game build; assets |

## Documents an agent must read before touching code

1. `docs/SPEC_PIANO.md` — the specification, phase by phase, with exit criteria.
2. `docs/PLAN_BREAKDOWN.md` — the reviewed breakdown and the static-recomp-vs-source-port decision.
3. `docs/RUNTIME_MAP.md`, `docs/RENDERER_MAP.md`, `docs/NETCODE_MAP.md` — how the upstream runtime works.
4. `docs/PROGRESS.md` — what is done, what is next.
5. `docs/AGENT_RULES.md` — working rules for AI agents in this repo.

## Build outline (see docs/DEPLOY.md)

```
scripts/build_web.sh      # Vite build -> dist/
scripts/build_game.sh     # DOL -> recomp -> C++ -> Emscripten -> melee.wasm (CI only)
scripts/make_manifest.py  # disc filesystem -> assets/manifest.json (content-addressed)
scripts/upload_assets.sh  # new files -> R2
scripts/deploy.sh         # dist/ -> Cloudflare Pages
```

Licence: GPL-2.0-or-later, inherited from upstream. Generated code derived from the
Nintendo DOL is never published.
