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

## The checkpoint trace does not inflate the measured frame times — a hypothesis tested and dropped (2026-09-30, night)

The night consultation proposed that the device numbers might be measured by an instrument that costs
what it measures: `native/headless_host.cpp` hashes about 40 MiB of RAM and ARAM after every retrace,
`sim_ms` excludes that work, and the next frame starts with the cache it evicted. On the iPhone the
wall clock was 24 s against 5.2 s of simulated frames, so the mechanism was plausible enough to test
before trusting the numbers.

Six trials on the native binary built from the served core's commit, alternating, 2400 frames each,
same disc and same script, statistics from `scripts/phase0/frame_stats.py --in-match` (the 762 match
frames):

| trials | mode | in-match mean ms | mean of means | wall clock |
| --- | --- | --- | --- | --- |
| 1, 2, 3 | with `--state-trace` | 14.69 / 14.95 / 13.87 | **14.504** | 54 / 53 / 52 s |
| 1, 2, 3 | without it | 15.24 / 14.37 / 14.25 | **14.622** | 53 / 54 / 52 s |

**No measurable effect: the difference is −0.8%, in the direction opposite to the hypothesis, and the
spread inside each series is ±5% — five times the difference.** The wall clock is the same to the
second, and all three traced runs hash `c79c53b9…` and end at `mode=2 state=2 match_frame=762`, so
the comparison is between two runs of the same simulation and not between two different ones. The gap
between wall clock and simulated time is real, but it is not the checkpoint trace: the native harness
shows the same gap (about 53 s of wall clock for about 11 s of frames) with and without it.
**The device row stands as measured: no correction is owed to 3.0315 / 3.2442 / 3.0809 ms.**

Caveat kept in the record: this ran the x86 binary on the VPS, not the WebAssembly module under
JavaScriptCore, so it removes one candidate explanation without explaining the gap. Method, table and
limits: `docs/HARNESS_OVERHEAD_EXPERIMENT.md`.

## The optimisation level: measured, bit-exact, and 5.2x too big to ship (2026-09-30, night)

The device row misses the GO line by 8% and the served core is `-Oz`, which this repository had
measured as roughly 6% slower than `-O1`. That made the optimisation level the first lever to test.
`phase0-build.yml` now takes an `opt_level` input and `wasm/core/CMakeLists.txt` exposes `MELEE_OPT`
with `-Oz` as the unchanged default (PR #20), so the lever became measurable instead of arguable.

Dispatch `36779031737` (main `f008e27`, `opt_level=-O1`, both uploads on), success, 21:22 → 22:00 UTC.
The run summary prints `opt_level=-O1`, and the artifact's `core.json` says
`{"commit":"f008e27881e67b5233d8384c60934713b9e92eca","opt":"-O1"}` — the field now reports what CMake
configured with, which is what PR #20 fixed: it used to be grepped out of the build definition and
matched the `-O1` in a comment.

| module | `-O1` bytes | `-Oz` bytes (run 36776512026) | Pages limit | `within_pages_limit` at `-O1` |
| --- | --- | --- | --- | --- |
| `melee_core_node.wasm` | 85.658.487 | 16.323.657 | 26.214.400 | **false** |
| `melee_core_web.wasm` | 85.658.030 | 16.323.255 | 26.214.400 | **false** |

Where the bytes went, read by opening the module rather than guessed: the `code` section is
84.881.224 bytes, **99.1%** of the file. It is not the name section and not debug information, so
"compile at `-O1` and strip the symbols" has nothing to strip.

**Correctness and speed, measured on the VPS** with the downloaded Node module, the operator's own
disc, the project's script and 2400 frames: two runs, both `exit 0`, both trace SHA-1 `c79c53b9…`,
both `identical: 2400 retraces` against the native reference, both ending at
`mode=2 state=2 match_frame=762`. In-match means 28.46 and 25.31 ms against 30.02 / 27.76 / 28.92 ms
for the three `-Oz` runs of the same day: **about 7% faster**, which is the ratio the repository had
been carrying as an estimate from an older commit.

**The level is therefore not the lever, and the reason is size, not speed.** `-Oz` stays the shipped
core because at `-O1` the module cannot be published to Cloudflare Pages at all — 3.3x over the
per-file limit. The route that remains is a level per file: the hot translation units at `-O2`/`-O3`
and the rest at `-Oz`, which should cost few bytes and must be measured with this same method (2400
checkpoints, bytes, `within_pages_limit`). Full method, acceptance criteria and numbers:
`docs/OPT_LEVEL_EXPERIMENT.md`.

## PR 4, step 1 — the disc cache verifies every piece before it writes one (2026-10-01, night)

`docs/NIGHT_HANDOFF.md` ordered PR 4 (`docs/PHASE0_DEPLOY_PLAN.md` section 5) as four small steps.
This is the first: the module that decides what a verified disc is. Nothing is wired into the
spike page yet — the OPFS worker, the new JSON fields and the page button are the steps after it.

**New.** `web/src/spike/disc-cache.ts`, `web/tests/unit/disc-cache.test.ts` (28 tests),
`web/tests/unit/fakes/discFixtures.ts`.

The rules the module enforces, and why each one exists:

| Rule | Why it exists |
| --- | --- |
| The manifest is validated before anything else: total size, piece size, piece count (it must be the ceiling of the division), both digest formats, and a piece no bigger than 32 MiB | one piece is held in memory at a time, and a document that disagrees with itself is refused before a 1.36 GB download instead of after it |
| The cache's identity is the SHA-256 of the manifest's validated fields | a different disc, or the same disc cut differently, cannot read the old bytes |
| A download re-reads and **re-hashes** every stored piece, and truncates the file at the first piece that is missing, short or corrupt | length alone certifies nothing: a piece of the right length can hold the wrong bytes |
| Each piece is asked for with an exact `Range`, and `206`, `Content-Range`, body length and SHA-256 are all checked **before** a byte is written | a `200`, an HTML page, a wrong `Content-Range`, a short body and a body longer than requested are each refused |
| Free space is demanded before the download starts: the missing bytes plus an 8 MiB margin | `estimate()` reports without reserving anything, and `persist()` may be denied |

**Measured.**

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36785570437` (PR CI) | **success** | **245 unit tests across 18 files** (was 217 across 17: +28, exactly the new file), 4.43 s; typecheck and build clean; 10 shell Chromium tests pass (5.6 s); deploy skipped without credentials |
| `36785570607` (Phase 0 — WASM core) | **success** | job 12 m 13 s (22:26:27 → 22:38:40 UTC); the spike page typechecks and builds with the new module in its graph, and the synthetic-disc Chromium test still passes (740 ms) |
| `36785529423` (push CI) | **success** | same commit |

Local convenience check, **not evidence**: `npm install` is forbidden on this VPS
(`docs/AGENT_RULES.md` rule 3), so the same test file was executed under Node 22 type stripping
with a local stand-in for vitest's globals — 28 passed, 0 failed. The runs above are the authority.

**Not in this step.** The dedicated OPFS worker (the browser implementation of `DiscStore`), the
`disc_source` / `storage_persisted` / `core_load_ms` fields, the download button in
`web/spike.html`, and the Chromium tests in `web/tests/spike/spike.spec.ts`. The plan's known
defects that belong to those steps are untouched here: the spike fixture is still too small to
exercise a resume, a private window is still incompatible with a persistent cache, and removing
`sw.js` from the deploy still does not unregister a service worker that is already registered.

**Next step.** The OPFS worker: one `createSyncAccessHandle()`, sequential download, at most one
piece in memory, `flush()` after every piece, `close()` in `finally`, the `File` returned after the
close, and downloads, deletions and runs serialised even across tabs. Then the JSON fields, then
the button in the page.

## PR 4, step 2 — the disc cache writes through one OPFS worker (2026-10-01, night)

Written up late: PR #28 (`feat/phase0-opfs-worker`, merged 2026-10-01 01:51 UTC as `aad3598`)
landed the browser implementation of step 1's `DiscStore` without a section here, so the "Next
step" of the section above still named it as pending. It is recorded now because a session that
reads this file alone would otherwise rebuild it.

**New.** `web/src/spike/opfs-worker.ts` (the writer: one `createSyncAccessHandle()`, `flush()`
after every piece, `close()` in a `finally`, a write only at the current end of the file, the
`File` handed out with no handle open, one exclusive Web Lock per cache identity),
`web/src/spike/opfs-store.ts` (the page's side: one identified message per operation, replies
matched by id, everything in flight rejected when the worker dies),
`web/tests/unit/opfs-worker.test.ts`, `web/tests/unit/opfs-store.test.ts`, and the fakes
`web/tests/unit/fakes/fakeSyncOpfs.ts` and `web/tests/unit/fakes/fakeWorkerPort.ts`.

**Measured.** Runs `36798558897` (CI, **success**) and `36798558952` (Phase 0 — WASM core,
**success**), both on `f54ab72`: **282 unit tests across 20 files** (was 245 across 18: +37, the
two new files), 3.95 s; typecheck and build clean; the spike Chromium test still passes.

## PR 4, step 3 — the page names its disc source, its storage state and the core load time (2026-10-01, night)

Step 3 of PR 4 (`docs/PHASE0_DEPLOY_PLAN.md` section 5). Steps 1 and 2 decided what a verified
disc is and where its bytes are written; this step is the page: it runs from the verified cached
disc when there is one and from the file selector when there is not, and the result JSON says
which of the two it was.

**New.** `web/src/spike/disc-source.ts`, `web/tests/unit/disc-source.test.ts` (7 tests).
**Modified.** `web/src/spike/main.ts` (the choice, and `disc_source`, `storage_persisted`,
`core_load_ms` in the result), `web/src/spike/worker.ts` (the `core_load_ms` measurement only; the
WORKERFS mount is untouched), `web/tests/spike/spike.spec.ts` (two tests added).

The rules the choice enforces, and why each one exists:

| Rule | Why it exists |
| --- | --- |
| A verified cached disc wins over the picked file | the cached one has been hashed piece by piece and its length checked against the manifest; the picked file has been checked for its size and for nothing else |
| A cache that cannot answer is a fallback, not a failure | the manifest is served by a Cloudflare Function: a local preview, a deploy where the binding is missing, and a phone whose connection dropped mid-download must all still run from the selector |
| The result says where the disc came from | without `disc_source`, an operator reading a result cannot tell an OPFS run from a selector run, and the two are not the same measurement |
| `core_load_ms` is measured in the worker, from its start to the `core` message | it is the wait the operator actually has: the four fetches, the module's own download and compile, the runtime's initialisation. Nothing about the run depends on it |

`storage_persisted` is what the browser answers when asked whether this origin's storage is
persisted, read at the moment of the run. It is reported rather than demanded: a denied
`persist()` does not fail a run, it means the cached disc may be evicted before the next one.

**Measured.**

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36804319138` (CI, on `75cd4d0`) | **success** | **289 unit tests across 21 files** (was 282 across 20: +7, exactly the new file), 4.96 s; typecheck and build clean; the shell's browser tests pass; deploy skipped without credentials |
| `36804335543` (Phase 0 — WASM core, on `75cd4d0`) | **success** | job 10 m 43 s (02:07:32 → 02:18:15 UTC); the spike page typechecks and builds with the new module and the OPFS worker in its graph, and **3 Chromium spike tests pass** (673 ms, 256 ms, 554 ms; 3.9 s) |
| `36804335525` (push CI, on `75cd4d0`) | **success** | same commit |

Local convenience check, **not evidence**: `npm install` is forbidden on this VPS
(`docs/AGENT_RULES.md` rule 3), so `src/spike` was typechecked with the repository's flags and the
new test file executed under a vitest borrowed from another tree (4.1.10; this repository pins
`^2.1.0`) against a scratch copy — 7 passed, and 289 unit tests across 21 files passed there too.
The runs above are the authority.

**Not in this step.** The download button in `web/spike.html`, its progress line and its delete
button, and the Chromium tests that need a populated cache: the multi-piece fixture with a short
last piece, the interrupt-and-resume with an exact `Range`, the corrupt piece, the complete cache
that downloads nothing, and the run that reaches the expected DOL error with `disc_source=opfs`.
The OPFS branch of the choice is covered by the unit tests here; the browser end of it arrives
with the button. The plan's known defects that belong to step 4 are still untouched: the spike
fixture is still too small to exercise a resume, a private window is still incompatible with a
persistent cache, and removing `sw.js` from the deploy still does not unregister a service worker
that is already registered.

**Next step.** Step 4 of PR 4: the button in `web/spike.html` (download into OPFS with a progress
line, and a delete button), then the Chromium tests over a populated cache, including the
`disc_source=opfs` run. After PR 4, PR 5 (the `deploy_spike` step) and PR 6
(`scripts/phase0/go_no_go.py`, S8 of `docs/PHASE0_NEXT.md`, still not written).

## PR 4, step 4 — the page downloads the disc into OPFS from a button (2026-10-01, night)

The last step of PR 4 (`docs/PHASE0_DEPLOY_PLAN.md` section 5). Steps 1–3 decided what a verified
disc is, where its bytes are written and which of the two discs a run used; this step is the only
way those bytes ever appear: the operator clicks a button, the page downloads the disc into this
origin's own storage piece by piece, and the next run takes its disc from there instead of from the
file selector. **PR 4 is complete with this step.**

**Modified.** `web/spike.html` (a "Disc cache" section: download button, delete button, a line
that says what the cache holds and a line for the download's progress), `web/src/spike/main.ts`
(the two handlers, `humanBytes`, `refreshDiscStatus`; the run itself is unchanged),
`web/tests/spike/spike.spec.ts` (the synthetic disc served by the test itself and four new tests;
the old selector test is replaced by the `disc_source=opfs` run). `disc-cache.ts`,
`opfs-worker.ts` and `disc-source.ts` are untouched: this step wires what they already do.

The rules the page enforces, and why each one exists:

| Rule | Why it exists |
| --- | --- |
| The status line asks for the **verified** disc (`getVerifiedDisc()`), never for the stored length | a length is not a disc: a half-written or poisoned cache must not be reported as ready, and the verification re-reads and re-hashes every stored piece and truncates at the first bad one |
| A cache that cannot answer is reported as unavailable, not as an error | the manifest is served by a Cloudflare Function: a local preview, a missing binding or a dropped connection must still leave the page runnable from the selector |
| A second click joins the download in flight | `downloadDisc()` serialises by cache identity, so the button cannot start a second writer on the same file |
| Delete stops a download first, then removes the bytes from OPFS | "deleted" means gone from the origin's storage, not forgotten by the page: the next download starts at offset 0 and the next run falls back to the selector |
| The fixture is four pieces of 16 KiB with a **short last piece** (2000 bytes) | the plan's own fixture was too small to exercise a resume; a single piece cannot show one, and a full-size last piece cannot show that the last `Range` is the short one. **Defect 1 of the plan is corrected here** |
| The test serves the manifest and the byte ranges itself | no CI runner has the operator's ISO and none ever will (`docs/AGENT_RULES.md` rule 1); `functions/phase0/disc.ts` is the real endpoint, and the assertions are about what the page does with the bytes |
| The cache is filled and read inside one browser session | the plan's **defect 2** (a private window is incompatible with a persistent cache) is real for the operator's procedure, but not for these tests: each test fills the cache it then reads, and nothing asserts that the cache survives the session. `storage_persisted` is reported, never demanded |

**Measured.**

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36810185941` (CI, on `eb8f9d5`) | **success** | **289 unit tests across 21 files**, 5.06 s (unchanged: this step adds browser tests, not unit tests); typecheck and build clean; **10 shell Chromium tests pass** (7.5 s); deploy skipped without credentials |
| `36810185919` (Phase 0 — WASM core, on `eb8f9d5`) | **success** | job 12 m 30 s (03:22:10 → 03:34:40 UTC); **6 spike Chromium tests pass** (789, 445, 497, 367, 531, 789 ms; 5.0 s) — the one WORKERFS test plus the five cache tests |
| `36810154802` (push CI, on `eb8f9d5`) | **success** | same commit, 03:21:46 → 03:23:40 UTC |

What the five cache tests assert, with the `Range` headers the page actually sent (all six runs
observed in the job log above):

| Test | Evidence |
| --- | --- |
| download fills OPFS, a complete cache is not downloaded again | four pieces requested in order, the last one short: `bytes=0-16383`, `bytes=16384-32767`, `bytes=32768-49151`, `bytes=49152-51151`; a second click sends **no request at all** |
| an interrupted download resumes at the last verified piece | piece 3 answered `500`: three ranges sent, cache reports "no verified disc"; the retry asks for exactly `bytes=32768-49151` and `bytes=49152-51151` — the two stored pieces are re-read and re-hashed locally, not fetched again |
| a corrupt piece is refused before it is written | piece 2 served with one flipped byte: the download fails on the hash, and the retry asks for `bytes=16384-32767` again (it was never written) plus the two pieces after it |
| delete removes the cached bytes | after delete the status is "no verified disc" and the next download sends all four ranges again |
| a run takes its disc out of OPFS | no file chosen, `disc_source` is `opfs`, `iso_bytes` 51152, `exit_code` 1 and `FATAL: cannot read full Melee DOL` in the log — the same failure `docs/PROGRESS.md` S6 records, so the OPFS path reaches the expected error and not another one |

**Not in this step.** **Defect 3 of the plan** (removing `sw.js` from the deploy does not unregister
a service worker that is already registered) belongs to PR 5, the `deploy_spike` step: nothing in
this repository's CI serves a registered service worker, so there is nothing here to fix it against.
PR 5 also owns the `_headers` rule for `/spike-core/*` and the `vite.config.ts` comment correction.

**Next step.** PR 5 (the deploy from the CI: `deploy_spike`, the `sw.js` removal, the `_headers`
rule) or PR 6 (`scripts/phase0/go_no_go.py`, S8 of `docs/PHASE0_NEXT.md`). The manifest endpoint
the page now depends on is `/phase0/disc-chunks`, produced by `scripts/phase0/disc_chunks.py`, and
it still has to be uploaded to R2 (`scripts/phase0/upload_disc.sh`, needs the operator's O2/O3).

## PR 6, S8 — the go/no-go becomes a command (2026-10-01, night)

`docs/PHASE0_DEVICE_PLAN.md` section 5 ended with "Fino ad allora i conti della sezione 6 si fanno a
mano": this is the tool that stops the hand calculation. It reads the `melee-spike-result/1` JSONs,
applies C1–C8 of section 5 and the criterion of section 6 with the clock's `q`, and prints the
verdict. `docs/PHASE0_REPORT.md` is deliberately **not** written tonight: P0-12 belongs with the
operator's own rows, and the task that ordered this tool said so.

**New.** `scripts/phase0/go_no_go.py`, `scripts/tests/test_go_no_go.py` (30 tests; 96 across
`scripts/tests`, all passing on the VPS with Python 3.14.7 — a pure-Python tool, so running it here
is not the build `docs/AGENT_RULES.md` rule 3 forbids).

The rules the tool enforces, and why each one exists:

| Rule | Why it exists |
| --- | --- |
| The trace is re-compared with `compare_checkpoints.py` and the statistics recomputed with `frame_stats.py` | section 5: `trace_csv` and `sim_times_csv` are evidence, everything else in the JSON is a declaration. A JSON whose declared `stats_in_match` disagrees with its own CSV (beyond the page's two-decimal rounding) is refused rather than believed |
| A trace that differs is NO-GO whatever the timings say — and it is not an input error | "unexplained" is not machine-checkable: the difference is a result about the port, not a defect in the evidence. Only the operator can record an explanation, next to this tool's output, never inside it |
| C3 has exactly one exception, and it is the plan's own | section 5, "Il commit del riferimento": a core built from a later commit than the reference trace is accepted — annotating **both** commits — only when the trace is identical cell by cell *and* hashes to `c79c53b9…`. Anything less is discarded (exit 2), so a JSON from another core can never be averaged into a verdict on trust |
| C2 is not an input error | section 5 says C2 "vale solo la regola del NO-GO netto": a coarse clock or a page that was not cross-origin isolated forbids a GO and leaves the net NO-GO rule standing. The run stays evidence, and the case is tested as "no verdict", not as exit 2 |
| `q` is applied in the direction that makes the verdict harder | section 6: GO needs `m + q ≤ 3` and `p + q ≤ 6`; NO-GO needs `m − q > 6` or `p − q > 12`; the middle band needs `m − q > 3`, `m + q ≤ 6` and `p + q ≤ 12` |
| The worst repeat decides, and fewer than three repeats is an input error | the criterion is defined over three repeats (section 6, prerequisites) |
| A class nobody measured is not an error, it is an empty row | the desktop row does not exist yet, and its thresholds are then vacuous rather than failing |
| A verdict other than GO on an `-O1` core is `provisional` | S11 of `docs/PHASE0_NEXT.md` |
| Exit codes 0 GO / 1 NO-GO / 2 input error / 3 desktop only / 4 no verdict, one JSON on stdout then `VERDICT: …` | S8's interface, so the output can go into the report verbatim |

**Measured — the iPhone row, run on the VPS.** This is the first time the row is decided by code
rather than by hand:

```bash
python3 scripts/phase0/go_no_go.py \
  --reference /home/hermes/incoming/phase0/f0d76a2816ec/runs/native-1/trace.csv \
  --reference-commit f0d76a2816eceefb7ec98b5b4a78a55edfa537c0 \
  --phone /home/hermes/incoming/phase0/devices/iphone-safari/*.json
```

Output: `VERDICT: DESKTOP-ONLY`, exit 3, `provisional: false`.

| Field | Value |
| --- | --- |
| worst phone mean (three repeats) | **3.244226 ms** — `m − q` = 3.2242 > 3, so not GO; `m + q` = 3.2642 ≤ 6 |
| worst phone p99 | **5.64 ms** — `p + q` = 5.66 ≤ 12 |
| `q` (largest `timer_resolution_ms`) | 0.02 ms |
| spread between the three means | 7.02% (tolerance 15%) |
| worst warm-up, first vs last 100 in-match frames | 6.59% (tolerance 15%) |
| traces | all three identical to the native reference, 2400 rows each, SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571` |
| in-match rows | 762 each, and the recomputed mean/p95/p99/max equal the declared ones |
| C3 | the JSONs ran the core at `4fba3a08…` while the reference trace is `f0d76a28…`: accepted by the cross-commit rule, with the annotation in `reasons` |

**What that verdict is not.** It is the **iOS row only** (`docs/OPEN_QUESTIONS.md` Q9): a GO would
not have closed the Android row, and this is not a GO — the middle band is exactly the outcome the
device plan describes as "si procede solo su desktop e si rivaluta il mobile in Fase 4". It is not
`provisional` because the served core is `-Oz` and not `-O1` (S11). The row that decides (M2, a
mid-range Android) is still unmeasured, and `docs/NIGHT_HANDOFF.md` still holds: the iPhone is not
8% from the mobile line, the mobile line is unmeasured and may be 3x away.

**Measured in CI.**

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36816027497` (CI, on the PR) | **success** | hygiene job: `Ran 96 tests in 1.340s`, 30 of them in `test_go_no_go.py`; web shell: 289 unit tests across 21 files, typecheck and build clean; 10 shell Chromium tests pass (7.3 s); deploy skipped without credentials |
| `36816008571` (push CI) | **success** | same commit |
| `phase0-build.yml` | not triggered, on purpose | its path filter lists only the scripts the build itself uses, so this PR costs about four runner-minutes instead of a 35-minute WASM build |

**Next step.** PR 5 of the deploy plan (`deploy_spike`), then the report once the operator's rows
exist. The manifest endpoint the page needs (`/phase0/disc-chunks`) still has to be uploaded to R2.

## The device server answers the disc the way the Function does (2026-10-01, night)

Both steps the night handoff ordered were already in `main` when this session started: PR 4 is
complete (steps 1–4 as #26, #28, #29, #30) and so is S8 (`scripts/phase0/go_no_go.py`, #31). The
deploy plan's PR 1–6 are all landed, and what is left in its order of execution is the operator's
(O1–O10, the M1/M2/M5 devices). Verified before touching anything, on `bef2c56`:
`python3 scripts/phase0/go_no_go.py --reference …/native-1/trace.csv --reference-commit
f0d76a2816ec… --phone …/devices/iphone-safari/*.json` prints `VERDICT: DESKTOP-ONLY`, worst repeat
3.2442 ms mean and 5.64 ms p99, `provisional: false` — the PR 6 row, reproduced — and
`python3 -m unittest discover -s scripts/tests` is 96 tests, OK.

What was still unguarded, and sits on the critical path of the operator's next session, is the
server that session talks to: `scripts/phase0/serve_spike.py`, which
`scripts/phase0/device_test_serve.sh` starts behind the tunnel (`docs/PHASE0_DEVICE_PLAN.md`
section 4) and which `docs/PHASE0_DEPLOY_PLAN.md` section 2 calls the route that does not wait for
Cloudflare credentials. It is the local stand-in for the page with its isolation headers and for
the disc with byte ranges — and nothing tested either.

**The defect.** Reproduced on the VPS against the operator's own ISO, on `127.0.0.1`, before the
fix (the server was stopped afterwards):

| Request | Answered | Should be |
| --- | --- | --- |
| `Range: bytes=1459978240-1459978339` (offset == size) | `206`, `Content-Range: bytes 1459978240-1459978239/1459978240`, `Content-Length: 0` | `416`, `Content-Range: bytes */1459978240` |
| `Range: bytes=100-50` (end before start) | `206`, `Content-Range: bytes 100-50/…`, no usable `Content-Length`; curl exits 8 (malformed reply) | `416` |
| `Range: bytes=-0` (a zero-byte suffix) | `206`, the same impossible `Content-Range` | `416` |
| `Range: bytes=-` | `206` with the whole range | `200`, the whole object |

The Pages Function that serves this same disc in production (`functions/phase0/[[path]].ts`,
`resolveRange`, guarded by `tests/functions/phase0-disc.test.ts`) answers exactly that. Two servers
answering the same requests must not disagree about a range that cannot be satisfied: a browser
resuming a 1.4 GB download that asks past the end is entitled to a `416` and not to a `206` it
cannot frame.

**New.** `scripts/tests/test_serve_spike.py` (22 tests: the range table above, a clamped end past
the last byte, an open range, a suffix range, a range header it does not understand, HEAD, the
`401` and the isolation headers on it, `/` and `application/wasm`, a path that tries to leave the
dist directory, a run without a password, and `main()` — the wrong-disc refusal that must happen
*before* it binds, the address it binds, and the line the device procedure quotes back).
**Modified.** `scripts/phase0/serve_spike.py`: the resolution moves into one function,
`resolve_range`, mirroring the Function case by case, and `send_head` answers `416` with
`Content-Length: 0` and no body. No ISO and no game data is involved: the disc in the tests is 4096
bytes in memory and `main()` is tested with `DISC_BYTES` patched.

**Measured.** Against the server as it was, the new file fails 6 tests and errors on 16 (the
`resolve_range` cases do not exist yet); with the fix it is 22 of 22.

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36821195726` (CI, on the PR, `7fcf205`) | **success** | hygiene: `Ran 118 tests in 9.992s` (was 96; +22, the new file), `OK`; 188 tracked files checked for game data; web shell: **289 unit tests across 21 files** (unchanged), typecheck and build clean; **10 shell Chromium tests pass** (8.2 s); deploy skipped without credentials. Jobs: 25 s, 40 s, 61 s, 7 s |
| `36821162687` (push CI, on `7fcf205`) | **success** | same commit |
| `phase0-build.yml` | not triggered, on purpose | its path filter lists only the scripts the build itself uses, so this PR costs about two runner-minutes instead of a 35-minute WASM build |

**Not in this step.** The tunnel script (`scripts/phase0/device_test_serve.sh`) still has no test:
it needs `cloudflared` and a real tunnel, which no runner has. The page, the OPFS worker and the
Function are untouched — the Function is the reference this server was aligned to.

**Next step.** The plan's remaining autonomous work is exhausted; what is left needs the operator:
O1 (may the module and the disc go to Cloudflare at all), O2–O9 (accounts, bucket, keys, Access),
and the device rows — M1 and M2 first (M2 decides), then M5 for OPFS over the real host. The
manifest for `/phase0/disc-chunks` is already computed and verified on the VPS
(`/home/hermes/incoming/phase0/disc-chunks.json`: 1,459,978,240 bytes, 88 chunks of 16 MiB, last
one 360,448 bytes, SHA-1 `d4e70c06…`), and only its upload to R2 (`scripts/phase0/upload_disc.sh`,
O2/O3/O4) is missing. `docs/PHASE0_REPORT.md` stays unwritten until those rows exist.

## The device server serves the disc where the page asks for it (2026-10-01, morning)

`#33` aligned the device server's piece manifest with the Pages Function and recorded it as "the
OPFS download runs without Cloudflare". Half of that was true. The manifest is served at
`/phase0/disc-chunks`, which is the page's `manifestUrl` — but the page asks for the disc itself at
`/phase0/disc` (`discUrl`, `web/src/spike/disc-cache.ts`), and `scripts/phase0/serve_spike.py`
served it only at `/disc.iso`, the path the operator's own Safari download uses
(`docs/PHASE0_DEVICE_PLAN.md` section 4, step 2). Every other request falls through to the dist
directory, so `/phase0/disc` was `<dist>/phase0/disc`: a `404`. On a device run the page would have
read the manifest, reported its cache as unavailable, and failed the download on the first piece
with `DiscFetchError: /phase0/disc answered 404 to bytes=0-16777215` (`disc-cache.ts`, `fetchPiece`,
which requires a `206`) — in the one place the OPFS path can be exercised before Cloudflare
credentials exist, and with the operator watching.

**The fix.** `serve_spike.py` gains the Function's route as a constant and answers the disc on both:
`DISC_ROUTE = '/phase0/disc'` and `ISO_ROUTE = '/disc.iso'` are the same file, and the startup line
names both. Nothing else changes — the range machinery, the `416`s, the manifest route and the
isolation headers are untouched, and `/disc.iso` keeps working for the procedure as written.

**New.** Four tests in `scripts/tests/test_serve_spike.py`: the page's route answers a range (`206`,
`Content-Range: bytes 0-2047/4096`, the right 2048 bytes), both routes serve the same bytes, a file
of the same name in the dist does not shadow the route, and the constants test now pins
`DISC_ROUTE` next to the existing `MANIFEST_ROUTE` assertion.

**Measured, on the VPS** (`python3 -m unittest discover -s scripts/tests`; pure Python, so allowed
here). On `4a3f537`, the commit `#33` left: **132 tests, OK**. With the new tests and **without** the
fix: **3 failures and 1 error** — `test_the_disc_is_served_at_the_route_the_page_asks_for`,
`test_both_disc_routes_serve_the_same_file`,
`test_the_disc_route_wins_over_a_file_of_the_same_name_in_the_dist`, and the constants test erroring
on the missing `DISC_ROUTE`. With the fix: **135 tests, OK**. The disc in those tests is 4096 bytes
in memory and the server is real HTTP on an ephemeral port; no ISO is involved
(`docs/AGENT_RULES.md` rule 1), and no server was left running.

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| pending | | the CI table is added before the merge, as for the previous steps |

**Not in this step.** The tunnel script (`scripts/phase0/device_test_serve.sh`) still has no test: it
needs `cloudflared` and a real tunnel, which no runner has. Its output still prints only the
`/disc.iso` address, which is the one the operator needs.

**Next step.** Unchanged: the device rows. M1 and M2 first (M2 decides), then the OPFS run over the
real host, which this fix is what makes possible over the device server. O1–O9 stay the operator's.
