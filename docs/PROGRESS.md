# Progress log

Rule (`docs/AGENT_RULES.md`): a new session must be able to resume from this file
alone. Update it at the end of every working session.

## Current state

**Phase: pre-Phase-0. Infrastructure night.** No game data is available yet, so nothing
that requires the DOL has been attempted. Everything built so far is verified by CI.

| Area | State | Evidence |
| --- | --- | --- |
| Private repo | Created and pushed | `github.com/isDemetrio/melee-web`, branch `main` |
| Upstream pin | Submodule pinned at v0.8.1 | `docs/UPSTREAM_PIN.md`, commit `3aab717` |
| Architecture decision | Static recomp is the base for WASM | `docs/PLAN_BREAKDOWN.md` §1 |
| Technical maps | Runtime + renderer + netcode | `docs/RUNTIME_MAP.md`, `docs/RENDERER_MAP.md`, `docs/NETCODE_MAP.md` |
| Repo hygiene gate | Implemented, 7 unit tests pass | `scripts/check_no_game_data.py` |
| Web shell | Sources in place, CI verification pending | `web/` |
| Lobby / transport | Negotiation + transport implemented, unit tests written | `web/src/net/`, `web/tests/unit/` |
| Cloudflare | Not started | — |
| Game build | Blocked on the operator's ISO | `docs/OPEN_QUESTIONS.md` |

## Next step

1. Get CI green on `main` (hygiene, web, e2e).
2. Then, in order: Cloudflare Pages Functions + tests, asset manifest tooling,
   deploy scripts, PWA shell, touch overlay.
3. Phase 0 (the go/no-go spike) starts the moment the operator supplies the ISO.

## Decisions taken (with reasons)

- **Static recomp, not source port**, for the browser target: the source port's game
  library requires GCC's `scalar_storage_order` (`sourceport/game/CMakeLists.txt:13`)
  which clang/Emscripten does not implement, its FMA fidelity depends on GCC contraction
  into x86 FMA, and its host still links the same Windows runtime that would have to be
  ported anyway. Full evidence in `docs/PLAN_BREAKDOWN.md` §1.
- **The DOL cannot go in a GitHub Actions secret** (48 KB limit; `main.dol` is ~4.5 MB).
  It will live in a separate private repository or a private release asset, pulled by the
  build job. Recorded in `docs/OPEN_QUESTIONS.md`.
- **Lobby code must be testable without Supabase**, so signalling is an interface with an
  in-memory implementation for unit tests, a `BroadcastChannel` implementation for
  two-tab end-to-end tests, and the Supabase adapter used in production.
- **Layout deviation from `docs/PLAN_BREAKDOWN.md` T6**: the networking layer lives in
  `web/src/net/` rather than `web/src/lobby/`. Rationale: transport, signalling and
  session negotiation are one concern and the lobby screen is only a consumer of them.
  The interfaces and behaviours specified in T6 are implemented as written.

## Measured numbers

- **FMA native vs WASM: NOT bit-identical** (WASM probe, first run, 2026-09-29). The
  SHA-256 over 1,000,000 triples × 8 paths = 8,000,000 results differed between the
  native x86-intrinsic build and the patched `std::fma` WASM build (emsdk 4.0.23,
  Node 22). That is the only measured fact: the run URL and digests were not copied
  here, and how many results differ, and in which class, is **unknown**. The probe
  now classifies every divergence (`wasm/README.md`, "Finding"); CI stays strict.
  Paste the next run's classification table here verbatim, with its run URL.
- Whether the game ever feeds NaN into these operations: **not measured**; needs
  the running build (Q1). Only this decides whether a NaN-only divergence is harmless.
- Compile success of the four upstream tests and native/WASM ns/op: see that run's
  log and `wasm-probe/bench.json` artifact; not yet recorded here.

## Open blockers

See `docs/OPEN_QUESTIONS.md`. In short: the ISO, and where the heavy build runs.

## T4 — CI-only WASM probe prepared (2026-09-29)

Sources, portable-intrinsics/FMA patch and `.github/workflows/wasm-probe.yml` are
in place with emsdk 4.0.23. All four no-DOL candidate tests are included. Native
FMA/bench executables build before patching upstream, so the reference uses the
original x86 intrinsic bodies. The gate compares all result bits, including NaNs.

Local verification is static only: patch applicability, shell/YAML/embedded Python
syntax and upstream source paths. No compiler, emsdk, build or runtime was invoked.
No Git state-changing command or upstream edit was performed. CI has not run;
compile success, FMA hashes and native/WASM ns/op are **not yet measured**.
Next: run the probe workflow after these files are submitted, then record its run
URL, the two hashes and `wasm-probe/bench.json` timings here. Full runtime MXCSR
rounding/FTZ/DAZ remains outside T4; see `wasm/README.md` for evidence limits.
