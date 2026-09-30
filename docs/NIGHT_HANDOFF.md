# Night handoff — state at 2026-09-30, 21:05 UTC

Written by the orchestrator at the start of the second overnight session. Read it together with
`PROGRESS.md` and the new `docs/DEVICE_TEST_IPHONE16PRO.md`. The previous handoff (2026-09-29) is
superseded; its content is in git history.

## What moved since the last handoff

- The Phase 0 deploy plan is written and in `main`: `docs/PHASE0_DEPLOY_PLAN.md`. It is the map for
  everything below.
- The `-Oz` core is in `main` (PR #13), CI builds the spike dist, the disc is served by a Pages
  Function with byte ranges (PR #16), the native reference at the served commit is recorded
  (PR #17), and the checkpoint runner has 44 guards (PR #18, merged tonight).
- **The device row is measured.** `docs/DEVICE_TEST_IPHONE16PRO.md`: the operator's iPhone 16 Pro on
  Safari ran the spike three times, 2400 retraces each. All three reproduce the native trace
  (`c79c53b9cdf81426fa0277e7497a69e55bc5f571`, 0 differing rows out of 2400), exit 0,
  `crossOriginIsolated` true, clock resolution 0.02 ms. In-match mean/p99: 3.03/3.96, 3.24/5.64,
  3.08/4.12 ms. That is the "desktop only" band — the worst run misses the 3 ms GO line by 0.26 ms.
  Thermal drift is visible inside run 2 (+6.6%).
- **PR #20 is open** on `perf/opt-level-input`: the core's optimisation level becomes a CI input
  (`MELEE_OPT`, default `-Oz` unchanged) and `core.json` reads the level CMake actually configured
  with. **Do not touch `.github/workflows/phase0-build.yml` or `wasm/core/CMakeLists.txt`** — that
  branch owns them tonight. Read them if you need to.

## Yours tonight: PR 4, the page that populates OPFS

`docs/PHASE0_DEPLOY_PLAN.md` section 5, PR 4. The task prompt carries the agreed design (the API of
`disc-cache.ts`, the dedicated OPFS worker, the resume and per-chunk verification rules, the
Chromium test list, and the four defects of the plan to correct while you meet them). Follow it
rather than redesigning it. One small verifiable step per run, a PR per step, CI green, and
`docs/PROGRESS.md` updated with the numbers you actually measured.

If the level experiment blocks you, work on `scripts/phase0/go_no_go.py` instead (S8 of
`docs/PHASE0_NEXT.md`), which is pure Python and testable here. Do not write
`docs/PHASE0_REPORT.md` tonight.

## Parked for the operator, do not invent an answer

- **O1**: whether the module and the disc may go to Cloudflare behind Access at all (the legal
  question). O2–O9 are credentials and account setup. O10 is the exact Android model.
- **M1** (desktop Chrome), **M2** (mid-range Android) and **M5** (Android with OPFS over the real
  host) need the operator's device. **M2 is the row that decides and it has not been measured.**

## The risk that matters more than any compiler flag

An A18 Pro scores roughly 3,400 in Geekbench 6 single-core; a Snapdragon 7-series roughly
1,100–1,200. That is about 3x. From the iPhone's 3.1 ms per frame that predicts **7–10 ms on M2**,
i.e. past the NO-GO threshold of 6 ms, where `docs/SPEC_PIANO.md` stops the project. No
optimisation flag recovers 3x; that would take structural work (skipping GX and audio work inside
the measured window, or recompiler codegen). Do not write anywhere that the mobile row is "8% away":
it is 8% away on the iPhone, and the deciding row is unmeasured and may be 3x away.

## A measurement caveat that is being checked tonight

`native/headless_host.cpp` hashes about 40 MiB of RAM/ARAM after every retrace
(`trace_state`/`digest_state`). `sim_ms` excludes that work, but the next frame starts with the
cache it evicted — and on the iPhone the wall clock was 24 s against 5.2 s of simulation. An A/B on
the native binary (three runs with `--state-trace`, three without, alternating) is running on the
VPS. If it shows 3% or more, the 3.2 ms figures are inflated by the harness rather than by the
browser, and the interpretation of the whole device row changes. The result lands in `PROGRESS.md`
and in the morning report.

## Rules that still hold

- CI is the source of truth. A green-looking explanation from an agent is not evidence; check which
  step failed, not just that a job is red.
- Never commit game data. Traces, card images and dist artifacts live under
  `/home/hermes/incoming/phase0/`, never in the checkout.
- No builds on the VPS: 2 vCPU, 3.7 GB, no toolchain. Compilation happens in GitHub Actions only.
  Running the Node module against the disc on the VPS is fine and is how parity is checked.
- Do not touch the verdict thresholds (`docs/SPEC_PIANO.md`, `docs/PHASE0_DEVICE_PLAN.md` sections
  5–6), the native reference (`c79c53b9…`) or the iPhone evidence.
- Do not merge the fma fast path; do not enable `-ffast-math` or `-mrelaxed-simd` at any level.
