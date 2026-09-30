# Progress log

Rule (`docs/AGENT_RULES.md`): a new session must be able to resume from this file
alone. Update it at the end of every working session.

## Current state — 2026-09-30 06:40 UTC, branch `feat/wasm-runtime-maps`, PR #1

**Phase: pre-Phase-0. Infrastructure.** No game data is available yet, so nothing that
requires the DOL has been attempted. There is no disc image, so there is no DOL, no
recompiled game and no `melee.wasm`. **The game cannot be played, and no amount of work in
this repository changes that.** Everything called "verified" below is verified by CI on this
branch.

**All three workflows are green on commit `b181d0b`** (`CI`, `Pages Functions`,
`WASM toolchain probe`). PR #1 is open and mergeable; `main` is still at the earlier docs
commit. Nothing was merged tonight: the merge is the operator's call, and the PR title
("docs: map runtime, renderer and netcode for WASM port") no longer describes its contents.

| Area | State | Evidence |
| --- | --- | --- |
| Private repo | Created and pushed | `github.com/isDemetrio/melee-web` |
| Upstream pin | Submodule pinned at v0.8.1, commit `3aab717` | `docs/UPSTREAM_PIN.md` |
| Architecture decision | Static recomp is the base for WASM | `docs/PLAN_BREAKDOWN.md` §1 |
| Technical maps | Runtime + renderer + netcode | `docs/RUNTIME_MAP.md`, `RENDERER_MAP.md`, `NETCODE_MAP.md` |
| Repo hygiene gate | Implemented, unit-tested | `scripts/check_no_game_data.py`, `scripts/tests/` |
| Web shell | Typechecks, 210 unit tests, builds | CI run 36677219773 |
| Browser tests | 10 Playwright tests pass | same run, job `Browser tests (Chromium)` |
| First-load shell | 41.1 KB across 3 files, budget 1024 KB | same run, "Report and bound the shell size" |
| Lobby / transport | Negotiation, WebRTC transport, BroadcastChannel + Supabase signalling | `web/src/net/`; the Supabase adapter is written but not unit-tested |
| Input layer | Keyboard, Gamepad API, touch overlay → one PAD state | `web/src/input/`, unit tests + `touch-overlay.spec.ts` |
| Asset pipeline | Manifest generator + schema; upload and deploy scripts guard-tested | `scripts/make_manifest.py`, `docs/DEPLOY.md` |
| Asset client | Manifest reader + OPFS content-addressed cache | `web/src/assets/`, unit tests against a fake OPFS |
| Cloudflare | Functions typecheck, bundle and are tested; nothing deployed | `functions/`, `docs/DEPLOY.md`; deploy job skips without credentials |
| WASM probe | 4 upstream tests + shim test + 8,000,000-result FMA corpus, bit-exact vs native | run 36677219860 |
| Game build | **Phase 0 started**: disc verified, DOL secured, recompiler runs on the DOL | `docs/OPEN_QUESTIONS.md` Q1/Q2; this file, "Phase 0 started" |

## What the night of 2026-09-29 → 30 changed

1. **The WASM probe is green, and the strict gate was not weakened.** Run 36672598366 had
   left 64 `nan-sign` and 716 `nan-payload` divergences. Every one of them had a NaN operand
   and every one was on an `fmadd` path: `fmadd` reaches `wasm_compat::fma` with no wrapper
   in between, and that function had no NaN guard while its three negating siblings did. The
   hardware returns the first NaN operand quieted and unnegated; `fma` now does too.
2. **The comparison report gained a per-path view** (results, native NaN results,
   divergences, and the first example per kind and path), because the kind table alone
   cannot separate "the shim computed the wrong NaN" from "the rounding step lost one".
3. **Two documents were corrected against measurement**: `docs/PORT_CHANGES.md` had claimed
   `fmadd` was unaffected (the next run refuted it), and `docs/OPEN_QUESTIONS.md` Q7 had
   attributed the residual to the platform's NaN latitude (it was the shim, both times).
4. Docs pass: `README.md` no longer lists a `scripts/build_game.sh` that does not exist,
   `docs/DEPLOY.md` no longer says the client asset path is unwritten, and this file is back
   in line with the repository.

## Phase 0 started — 2026-09-30

The disc arrived, so the blocker recorded all night is gone. What is actually done, with
the measurement next to it:

1. **The disc image is verified.** `Super Smash Bros. Melee (USA) (En,Ja) (v1.02)`,
   1,459,978,240 bytes, SHA-1 `d4e70c064cc714ba8400a849cf299dbd1aa326fc` — the Redump value
   for that revision, and the one `999sian/melee-pc` requires. Disc magic `c2339f3d` at
   `0x1C`. It lives on the VPS at `/home/hermes/incoming/melee-ntsc102.iso`, in no repository.
2. **`main.dol` is extracted and secured.** Offset read from the disc header's own field at
   `0x420` (`0x1e800`), range truncated at the end of the last section (`0x4385e0`):
   4,425,184 bytes, SHA-1 `08e0bf20134dfcb260699671004527b2d6bb1a45` — the value
   `doldecomp/melee` documents for GALE01 1.02. Pushed to the private
   `github.com/isDemetrio/melee-orig-dol`; the remote blob was read back and matches.
3. **The recompiler runs on the DOL.** `port/recomp/recomp.py --dol <the DOL>` completes in
   **27.2 s** with **877 MB peak RSS** on this 2-vCPU VPS, and emits **144 translation units,
   20,076 functions, 114 HLE overrides, 151 files, 67 MB of C++, 1,385,023 lines**, guest
   image digest `7883e197ff19`. It refuses any DOL whose SHA-1 is not the one above, so the
   run also re-proves the extraction.
   - The count differs from the stale upstream sample tree (`port/generated.before-*/`,
     40,154 functions). Expected: that tree was generated with the Slippi/Gecko code tables
     baked in (`--gct-base`), and this run was not. The real build passes `--gct-base`.
   - Every emitted TU includes `<intrin.h>` (144 of 144). Emscripten has no such header;
     `wasm/compat/intrin.h` already exists to satisfy it, and the generated code calls no
     MSVC intrinsic directly (checked: the only `_`-prefixed names are this port's own
     helpers). Worth confirming on the first real WASM compile rather than assuming.
4. **Where this stops.** Everything above is Python or a file operation, so it runs here.
   Everything below — the native headless Linux build, the `melee_core_wasm` CMake target,
   `emcmake`, the link — needs a compiler toolchain this VPS does not have (no cmake, no
   ninja, no clang, no emsdk; `g++` and `make` exist) and that `vps-performance-policy`
   forbids installing for builds this size. **The build machine is the remaining blocker**,
   and it is a decision only the operator can take: a GitHub Actions runner (free, 2 cores
   / 7 GB on a private repo, slow but zero cost, needs a token that can read the DOL repo),
   or a Codespace (faster, needs an authorisation and consumes the free core-hours).

## Next step
1. Merge PR #1 to `main` (every workflow is green) once the operator has read it; the PR
   description needs rewriting first, it still describes only the docs commit.
2. Then, in order: the WASM-x86 vs WASM-arm64 probe comparison (the browser-to-browser
   question, not native-vs-WASM), the real asset-extraction scripts, the PWA/service-worker
   polish, and Phase 0 the moment the ISO exists.
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
- **A NaN operand is returned, not computed with.** The x86 FMA instructions propagate the
  first NaN operand quieted and unnegated; the WASM build must match, and matching it is
  not the same decision as accepting the engine's NaN latitude for results that have no NaN
  operand. The first is a divergence the shim invented and is fixed; the second measures 0
  on the probe corpus. `docs/OPEN_QUESTIONS.md` Q7 is closed by measurement.

## Measured numbers

All from CI, never from this VPS (which has no compiler). Runner
`Linux-6.17.0-1022-azure-x86_64`, Node v22.23.3, emsdk 4.0.23, upstream
`3aab7172db243c159afa76ecb2c564b3de8e4c0a`.

- **FMA corpus, native vs WASM: bit-identical.** Run 36677219860, 8,000,000 results
  (1,000,000 triples × 8 paths), **0 divergent**, both digests
  `6b79b92a3bc1fb1699853e1c8c671d37aaf64f82378bcb9d393387480f66afc9`. No exemption used.
  NaN results are not rare in this corpus: 7,085 per double path and 6,589 per single path
  on the native side, and 51,656 results have a NaN operand.
- **The four runs that got there**, each a change to `wasm/compat/fma.h`: 36647200912
  (`std::fma` directly) 20,264 divergent / `zero-sign` 120; 36661984096 (+ zero-addend
  guard) 20,144 / `zero-sign` 0; 36672598366 (+ NaN guard in the three wrappers) 780 /
  `nan-sign` 64, `nan-payload` 716; 36677219860 (+ NaN guard in `fma`) 0.
- **Benchmark** (`wasm-probe/bench.json` in run 36677219860, no threshold): dependent
  `fmadd` chain 3.059887 ns/op native against 21.261028 ns/op WASM; guest
  `ld32`/`st32` round trip 0.594146 ns native against 0.492923 ns WASM. Both sides report
  `fma_sink` 1.0099501665385733 and `memory_sink` 2280707264, i.e. 10⁷ dependent FMA calls
  accumulate to the same double on both builds — a second, independent parity signal.
  There is no pre-guard baseline, so these numbers do not say what the guards cost.
- **Shell**: 41.1 KB first-load across 3 files (0.70 KB HTML + 2.82 KB CSS + 38.52 KB JS),
  budget 1024 KB. The 216.43 kB chunk in the build log is the dynamically imported Supabase
  client, which is not part of the first load and is not counted by
  `web/scripts/check-bundle-size.mjs`.
- **Test counts**: 210 unit tests in 16 files, 10 browser tests, 4 Pages Functions test
  files. The WASM probe job takes ~1m34s end to end, so a probe fix can be iterated on
  within a few minutes.
- Whether the game ever feeds NaN into these four operations: **not measured**; needs the
  running build (Q1). It no longer decides a policy — nothing diverges — but it would say
  how much the corpus's NaN density resembles gameplay.

## Open blockers

See `docs/OPEN_QUESTIONS.md`. In short: the ISO (Q1), where the DOL lives for CI (Q2), and
Cloudflare/Supabase credentials (Q3). Q7 is closed by measurement.

## Phase 0 progress — 2026-09-30, after the disc arrived

`docs/PHASE0_TASKS.md` is the breakdown: twelve tasks from the DOL to the go/no-go report,
each with its files, its CI verification and its risk. Two of them are done and green, and
one real attempt at the native reference exists but has never been compiled.

**P0-01, done.** The recompiler's generated C++ compiles, both with `em++` and with the host
`g++`. Run 36699635826, `ubuntu-24.04`:

| TU | em++ | g++ |
| --- | --- | --- |
| `guest_000.cpp` (smallest) | 6.60 s, 229 MB RSS, 762 KB object | 7.08 s, 332 MB, 535 KB |
| `guest_139.cpp` (largest) | 6.13 s, 196 MB, 540 KB | 6.17 s, 355 MB, 1.15 MB |

Two corrections came out of doing it. The first run measured `guest_table.cpp` as "the
largest TU" — that file is the dispatch table, not a guest function, so the number described
something other than what it claimed; the selection now excludes it. And the step failed once
on `sort: fflush failed: Broken pipe`: under `set -o pipefail`, a `head` that closes the pipe
kills `sort` with SIGPIPE and the step exits 2. Replaced with one `awk` that reads the whole
stream.

**P0-02, done, and the prediction was wrong.** The recompiler now runs with
`--gct-base 0x8065CC80`, the address the release build bakes Slippi's code table at
(`build.bat:26`, `README.md:119`), and the job fails if its log still says the table was
skipped. The breakdown expected the TU count, the function count and the guest image digest
to change. **They do not.** 144 TUs, 20,076 functions, image `7883e197ff19`, identical with
and without the flag. What changes is the log: `skipped: pass --gct-base` disappears and the
hook line reads `203 hooks, 0 C0 caves`. So the flag takes effect and has nothing to
translate, because this code list carries no C0 caves. The expectations were left as they
were, with the reason written beside them.

**The Linux headless reference, unverified.** `native/` (1533 lines, PR #2) links real
generated guest functions, PPC dispatch, OS/DVD/PAD/card HLE, ARAM DMA and AX mixing, with a
portable host layer in place of the Win32 one, plus patch `0002` and its own CI workflow. It
has **never been compiled or run**: the workflow in the same PR is what will decide. Its
README states what it substitutes (a FIFO decoder that keeps CP/VAT framing and discards
presentation work, no renderer, no network, Slippi rejected at boot so it needs `--no-slippi`)
and what is unverified: build, boot, the 2400 frames, scripted match entry, Windows parity.
`scripts/apply_patches.sh` applies both patches in order — checked here, and a check of `0002`
against an unpatched tree fails, which is expected and is not a defect.

**What is still the operator's call.** D1: whether the ISO goes somewhere CI can read, without
which P0-08 and P0-09 — the 2400-checkpoint comparison, the first go/no-go criterion — cannot
run at all. D2: runner size, only if the full guest build fails on a standard runner. D3:
whether game-derived build products may be cached. D4/D5: how devices reach the spike page and
which devices. All six are written out in `docs/PHASE0_TASKS.md` §4 with the cost of waiting.

## The first native run — 2026-09-30, on the operator's VPS

This is the first time the game has been executed in this project. The binary was built in CI
(`phase0-native-headless`, run 36702692761, 158 ninja targets, `native_fifo` 1/1 passed),
carried to the VPS as a private artifact, and run there against the operator's own disc, which
is where the only copy of it is.

**It boots and it simulates.** `scripts/phase0/run_checkpoints.sh`, 2400 frames requested,
`--fast --time-base 1 --volume 0`, `vs_match.txt`, fresh card directory:

- disc verified first: 1,459,978,240 bytes, SHA-1 `d4e70c064cc714ba8400a849cf299dbd1aa326fc`
- **exit status 0, wall clock 50 s** for 2400 frames on this 2-vCPU VPS, with the process
  `nice`d — roughly 21 ms of simulation per frame *on the weakest machine in the project*
- **2401 rows** in the trace (header plus 2400 retraces), header
  `retrace,cpu,ram,aram,events`, all 2400 `cpu` and `ram` hashes distinct: the guest is doing
  work every frame, not repeating a state
- `aram` has 177 distinct values, so audio DMA is moving
- `events` is zero except for 360 rows carrying `0000000100000000` and 5 carrying
  `0000000000000001`

**Run-to-run stability, which the specification accepts in place of a Windows reference
(`docs/SPEC_PIANO.md` step 1) since no Windows build is available:** two independent runs of the
same binary, each with its own fresh card directory, produced traces identical **bit for bit**,
both SHA-1 `138cfc3b55afcbe9f6b293b4dcb4336c467d1797`.

**First run was a menu, and the scene report proved it.** `vs_match.txt` assumes Slippi boot
timing and this translation is built `--no-slippi`. The entry point now reads the scene the
same way an `@scene` script does, and with that script the run ends at
`mode=1 state=0 match_frame=0`: 2400 deterministic frames of a menu, no match, no Vs. mode.
The 360 frames carrying an event mask were not a match-start hook. This is precisely the risk
`docs/PHASE0_TASKS.md` P0-08 records, caught by measuring instead of assuming.

**With an `@scene`-anchored script it is a real match.** The project's own parity scripts exist
for exactly this reason — their header notes that vanilla and native reach `GM_MENU` at
retrace 403 and 702 respectively, so their menu entries are relative to the retrace where the
host *first observes* the scene, not to an absolute frame. Re-running the same binary against
the same disc with `port/scripts/parity_vs_onett.txt`:

- `final scene: mode=2 state=2 match_frame=762 (retraces=2400)` — Vs. mode, and the match had
  simulated **762 frames** when the run ended, so the match starts around retrace 1638
- exit status 0, **54 s** for 2400 retraces
- two independent runs again **bit-identical**, both SHA-1
  `c79c53b9cdf81426fa0277e7497a69e55bc5f571` (a different trace from the menu run, as it must be)

So the reference is real and reproducible: the game boots, reaches Vs. mode, plays a match, and
produces the same trace every time. **`vs_match.txt` is the wrong script for this build** —
P0-08's checkpoint harness must use an `@scene`-anchored script, and only ~762 of the 2400
retraces are in-match, which is the number that matters for the rollback budget.

**Consequences.** P0-08's first half is done and its numbers exist. The native-vs-WASM
comparison (P0-09) still needs a WASM core, which does not exist yet (P0-04…P0-07), and the
cross-platform criterion still needs D1 if it is ever to run in CI rather than here.

## P0-09 — the WASM core against the native reference, 2026-09-30

**The criterion passes, with no tolerance needed.** Commit `f0d76a2816eceefb7ec98b5b4a78a55edfa537c0`;
the native executable and the WASM module were built by CI **from that one commit**
(`phase0-native-headless` run 36722713202, `phase0-build` run 36722718249), carried to this VPS
as private opt-in artifacts, and run against the operator's own disc, verified first
(1,459,978,240 bytes, SHA-1 `d4e70c064cc714ba8400a849cf299dbd1aa326fc`).

**Every one of the five traces is byte-identical, SHA-1
`c79c53b9cdf81426fa0277e7497a69e55bc5f571`:**

| run | what it is | wall clock | trace SHA-1 |
| --- | --- | --- | --- |
| `native-1` | native, 2400 retraces | 54 s | `c79c53b9…` |
| `native-2` | native again, fresh card | 54 s | `c79c53b9…` |
| `wasm-node-1` | **WASM under Node** | **81 s** | `c79c53b9…` |
| `wasm-node-2` | WASM again, fresh card | 81 s | `c79c53b9…` |
| `reference-2026-09-30` | the 10:29 binary, *before* patches 0003–0007 | 54 s | `c79c53b9…` |

`scripts/phase0/compare_checkpoints.py` on each pair:

- **A** native-1 vs native-2 → `identical: 2400 retraces`, exit 0
- **C** wasm-node-1 vs wasm-node-2 → `identical: 2400 retraces`, exit 0
- **E** **native-1 vs wasm-node-1 → `identical: 2400 retraces`, exit 0** ← the P0-09 criterion
- **F** the 10:29 reference vs native-1 → `identical: 2400 retraces`, exit 0

All five runs end at `final scene: mode=2 state=2 match_frame=762 (retraces=2400)`, i.e. a real
Vs. match, started around retrace 1638. All five report `FPSCR requests: RN=0 NI=0`: **Melee
never asks for non-default rounding or for NI in this run**, which is the empirical answer to
the question patch 0004 was written to ask, and it means the absent x86 MXCSR emulation is not
exercised by this trace.

**F is a finding in its own right.** The 10:29 binary was built before patches 0003–0007 and
before the shared SHA-1 code; it produces the same trace anyway. So those portability changes
are state-neutral, and the WASM/native agreement cannot be an artefact of the two builds sharing
a recent change.

**Timing (proxy numbers, and they must be read as such).** These are `--fast` simulation times
from `--sim-times`, which exclude the per-retrace state hashing, measured **under Node on a
2-vCPU VPS with a `-O1` build** — not a phone, and not the shipping optimisation level:

- in-match (762 frames), native: mean 15.20 ms, p95 17.78, p99 20.86, max 38.64
- in-match (762 frames), WASM: mean 27.34 ms, p95 34.82, p99 43.36, max 77.29
- all 2400 retraces, native: mean 9.54 ms, p95 17.56, p99 32.41, max 50.02 (retrace 1 is boot)

Against the 16.67 ms budget of 60 Hz, **p95 is already over it for both builds on this machine**.
That is not a verdict on the device question — it is `-O1` on two shared vCPUs — but it does mean
the first honest device measurement (P0-10/P0-11) has a real chance of failing, and the levers
(optimisation level, wasm-opt, the actual phone) are untested.

**What is deliberately missing from this result.** Comparison **B** (native threaded vs native
single-threaded) and **D** (single-threaded native vs WASM) did not run: the native workflow
builds only the threaded variant, so no single-thread native binary exists to compare. The WASM
module is single-threaded, so E compares a threaded native against a single-threaded WASM and
they agree — which is stronger than D would have been, but B remains unmeasured and P0-08's own
verification list asks for it.

**Deviation, recorded on purpose.** P0-09's task entry expects this in a CI job. It ran here
instead, because CI has no disc image (D1 unanswered). The comparison logic is the same code
either way; what differs is who owns the disc.


## P0-10 / S6 — browser Worker harness, 2026-09-30

Implementation: `web/spike.html`, one module Worker per run, ES-module web factory,
WORKERFS disc mount, raw CSV/result JSON download, checkpoint comparison and nearest-rank
simulation statistics. The shell build includes the page but no core; only the WASM
workflow assembles `/spike-core/` and tests it in Chromium with a synthetic 0x440-byte
header. No game data is included in the test. Python remains the authoritative comparator.

P0-10 deviation: WORKERFS reads the selected File synchronously on demand instead of
MEMFS-preloading the 1,459,978,240-byte ISO. No ISO upload or whole-disc memory copy.
The service worker bypasses `/spike-core/`; controlled spike pages refuse a run.

Plan/repository discrepancy: S2 landed `upload_module` and `melee-core-wasm-node`, not
`upload_wasm` or a combined artifact. S6 preserves that Node-only interface and adds
`upload_spike` (default false, dispatch only, three-day private artifact). No S1/S2 runtime
or script changes, upstream edits or new port patches. Real-disc browser parity, device
performance and go/no-go remain unmeasured; S7 and Q8 require the operator's desktop/ISO
and confirmation of the web artifact exception. CI evidence will be recorded below.

### S6 measured verification

Implementation commit `d3cbbc672e0cd0d49e26e66c81ff17e35a8345cf`, PR #12:

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36729092794` (WASM core) | **success** | job 33m20s; offline compile/link 846 s, release guest 969 s; reported build wall 1905 s |
| `36729092730` (PR CI) | **success** | 217 unit tests across 17 files; 10 shell Chromium tests, 8.4 s test time |
| `36729059364` (push CI) | **success** | web job 38 s, browser job 1m51s |
| `36729092834` (WASM probe) | **success** | job 1m37s |

WASM run log: Node module **87,118,511 bytes**, web module **87,118,045 bytes**;
both `within_pages_limit: false` (limit 26,214,400 bytes), both
`forbidden_libm_imports: []`. Highest compiler peak RSS **7,425,808 KiB**.
Spike page build step 22 s; Chromium setup/test step approximately 36 s;
**one synthetic-disc test passed in 3.6 s**. Its assertions verify the module loads in a
Worker, WORKERFS reads the selected File, `callMain` returns exit 1 with
`FATAL: cannot read full Melee DOL`, the page is cross-origin isolated and the result
JSON download becomes visible. Neither WORKERFS export nor ExitStatus fallback was needed.
Local checks: **66 Python tests passed**, staged and `--all` game-data gates passed.

**Demonstrated:** the CI-built spike page serves and executes the web core in Chromium
with a synthetic disc. **Not demonstrated:** real-disc browser boot, 2400-checkpoint browser
parity, phone/desktop simulation timings, or the go/no-go. No spike artifact was uploaded;
Cloudflare deployment was skipped for missing credentials. S7 remains operator-dependent
(Q8); the 87 MB core cannot go on Pages. No build or browser ran on the VPS.

Integration note: main advanced to `d0ef872` (PR #11) during S6. Its P0-09 report,
Node-capable checkpoint runner with `--sim-times`, and narrowed workflow script paths
are preserved. Only the report append conflicted. The runner still defaults to
`vs_match.txt`; S6 explicitly uses `parity_vs_onett.txt`, without editing the runner.
The synthetic-disc failure is now at `native/headless_host.cpp:199` (plan: line 196).
All measured runs above precede this documentation/base integration; subsequent PR checks
must pass before merge. No compiled source changed during integration.

## Phase 0 — the module shrinks by 81%, and stays bit-identical (2026-09-30, evening)

The module was **87.118.511 bytes**, 3.3x Cloudflare Pages' 25 MiB per-file limit, and it is what
a phone would have to download. Two of the three size levers cannot touch arithmetic (`-g2` debug
info, `-sASSERTIONS=1`); the third, `-Oz` instead of `-O1`, can in principle, so it was measured
rather than argued about, on branch `phase0/oz-size-experiment` (run `36743835141`).

| | `-O1` | `-Oz` | |
| --- | --- | --- | --- |
| module | 87.118.511 B | **16.323.657 B** | **−81.3%** |
| Pages 25 MiB limit | 3.3x over | **under** | |
| 2400 checkpoints | `c79c53b9…` | `c79c53b9…` | **identical** |
| 2400 retraces | 81 s | 79 s | |
| in-match mean / p95 / p99 | 27.34 / 34.82 / 43.36 ms | 28.92 / 37.78 / 46.53 ms | ~6% slower |

**What this establishes.** The size blocker is gone: the module is a normal mobile download and
fits the deploy target. And it is gone *without* buying it with correctness — the `-Oz` module
reproduces the native reference trace byte for byte, on the same commit and the same script, so
the optimiser changed nothing observable. `-ffp-contract=off` and `-fno-fast-math` held at the
new level, which is the part that could have broken the arithmetic and did not.

**What it costs.** About 6% on the simulation, measured the same way as everything else. `-Oz`
optimises for size, so this is the expected shape of the trade, not a surprise.

**Still open.** The real go/no-go threshold for a phone is a mean of ≤ 3 ms and a p99 of ≤ 6 ms
per frame (`docs/SPEC_PIANO.md`, "Criteri go/no-go" — the 16.67 ms frame budget is necessary but
not sufficient, because Slippi's rollback can resimulate up to 7 frames in one tick). At 28.92 ms
on this VPS the mobile target is ~10x away, and `docs/PHASE0_DEVICE_PLAN.md` says to expect a
NO-GO. Two things keep that provisional: this is a shared 2-vCPU VPS rather than a phone's big
core, and no measurement has been taken on a device yet.

## The spike page is served, and the web module is measured — 2026-09-30, evening

The first half of `docs/PHASE0_DEPLOY_PLAN.md` §6 step 2 is done, and one of its open
questions is closed by reading a log instead of deducing.

- `phase0-build.yml` was dispatched on `main` with `upload_spike=true`: run **36753728272**,
  job **7m18s** (17:45:56 → 17:53:14), every step success — including the 144 release guest
  TUs, the WASM core link, the spike page build and the synthetic-disc Chromium test.
- Artifact `melee-spike-dist`: 4,669,739 bytes compressed, expires 2026-10-03. It holds
  `spike-core/melee_core_web.wasm` at **16,323,255 bytes** — this is the **web** module at
  `-Oz`, the number `docs/PHASE0_DEPLOY_PLAN.md` §0.3 recorded as unverified. It is **81.3%
  smaller** than the `-O1` web module (87,118,045 bytes) and **under** the 25 MiB Pages
  per-file limit, so size is no longer what blocks a deployment.
- `spike-core/core.json` = `{"commit":"4fba3a080af6f205cc6107ada7baefeb0315cae0","opt":"-Oz"}`.
  The commit is `main`'s head, so the core served to the device is the `-Oz` build that
  already reproduced the native trace bit for bit.
- The artifact was downloaded **outside the checkout** to
  `/home/hermes/incoming/phase0/spike-dist` and served by
  `.hermes/cache/scratch/spike-serve/serve_spike.py` on `127.0.0.1:8091`, verified from the
  VPS with `curl` rather than assumed:

| Request | Result |
| --- | --- |
| `HEAD /spike.html` | `200`, `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store` |
| `HEAD /disc.iso` with `Range: bytes=0-5` | `206`, `Content-Range: bytes 0-5/1459978240` |
| `HEAD /spike-core/melee_core_web.wasm` | `200`, `Content-Type: application/wasm`, `Content-Length: 16323255` |

Not verified here: **HTTPS on the tailnet**. `tailscale serve --bg 8091` has not been run, so
the isolation headers above are only effective if the page is reached over a secure context.
Over plain `http://` on a tailnet IP the browser ignores them, `cross_origin_isolated` stays
false and the clock is coarser than the ≤ 0.1 ms the verdict needs
(`docs/PHASE0_DEVICE_PLAN.md` §0.3, §6).

Also still open from §6: PR 3 (the `/phase0/disc` Function), PR 4 (the OPFS page), PR 5 (the
deploy step), and the operator's decision O1.

## Deploy plan PR 3 — the disc Function (2026-09-30, evening)

`docs/PHASE0_DEPLOY_PLAN.md` §6 step 4, the first of the four `[subito]` PRs after the plan.
PR #16, commit `2208884`, branch `phase0/disc-function`, one logical change, no upstream file
touched, so no `patches/` entry and no `docs/PORT_CHANGES.md` row.

**What it is.** `functions/phase0/[[path]].ts` answers `GET` and `HEAD` for `/phase0/disc`
(object `melee-ntsc102.iso`) and `/phase0/disc-chunks` (object `disc-chunks.json`), the two
objects `scripts/phase0/upload_disc.sh` puts in the private `melee-phase0-disc` bucket. The
object key is chosen from the request path against a fixed table and never taken from the
request. One `bytes=` range is served with `206` and a `Content-Range` computed from a real
ranged R2 read; an unsatisfiable range is `416` with `bytes */<size>`; a malformed, multi-range
or unknown-unit header is ignored and the whole object is served; `HEAD` never reads a body;
`503` without the binding, `404` for an unknown path under `/phase0` or an absent object, `502`
on an R2 failure with no diagnostics forwarded. `Cache-Control: no-store`,
`Cross-Origin-Resource-Policy: same-origin`, `Accept-Ranges: bytes`. `functions/types.ts` gains
`PHASE0_DISC` as a structural subset of `R2Bucket` (the `ASSETS_R2` pattern), `wrangler.toml`
the second `[[r2_buckets]]` block.

**Deviation, deliberate.** The plan names `functions/phase0/disc.ts`. The file is the catch-all
`functions/phase0/[[path]].ts` instead: `wrangler pages functions build` treats every `.ts` file
under `functions/` as a route candidate (`vitest.config.ts` records the same constraint for the
tests), so the range logic cannot live in a shared helper module there, and one file per route
would duplicate it. The route table is what keeps the keys fixed.

### Measured verification

| Actions run | Job | Conclusion | Measurement |
| --- | --- | --- | --- |
| `36760716404` (Pages Functions) | `functions` | **success** | 33 s; typecheck, `vitest` and `wrangler pages functions build` |
| same run | `Run npm test` | — | `tests/functions/phase0-disc.test.ts` **23 tests**, suite **120 tests in 5 files**, all passed |
| `36760716501` (PR CI) | hygiene / web shell | **success** | 18 s / 37 s |
| `36760654826` (push CI) | hygiene / web shell / browser | **success** | 22 s / 42 s / 1m51s (10 Chromium tests) |

The 23 tests are 18 assertions over a ten-byte fake object (whole object, chunk manifest,
eleven range headers, ranged and unranged `HEAD`, `405`, unknown path, `503`, absent object,
`502`, and the exact R2 keys and ranged reads) plus the composed-middleware case, which asserts
that a request without an Access token is answered `403` **before** R2 is touched.

**Demonstrated:** the routing, the range arithmetic, the response headers and every error path,
plus the route still bundling. **Not demonstrated, and the commit says so:** nothing has run
against a real R2 bucket; the bucket does not exist yet (operator item O3); whether Cloudflare's
edge or Pages passes a `Range` header through to a Function unchanged is on the §3 checklist for
the first deploy.

**Risk recorded, not fixed.** `wrangler.toml` now declares a binding to a bucket that does not
exist. The `ci.yml` deploy job skips only while the Cloudflare credentials are absent, so the
first shell deploy after the credentials arrive will fail until O3 is done or the block is
removed. That is what the plan asks for; it is in the PR description so the failure is not a
surprise in the wrong job.

**Next, in plan order:** PR 4 (the page that populates OPFS from `/phase0/disc`, with the
`disc_source`/`storage_persisted`/`core_load_ms` fields in the result JSON), then PR 5 (the
`deploy_spike` step in `phase0-build.yml`). Both are `[subito]`: the OPFS page is testable in
Chromium against a synthetic disc with ranged responses, and the deploy step skips itself
without credentials. Step 3 of §6 — a native trace at the commit the served core was built from
— still needs a dispatch plus the ISO, and step 6 onwards need O1 (the Cloudflare decision).

## The native reference at the served core's commit — 2026-09-30, evening (§6 step 3)

`docs/PHASE0_DEPLOY_PLAN.md` §6 step 3: the core served to a device must be compared against a
native reference built from the **same commit**. The spike core in
`/home/hermes/incoming/phase0/spike-dist` announces itself in `core.json` as
`{"commit":"4fba3a080af6f205cc6107ada7baefeb0315cae0","opt":"-Oz"}` (run `36753728272`), while the
only native trace this project had came from `f0d76a28` (run `36722713202`). Comparing across
those two commits would mix two variables, which `docs/PHASE0_DEVICE_PLAN.md` §5 ("Il commit del
riferimento") forbids.

**How it was done.** Tag `phase0-native-ref-4fba3a0` at `4fba3a080af6f205cc6107ada7baefeb0315cae0`
(kept in the repository: it makes "which commit the reference came from" self-documenting instead
of a claim in a document), then `phase0-native-headless.yml` dispatched at that tag with
`upload_binary=true` — run **`36761760073`**, **success**, artifact `melee-core-headless`
8,308,846 bytes, expires 2026-10-03 — downloaded to
`/home/hermes/incoming/phase0/reference-4fba3a0/`, outside the checkout, and run here twice
against the operator's own disc, verified first (1,459,978,240 bytes, SHA-1
`d4e70c064cc714ba8400a849cf299dbd1aa326fc`), with `parity_vs_onett.txt` passed explicitly
(`scripts/phase0/run_checkpoints.sh` still defaults to `vs_match.txt`, the script P0-08 measured
as wrong for this build).

| Run | Wall clock | Trace SHA-1 | Final scene |
| --- | --- | --- | --- |
| `run-1` | 55 s | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | `mode=2 state=2 match_frame=762 (retraces=2400)` |
| `run-2` | 54 s | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | same |

`scripts/phase0/compare_checkpoints.py run-1 run-2` → `identical: 2400 retraces`, exit 0. Both
runs report `FPSCR requests: RN=0 NI=0`.

**The finding: the reference is the one we already had.** The trace at `4fba3a0` is byte-identical
to the `f0d76a28` trace, so everything committed between those two commits — the `-Oz` switch and
the `-g0` debug level in `wasm/core/CMakeLists.txt`, the `core.json` fix in `phase0-build.yml`,
`serve_spike.py`, documentation — moved nothing observable in the native build. The device parity
check therefore has a real reference at the served core's commit rather than an inference from a
neighbouring one, and the number to expect from the browser is `c79c53b9…`.

**Timing, context only** (`--sim-times`, this 2-vCPU VPS, `nice`d, `--fast`, nearest-rank):
in-match 762 rows mean **14.92 ms**, p95 18.34, p99 19.50, max 23.31; all 2400 rows mean 9.61,
p95 18.98, p99 31.94, max 46.79 (retrace 1 is boot). This is the native side of the proxy pair,
not a device number, and it does not enter the verdict.

**Next:** PR 4 of the deploy plan (the page that populates OPFS from `/phase0/disc`) and PR 5
(the `deploy_spike` step). Both are `[subito]`. The device runs (M1/M2 via road D) need the
operator and no Cloudflare credentials.

## The checkpoint runner stops defaulting to the wrong script — 2026-09-30, evening

`scripts/phase0/run_checkpoints.sh` is the only script in this repository that writes a
game-derived trace, and it carried three defects that only bite when someone runs it for real:
its default script was `port/scripts/vs_match.txt`, which P0-08 measured as wrong for this
`--no-slippi` build (2400 deterministic retraces of a menu, no match at all); a typo in the
script argument fell back to that default silently; and nothing stopped the output directory
from being inside the checkout, where the script removes and recreates it — the trace and card
image it then writes are game-derived, so a path inside the repository would have deleted
tracked files and left files that `scripts/check_no_game_data.py` rejects.

**What changed** (one logical change, PR #18, branch `phase0/runner-guards`, commit `175aae7`):
the default is `port/scripts/parity_vs_onett.txt`, the @scene-anchored script P0-08 established
as the right one; a nonexistent script is a refusal that names the path; an output directory
inside the repository is a refusal; `--dry-run` resolves everything, prints the exact command a
real run would execute and touches no disc; a `.js` module is run with `${NODE:-node}`; and the
end-of-run report now prints the trace SHA-1, the `final scene:` line and the `FPSCR requests:`
line, because P0-08 was caught by the scene line and a checkpoint count must never again be read
as "a match was played" without evidence. No upstream file is touched, so there is no `patches/`
entry and no `docs/PORT_CHANGES.md` row.

**The guards are the deliverable, not the prose.** `scripts/tests/test_phase0_runner.sh` is new
and runs in the hygiene job of `ci.yml`. Every case ends in a refusal or in a dry run: no ISO is
needed and no binary is launched, so it works in CI, where the disc does not exist.

| Check | Result |
| --- | --- |
| Locally, on this VPS | **44/44 guards hold**, exit 0 |
| Mutation: the default back to `vs_match.txt` | **2 guards fail, exit 1** — the suite is not vacuous |
| CI, PR run `36771942657`, hygiene step "Phase 0 checkpoint runner guards" | **success**, log line `44 checkpoint runner guards hold` |
| The same step, from the log timestamps | 20:20:56.93 → 20:20:57.04, about **0.1 s** |
| Hygiene job duration | 22 s (PR run `36771942657`) and 18 s (push run `36771929834`), both success |

**Deviation from `docs/PHASE0_NEXT.md` S2 item 3, deliberate.** The repository root is derived
from the location of the script (`BASH_SOURCE`) instead of from `git rev-parse --show-toplevel`
in the directory of the caller, as that step prescribed. Every real trace is written under
`/home/hermes/incoming/phase0`, which is not a repository: `git rev-parse` fails there, the
fallback would be `pwd`, and the "inside the checkout" test would then refuse the legitimate
output directory. That step also asked for the two `grep` lines at the end of the run: they are
there. The `.js` handling already existed in `main`.

**Not verified, and deliberately not covered.** Nothing has run against a real disc since this
change, so the new report lines are exercised only through the refusal paths. The
"expected size, wrong SHA-1" refusal is not covered by the new suite: it is only reachable with
a 1,459,978,240-byte fixture, and the same gate over the same fixture is already exercised for
`scripts/phase0/upload_disc.sh` in `scripts/tests/test_deploy_guard.sh`. What the new suite
checks instead is that the two constants still match the Redump values stated in
`docs/OPEN_QUESTIONS.md`. The row in `docs/PHASE0_NEXT.md` §0 that says the runner defaults to
the wrong script is left as written: it records the state at 12:20 UTC, and this section
supersedes it.

## The device row: the iPhone runs the same game, and lands in the "desktop only" band (2026-09-30, night)

Three runs of the 2400-retrace spike on the operator's **iPhone 16 Pro**, served over HTTPS, verified
on the VPS from the JSONs the page produced. Full evidence, tables and every check:
`docs/DEVICE_TEST_IPHONE16PRO.md`.

- **Correctness: pass, three times.** Trace SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571` in all
  three runs, and **0 differing rows out of 2400** against `$D/runs/native-1/trace.csv`. JavaScriptCore
  on iOS reproduces the native reference exactly: the open question of `docs/PHASE0_DEVICE_PLAN.md` §0.3
  is now answered by a measurement, not an inference.
- **The clock is clean**: `cross_origin_isolated: true`, `timer_resolution_ms` **0.02 ms** (threshold
  0.1). Reaching a secure context took a detour: `tailscale serve` failed with `Access denied: serve
  config denied` (writing serve config needs root and this VPS has no sudo), so the page was served
  through a `cloudflared` quick tunnel — trusted HTTPS, verified with `curl` before the runs.
- **Timings, in-match, worst of three: mean 3.2442 ms, p99 5.64 ms.** The three runs gave means
  3.0315 / 3.2442 / 3.0809 and p99 3.96 / 5.64 / 4.12.
  Against the spec's thresholds: **not GO** (`m + q ≤ 3` fails by 0.26 ms, about
  9%) and **not NO-GO**, therefore the "desktop only" band — proceed on desktop and
  re-evaluate the mobile row in Phase 4. `p ≤ 16.67 ms`, so 60 Hz without rollback holds.
- **Where it can move.** The served core is `-Oz`, measured here as ~6% slower than `-O1`; applying that
  ratio puts the worst run at ~3.07 ms (still outside the GO line) and the best at
  ~2.87 ms (inside). That is an extrapolation from a VPS measurement,
  not a device measurement: to settle it, rebuild at `-O1` and repeat the three runs.
  `phase0-build.yml` has no input for the optimisation level today, so it needs a code change, with the
  2400-checkpoint parity as the precondition (both levels already produce `c79c53b9…` on the VPS).
- **Not established.** One device, one OS version (the operator reports iOS 27, the page's user agent
  says `iPhone OS 18_7`; both are recorded, the discrepancy is unresolved), Safari only. No graphics, no
  audio, no input, no network, no long session: run 2 shows thermal drift (+6.6% inside the run) already
  at this scale, and the timings are declared by the page, not proven to come from the phone.
- **Evidence**, kept out of the repository because the trace is game-derived:
  `/home/hermes/incoming/phase0/devices/iphone-safari/` (three JSONs as received, plus the extracted
  `runN_trace.csv` / `runN_sim_times.csv`).

**Next step.** Either accept the "desktop only" reading for the mobile row, or make the optimisation
level selectable in `phase0-build.yml` and repeat the three runs at `-O1`; the second is the only path
that turns the extrapolation above into a number.
