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
| `36838901377` (CI, on the PR, `4a9a804`) | **success** | hygiene: `Ran 135 tests in 15.208s`, `OK` (was 132 on `4a3f537`); 188 tracked files checked for game data; web shell: **289 unit tests across 21 files** (unchanged), typecheck and build clean, first-load shell 41.3 KB across 4 files (budget 1024 KB); **10 shell Chromium tests pass** (6.9 s); deploy skipped without credentials |
| `36838962972` (push CI, on `4a9a804`) | **success** | same commit, all four jobs green |
| `phase0-build.yml` | not triggered, on purpose | its path filter lists only the scripts the build itself uses, so this PR costs about two runner-minutes instead of a 35-minute WASM build |

**Not in this step.** The tunnel script (`scripts/phase0/device_test_serve.sh`) still has no test: it
needs `cloudflared` and a real tunnel, which no runner has. Its output still prints only the
`/disc.iso` address, which is the one the operator needs.

**Next step.** Unchanged: the device rows. M1 and M2 first (M2 decides), then the OPFS run over the
real host, which this fix is what makes possible over the device server. O1–O9 stay the operator's.

## The device tunnel command gets the tests it never had — 2026-10-01, morning

Two entries in this file ended with the same gap: `scripts/phase0/device_test_serve.sh` has no test,
because it needs `cloudflared` and a real tunnel and no runner has either. The script is the fallback
route for a device session -- one command that starts `serve_spike.py`, opens a quick tunnel, checks
that the page arrives with its isolation header, and prints the address, the user and the password --
and it hands out that password for an address which is **public** while it runs.

**The suite.** `scripts/tests/test_device_test_serve.sh`, six cases, no tunnel and no disc: `cloudflared`
is a stub on PATH that prints an address of the shape the script greps for and then stays alive; the
disc is a sparse zero file of the 1,459,978,240 bytes the server insists on, outside the repository
(the fixture trick `scripts/tests/test_deploy_guard.sh` already uses); and `curl` is a stub that answers
the stub tunnel address from a canned response and delegates everything else to the real curl, because
no certificate for a stub hostname can exist. Everything else is real: the server is the real
`serve_spike.py` on an ephemeral port, so the readiness loop, the manifest handover, the basic-auth
user, the printed block and the cleanup after Ctrl-C are exercised for real.

The cases: the usage text; five refusals (unknown argument, missing dist, missing disc image, a dist
that is the shell and not the spike build, no cloudflared anywhere); a full run with the real manifest
written by `disc_chunks.py`, asserting the block, the ten-character password, that the local server
answers the manifest route and the page with that password, and that the server and the tunnel are gone
after Ctrl-C; a run with a password given on the command line and no manifest, asserting the warning
and that the block does not name a manifest; a manifest route answering 500, asserting the warning; and
a dist that never answers the readiness probe, asserting that the run stops naming it.

**The two defects it found.**

1. **A two-character password on a public address.** The generator filtered a single 64-byte read of
   `/dev/urandom`: measured on the VPS over 200 draws, 110 were shorter than ten characters, the mean
   was 8.28 and the shortest was **two**. The address is public for as long as the script runs, so a
   two-character basic-auth password is brute-forced in seconds. Now the read is 4096 bytes (518 to 595
   usable characters, measured over five draws), the truncation is done by the shell rather than by a
   second `head` in the pipeline -- so no stage can be killed by SIGPIPE under `pipefail`, the failure
   mode that killed a CI step in this repository once already -- and the result is checked to be exactly
   ten characters, with a refusal rather than a short password.
2. **The manifest line ran into the user line.** `manifest_line` was interpolated into the heredoc line
   that prints the user field, so a run with a manifest printed `manifest <url>  user  fabri` on one
   line. The manifest line is now printed on a line of its own, and only when the route answered.

**Measured, on the VPS** (pure bash, python and HTTP on loopback: no build, no ISO, no game data):

| Command | Result |
| --- | --- |
| `bash scripts/tests/test_device_test_serve.sh` on the script before the two fixes | **1 assertion failed** ("the user line is not on a line of its own"); the password assertion passed on that draw and fails on about 55% of draws |
| the same suite after the two fixes | **6 cases, all assertions pass**, run twice |
| `python3 -m unittest discover -s scripts/tests` | `Ran 135 tests`, `OK` (unchanged) |
| `bash scripts/tests/test_deploy_guard.sh` | all deploy and upload guards hold |
| `bash scripts/tests/test_phase0_runner.sh` | 44 checkpoint runner guards hold |

**In CI.** `.github/workflows/ci.yml` gains a `Device tunnel guards` step next to the other two shell
suites, so the new file runs on every push.
## The spike is published, the OPFS path costs nothing, and the optimisation campaign finds its ceiling (2026-10-01, afternoon)

This session did four things in one order: put the page on a stable host, measure the disc cache on a
device that is not the operator's, profile the simulation instead of guessing where its time goes, and
then spend the CI budget on the levers that profile pointed at. The last of those produced a negative
result that is as useful as the positive ones.

### The spike is live on Pages, behind Access

`deploy_spike` had failed twice. The first cause was a dirty tree and is fixed by PR #37 (deploy from
a clean copy of the commit). The second was the real one and only surfaced once the first was gone:
the Pages project declares **two** R2 buckets in `wrangler.toml`, and while `melee-phase0-disc` existed,
**`melee-web-assets`** — the product's asset store, named in `docs/DEPLOY.md` and required by
`functions/` — had never been created. Wrangler refused to publish the Function: *"R2 bucket
'melee-web-assets' not found"*. The bucket was created empty (free: R2 charges for stored bytes, not
for buckets) and run `36868675226` published successfully.

| Check | Result |
| --- | --- |
| `https://phase0-spike.melee-web.pages.dev/spike.html` | **302** → `cloudflareaccess.com/cdn-cgi/access/login/phase0-spike…` |
| `/` | 302, the same |
| access | only the operator's email; the disc is served by the Function from `melee-phase0-disc` |

This is M5's host, and it is also the answer to the operator's own question about cleaning up: the
tunnel's address dies with the tunnel, so a cached disc downloaded from it can only be removed from the
browser's own storage settings. A Pages address is stable, so the page's **"Delete the cached disc"**
button keeps working days later, with the tab closed.

### The OPFS disc costs nothing on a device, and the 2016-tablet reading was wrong

The operator ran the same page twice on the iPhone 16 Pro with the disc **downloaded into OPFS** rather
than picked from the file system — the first time that path has been exercised on a device that is not
this VPS. Evidence: `/home/hermes/incoming/phase0/devices/iphone-safari-opfs-2026-10-01/`.

| Run | in-match mean | p95 | p99 | max | disc_source | trace |
| --- | --- | --- | --- | --- | --- | --- |
| 13:10:15 | 3.359 ms | 3.90 | 4.30 | 9.04 | `opfs` | `c79c53b9…` |
| 13:11:02 | 3.367 ms | 3.90 | 4.74 | 7.98 | `opfs` | `c79c53b9…` |

Against the three file-picker runs of the same device (3.0315 / 3.2442 / 3.0809 ms), the cached path is
within noise. `cross_origin_isolated: true`, `timer_resolution_ms` 0.02 ms, `exit_code` 0,
`mode=2 state=2 match_frame=762`. **The disc source is not a variable in the timings**, which removes
one of the three candidate explanations for the slow Firefox and Chrome rows below. Note for the
device procedure: `storage_persisted` is **false** on iOS — Safari does not promise to keep the cached
disc, so the delete button is the only guaranteed way to free the space.

**Correction to the earlier reading of those rows.** The Firefox and Chrome runs from the friend's
device reported `Mozilla/5.0 (X11; Linux x86_64 …)`, which was read here as a desktop Linux machine and
recorded as such. That is wrong: it is the user agent Chrome and Firefox send **on Android with
"Request desktop site" enabled**. The runs were on the device, executing natively. The operator reports
a **2025 OnePlus tablet with OxygenOS**, 120 Hz. So the numbers stand (12.1 / 13.9 / 13.9 ms in-match on
Firefox, 16.06 ms on Chrome, trace identical in all four) and the verdict `NO-GO` stands for that
browser configuration, but the row is **not** an M2 row: a desktop-mode user agent is not the mobile
configuration the plan specifies. The test that resolves it is the same page with desktop mode off,
plus the exact model — a cheap 2025 tablet (Helio G99 class) and a flagship tablet (Snapdragon 8 class)
differ by a factor of three here, and "smooth at 120 Hz" describes the interface, not single-core
compute.

### Where the frame time goes, measured instead of assumed

A V8 CPU profile of a 600-frame run (`node --cpu-prof`, parsed by sample and `timeDeltas`) answers the
question the night consultation said to answer first:

| Finding | Value |
| --- | --- |
| CPU busy | **99.4%** (0.6% idle) — the frame is compute, not disc I/O |
| one wasm function | **53%** of sampled time (indices shift between builds, so it cannot be named from the shipped module: it carries no name section) |

That is what aimed the next two experiments, and both were screened locally with
`scripts/phase0/run_checkpoints.sh` (2400 checkpoints, ~75 s, no CI minutes) before anything was
proposed.

### Three levers, measured: two merge, one is closed by size

| Module | size | Pages limit | in-match mean (2 runs) | vs baseline | trace |
| --- | --- | --- | --- | --- | --- |
| baseline `-Oz` (`d04610d`) | 16,323,657 B | 62% | 27.667 / 27.332 ms | — | `c79c53b9…` |
| `wasm-opt -O2` post-link | 15,162,083 B | 58% | 26.014 / 26.470 ms | **−4.6%** | identical |
| `-O2` on `ppc_runtime.cpp` + `interp.cpp` | 15,178,688 B | 58% | 25.367 / 23.655 ms | **−10.9%** | identical |
| both (main `8f44970`) | 15,173,540 B | 58% | 23.794 / 25.475 ms | **−10.4%** | identical |
| `-O2` on all generated guest code | **70,133,325 B** | **268% — out** | 24.035 / 23.793 ms | −2.9% (noise) | identical |

- **`wasm-opt` post-link (PR #43, merged).** −7.1% size and −4.6% time, and the CI step checks that the
  post-processed module still compiles. `--all-features` produces a module the engine rejects
  (`unknown import kind 0x7f`), so the CI uses an explicit feature set.
- **`-O2` on the two PowerPC units (PR #41, merged).** −7.0% size, −10.9% time, with
  `scripts/phase0/assert_hot_opt.sh` reading the real compile commands so that a `-Oz` arriving after
  the source property cannot make the experiment measure nothing. The size went **down**: `-O2` beats
  `-Oz` on these two units.
- **The two do not stack.** Together they are −10.4%, not −15%: they overlap on the same code. Recorded
  because a PR body that claimed the sum would be wrong.
- **The generated guest code at `-O2` (PR #44, closed).** +362% size for a ~3% difference inside the
  ±7% spread between repeats. Both the Pages per-file limit and the speed test close it, and the useful
  part is what it proves by elimination: **the 53% function is not in the generated guest code**, or
  compiling that code at `-O2` would have moved the needle. It is in the port's own runtime — which is
  exactly why `-O2` on `ppc_runtime.cpp` and `interp.cpp` was worth 11% while this is worth nothing.
  Further gain has to come from changing that code, not from asking the compiler again.

### The CI budget was being spent twice per push

The repository is private, so Actions minutes come out of the free plan's 2,000-minute monthly
allowance. Measured for this one day: **91 workflow runs, roughly 660 minutes** — a third of the month,
with 24 WASM core builds at 18–35 minutes each. Two concrete wastes, both fixed in PR #45:

- `ci.yml` triggered on a push to **every** branch *and* on pull requests, so a commit on a branch with
  an open pull request ran the whole suite twice — the two-runs-per-push the numbers show. Branches are
  verified by their pull request; `main` is verified after the merge, and that is now the only push
  that triggers it.
- The practice is written into `docs/AGENT_RULES.md` ("CI budget") with these numbers: batch experiments
  into one build, screen locally first, never leave two runs of one branch alive, keep the heavy build
  on the paths that need it.

When the allowance runs out the jobs stop until the next month and **nothing is charged** (the spending
limit is zero), so the cost of waste is stalled work, not money.

### Not in this session

The renderer, untouched: `web/src/` still has no drawing code at all, and `docs/RENDERER_MAP.md` holds
the order (GX command interception, a `Backend` interface, the WebGPU implementation priorities).
Audio output plumbing. SIMD and threading in the simulation. The M2 row is still unmeasured, and the
operator's own Pages-hosted run of the optimised module (which needs a native reference built at the
same commit for `go_no_go.py`'s cross-commit rule) has not been done.

### Next step

**The renderer's first priority** — the backend seam, the canvas, and the first frame of the game
drawn from the simulation's command stream — because the speed question is answered well enough to
build on (3.36 ms per frame on the iPhone against a 16.67 ms budget at 60 Hz, ~5x headroom) and further
compiler-level speed work is closed by size. The remaining speed ideas that are not closed (the
interpreter's dispatch path, SIMD) are worth single-digit percentages each and belong after a visible
frame exists. M2 stays open until an Android device in the mobile configuration is available.

## Renderer step 1 — a WebGPU backend that presents the frame's clear (2026-10-01, evening)

Branch `render/webgpu-step1`. **Written, not run**: the account's Actions minutes are exhausted, so
no workflow has picked up a job, and nothing here has been compiled — the VPS builds nothing.

**What was found.** The web build had no backend and never built a frame: `gx_core.cpp` is not in
the shipped modules (`native/core_sources.cmake`), `native/headless_fifo.cpp` decodes the FIFO in
its place and drops all render state, and `gx::init` is never called. And no CI runner can produce
a game frame at all: without the disc every spike run stops at the DOL, before the first GX command.

**What was written.**

- `native/headless_fifo.cpp`, `native/headless.h`: `host::gx_set_backend`. With a backend attached,
  each EFB copy is recorded as `gx_core.cpp` records it and the `gx::Frame` is handed over at the
  XFB copy. Null by default; the native reference and the Node module never set it.
- `wasm/render/gx_webgpu.cpp` (web module only): `gx::Backend` with a persistent EFB texture;
  replays each copy in order — EFB to canvas, then clear. Draws ignored. Detaches itself on any
  JavaScript failure. `gx_webgpu_selftest` feeds the real decoder a frame's closing BP writes.
- `web/src/spike/gpu.ts`, `worker.ts`, `main.ts`, `spike.html`: `?canvas` hands a run an
  `OffscreenCanvas`; the device is acquired before `callMain`; without a canvas nothing changes.
- Tests: `native/tests/fifo_test.cpp` (the seam: frames, order, colour, detach) and
  `web/tests/spike/render.spec.ts` (two copies show the clear colour, one copy shows the
  zero-initialised EFB, no canvas renders nothing; pixels read back with `copyTextureToBuffer`).

**Next step.** When CI has minutes: run the probe (PR #47) first, then this branch's
`Phase 0 — WASM core` and `Phase 0 — Linux headless reference` runs. Then the operator's call on
`docs/OPEN_QUESTIONS.md` Q10 before step 2.

**Update, first CI run (run `36892349174`, commit `54800cd`).** The C++ compiles and links in both
builds; `native_fifo_test`, seam included, passed under g++ (run `36892349475`); the CI Chromium
gave the render test a device. Two render tests failed on the readback: `device lost: Device was
destroyed.` then `mapAsync` aborted with `A valid external Instance reference no longer exists.`
Diagnosis: nothing reachable from the worker's global scope held the adapter, device or readback
buffer once the synchronous stretch ended, so they could be collected while the map was pending.
Fix: `web/src/spike/gpu.ts` roots every opened GPU object and every in-flight readback buffer for
the worker's lifetime. The second test's `[0,0,0,0]` was right; its null pixel was the same failure.

**Update, runs `36896537472` and `36898914442`.** Rooting the GPU objects (`cdba78b`) changed
nothing: collection was not the cause. The diagnostic run's timeline settled where the device dies.
Buffer round trips pass across several task boundaries while the canvas is configured but
untouched. About 0.7 ms after the first task that calls `getCurrentTexture` yields (the moment its
canvas frame is committed), the device is lost (`destroyed`) and every pending map aborts. One
realm, one device, the backend used it, two copies recorded. Ruled out: a runtime exit (the
self-test calls no `callMain`; `-sEXIT_RUNTIME=1` is linked only into the Node module and
`sha1_test`) and `emdawnwebgpu` (not linked; 0 mentions in the run's log). What it is inside
Chromium is not established. Change: the backend's XFB target is pluggable. CI reads the backend's
output back from an offscreen texture (`?gx-selftest…&target=texture`), and the canvas path is
asserted in CI without a pixel. The canvas pixel test runs with `SPIKE_CANVAS_READBACK=1`, and a
`?canvas` run reports it as `render.readback`, for a real device to settle.

## The WebGPU toolchain probe answers — and one of its answers was the harness (2026-10-01, night)

Branch `render/webgpu-probe`, PR #47. This is the first step the renderer's plan named: the previous
section ends "run the probe (PR #47) first", because `docs/RENDERER_MAP.md` puts a WebGPU backend at
the top of the renderer and the plan rested on two assumptions that were cheap to check once and
expensive to assume for a whole backend. Both are now measured, in run `36920684654` (the `WebGPU
toolchain probe` job, headless Chromium 153.0.8010.12 on a standard runner, adapter `google
swiftshader`, two minutes; both launch configurations answer).

| Question | Answer | Evidence, run `36920684654` |
| --- | --- | --- |
| Does the pinned Emscripten (4.0.23) build and link a unit that includes `<webgpu/webgpu.h>` and calls into it, with `--use-port=emdawnwebgpu`? | **Yes** | the compile step; the page then loads the module and collects `cxx: instance created` / `cxx: instance released, toolchain ok` |
| Does the browser this repository's CI can run give the renderer a device it can render with? | **Yes, on the backend path** — `google swiftshader`, a device, `buffer round trip: "ok"` at 9.0 ms, and a texture cleared to red read back as `[255,0,0,255]` at 16.6 ms | `adapter`, `round_trip`, `readback`, `uncaptured errors: []` |
| Can a canvas pixel be read back in CI? | **No** — the device does not survive the canvas frame's commit | `canvas: "configured and cleared"` at 17.0 ms, `device lost: destroyed` at 28.6 ms, and `canvas_commit` recording the loss; `web/tests/spike/render.spec.ts` "THE GAP" records the same failure and already routes around it with an offscreen texture target |

**The realm is not what kills the device.** The earlier diagnosis in this file was that the page's
main thread was the cause, and that a worker — where the renderer and this repository's own CI
readback live — would keep the device alive. The worker readback does work; the canvas commit still
ends the device, in either realm. That is the boundary `render.spec.ts` already documents, now
measured in the realm the renderer runs in as well, and it is why the canvas pixel stays a real-device
measurement.

**The zero that was not an answer.** Run `36912403273`'s first worker version read `[0,0,0,0]` from a
texture it had just cleared to red, and the cause was this probe's own copy, not the GPU: the whole
4x4 texture with `bytesPerRow: 256` into a 256-byte buffer is a copy WebGPU rejects — four rows need
`256 * 3 + 16 = 784` bytes — and it rejects it with a validation error, which neither throws nor stops
the run. The buffer stayed zero-initialised, so the harness read a plausible `[0,0,0,0]` off it and
the job reported a GPU failure that had not happened. Three changes in
`wasm/probe/webgpu_probe_worker.js`, all of them about not confusing a silent rejection with a
measurement: the copy is now the one `web/src/spike/gpu.ts`'s `readPixel` makes and CI returns the
colour from (one pixel, `bytesPerRow: 256`, a 256-byte buffer); an `uncapturederror` listener reports
a rejected command instead of letting it read as an answer; and a buffer round trip that touches
neither texture nor canvas runs first, so "the device is dead" and "the copy is wrong" cannot be
confused again. `wasm/probe/check.mjs` requires those three and the canvas configure, and records the
canvas commit without requiring it.

**What this does not answer.** Q10(b) in `docs/OPEN_QUESTIONS.md`: whether the port can *adopt* a
device acquired in JavaScript, so the backend owns the instance instead of reaching the device
through `EM_JS`. The probe proves the port builds, links and creates an instance of its own; the
import is a different question and is not attempted here.

**Next step.** Unchanged, and now unblocked on this side: the operator's call on Q10 (a) before
renderer step 2, and (b) with this probe's answer in hand.

## The deploy plan's Cloudflare numbers are read, not assumed (2026-10-01, night)

`docs/PHASE0_DEPLOY_PLAN.md` §1's limits table ended seven rows in "**da verificare**", each naming
the page that would settle it, and §7 said they stayed hypotheses until the first deploy. None of
the seven needed an account, a credential or a device — they were documentation questions — so they
were read on 2026-10-01 and the plan now carries the answer and the quote.

| Row | Value | Source |
| --- | --- | --- |
| Pages: maximum size per file | 25 MiB | `pages/platform/limits/` |
| Pages: files per site | 20.000 (Free) | same page |
| Pages Functions: requests per day | 100.000/day, 10 ms CPU (Workers Free) | `workers/platform/limits/`, plus the Pages line that binds Functions to the Workers quota |
| `wrangler r2 object put` | 315 MB per object, one object at a time | `r2/objects/upload-objects/` |
| R2: object size, single upload | 5 TiB per object; 5 GiB single PUT; 4,995 TiB multipart in up to 10.000 parts | `r2/platform/limits/` |
| R2 free tier | 10 GB-month, 1M Class A, 10M Class B, egress free | `r2/pricing/` |
| Access free | 50 users | `cloudflare.com/zero-trust/products/access` |

**What the numbers change.** The disc is 1,36 GiB, which is inside the documented single-PUT limit
(5 GiB) but outside the range R2's own guide recommends for a single PUT (under ~100 MB), so the
documented path for a file that size is multipart — what `rclone` already does. It fits the R2 free
tier (10 GB-month), so keeping it in the bucket costs nothing while the measurement is open, and 88
Class B reads per full download sit far inside the 10 million per month. The two local sizes were
measured, not estimated: the spike `dist` is 21 files / 18.005.796 bytes (13 files / 268.162 bytes
without `spike-core` and the source maps), and the web module at `-Oz` is 16.323.255 bytes, read
from run `36743835141`'s `wasm_report.py` output — the log line §0.3 asked for. Nothing was
deployed, no account was touched, no game data moved, and no source file changed.

**Next step.** Unchanged, with one fewer unknown: the device rows (M1, M2, M5) and O1-O10 are the
operator's, and the renderer's step 2 waits on Q10(a). No autonomous step of the plan is left open.

## Q10(b) is answered by measurement: C++ adopts the device the page acquired (2026-10-02, night)

`render/webgpu-device-import`, PR #52, merged `b617b23`. The branch was written by the 2026-10-01 night
session and pushed with all seven checks green; it was left open, and the answer it produces was the
last thing `docs/OPEN_QUESTIONS.md` Q10 called "unknown — needs investigation". This session landed it
and recorded the answer in that file.

**The measurement, in run `36932059429`** — job `WebGPU toolchain probe`, headless Chromium
153.0.8010.12, adapter `google swiftshader`, 1m26s, commit `9ab7f53`. The page acquires a device
before instantiating the module; the pinned Emscripten 4.0.23 port declares the import —
`webgpu/include/webgpu/webgpu.h:2265` exports `emscripten_webgpu_get_device`, which reads
`Module['preinitializedWebGPUDevice']` — and C++ adopts the device: it asks it for its queue, reads its
limits (`maxTextureDimension2D 8192`), creates a 1x1 RGBA8 texture with it and writes a red pixel
through the adopted queue. Both launch configurations answer
`adopt: {"device":true,"queue":true,"limits":true,"wrote":true}` with `adopt_device_lost: null` and
`adopt_errors: []`; `wasm/probe/check.mjs` requires all four of those, so a rejected command — which
raises a validation error and neither throws nor stops the run — cannot read as an answer. The renderer
can therefore own the instance, adapter and device instead of reaching them through `EM_JS`: the choice
Q10(b) leaves to the operator is now an informed one, and `EM_JS` stays the zero-change option.

**The one gap, named rather than papered over.** The probe instantiates its module on the page, while
the renderer instantiates its own in the worker, `web/src/spike/worker.ts`. The import is a module
argument read before instantiation and does not depend on the realm, but that is reasoning: adoption
inside the realm of the worker is not measured. Unchanged as well, the canvas pixel still needs a real
device, because CI loses the device when the canvas frame is committed (PR #47).

**Also in this PR.** `phase0-build.yml` no longer lists `wasm/probe/**` in `pull_request.paths`: no
target that workflow compiles reads it, it configures `wasm/core` and reads `wasm/compat` and
`wasm/render`, so a probe edit no longer buys a 35-minute WASM core build — the same rule the
`scripts/phase0` list already follows. The probe has its own workflow, and it costs 1m26s.

**Next step.** Unchanged, one unknown shorter: the decision of the operator on Q10(a), where the frames
of the web build come from, before renderer step 2. Nothing else in the plan is autonomous and open.

## The adoption is measured in the worker, where the renderer's module lives (2026-10-02, night)

`probe/worker-realm-adoption`, PR #55. The 2026-10-02 night session answered
Q10(b) on the page and wrote down what its own answer did not cover: the probe instantiated its module on
the main thread, while the renderer instantiates its own in a worker (`web/src/spike/worker.ts`), and "the
import is a module argument read before instantiation, so it does not depend on the realm" was reasoning,
not a measurement. That is the last unknown standing between the operator and an informed choice between
`EM_JS` and `<webgpu/webgpu.h>`, and it costs one probe run to remove.

**What changed, in the probe only.** `wasm/probe/webgpu_probe_worker.js` asks the same question of its own
realm, after the texture readback and **before** the canvas step: the device the worker acquired for the
canvas is handed over in the module's arguments, C++ adopts it through `emscripten_webgpu_get_device()`,
and the four lines it prints become `adopt_worker`. It runs before the canvas step on purpose — the canvas
frame's commit is where CI's Chromium loses the device, and an adoption measured on a dead device answers
nothing. `wasm/probe/check.mjs` requires the four fields individually, for the same reason it requires
`adopt`: a rejected command raises a validation error, and a validation error is not an answer.
`wasm/probe/webgpu_probe.html` carries the two new fields. No C++, no workflow, no build flag.

**The measurement, in run `36955231521`** — job `WebGPU toolchain probe`, headless Chromium 153.0.8010.12,
adapter `google swiftshader`, 1m19s, commit `34bcb9f`. Both launch configurations answer
`adopt_worker: {"device":true,"queue":true,"limits":true,"wrote":true}`, in the realm
`DedicatedWorkerGlobalScope`, with `adopt_worker_lines` holding `cxx: instance created` /
`cxx: instance released, toolchain ok` / `adopt: device adopted` / `adopt: queue ok` /
`adopt: limits read, maxTextureDimension2D 8192` / `adopt: wrote 4 bytes into a texture the adopted
device created`.

| Configuration | adopt in the worker | adopted at | canvas commit at | device lost at |
| --- | --- | --- | --- | --- |
| Playwright default (`chromium-headless-shell`) | all four true | 42.5 ms | 43.0 ms | 44.9 ms |
| `channel: 'chromium'` (new headless, full build) | all four true | 47.3 ms | 47.6 ms | 70.3 ms |

**Two answers, not one.** The first is the one asked for: C++ adopts the device JavaScript acquired, in
the realm the renderer's module is instantiated in, so Q10(b) now holds where it has to hold. The second
came free and is worth recording: the probe unit is compiled with `-sENVIRONMENT=web`, and it loads and
runs in a worker with no change to that setting — the renderer does not need `worker` added to it. What is
still not measured is unchanged: CI's Chromium loses the device when the canvas frame is committed, in both
realms (PR #47), so the canvas pixel stays a real-device measurement, and no CI runner produces a game
frame without the disc.

**Measured in CI.**

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36955231521` (WebGPU toolchain probe, on `34bcb9f`) | **success** | job 1m19s; both configurations `PROBE OK`, `adopt_worker` all four true, `adopt_errors: []`, `adopt_device_lost: null` |
| `36955231507` (WASM toolchain probe, on `34bcb9f`) | **success** | the FMA corpus and the bench are untouched by this change |
| `36955231532` (CI, on `34bcb9f`) | **success** | hygiene, web shell and the browser tests are untouched by this change |
| `36955443541`, `36955443531`, `36955443529` (the same three, on `3833c0a`, the docs commit) | **success** | the probe answers `adopt_worker` all four true again, in both configurations; a probe this repository has seen fail four times for harness reasons is worth running twice before its answer is recorded |

**Next step.** Unchanged, one unknown shorter: the decision of the operator on Q10(a), where the frames of
the web build come from, before renderer step 2. Nothing else in the plan is autonomous and open.

## The device tunnel guards land, and the live defects they found on `main` are gone (2026-10-02, night)

`phase0/device-tunnel-guards`, PR #36, merged `348f4717`. The branch was written and pushed on
2026-10-01 morning and left open; this session landed it. Two entries in this file ended with the same
gap — `scripts/phase0/device_test_serve.sh` has no test, because it needs `cloudflared` and a real
tunnel and no runner has either — and `scripts/tests/test_device_test_serve.sh` closes it: six cases,
with a stub `cloudflared` on `PATH`, a stub `curl` that answers the stub address, and a sparse zero file
of the 1,459,978,240 bytes the server insists on, outside the checkout. The real `serve_spike.py` runs
on an ephemeral port, so the readiness loop, the manifest handover, the basic-auth user and the cleanup
after Ctrl-C are exercised for real. No tunnel, no ISO, no game data.

**The two defects were still live on `main` when this session started** — the branch's fixes had never
been merged:

| Defect | On `main` before | After |
| --- | --- | --- |
| a password drawn from one 64-byte read, guarding an address that is public while the script runs | measured over 200 draws on the VPS: 110 shorter than ten characters, mean 8.28, shortest **two** | a 4096-byte read (518 to 595 usable characters), truncated by the shell, refused unless exactly ten |
| the manifest line interpolated into the user line | a run with a manifest printed `manifest <url>  user  fabri` on one line | the manifest line is printed on a line of its own, and only when the route answered |

**Measured locally before the push** (pure bash, python and HTTP on loopback: no build, no ISO, no game
data): `bash scripts/tests/test_device_test_serve.sh` — six cases, all assertions pass; `python3 -m
unittest discover -s scripts/tests` — `Ran 135 tests`, `OK`; `bash scripts/tests/test_deploy_guard.sh` —
all guards hold; `bash scripts/tests/test_phase0_runner.sh` — 44 guards hold.

**Measured in CI.**

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36960450525` (CI, on `d2300eb`, the merge of `main` into the branch) | **success** | all four jobs green; the new `Device tunnel guards` step is green in `Repo hygiene and workflow lint` |
| `phase0-build.yml` | not triggered, on purpose | its path filter lists only the scripts the WASM build itself uses, so this cost about two runner-minutes instead of a 35-minute core build |

**How it was landed.** The branch was rebased onto `main` locally and then updated by a merge of `main`
instead: a rebase rewrites the remote branch, and a history-rewriting push is refused in this session's
sandbox. The tree after the merge is byte-identical to the tree after the rebase (`git diff --stat
1e6a2bc` empty), and the diff against `main` is exactly the four files the pull request describes. The
two CI failures recorded on the branch's older commits (`36847849760`, `36847803330`) were the
`Cloudflare Pages` job on a base that predates the explicit `CF_DEPLOY_SHELL` switch of PR #35:
unrelated to this change, and they do not recur on the merge.

**Still open, and now named rather than implied.** The claim this file has repeated — "nothing else in
the plan is autonomous and open" — holds for `docs/PHASE0_DEPLOY_PLAN.md` §6, whose remaining steps are
the operator's: M1, M2 and M5 on a device, O1's legal call, O2–O9's credentials, and Q10(a)'s decision
before renderer step 2. It does **not** hold for the repository's open pull requests, which this session
checked one by one:

- **PR #42 (`fix/build-output-dir`) is a live defect on `main`**, not a stale branch: `web/vite.config.ts`
  sets `outDir: '../dist'`, so `npx vite build` writes the shell to `<repo>/dist`, while
  `scripts/deploy.sh` (default `--dist-dir web/dist`), `scripts/build_web.sh` and `wrangler.toml`
  (`pages_build_output_dir = "web/dist"`) all read `web/dist`. The shell deploy of step 11 would refuse
  with `web/dist/_headers is missing`, exactly as run `36843140022` did, and the documented local build
  command fails the same way. It is not landed here because landing it costs a 35-minute WASM core
  build: `web/vite.config.ts` is in `phase0-build.yml`'s `pull_request.paths`, although no target that
  workflow compiles reads it — the same argument that removed `wasm/probe/**` from that list in PR #55.
- **PR #38, #39 and #40 are superseded**: #38's two Cloudflare claims were landed by #53, and #39/#40 are
  two copies of one frame-time consultation whose substance is in this file's "Where the frame time
  goes" and "Three levers, measured" entries. They are left open for the operator to close rather than
  closed by a worker session.

**Next step.** Unchanged, and now the only thing left that is not a leftover: the decision of the
operator on `docs/OPEN_QUESTIONS.md` Q10(a) before renderer step 2, then the device rows M1 and M2 (M2
decides), which no autonomous session can produce.

## The built shell lands where the deploy looks for it (2026-10-02, morning)

`fix/build-output-dir` (PR #42) was written on 2026-10-01 midday and left open. The 2026-10-02 night
session found the defect it fixes still live on `main`, and did not land it, naming the reason:
landing it "costs a 35-minute WASM core build", because `web/vite.config.ts` is in
`phase0-build.yml` paths for `pull_request`. This session landed it. The first half of that reason
is a measurement, and it does not hold.

**The cost, measured.** The workflow run for this branch on 2026-10-01, `36861922615` at `ff31ca3`,
took **10m42s** end to end (job `build` 10m38s, the shipped default `-Oz`). The run of this session,
`36965278604` at `65d1191`, took **5m34s** (job `build` 5m30s, 04:36:22 to 04:41:52). The
35-minute figure that `docs/AGENT_RULES.md` quotes describes the `-O2`-on-all-guest-code experiment
(`perf/guest-o2`, `36864866829`, **52m32s**), not a default build. So the price of landing this was
between five and eleven runner-minutes, and the deferral was not buying what it thought it was.

**The defect, still live on `main` before this.** `web/vite.config.ts` set `outDir: '../dist'`.
`outDir` is resolved relative to `root`, and `root` is `'.'`, that is `web/`, so `npx vite build`
wrote the shell to `<repo>/dist`, one level above the shell. Every consumer of that artifact looks
in `web/dist`: `scripts/deploy.sh` (its default `--dist-dir`, and it refuses to upload without
`_headers`), `scripts/build_web.sh` (which checks `_headers` right after the build, so the
documented local build failed the same way), and `wrangler.toml` (`pages_build_output_dir`). Two
consumers had instead been adapted to the wrong location: the CI size report read `../dist`, and
`web/playwright.config.ts` served `../dist`. The shell deploy therefore could not have succeeded,
which is exactly what the first real attempt refused on: `web/dist/_headers is missing`, run
`36843140022`.

**Changed.** `outDir: 'dist'` in `web/vite.config.ts`, whose comment now names the three things
that read that directory, and folds in the minor correction `docs/PHASE0_DEPLOY_PLAN.md` section 0
asks for (the comment claimed `_headers` was "at the repo root"; it is `web/public/_headers`);
`web/playwright.config.ts` serves `dist`; the CI web job size report reads `dist`. **New guard**:
the same job asserts immediately after the build that `dist/_headers` and `dist/index.html` exist,
that `dist/_headers` is byte-identical to `public/_headers`, and that `../dist` was not written.
That is the criterion `docs/PLAN_BREAKDOWN.md` line 184 states and no job checked.

**How it was landed.** The branch was updated onto `main` by merging `main` into it, not by
rebasing: a rebase rewrites the remote branch, and a history-rewriting push is refused in this
session. The tree after the merge differs from `main` in exactly the three files above
(`git diff origin/main --stat`).

**Measured locally before the push** (pure Python and bash: no build, `docs/AGENT_RULES.md` rules 2
and 3): `python3 -m unittest discover -s scripts/tests` — **135 tests, OK**, the same count as on
`main`; `bash scripts/tests/test_deploy_guard.sh` — all guards hold; `bash
scripts/tests/test_phase0_runner.sh` — 44 guards hold; `bash scripts/tests/test_device_test_serve.sh`
— 6 cases pass. The layout assertion needs Node, so the CI web job is what decides it.

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36965278620` (CI, on `65d1191`) | **success** | 1m35s; hygiene `Ran 135 tests`, OK; web shell green, and the new step prints `web/dist/_headers is byte-identical to web/public/_headers`; the size report reads `dist`, first-load shell 41.3 KB across 4 files (budget 1024 KB); browser tests (Chromium) 51s |
| `36965278604` (Phase 0 — WASM core, on `65d1191`) | **success** | 5m34s, job `build` 5m30s; the spike page builds around the fresh core and the Chromium harness runs 11 tests: **10 passed, 1 skipped** in 5.0s. The skipped one is the canvas pixel, the gap PR #47 documented |

**What this session did not do, and why.** It did not remove `web/vite.config.ts` from
`phase0-build.yml` paths, which is the change that would make edits to that file free. The
2026-10-02 night session wrote that "no target that workflow compiles reads it"; that is not exact.
The step "Build the spike page around the web core (P0-10)" of that workflow runs `npx vite build`,
which reads the file, so removing it is a real trade: a `vite.config.ts` that breaks the spike build
would stop being caught by that workflow, though the `ci.yml` web job builds the same shell and
would catch most of it. That trade belongs in a pull request of its own, with its own argument and
its own measurement, not folded into a defect fix. The three superseded pull requests the night
session listed (#38, #39, #40) are left to the operator, as it left them.

**Not in this step.** Nothing is published: the shell deploy job stays off until
`CF_DEPLOY_SHELL=true`, the switch PR #35 added, so this change cannot put a page on the project
address. `wrangler.toml` and `docs/DEPLOY.md` already named `web/dist` and are unchanged;
`scripts/build_web.sh` is unchanged too, because it becomes correct rather than being corrected.

**Next step.** Unchanged, and now with no leftover pull request of its own: the decision of the
operator on `docs/OPEN_QUESTIONS.md` Q10(a) before renderer step 2, then the device rows M1 and M2
(M2 decides). Both are outside what an autonomous session can produce.

## A `vite.config.ts` edit no longer buys a WASM core build (2026-10-02, morning)

`ci/vite-config-no-core-build`. The 2026-10-02 morning session landed the `outDir` defect and left
exactly one thing named and undone: `web/vite.config.ts` was still in `phase0-build.yml`'s
`pull_request.paths`, so an edit to it bought a WASM core build, and the session judged that trade
("a `vite.config.ts` that breaks the spike build would stop being caught by that workflow") to
belong "in a pull request of its own, with its own argument and its own measurement". This is that
pull request.

**The measurement was already in the repository.** PR #42 changed `web/vite.config.ts`,
`web/playwright.config.ts`, `.github/workflows/ci.yml` and two documents. Of those five files only
`web/vite.config.ts` is in `phase0-build.yml`'s list, so the two `Phase 0 — WASM core` runs that
pull request paid — `36965278604` (5m34s) and `36965993838` (5m47s) — are the price of a
config-only trigger, measured rather than estimated. Its two `CI` runs were 1m35s and 1m24s.

**Why the entry was there, and what replaces it.** The workflow's spike step runs `npx tsc --noEmit`
and `npx vite build --outDir "$RUNNER_TEMP/spike-dist" --emptyOutDir`, which reads the config. But
`ci.yml` has **no path filter**: it runs on every pull request, and its web job runs the same
`npx tsc --noEmit` and the same `npx vite build` — same config, same two entries
(`main: index.html`, `spike: spike.html`) — plus the browser tests. So what the spike step added for
a config-only change was the spike page's own invariants, and the two that matter are now asserted
where every pull request runs, in seconds instead of minutes:

- `ci.yml`'s "The build lands where the deploy looks for it" step also asserts `dist/spike.html`: a
  config change that stops emitting the spike entry fails there, before any deploy.
- `web/tests/unit/build-config.test.ts` (new, 4 cases) asserts the fields whose silent breakage
  costs the most: `root`/`outDir` (where the deploy reads the shell, the defect of PR #42), both
  entries, the COOP/COEP headers the threaded core needs, and `worker.format: 'es'` — the spike's
  workers are constructed with `{ type: 'module' }` in `web/src/spike/main.ts` and
  `web/src/spike/opfs-store.ts`, the only workers in the repository, so an `iife` format would break
  them at run time and nowhere else.

**Measured locally before the push** (no install, no bundler: `docs/AGENT_RULES.md` rules 2 and 3).
The four assertions were run against the real exported config object with Node's type stripping and
an identity `defineConfig` shim (`node --experimental-strip-types`), and all four hold: `root` `"."`,
`outDir` `"dist"`, input keys `["main","spike"]` ending in `index.html`/`spike.html`,
`worker.format` `"es"`, both header sets `same-origin`/`require-corp`. The Python and bash suites are
untouched by this change.

**What it does not cover, named rather than implied.** A config change that breaks the spike page at
run time in a way those fields do not name. The spike tests still run on every pull request that
touches `web/spike.html`, `web/src/spike/**`, `web/tests/spike/**`, the core, or the workflow file
itself — which is why this pull request still pays one core build: `phase0-build.yml` lists itself in
its own paths, deliberately, so a change to the workflow is exercised by the workflow.

**Measured in CI** (both on `ea92e1f`).

| Actions run | Conclusion | Measurement |
| --- | --- | --- |
| `36976705772` (CI) | **success** | 1m40s; hygiene `Ran 135 tests`, OK; the web job's unit tests are **22 files** (21 before) with the four new `build-config` cases green, and its build guard passes `test -f dist/spike.html` (the build log shows `dist/spike.html 1.55 kB`); browser tests and the Pages job as before |
| `36976705807` (Phase 0 — WASM core) | **success** | job `build` 8m50s; the spike page builds around the fresh core (`spike.html` 1.55 kB in the spike dist) and the Chromium harness runs 11 tests: **10 passed, 1 skipped** in 5.7s, the skipped one being the canvas pixel (PR #47's gap) |

This pull request pays one core build on purpose: `phase0-build.yml` lists **itself** in its own
paths, so a change to the workflow is exercised by the workflow.

**Next step.** Unchanged: the decision of the operator on `docs/OPEN_QUESTIONS.md` Q10(a) before
renderer step 2, then the device rows M1 and M2 (M2 decides), then O1–O9 and M5. Nothing else in
`docs/PHASE0_DEPLOY_PLAN.md` §5–§6 is autonomous and open, and the leftover this session was named
for is now closed.

## 2026-10-02 — Real GX decoder spike handoff (`spike/renderer-real-decoder`)

Shared native/Node/web sources now select the upstream real decoder plus observer/pose/audit
dependencies and an offline FIFO/backend adapter. Source review found an unresolved
`render_observer -> authored_stats -> authored_pose/subframe` closure; stopped before extending
the porting scope, with no fake statistics implementation or relaxed check. Details and exact
evidence are under Q10(a) in `docs/OPEN_QUESTIONS.md`. Legacy FIFO tests remain unchanged.
No local build, Node, ISO operation, CI polling or checkpoint comparison. This is an unmeasured,
not-for-merge experiment; the parent session owns CI results and same-commit 2400-checkpoint
validation if link closure is subsequently resolved.

2026-10-02 — Q10(a) follow-up: confirmed direct GX observer calls; supplied portable offline `authored_stats()` counter storage without the subframe solver. Known symbol closure addressed at source level; build/link/parity unmeasured, legacy FIFO tests and CI unchanged; draft PR #63 updated, no CI polling.

**Measured the same day — the spike holds, and the answer is the best of the three possible.** Both builds of the branch are green (`Phase 0 — Linux headless reference (offline)` run `36999621064`, `Phase 0 — WASM core` run `36999621081`), so the real decoder links for the native reference and for the web module **from one commit**. Both were then dispatched with their opt-in private artifacts (`37000659238` → `melee-core-headless`, `37000662755` → `melee-core-wasm-node`) and run on the operator's own disc through `scripts/phase0/run_checkpoints.sh` with `parity_vs_onett.txt`, 2400 retraces:

| Run | trace SHA-1 | final scene |
| --- | --- | --- |
| native, real decoder | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | `mode=2 state=2 match_frame=762` |
| web module, real decoder | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | `mode=2 state=2 match_frame=762` |
| reference of 2026-09-30, legacy decoder | `c79c53b9cdf81426fa0277e7497a69e55bc5f571` | `mode=2 state=2 match_frame=762` |

2401 rows each, and `diff` reports no differing line. **The real decoder does not change the simulated state**: the parity guarantee survives the substitution, and it is the third column that makes the claim strong — the trace taken *before* the substitution is the trace taken after it. `native_fifo_test` still exercises the legacy decoder only and is not evidence for this path; no CI check, guest read/write or texture RAM watch was relaxed. **Option 1 is adopted**, the branch is mergeable, and renderer step 2 is no longer blocked by Q10(a).


### 2026-10-02 — Baseline WebGPU geometry (`render/webgpu-geometry`)

Implemented only in `wasm/render/gx_webgpu.cpp`: packed 108-byte vertex uploads (offset
assertions against `gx::Vertex`), per-segment upstream index conversion, triangles/lines,
unsupported-primitive logging, position/normal XF transforms, projection, vertex colors,
viewport/scissor, D3D clockwise culling and reversed depth comparisons. A persistent D32
attachment clears with reversed `clear_z`; like the existing color clear this still covers
all of the EFB. The shader samples a neutral white 1×1 texture in slot 0. Pipelines belong
to this device and do not use `DrawCall::cached_pipeline`; submitted transient buffers retire
on queue completion. No source-set, simulation, native or Node backend changes.

`gx_webgpu_selftest` now optionally submits synthetic recorded Frame/DrawCall/Vertex data
following the existing real-FIFO clear test. `web/tests/spike/render.spec.ts` checks a green
transformed triangle against blue clear, red/far and blue/far overlapping triangles, an outside
probe, scissor rejection, culling and unsupported points. Removing draws cannot pass the green
assertion; disabling depth lets blue win. Canvas submission assertions remain without pixel
assertions. The synthetic draws test the backend ABI, not FIFO vertex decoding.

Verification performed: source review and `git diff --check` only. No local compilation,
browser run, CI result, preview, game frame or 2400-checkpoint parity was verified. The parent
session owns parity. Per operator instruction this session pushes a draft and does not pursue CI.

Known limits: lighting/channel controls and texgen remain unfinished priority 2 work; transformed
normals and col1 are carried but the fragment shader uses col0. Priority 3 TEV, alpha test,
blend/write masks, fog and destination alpha, and priority 4 real textures remain absent.
Line conversion is implemented but has no pixel fixture yet; perspective, inverted/outside
viewports, all matrix indices and normal lighting behavior need further GPU coverage. Viewport
mapping uses full-EFB rasterization plus original clip-coordinate rejection in the fragment
shader; edge/sample equivalence with D3D needs comparison. No performance measurement or device
loss/recreation validation; per-segment uploads/submissions and unbounded pipeline residency
are provisional. Resource completion callbacks need the worker event loop to turn.


## 2026-10-02 — WebGPU snapshot textures (`render/webgpu-textures`)

Implemented in `wasm/render/gx_webgpu.cpp`: eight explicit texture/sampler bindings; immutable
snapshot-only uploads; reuse of upstream CPU decoding for all eleven GX formats to RGBA8;
per-level mip decoding/upload; D3D wrap/min/mag/mip/LOD mapping with signed shader bias;
slot-0 MODULATE; retirement after submitted GPU work. No texture cache is introduced: every
segment re-uploads, so image/TLUT changes invalidate naturally, at an unmeasured performance
cost. Unsupported/malformed snapshots and inverted LOD clamps stop the backend instead of
substituting guessed pixels. No simulation, native, Node, CI or submodule changes.

Added 19 synthetic GPU pixel cases in `web/tests/spike/render.spec.ts`: all formats, RGBA8
MODULATE, image/TLUT replacement with identical address/hash, forced mip, three wrap modes,
and linear magnification. They use the existing worker `copyTextureToBuffer` readback and
non-white expected colors; omitting texture sampling cannot satisfy them. CMPR is CPU
decompressed; RGBA8 AR/GB planes and all tiled formats are repacked to linear RGBA8.

Verification performed: source inspection against pinned upstream `gx_texture.cpp`,
`texture_snapshot.h`, `TextureRef`, and `gx_d3d12.cpp:1613–1648`; `git diff --check`.
**Not executed:** compilation, tests/CI, browser/GPU readback, preview, real-game captures,
performance/memory measurements or the 2400-checkpoint parity run. Per task instructions,
no local build, no CI chasing and no parity claim; parity belongs to the parent session.

Known limits/next step: validate the draft in CI and on GPU, then add bias/minification/trilinear,
rectangular mip, TLUT variants/index and CMPR transparency fixtures. Slot 0/raw UV0 MODULATE is
a deliberate TEV subset; slots 1–7 await priority 3 shading. Texgen, lighting, EFB copy texture
lookup, optional anisotropy/replacements, caching and device recreation remain open. Q10 in
`docs/OPEN_QUESTIONS.md` records these boundaries. Deliver as a draft PR; stop without merge.

**Landed by the parent session**, measured in the same Chromium harness: **35 passed, 1 skipped**
(16.2s), the texture cases among them — RGBA8 MODULATE including alpha, image and TLUT replacement
at an identical address/hash, mip 1 with LOD clamps, clamp/repeat/mirror repeat, and linear
magnification across a tile boundary. The skipped one is still the canvas pixel (PR #47's gap).

### 2026-10-02 — Access JWKS retrieval (`fix/access-jwks-fetch`)

Changed Pages entry-point retrieval to plain `fetch(url)` and require the final response URL
host to exactly match `ACCESS_TEAM_DOMAIN`, failing closed on missing/invalid URLs. HTTP
failures and untrusted final URLs retain `access_jwks_unavailable`; thrown fetches now use
`access_jwks_unreachable`. Configuration/invalid-JWKS diagnostics, generic token 403s and
signature verification are unchanged. Updated fake responses with final URLs and added
same-host path, foreign host, port mismatch, missing/invalid URL, 404/500 and thrown-fetch
coverage. DEPLOY documents the runtime coverage gap and the required live verification.

Verification: source review and `git diff --check` only. No local build, typecheck or tests,
no CI outcome, preview publication, actual Cloudflare redirect behaviour or authenticated
Access request verified. A real deployment and real login are the decisive remaining check;
the mocked suite cannot establish runtime fetch-option support. No simulation, renderer,
submodule or CI/guard changes. Delivered as a draft PR; no CI pursuit or merge.

**Same option, second file — added by the parent session.** `functions/api/turn-credentials.ts` sent
its upstream POST with `redirect: 'error'` too, so it failed in production the same way for the same
reason, and its mocked test could not see it either. It now uses `redirect: 'manual'`: that upstream
is not expected to redirect, so a redirect is **refused** rather than followed, and the existing
`!upstream.ok` check maps it to 502 — no final-host check is needed where nothing is followed. Its
test's expected request options were updated to match, and a repository-wide search confirms no
other live occurrence of the option remains.

### 2026-10-02 — Disabled decoder clocks and GX optimisation (`perf/decoder-cost-2`)

Based on `471a96c`; scope is P2/P4 from the decoder cost analysis. Patch 0008 now
checks `offline_cost_mode` before either scope clock read. Mode 1 retains both reads,
nanosecond conversion, slots and accumulation; mode 2 retains the legacy discarded
reads. The mode is selected before simulation starts. Native `MELEE_HEADLESS` without
`MELEE_OFFLINE_COST` uses an empty scope, matching its existing no-op collector;
the profiling-enabled desktop implementation stays intact. Actual timing values and
profiling overhead have not been compared; unchanged accounting is not a measurement.

Added GX files to `MELEE_HOT_SOURCES` one per commit, and extended the existing
compile-command assertion to cover them. `-ffp-contract=off`, `-fno-fast-math`, the
remaining sources and link optimisation settings are unchanged. No draw preparation,
palette generation, DrawCall, validation or game-state changes were made.

| Cumulative web configuration | Commit | Web WASM bytes |
| --- | --- | --- |
| Main baseline (operator supplied) | `471a96c` | 16,323,255 (not remeasured) |
| P2 only; size comparison baseline | `f9abfb8` | Not measured |
| Add `gx_core.cpp` at `-O2` | `417104e` | Not measured |
| Also add `gx_texture.cpp` at `-O2` | `3d2fe87` | Not measured |
| Also add `render_observer.cpp` at `-O2` | `c712fe6` | Not measured |

**Size gate remains unresolved.** Local builds are forbidden and the operator explicitly
requested stopping before CI. Build the above revisions in CI with identical inputs to
measure each increment. If the module exceeds 20 MiB (20,971,520 bytes), remove `-O2`
from the largest contributor and rebuild before accepting the change. No contributor
has been identified or reverted without measurements. Cloudflare's 25 MiB limit is
26,214,400 bytes; the baseline alone cannot establish safety of this draft.

Verification performed: source review, `git diff --check`, and sequential application
of all eight patches to temporary copies of the affected files from pinned upstream
`3aab717`, without modifying the upstream checkout or compiling anything.
**Not executed:** build, automated tests, CI dispatch/inspection, preview, module-size
measurement, iPhone performance/p99, enabled-profiler comparison, or native/WASM
2400-checkpoint parity. The required trace SHA-1 remains
`c79c53b9cdf81426fa0277e7497a69e55bc5f571`; the operator owns that check and this draft
makes no parity claim. The mean <= 3 ms / p99 <= 6 ms target is unverified.
Delivery is a draft PR only; no merge. PR-triggered workflows may start automatically;
this session does not dispatch, monitor or claim their results.

## 2026-10-02 — frame split, awaiting all execution checks

Branch `perf/frame-split` starts at `1de335850e06ba84f5e0651b5f9be62de7ef6c83`,
exactly `perf/decoder-cost-2` / PR #71 (unmerged). The worktree already contained
this newly created, clean branch; no existing commits were replaced. Draft PR
is based on `perf/decoder-cost-2`, so only this measurement change is in its diff.

- Added instrumentation: `observer_game_ms` times constructor/destructor bodies of all seven game-side hook kinds, counting entries by kind; guest function time excluded.
- Added instrumentation: `end_frame_ms` times the complete XFB completion block, including backend recycling and cleanup; **nested inside decoder time**, not outside it.
- Added instrumentation: `watched_ram_block_writes` counts version increments per watched block touched, including bulk callers; no per-write timer.
- Added instrumentation: `watched_ram_blocks` reports the per-retrace watched-block count with min/max/last summaries; not additive across retraces.
- Accounting: seven exclusive phases sum to `sim_ms`; five partition identities are checked with unchanged tolerance, signed residuals preserved, old CSV rejected.
- Observer switch: **not implemented** because readers exist, including offline GX statistics; evidence and precise measurement boundaries in `docs/PORT_CHANGES.md` §0009.
- Verified by source inspection: same upstream pin and P2/O2 base; full patch series applies sequentially in an isolated Git index; `git diff --check` clean.
- Not verified: C++/WASM compilation, TypeScript checks, newly extended unit tests, CI, preview, iPhone performance, disabled-mode overhead, or runtime partition values.
- Not verified: 2400-checkpoint trace against `c79c53b9cdf81426fa0277e7497a69e55bc5f571`; operator will execute it. No simulation-equivalence claim.
- No new timings measured, no optimizations, no decoder algorithm changes, no game data added, no local builds/tests or CI dispatch. Commit uses `[skip ci]` to honor the requested stop before CI without editing workflow gates.

Next: operator authorizes CI/build, runs the trace and iPhone measurement with
`?decoder-cost`, and reviews residuals/overhead before any optimization. Same-build
observer on/off comparison remains unavailable under the reader constraint.

## 2026-10-02 — the decoder cost measured, and two cheap fixes that paid for it

The phone measurement put the simulation at **12.51 ms** per in-match frame (iPhone 16 Pro,
2400 frames, no canvas, no backend), against the declared cap of mean <= 3 ms / p99 <= 6 ms.
The opt-in phase profiler (`?decoder-cost`, PR #69) then split the frame: draw recording
0.61 ms, textures 0.45 ms, per-draw observer 0.09 ms, decoder work outside those 4.83 ms, and
everything **outside** the decoder 9.90 ms. The profiler's own clock reads cost about 3.4 ms
per frame (15.88 instrumented against 12.51 clean) — tens of thousands of clock reads per
frame, because `SimCostScope` read the clock even with profiling off.

Two changes followed (PR #71), both safe by construction and both verified before merge:

- **P2** — the simulation-cost scope no longer reads the clock when profiling is off.
- **P4** — `gx_core.cpp`, `gx_texture.cpp` and `render_observer.cpp` move to `-O2`.

Measured on the same device, same test, clean run, commit `d624d06`: in-match mean **4.35 ms**
(was 12.51), p99 **6.20 ms** (was 14.02), all-frame mean 2.74 ms (was 7.22), wall 26.8 s (was
38.4 s). The module came out **smaller**: 15,229,664 bytes against 16,323,657 — `-Oz` was
costing both speed and size on those three files.

Verified, not claimed: the 2400-checkpoint trace is `c79c53b9cdf81426fa0277e7497a69e55bc5f571`
with the new module under Node against the operator's disc, 0 differing rows of 2401, and it
stays identical with the frame-split instrumentation (PR #72) inside. CI was green on the exact
merged commits.

Remaining gap: the in-match mean is 45% above the 3 ms cap and the p99 3% above the 6 ms cap.
PR #72 adds `observer_game_ms`, `end_frame_ms` and watched-RAM counters so the next phone run
attributes the remainder; the observer switch was **not** implemented because readers of those
values exist, including offline GX statistics (see `docs/PORT_CHANGES.md` §0009).

The largest single item turned out to be **our own instrumentation**, not the renderer: the two
"safe, small" changes beat any clever change to the drawing path by a wide margin. Measure
first — the analysis that ranked draw recording and texture snapshots as the top suspects was
wrong by an order of magnitude (together 7% of the frame).

## 2026-10-02 — guest code baseline, no justified optimization

Branch `perf/guest-code`, base `6dd96f4`. Python recompiler successfully ran locally
on the verified external DOL with patches 0001–0009, offline and release, without
compiling. External outputs: `/home/hermes/incoming/guest-code-baseline-{offline,release}`.
Full reader audit, reproduction, aggregates and next measurement:
[Guest code audit](GUEST_CODE_AUDIT.md). Added aggregate-only counter
`scripts/analysis/count_guest_code.py`.

Offline/release respectively: 137/144 TUs, 19,827/20,076 functions,
962,305/1,019,597 instruction-comment sites, 19,713/19,962 function-entry sites,
56,348,251/62,764,846 numbered C++ TU bytes. **Zero per-instruction PC stores**;
`last_pc` is assigned once per executed function entry by inline `enter()`.
**Zero local-block returns to a central dispatcher**: local gotos and C++ calls
already connect the code. Explicit C++ returns: 22,317/23,623, not dispatcher exits.
Dynamic entry counts per frame remain unknown; no estimate invented from static counts.

No optimization implemented: dropping entry instrumentation would change diagnostic
history/hooks/watchdog, and backedge polling delivers simulation events. The proposed
DolRecomp transformations do not apply to the pinned emitter. Next: per-frame delta
of existing `g_enter_count` plus symbolized guest/helper profile on the same workload,
then one justified exact-semantics optimization and clean iPhone A/B.

Not verified: 2400-checkpoint SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`
(operator owns execution), phone mean/p99, module size, preview, or native/WASM
compilation of the generated outputs. No local build or test suite was run.
Delivery is a draft analysis PR, no merge; CI status reported with delivery.

## 2026-10-02 — WebGPU device loss: instrument before changing lifetime

Branch `fix/webgpu-device-loss`, base `df62fa2` (main). The branch already existed
at exactly this base, clean, with no implementation commits when this session began.
Phone evidence supplied by operator: 81 copies, createSampler InvalidStateError,
then createBuffer failure. Device-loss reason and resource counts remain unknown.

`gx_webgpu.cpp` already retires textures/buffers, but via promise callbacks after
submission; these cannot execute during synchronous `callMain`. This is a backlog
hypothesis, not proof of the phone's cause. Pipelines are already cached. Samplers,
bind groups and pipelines have no destroy API; cumulative creation is not live allocation.

Added device-wide API counts (attempted/returned/thrown, explicit destroy calls,
undestroyed and peak for textures/buffers), immutable snapshots at first failure,
structured device.lost reason/message and uncaptured error type/message/timestamp.
Observers now precede the first GPU probe. Report waits a minimum 50 ms after readback
for queued events; null deviceLoss means not observed within that window, not healthy.
No resource lifetimes changed yet. Synthetic CI burst: 128 repetitions, 384 draws,
expected 3072 samplers and peak 3076 textures before retirement callbacks. Pending CI.

The canvas readback skip remains: documented Chromium failure on first canvas commit
(run 36898914442) is not proven identical to the phone's failure after 81 copies.
No local builds/tests, no disc data, no simulation changes. NOT verified: the operator's
2400-checkpoint trace `c79c53b9cdf81426fa0277e7497a69e55bc5f571`, phone device-loss
reason, 2400-frame canvas survival, preview or GPU memory. Draft PR only, no merge.

### Measurement and targeted lifetime correction

Baseline commit `99f7665`, Actions run [37025783561](https://github.com/isDemetrio/melee-web/actions/runs/37025783561):
36 passed, 1 skipped. Real WebGPU backend, 128 repetitions / 384 textured draws,
one synchronous worker task, offscreen texture, correct pixel `[128,64,32,192]`.

| Type | Created | Explicitly destroyed at report | Peak undestroyed |
| --- | ---: | ---: | ---: |
| sampler | 3072 | unavailable (no API) | unavailable |
| texture | 3076 | 3072 | 3076 |
| buffer | 1157 | 1152 | 1157 |
| bind group | 384 | unavailable (no API) | unavailable |
| pipeline | 1 | unavailable (no API) | unavailable |

All transient texture/buffer resources accumulate during the task and retirement runs
only afterward. This disproves "never released", but confirms an unbounded-with-workload
retirement backlog. No device loss or validation errors occurred in this baseline.
These are API lifetime counts, **not GPU allocation bytes or a measured iPhone failure**.

Correction: destroy transient textures/buffers immediately after submission (and on
failed draws), letting the implementation retire already submitted work, as required by
[WebGPU buffer destruction](https://www.w3.org/TR/webgpu/#buffer-destruction) and
[texture destruction](https://www.w3.org/TR/webgpu/#texture-destruction). Also explicitly
destroy probe/readback buffers (five remained undestroyed in the baseline report).
No texture/sampler cache added: sampler creation counts do not establish live allocation.
Pipeline cache unchanged. No simulation, scheduling or Asyncify changes.

Regression coverage now repeats both 384 and 2400 textured draws in one task and requires
correct readback, zero errors/loss, peak 12 textures / 3 buffers, final 4 persistent
textures / 0 buffers. Synthetic 2400 XFB copies are not 2400 game frames or actual screen
presentations. Added unit coverage for deferred loss/uncaptured errors and immutable
first-failure counters. Final CI pending. Original phone loss reason remains unknown.

## 2026-10-02 — WebGPU device survival: bounded sampler cache

Branch `fix/gpu-device-survival`, base `6f3ff5f` (main, PR #77 merged). Operator evidence, on
`7296478` (**before** PR #77): `?canvas`, 2400 frames, iPhone 16 Pro, `presented: 81`, first
failure `createSampler` (InvalidStateError), then readback `createBuffer`; simulation trace correct.

What the code shows on the base. The promise-callback retirement that fits the operator's
description was already replaced by PR #77's second commit (`6971bc9`): transient textures and
buffers are destroyed synchronously after `queue.submit`, and CI asserts peak 12 textures / 3
buffers through 2400 synchronous textured draws. **The phone has not run a build with that.**
What still grows with every draw and has no `destroy()`: 8 samplers (unused slots included),
1 bind group, 10 texture views, encoders. Samplers are the measured failing call.

Options, judged on the code:
1. Synchronous release: already done for every destroyable type (`6971bc9`). Samplers, bind
   groups and views have no release API.
2. Yield to the event loop every N frames: the simulation is one `callMain`; Asyncify and
   `emscripten_sleep` are forbidden in the simulation path (`AGENT_RULES.md`). It needs the frame
   loop to return to JavaScript — a simulation-path restructure, not the smallest change.
3. Reuse: the sampler descriptor is a pure function of `mode0 & 0xFF` and `mode1 & 0xFFFF`.

Chosen: 3, samplers only. `gxw_texture` keeps a `Map` keyed on those bits, max 256 entries,
oldest dropped past the limit. Creation errors still go to `recordFailure`/`gpu.failure`, nothing
cached on a throw. Bind groups cannot be cached while slot textures are recreated per draw.
`resources.sampler.created` now counts cache misses. Tests: the 384/2400-draw resource tests
expect **1** sampler instead of `copies * 8`; new fixture `geometry=38` (clamp/repeat/clamp in one
frame) proves a hit never crosses wrap modes (pixel `[128,64,32,192]`, 2 samplers).

The skipped canvas-pixel test stays skipped: CI Chromium loses the device at the first canvas
commit with `copies=2` and no geometry — zero draws, zero samplers, zero transient textures — so
no resource-lifetime change can reach it (PROGRESS, runs `36896537472`/`36898914442`).

Recommended next, not done: yield every N frames via a re-entrant frame step (not Asyncify).
It is also what real on-screen presentation needs: an OffscreenCanvas frame is committed only
when the worker's task ends, so during `callMain` every XFB copy lands in the same
`getCurrentTexture()` and `presented` counts copies, not screen frames.

NOT verified: the 2400-checkpoint trace `c79c53b9cdf81426fa0277e7497a69e55bc5f571` (operator
runs it; the change is renderer-only), phone survival, phone device-loss reason, per-frame
cost on the phone (expected not to rise: a Map lookup replaces 8 `createSampler` per draw,
unmeasured), whether samplers or the pre-#77 textures caused the 81-copy loss. No local
build or test run; CI is the only build.

## 2026-10-02 — WebGPU resource audit: nothing per draw outlives its draw without a bound

Branch `fix/gpu-resource-audit`, base `d45a1fd` (main, PR #78 merged). Operator evidence on
`d45a1fd`, `?canvas`, 2400 frames, iPhone 16 Pro: sampler 3 created (was 93,544); texture
21,901 created / 21,898 destroyed; buffer 67,548 / 67,548; **bindGroup 22,514, no destroy**;
pipeline 6; `presented: 124` (was 81); first failure `createBindGroup` at 6755 ms; loss
"destroyed" at 35811 ms is our teardown; one 1013 ms frame; trace `c79c53b9…` identical.

Inventory of every GPU object the backend creates (`wasm/render/gx_webgpu.cpp`; `gpu.ts` only
outside `callMain`):

| Resource | destroy()? | Before | Now |
| --- | --- | --- | --- |
| EFB, depth, white textures; XFB texture (CI) | yes | once, persistent | unchanged |
| Bind group layout, pipeline layout | no | once | unchanged |
| Sampler | no | cache, 256, key `mode0&0xFF`, `mode1&0xFFFF` (#78) | unchanged |
| Shader module + render pipeline | no | per pipeline-key miss; key held all of `components` and `zmode` | key = the bits the descriptor reads (`components & 0x6400`, `zmode & 31`): at most 2·4·32·8 = 2048 |
| Slot texture | yes, sync after submit | one per used slot per draw | pool keyed `(slot, w, h, levels)`, LRU, ≤128 entries and ≤32 MiB; evicted ones `destroy()`ed synchronously |
| Slot texture view | no | 8 per draw | one per pool texture, white's once |
| EFB / depth view | no | 2 per draw, 2 per clear | once, in `gxw_open` |
| Uniform buffer | yes, sync | one per draw | one, persistent |
| Vertex / index buffer | yes, sync | two per draw | two, persistent, grown by doubling, old one `destroy()`ed |
| Bind group | no | **one per draw** | LRU cache, 256, key = the 8 slots' pool ids + sampler keys |
| Command encoder, render pass, command buffer | no (single-use by API) | per draw / copy | unchanged: consumed by `submit`, no reuse API |
| Probe / readback buffers (`gpu.ts`) | yes, in `finally` after `await` | before/after `callMain` only | unchanged |

No `destroy()` inside a promise callback runs during the simulation: the only awaited ones are
the probes and the readback, which are outside `callMain`.

Why the pool. A bind group names its resources; while each draw created its own textures and
uniform buffer, every bind group was single-use and could not be cached. Pool textures are
rewritten on every use (all mip levels, so no stale pixels; no hash or address is trusted).
Correctness rests on queue ordering: a `writeTexture`/`writeBuffer` issued after a `submit` does
not reach the work already submitted. CI fixtures that fail without it: `geometry=1` (three
layers in one vertex buffer), `31`/`32` (changed image/TLUT in one pooled texture), new
`geometry=6` (vertex/index buffers grow between submitted draws). The 384/2400-draw tests now
expect constant counts: 1 bind group, 12 textures (0 destroyed), 8 buffers (3 persistent).
A Node mock of the EM_JS bodies (not committed) ran 2400 identical draws (1 bind group) and 5000
draws over 300 shapes (pool held at 128, cache at 256, no destroyed texture ever bound).

Yielding to the event loop every N frames — **not done**. The simulation is
`ppc::call(..., 0x8000522C)` (`native/headless_main.cpp:99`), the game's own `__start`, which
never returns; `retrace()` (`native/headless_host.cpp:616`) runs inside the guest's call stack and
leaves only by throwing `ExitRequested`. Returning to JavaScript between frames means suspending
that stack: Asyncify (forbidden, `AGENT_RULES.md`), JSPI (not in Safari), or running the guest on
another thread. None is a renderer change, and none can be shown trace-preserving without a build
here. The previous entry's "re-entrant frame step" underestimated this. After this change the
backend no longer depends on GC or callbacks for anything with a release path.

NOT verified: the trace `c79c53b9cdf81426fa0277e7497a69e55bc5f571` (the change is renderer-only;
the operator runs it); phone survival, `presented`, the 1013 ms pause; whether 256 bind groups /
128 pool textures cover a real match without thrashing (the phone report's `bindGroup.created`
will say: near the draw count means too small); the eviction path in a real browser (mock only);
whether WebKit stalls on `writeBuffer`/`writeTexture` into resources in flight. A bind group or
sampler that fails validation is cached and reused: errors arrive as `uncapturederror` events,
which cannot run during `callMain`, so the first one is still what the report shows. No local
build; CI is the only build.

## 2026-10-02 — the #79 regression is upload volume, not pool thrash; textures cached by snapshot; a run heartbeat

Branch `fix/gpu-pool-thrash`, base `9b08acf` (main, PR #79 merged), PR #80. Operator evidence on
`9b08acf`, `?canvas`, 2400 frames, iPhone 16 Pro: the log stops at `scene: major 02 minor 02
(frame 1395)`, no report, minutes without progress ("o si blocca o ci mette una cifra"); on
`d45a1fd` the same run reached 2400.

**How it was measured.** CI built the web core of `9b08acf` as the private `melee-spike-dist`
artifact (`phase0-build.yml`, dispatch with `upload_spike`, run 37037610934). On the VPS, outside
the repository (`~/incoming/phase0/gpu-census/census.mjs`), that core ran under Node against the
operator's disc: a WORKERFS polyfill, and a mock WebGPU device that counts every call, records the
eight slots of every submitted draw and fingerprints every level-0 `writeTexture`. It is the real
game and the real `gx_webgpu.cpp` JavaScript; only the GPU is fake, so these are counts and CPU
costs, **not iPhone GPU timings**.

**The thrash hypothesis is refuted.** 2400 frames, 2,021,706 draws: the `(slot, w, h, levels)` pool
created **122 textures and evicted none** (peak 118 of 128, 6.8 MB); **157 bind groups** in the
whole run; no destroyed texture was ever bound or written. Pipelines: 19.

**What changed between d45a1fd and 9b08acf is how far the backend gets.** On `d45a1fd` the backend
died at the first `createBindGroup` failure (22,514 draws, ~124 copies, at 6.7 s) and
`gx_set_backend(nullptr)` made the rest of the run headless: the match was never rendered. #79
removed that failure, so the backend now reaches the match, where the draw path is far heavier:

| per frame (census, 9b08acf) | before scene 02:02 (frames 1–1394) | from frame 1395 (match) |
| --- | ---: | ---: |
| draws (one `submit` each) | 257 | **1,880** |
| `writeTexture` bytes | 2.85 MB | **117 MB** |
| `writeBuffer` bytes | 0.84 MB | 6.7 MB |
| Node ms, mock GPU | 34 | **276** |

Every draw decoded and rewrote every texture it binds, though a match frame uses only 140–154
distinct texture contents (≤6.2 MiB). The same core under Node: 80 s without the backend, 293 s
with it and no GPU at all. On the phone those 117 MB per frame also cross Safari's GPU-process
boundary. That is consistent with "ci mette una cifra"; whether the phone was slow or truly
stuck cannot be told from the evidence: the scene line is printed only at scene changes and the
next one is after frame 2400. WebKit's current `Queue.mm` does not wait on in-flight resources in
`writeBuffer`/`writeTexture` (it stages and blits); the iOS 18.7 WebKit was not checked.

**Fix.** Textures are cached by content. `upload_textures` gives each immutable `TextureSnapshot`
(with format, TLUT format, size, levels) an id and pins the snapshot while its texture is pooled;
`gxw_bind` keys the pool by that id, so a hit is neither decoded nor written. Snapshot identity is
sound because the decoder's `TextureSnapshotCache` returns the same object for the same bytes and
a new one when bytes change (memcmp, not hash/address). Eviction queues the id, and C++ forgets
the snapshot right after the bind that evicted it. Pool limits 1024 textures / 64 MiB; bind group
cache 256 → 1024 (817 distinct keys in the run; 256 missed 2383 times, 1024 only the 817
compulsory ones). The selftest fixture now returns one snapshot per distinct fixture texture, as
the decoder does.

Measured with the PR's core (artifact run 37041002424), same Node harness:

| | 9b08acf | this PR |
| --- | ---: | ---: |
| Node wall, 2400 frames (headless: 80 s) | 293 s | **109 s** |
| match frames, Node ms/frame | 285 | **73** |
| match frames, `writeTexture` per frame | 117 MB | **0.019 MB** |
| texture levels written, whole run | one set per draw | 1,818 |
| textures created / destroyed | 122 / 0 | 1,776 / 748 |
| bind groups created | 157 | 3,716 |
| trace SHA-1 (Node, mock GPU) | `c79c53b9…` | `c79c53b9…` |

1,776 textures, not 481: the decoder drops a snapshot unused for 3 frames, so content that returns
later is a new snapshot. In the match about 0.85 new contents per frame (an animated texture),
each evicting an old menu texture once the pool is full: steady, not thrash.

**Heartbeat.** `retrace()` calls `host::retrace_heartbeat` before the sim-time resume stamp (null
by default; set only by `wasm/core/heartbeat.cpp` in the web core; reads no guest state), and every
`gxw_draw` beats too. The worker posts at most one beat per 500 ms (frame, time, draws, copies,
pool, textures/bind groups created, backend failure). The page shows `heartbeat: frame N …`, says
`STALLED IN FRAME N+1` when beats arrive but the frame does not move, `SILENT` when nothing
arrives, keeps the record in `localStorage` (a reload shows where an unfinished run stopped),
offers a partial report, and puts the beat history in the result JSON. Under Node the hook was
called 2400 times, in order.

CI on PR #80: all checks green; the new browser test evicts past the pool limit in Chromium
(1200 contents, 176 destroyed, correct pixel, no validation error); 2400 identical textured draws
write the texture once.

**NOT verified:** the trace `c79c53b9cdf81426fa0277e7497a69e55bc5f571` on the phone (the operator
runs it; only the Node run above matched); anything on the iPhone: whether the match now runs at
an acceptable speed, whether the 9b08acf run was stuck or slow, real GPU time of ~1,880
`submit`s and ~5,600 `writeBuffer`s per frame (the next suspect if the phone is still slow:
one encoder per frame needs per-draw uniform/vertex offsets), and whether ~1 new bind group per
match frame (dropped from the cache to GC, as samplers were) fails again in a long session. A
census fingerprint samples bytes, so "481 contents" is an estimate; the snapshot counts are
exact. Not reverted: the diagnosis exonerates the pool, and reverting it would only bring back
the `createBindGroup` failure that turned rendering off before the match.

## T7 lands, and the flake the merge exposed (2026-10-02, evening)

`net/sab-ring` (PR #59) is merged as `5168783`, and `fix/flaky-disc-route-test` (PR #81) as `6488b49`.

**Why this and not something else.** `docs/PLAN_BREAKDOWN.md` T7 lists the SPSC ring over
`SharedArrayBuffer` among its deliverables, and everything else T7 lists had landed earlier
(`web/src/net/transport.ts`, `web/src/net/webrtc.ts`, `web/tests/e2e/rtc.spec.ts`). In the recommended
order `T0 → T1 → T4 → T2 → T3 → T5 → T6 → T8 → T7 → T9 → T10`, T9 is credential-gated (Cloudflare) and
T10 depends on all, so T7 was the one plan item that was neither done, nor credential-gated, nor waiting
on a device or an operator decision — and the branch had been open, green and unmerged since 12:23. This
session refreshed it onto `main` (merge `92ca20e`) and re-measured before merging, rather than merging a
tree CI had not seen.

**What landed.** `web/src/net/sab_ring.ts` and `wasm/net/sab_ring.h` — the same byte layout written
twice, frames `[u32 len][u8 lane][payload]` with head/tail as `Int32Array` indices;
`wasm/net/sab_ring_test.c` and `wasm/net/check_sab_ring.mjs` replay one scripted sequence through both
halves and require the two ring images to be identical byte for byte (including a frame that wraps the
end of the data region, a ring that fills and refuses, and three writes that are not frames);
`web/tests/unit/sab_ring.test.ts` is T7's stated JavaScript acceptance (wraparound, back-pressure that
returns instead of waiting, zero-length frames refused, 10^5 random frames round-tripped);
`docs/NETCODE_MAP.md` gains the "Transport" section; `wasm-probe.yml` compiles and runs both halves,
which is why this pull request cost no WASM core build.

**Measured.** Locally, on the merged tree, with Node and Python only (rules 2 and 3):
`python3 -m unittest discover -s scripts/tests` — **167 tests, OK**;
`python3 scripts/check_no_game_data.py --all` — clean, 228 tracked files;
`bash scripts/tests/test_deploy_guard.sh` — all deploy and upload guards hold;
`bash scripts/tests/test_device_test_serve.sh` — 6 cases pass. In CI on the exact merged head `92ca20e`:
run `37047248275` (CI) **success** 1m38s and run `37047248317` (WASM toolchain probe, both halves)
**success** 1m16s.

**The merge exposed a flaky test, and it was not the merge's.** The first `main` run after the merge,
`37047462284`, failed in *Repo hygiene and workflow lint* / *Unit tests for the hygiene gate*:
`test_both_disc_routes_serve_the_same_file` (`scripts/tests/test_serve_spike.py:206`) compared the two
whole responses, headers included, and `http.server` stamps `date` per response — so two requests that
straddle a second boundary differ on that header alone, and the log shows `18:26:56` against `18:26:57`.
The tree of `5168783` is byte-identical to `92ca20e` (`8e630c5a`), whose pull-request run was green
minutes earlier, and the rerun of `37047462284` is green: the same tree, two outcomes. Reproduced
deterministically on the VPS with the real fixture (stdlib only, no build): two requests one second
apart, `date` `18:32:09` against `18:32:10`, old assertion `False`, new assertion `True`. PR #81
asserts `date` present and then drops it; the status, every other header and the bytes are still
compared. CI run `37048256707` **success** 1m31s (all four jobs); the merge's own `main` run
`37048453891` **success** 1m43s.

**NOT verified.** The ring under two real threads: the module is built `MELEE_SINGLE_THREAD=1`
(`wasm/core/CMakeLists.txt`), so no second thread exists to produce or consume one, and nothing here is
linked into `melee_core_wasm` — there is no consumer yet, and adding it to that build would be a change
to the simulation path with no measurement behind it. No game frame has crossed a ring.

**Next step.** Unchanged, and now with T7 closed: T9 is credential-gated, T10 depends on it, and what
remains for the plan is the operator's — O1's legal call, O2–O9's credentials, and the device rows M1,
M2 and M5 whose in-match mean and p99 are the go/no-go. The renderer's open thread
(`render/webgpu-lighting`, PR #70) had uncommitted changes in its worktree when this session looked and
was left untouched, as was the stale uncommitted change in the main checkout's `wasm/net/sab_ring_test.c`.

## First playable integration — 2026-10-02 (feat/first-playable)

Main Game screen now owns a `PlaySession`: verified chunked R2 → OPFS disc loading (or an
explicit local ISO), the same CI web core and WebGPU backend as the spike, keyboard/gamepad/touch
port 1 via an atomic shared-memory mailbox. `native/headless_input.cpp` has an optional host
callback; browser-only `wasm/core/live_input.cpp` decodes PADStatus explicitly. With no livePad
option, the original scripted input path remains active. No changes under `wasm/render/`.

Confirmed from `native/headless_main.cpp`: callMain enters guest __start synchronously. Messages
cannot update input during that call. `web/src/play/worker.ts` explicitly transfers an ImageBitmap
at retraces and waits for the main-thread acknowledgement, bounding pending frames to one;
wall-clock pacing does not advance guest time. Stop/navigation terminates the worker, cancels
downloads and removes input listeners. Audio and online matches are not integrated. Play begins
at the game's own menus, without the parity input script. Old deployed cores fail visibly with a
request to rebuild, rather than silently ignoring input.

Overlay is now contained by the game stage instead of fixed over the viewport; initial opacity
uses settings. The operator's reported visual glitch has NOT been reproduced on their device.
Open question: whole image or borders, one-time or intermittent, device/browser/orientation and
exact Settings → overlay steps? Do not identify this layout defect as the proven cause.

Validation is CI-only (pending at initial commit): shared PAD serialization tests, mobile overlay
containment/navigation, and three consecutive real-core synthetic GX frames presented by the main
page without yielding the worker task. No game-data fixture. Actual disc boot, character movement,
phone presentation/performance and long-session GPU resource behavior still need operator testing.
The required trace `c79c53b9cdf81426fa0277e7497a69e55bc5f571` has NOT been verified by this agent;
the operator runs the unchanged scripted spike to verify it. Merge requires green CI and verified
preview; neither an input unit test nor synthetic GX proves the first playable acceptance criterion.

### The three CI failures on #83, measured before fixing (2026-10-02, night)

A diagnostic-only commit (`d3101e7`, run 37059095321) printed what the browser hit-tests at the zone
centres and what the presented frames carry, before anything was changed.

**Overlay (touch-overlay.spec.ts:17 and :57).** `document.elementFromPoint` at the centre of
`#stick-zone` and of `#touch-a` returned **`null`**: the points were *outside the viewport*
(y = −79 and −104 in a 1280×720 viewport, `scrollY` = 656, `#game-stage` top at −496). Nothing
covered the zones; nothing was there to hit. `page.check('#touch-overlay-toggle')` scrolls the
toggle into view, the toggle is in the Input panel below the stage, and the overlay is now
`position: absolute` inside the stage, so reaching the toggle scrolls the controls off the top.
Before, `position: fixed` pinned them to the viewport whatever the scroll. The 390×844 containment
test passed because it never sends a pointer event. Fix (`web/src/ui/screens/game.ts`): switching
the overlay on scrolls it back into view, bottom-aligned (`scrollIntoView({ block: 'end' })`, only if
it is not already fully visible), which also keeps the zones on screen on a landscape phone where
the stage is taller than the viewport. The two tests now also assert that `elementFromPoint` at the
centre is the zone, so a covered or off-screen control fails with what was hit instead of a
timeout on the readout. Whether this is the visual glitch the operator reported is still unknown.

**Pixels (playable.spec.ts:30).** The bitmaps were blank *before* the canvas: read straight from
each ImageBitmap in the page, ahead of `transferFromImageBitmap`, all three frames were
`[0, 0, 0, 0]`, while the PRESENTED word read 3. So this was not only the `bitmaprenderer` readback:
CI's Chromium hands the page transparent frames, consistent with render.spec.ts's THE GAP (the
device does not survive a canvas commit there) though not separately proven to be it. The test now
asserts what CI can: three 640×480 frames with serials 1, 2, 3, and PRESENTED = 3 (stored only after
a `transferFromImageBitmap` that did not throw; the worker blocks until each serial is acknowledged).
The pixel check reads the bitmap, not the canvas, and runs only with `SPIKE_CANVAS_READBACK=1`, like
render.spec.ts's canvas pixel test. **No CI test proves that the main page shows a non-blank
picture**; that needs a GPU that survives presenting, or the operator's device. Trace
`c79c53b9cdf81426fa0277e7497a69e55bc5f571` not verified by this agent; no change touches the
simulation or `wasm/render/`.

## The technical maps' citations become a check (2026-10-02, night)

**Why this and not something else.** `docs/PLAN_BREAKDOWN.md` T1 lists `scripts/check_docs.py` and
`scripts/tests/test_check_docs.py` among its deliverables, and T10's acceptance is
"`scripts/check_docs.py` green". Neither file has ever existed -- `git log --all -- scripts/check_docs.py`
is empty -- so the one plan item that was neither done, nor credential-gated, nor waiting on a device or
an operator decision was T1's own checker. The renderer was left alone on purpose: its open branch
(`render/webgpu-lighting`, PR #70) owns `wasm/render/gx_webgpu.cpp`, `web/tests/spike/render.spec.ts`
and `scripts/tests/test_em_js_bodies.py`, and it has been open since 13:42 UTC on 2026-10-02, so
priority 3 of `docs/RENDERER_MAP.md` would have put two sessions on one file. Nothing under
`wasm/`, `web/` or `native/` is touched here.

**What it checks, and what it does not.** T1 gives four machine criteria. Two of them describe the maps as
they were planned, not as they were written: "every file matched by
`port/runtime/{ppc,hle,host,gx,abi}/*.{cpp,h}` appears exactly once in RUNTIME_MAP's table" and "every
disposition cell is in the fixed vocabulary". `docs/RUNTIME_MAP.md` groups files into narrative rows
whose columns are responsibility, dependencies, Windows APIs and browser replacement, so there is no
`keep`/`shim`/`replace`/`stub`/`drop` cell to read, and the document's own header says the groups
carry their headers. Those two are recorded here instead of enforced, and a test asserts the deviation so
it cannot be mistaken for an oversight. The other two are implemented: every backticked path under
`port/`, `tools/` or `sourceport/` exists in the submodule checkout, and every `path:N` or
`path:N-M` citation is inside the file's line count.
The first is scoped to those prefixes because `docs/PLAN_BREAKDOWN.md` is a plan: it names files this
repository is meant to grow (`web/src/lobby/signaling.ts`, `.github/workflows/deploy.yml`) and shapes
that are not files (`*.iso`, `windows.h`) -- 266 of them, counted in the summary rather than checked.
The abbreviations the maps' headers define (`gx/` means `port/runtime/gx/`), a bare file name resolved
by name, and a citation to this repository's own files resolve the rest. Nothing is skipped in silence:
the summary line counts the citations read, the generated-output paths (the recompiler's
`port/generated*`), the tokens that are not source files (`mm.slippi.gg:43113`) and the paths outside
the submodule cited without a line.

**Measured, and the two defects it found.** On `main` at `8305929`, `python scripts/check_docs.py`
reads **210 citations** across the four documents and reported **2 violations**, both corrected here:
`docs/RENDERER_MAP.md:37` cited `gx_backend_dispatch.cpp:6–27` in a 25-line file (the four wrappers run
6–24), and `docs/NETCODE_MAP.md:14` cited `slippi_net.cpp:792–1097` in a 1090-line file (the matchmaking
section runs from its banner at 785 to the end of the file, 1090). Both were claims that could not be true
of the pinned upstream, which is the class this gate exists for. Locally on the VPS, with Python only
(rules 2 and 3): `python3 -m unittest discover -s scripts/tests` -- **189 tests, OK**, 1 skipped (22 new; the skipped case is the one that reads the pinned submodule, which this checkout does not have and CI does);
`python3 scripts/check_no_game_data.py --all` -- clean, 236 tracked files; `git diff --check` -- clean.
In CI on the exact head `537c5c2`: run `37071237555` (CI) **success** 1m54s, all four jobs green, and
the new step printed the same `210 citations in 4 documents, 0 violation(s)` line the local run did.
The unit-test step there reports `Ran 189 tests` / `OK` with no skip, so the case that reads the
pinned submodule is exercised in CI and skipped only in a checkout that has none.

**NOT verified.** Nothing about the renderer, the phone, the disc or the module: this change compiles
nothing and uploads nothing. The checker reads the submodule's text, so it is silent about whether the
cited lines still *say* what the map claims -- it catches a citation that cannot exist, not one that has
gone stale in meaning.

**Next step.** Unchanged, with one fewer leftover: T9 is credential-gated, T10 depends on it, and what
remains for the plan is the operator's -- O1's legal call, O2-O9's credentials, the device rows M1, M2 and
M5, and the renderer thread that PR #70 holds.

## The draw cost, split before it was cut: one encoder and one pass per frame (2026-10-02, night, `perf/draw-cost`)

The operator's iPhone 16 Pro run of `79a6fc6` (Safari, canvas, 2400 frames) was the first with a
real draw cost: in-match mean 46.3 ms (p95 109.9, p99 172.1), simulation ~3 ms of it, 1795 frames
presented of 2400, then `draw: InvalidStateError: GPUDevice.createCommandEncoder: Unable to make
command encoder.` No validation errors; texture pool and bind group cache both at 1024.

### The split, before any change

Bench: `~/incoming/phase0/draw-cost/bench2.mjs` (not committed: it runs the private core),
derived from the gpu-census bench. The CI web core of `8305929` (run 37065540768; its renderer is
byte-identical to `79a6fc6`'s) under Node against the operator's disc, with a mock WebGPU device
that counts every call by method; per-section timers spliced into the backend's EM_JS functions;
C++ by difference with a headless run. Per in-match frame, retraces 1639-2400 (762 frames):

| item, per in-match frame | calls, `8305929` | Node CPU ms (instrumented) | calls, `df8635e` |
| --- | ---: | ---: | ---: |
| `createCommandEncoder` | 1,877 | 1.63 | **1** |
| `beginRenderPass` + `end` | 1,877 + 1,877 | 6.98 with the row below | **6 + 6** |
| state + `drawIndexed` (pipeline, bind group, viewport, scissor, vertex, index, draw) | 13,119 | (above) | **2,261** |
| `finish` + `submit` | 1,877 + 1,877 | 1.47 | **1 + 1** |
| `writeBuffer` (vertices, indices, uniforms) | 5,622 calls, 6.65 MB | 2.28 | **3 calls, 3.77 MB** |
| bind group key + cache lookup | 0.86 created | 4.78 | 0.86 created |
| pipeline key + lookup | 1,874 lookups | 1.87 | same |
| `gxw_bind`, 8 per draw (sampler cache, texture pool) | 14,993 EM_JS calls | 4.07 | same |
| `writeTexture` | 0.86 calls, 11 KB | 0.01 | same |
| C++ backend (uniform rows, indices, texture decode) and EM_JS transitions | | ~8.6 | |
| **all WebGPU calls** | **28,131** | | **2,283** |
| **backend total, uninstrumented** (attached minus headless, 3 runs / 4 runs) | | **17.6** | **19.0** |

The instrumented sections add up to ~33 ms because the timers themselves cost: two clock reads
per mock call, 28k calls. They rank the items; the uninstrumented total is the number.

**What the bench cannot measure** -- and is therefore not split here:

- the time a real WebGPU call takes. On the iPhone every call is a message from the WebContent
  process to WebKit's GPU process, which then encodes Metal; the mock's calls are nearly free;
- GPU execution time, and presentation;
- JavaScriptCore against V8.

So the 42 ms are split only this far: **our own JavaScript and C++ are ~17.6 ms on the VPS**,
which is **~2.4 ms on the phone if they scale like the simulation does** (headless in-match
32.2 ms here against 4.35 ms on the phone, `d624d06`; an assumption, not a measurement). The
remaining **~40 ms are inside the 28,131 WebGPU calls per frame and/or waiting on the GPU**, in
proportions these tools cannot tell apart (if it were all calls: ~1.4 µs per call). GPU side,
unmeasured: each of the 1,877 render passes loaded and stored the whole 640x528 EFB and its
depth.

**The failure is the call volume.** In WebKit's source (main branch, read; the shipped Safari
not verified), `GPUDevice.createCommandEncoder` throws exactly this message only when
`RemoteDeviceProxy::createCommandEncoder` gets null, which it returns when the IPC send to the GPU
process fails. Every WebGPU call is such a message: ~28k per frame, 1,877 of them new encoders.

### The cut (`wasm/render/gx_webgpu.cpp`)

The biggest item by the split is the per-draw command structure, so the obvious first step was
the right one. Draws, clears and copies are recorded into **one batch**: one command encoder,
one render pass across consecutive draws, submitted at the XFB copy that ends the GX frame (and
at the end of `submit_frame`). Uniforms, vertices and indices are appended to per-batch arenas
(uniforms at a dynamic offset, 256-byte stride; vertices and indices via `baseVertex` and
`firstIndex`) and written with **one `writeBuffer` per arena** just before the submit, so no
draw of a batch overwrites another's data. Consecutive draws with identical constants share one
uniform slot (bind group or offset changes: ~329 per in-match frame for 1,874 draws). Pipeline, bind group, viewport and
scissor are sent only when they change. Whole run: encoders 2,025,740 -> 2,282, one per presented
frame plus three.

Safety rules, as code: a pooled texture named by the open (unsubmitted) batch is never evicted
(`batchSerial`; the pool may exceed its budget instead); arenas are replaced only between
batches, so the destroyed buffer is named by submitted work alone; an arena that overflows
submits its batch first, then doubles (to 16 MiB) so the next frame fits again. Measured: with
fixed 1 MiB / 256 KiB arenas each match frame overflowed into 4 submits; with growth, 1.

Memory, the price: the arenas are 1.75 MiB (uniforms) + 4 MiB (vertices) + 0.5 MiB (indices)
on the GPU after growth, the same again as JavaScript staging; 8 MiB GPU peak during a growth.
Before: 125 KB.

### Correctness, checked rather than argued

`VALIDATE=1` (`bench2.mjs`, then `bench3.mjs`): the mock keeps every buffer's bytes, applies
`writeBuffer` in queue order and executes every submitted `drawIndexed`. For each draw it checks
that the uniforms at its dynamic offset, its indices and the vertices they reach are
byte-identical to what `gxw_draw` was handed, and (`bench3.mjs`) that its pipeline, viewport,
scissor and the textures and samplers of its bind group are the ones the per-draw code would
have set; a submit naming a destroyed texture or buffer fails.

| run | draws checked | errors |
| --- | ---: | ---: |
| `8305929` (per-draw submit; the checker's own control) | 2,021,706 | 0 |
| `df8635e` (this branch) | 2,021,706 | **0** |
| broken on purpose: uniform offset forced to 0 (500 frames) | 81,994 | 81,565 |
| broken: `baseVertex` dropped (500 frames) | 81,994 | 81,565 |
| broken: pipeline set once per pass (700 frames) | 98,853 | 96,397 |
| broken: scissor set once per pass (2400 frames; it changes inside a pass only in the match) | 2,021,706 | 60,812 |
| pool limit 64, so the eviction guard is exercised: correct | 2,021,706 | **0** |
| pool limit 64, eviction guard removed | 2,021,706 | 4,572 "submit names a destroyed texture" |

At the real limit (1024) the guard is never reached in this run, so removing it alone shows
nothing; the limit-64 pair is the test that it matters. CI (`Phase 0 — WASM core`, real WebGPU in
Chromium/SwiftShader): all 42 spike tests pass, including the pixel probes, the eviction test
and `geometry 6`, which now pads one layer to 72,003 vertices so that the batch is submitted and
both arenas grow in the middle of a frame. In that same CI, 2400 synchronous selftest draws took
676 ms of worker time before and 163-180 ms after (one run each; Dawn, not WebKit).

Node CPU of our own code: **no gain**, as expected from a mock whose calls cost nothing. In-match
mean, three uninstrumented runs each, alternating: `8305929` 48.2 / 49.3 / 51.7 ms, `df8635e`
50.5 / 50.8 / 52.3 ms, headless 30.9-33.1 ms (4 runs). So ~17.6 -> ~19.0 ms: +1.5 ms, inside the
run-to-run spread (~3.5 ms) but probably real -- the uniform comparison and the arena copies. The
gain this change aims at is inside WebKit (28,131 -> 2,283 calls), which only the phone can show.

### The 1024-entry texture pool (question 4)

Yes: the 1027 live textures on the phone are the pool at its count limit (1024) plus EFB, depth
and the white fallback. It is not a leak and not thrash. Same core, `POOL_LIMIT` patched, 2400
frames:

| pool limit | live at end | bytes in pool | level-0 uploads | re-uploads of seen pixels |
| ---: | ---: | ---: | ---: | ---: |
| 64 | 64 | 2.3 MB | 136,018 | 135,537 (thrash: a frame binds up to ~164) |
| 256 | 256 | 7.6 MB | 1,773 | 1,292 |
| **1024** (current) | 1024 | 19.1 MB | 1,773 | 1,292 |
| 4096 | 1,772 (never full) | 41.0 MB | 1,773 | 1,292 |

From 256 to 4096 the work is identical: the 1,292 re-uploads are new snapshots of unchanged
bytes (a snapshot is a content; geometry 39's rule), not evictions coming back. Most of the 1024
entries are snapshots the game will not draw again, held until LRU eviction. **Raising the limit
buys nothing and costs memory. Lowering it to 256 would save ~11.5 MB here at no extra work, but
with 1.6x margin over the largest frame measured (~164); other stages and characters are
unmeasured.** Not changed in this PR: it is a separate decision.

### Also found: the main page presented on every draw (PR #84)

`web/src/play/worker.ts` treated the renderer's per-draw `heartbeat(-1)` as a completed retrace:
transfer, wait for the page's acknowledgement, then for the 60 Hz deadline -- ~1,874 times per
match frame. Separate PR, CI green; its selftest now draws, so three frames exactly is a test.

### Not verified by this agent

- **Anything on the phone**: whether the encoder failure is gone, the new frame time, whether
  2400 frames are presented with drawing to the end. The operator's run is the test.
- The trace: the bench writes it and every run here gave `c79c53b9cdf81426fa0277e7497a69e55bc5f571`
  (headless, attached, validating, both cores) -- but the reference check is the operator's.
- GPU time, before or after; WebKit's handling of dynamic offsets, `baseVertex` and 3.8 MB
  `writeBuffer`s on the device.
- The split of the ~40 ms between IPC, Metal encoding and GPU waits.
- Pictures from the real game: CI checks synthetic pixels; the bench checks bytes and state.

## The invalid-operation NaN was the engine's, and is now the reference's (2026-10-03, `ci/wasm-arm64-parity`)

**Why this and not something else.** `wasm/README.md`, "Next measurements" 2, is the arm64
comparison, and it was the one measurement still owed that needs neither a Cloudflare
credential, a phone, nor an operator decision: the peers of a netcode match are WASM engines on
different machines, and the native-vs-WASM corpus comparison says nothing about them. PR #88
built that job and its own gate came back red, because the thing it was built to look for was
there. Nothing else was touched: the renderer thread (PR #70 holds `wasm/render/gx_webgpu.cpp`)
and the operator's branch (`net/sab-ring`, with `wasm/net/sab_ring_test.c` uncommitted in the
main checkout) are left alone.

**The measurement.** Run 37097105278: one module, built once on x86, executed by Node v22.23.3
on x86_64 and on aarch64. **3,040 divergent results out of 8,000,000.** Every one of them is
class `nan-sign`, every one is an invalid operation with no NaN operand, and the first is
triple 12:

```
fmadd a=7ff0000000000000 c=0000000000000000 b=0000000000000000
      WASM-x86 fff8000000000000   WASM-arm64 7ff8000000000000
```

By input class, 3,040 of the 23,136 `inf-in` results and 0 of the other 7,976,864. By path,
228 each for the four double paths and 532 each for the four single ones -- the same class
arriving through `f25(c)`, which turns a subnormal multiplier into a zero. `0 * inf` and
`inf - inf` are the invalid operations; x86 answers them with its indefinite NaN and ARM with
its own default NaN, and the WASM specification leaves that choice to the engine.

**The fix.** `wasm/compat/fma.h` had that case parked as a policy question and said so in its
own header. It is the option `docs/OPEN_QUESTIONS.md` Q7 already records as chosen -- pin the
reference's bits -- applied to the case that was still open. `pinned(r)` returns
`0xFFF8000000000000` whenever an operation that had no NaN operand produces a NaN; with no NaN
operand a NaN result can only be an invalid operation, so the test is exact. It wraps the
zero-addend path's `x*y + z` and the `std::fma` call, and it is one compare per call.

| measured in CI | run 37097105278 | run 37101091371 |
| --- | ---: | ---: |
| WASM-x86 digest | `6b79b92a…f66afc9` | `6b79b92a…f66afc9` (unmoved) |
| WASM-arm64 digest | `ddb759d8…b86393e5` | `6b79b92a…f66afc9` (identical) |
| divergent, WASM-x86 vs WASM-arm64 | 3,040 | **0** |
| divergent, WASM vs native x86 intrinsics | 0 | 0 |

Both jobs of run 37101091371 print `GATE PASS`, and the x86 job's own table is unchanged
(`arithmetic parity (native reference): nan-vs-number=0, zero-sign=0, subnormal=0, value=0`) --
the check that the pin is a no-op where the engine already returned the reference's value.
`wasm/probe/fma_shim_test.cpp` gains eleven expectations, each set to the value the real module
produced for that triple, including the boundary this must not cross: the exact product of two
finite doubles may round to an infinity, and `fmsub(max, max, +inf)` is `-inf`, not a NaN.

**Verified without a compiler.** There is no compiler on this machine and rules 2 and 3 forbid
building here, so the screen was a model: `wasm/probe/fma_vectors.cpp`'s corpus (the
integer-only PRNG and the 24 edge values) plus `wasm/compat/fma.h`'s logic, in Python. It
reproduces the x86 dump **byte for byte** -- 0 mismatches in 8,000,000 results, and the dump's
sha256 is the published `6b79b92a…f66afc9` -- reproduces the arm64 digest `ddb759d8…b86393e5`
when the engine's NaN is the ARM default, counts exactly those 3,040 engine-NaN results, and
predicted `6b79b92a…f66afc9` for arm64 once the NaN is pinned, which is what run 37101091371
then measured. It also caught the 96-result boundary case above before CI did.

**NOT verified.** What the pin costs on the hot path: `fmadd_ns_per_op` moved 36.82 → 22.90
(x86) and 23.71 → 25.06 (arm64) across runs and runners, so these numbers resolve no cost and
none is claimed. Nothing about the phone, the disc, the renderer or the game: this change
touches a probe and the shim, not the simulation's integer state. The `Phase 0 — WASM core`
build of the same commit is the check that the real module still builds and runs with the
pinned shim.

**Next step.** The arm64 question is closed by measurement and PR #88 merges on the green
runs above. What remains is what needed the operator before this session: O1's legal call,
O2-O9's credentials, the device rows M1, M2 and M5, and the renderer thread PR #70 holds.

## The touch stick is drawn, and the controls stay with the game (2026-10-03, fix/touch-stick)

**What the operator reported.** On the phone the game reached the character select through the
on-screen controls (so touch reaches the guest), then stopped: "il pad per muoversi è invisibile",
the controls "non sempre sono ben visibili" and "di tanto in tanto sono un po buggati". Two screenshots
(title screen, character select) show the buttons and no stick at all.

**1. The stick is drawn.** It was a design decision (styles.css: "the zone *is* the control … there is
no stick to aim at") and it does not survive a real player. Each zone now draws a base and a knob
(`web/src/ui/screens/game.ts`, `paintStick`): at rest the base sits in the middle of its zone; when a
finger lands, the base moves under it — that point is the stick's neutral, as before — and the knob
follows the finger, stopping on the rim; on release both return. The base's radius *is* the
full-deflection travel (`zoneRadius`), so the rim is where the stick reads 127. The C-stick is drawn
the same way (yellow knob, "C"). Neither drawing takes pointer events, so the finger still lands on the
zone, and the PAD bytes come from the same `TouchControls.read()` as before: `view()` and `knobOffset()`
(`web/src/input/touch.ts`) are read-only, and a unit test runs the same gesture with and without the
drawing and compares the states. One stated difference between picture and input: past the rim on a
diagonal the knob stays on the circle while the bytes (clamped per axis, unchanged) go up to (127, 127);
the deadzone is not drawn.

**2. The controls stay on screen.** With the overlay on, `#game-stage` is `position: sticky` at the top of
the viewport (safe-area aware) and the page scrolls under it. The stage is capped at 60 % of the
viewport height (`max-width: 73svh`, since height = width × 60/73), or a landscape phone would be all
stage and the panels could never be reached; with the overlay off the layout is the old one. The
scroll-into-view on enabling is kept as a fallback.

**3. The intermittency — what was found, and what was not.** Not reproduced on a device; these are the
defects found in the code and visible in the two screenshots, each fixed:
- *Buttons that vanish on bright frames.* The buttons were white text on a 12 % white fill with a 35 %
  white rim, at the default overlay opacity of 0.5. On the character select's white panels that is
  white on white: in the second screenshot the buttons are barely findable. Now a dark fill inside a
  light rim with a shadowed label; an e2e test captures each control on a black and on a white canvas
  and requires the element to change the pixels (it fails on the old style for the white case).
- *An invisible C-stick between the stick and the buttons.* 18 % of the overlay's width was a C-stick
  nobody could see. A thumb aimed at the right edge of the stick or the left of the buttons landed
  there, and on the menus a C-stick does nothing visible. It is drawn now.
- *A page that pans sideways.* iOS sizes a file input to its label ("Scegli file nessun file
  selezionato"); in the first screenshot it overflows its panel past the screen edge, and in the second
  the whole page is shifted left (the title and the stage's right edge are cut). A page wider than the
  phone moves under the thumb. `input[type='file'] { max-width: 100% }`; the e2e test asserts no
  horizontal overflow at 390 px — in Chromium, whose file input is narrower, so it would not have
  caught the iOS case by itself.
- *No feedback on a press.* A missed tap and a dropped one looked the same. A held button is now drawn
  pressed (`data-pressed`).
- *Hardening, not a proven cause:* `-webkit-touch-callout: none` and `user-select: none` on the whole
  overlay (the stick zones had neither), so a long hold cannot start a selection or a callout, which on
  iOS would cancel the pointer. Not verified on a device.

**Tests.** e2e (`web/tests/e2e/touch-overlay.spec.ts`): both sticks visible, ≥ 48 px, inside their zones
and the viewport, effective opacity ≥ 0.3, and painting pixels on black and white frames; the knob under
the finger at half travel (stick_x 60–66), on the rim past it (0x7f), and back at rest on release with
neutral bytes; a held button drawn pressed; at 390×640 and 844×390, scrolled to the bottom of the page,
both sticks, A and Start inside the viewport and hit-tested as themselves, and the stick still writes
0x7f. The existing overlay tests are unchanged. Unit: `view`, `held`, `knobOffset`, and the
same-bytes-with-drawing check.

**Not verified by this agent.** Anything on the phone (that the stick is found and usable, Safari's
sticky behaviour with the URL bar, the long-press hardening, whether the operator's "buggy" is any of
the causes above); the trace `c79c53b9cdf81426fa0277e7497a69e55bc5f571` (no change touches the
simulation, `wasm/` or `web/public/sw.js` — the operator runs it). Nothing was built or run locally:
typecheck, unit and browser tests are CI's.

## The game page measures its frames, and the operator can send a report (2026-10-03, `perf/play-instrument`)

**Why this.** The operator played a real match on the phone: the game reaches the match and can be
played, but it lags, is not fluid, and every so often freezes and stutters; the menus are fluid.
PR #86 already cut the WebGPU calls from 28,131 to 2,283 per frame and is in production, and the
lag is still there. The spike page could say where a frame's time went; the game page could not
say anything, so the only measure of the lag was an impression. This change gives the game page
the spike's instrumentation and report. It changes no C++, nothing under `wasm/render/`, nothing
under `web/src/input/`, and not `web/public/sw.js`.

### What the report measures, per frame

A frame is one cycle of the play worker, from the end of one retrace's presentation to the end of
the next one's (`web/src/play/frame-meter.ts`). Five clock reads cut it into four parts that add up
to the cycle exactly:

| column | what it is |
| --- | --- |
| `core_ms` | `callMain` from the end of the last presentation to the next retrace beat: simulation, GX decoding, the backend's JS and C++, every WebGPU call |
| `webgpu_ms`, `webgpu_calls` | inside `core_ms`: time inside WebGPU calls, read around each call, and their number; split into `resources_ms` (create/destroy), `encode_ms` (encoder and pass), `queue_ms` (writeBuffer/writeTexture/submit), `present_ms` (getCurrentTexture) |
| `disc_ms`, `disc_bytes` | inside `core_ms`: WORKERFS reads of the disc |
| `decode_ms`, `non_decode_ms` | inside `core_ms`, only with **core split** on: the core's own profiler (patch 0008), GX decoding against everything else |
| `bitmap_ms` | `OffscreenCanvas.transferToImageBitmap` |
| `ack_ms` | posting the frame and waiting for the page to present it |
| `idle_ms` | the 60 Hz pacing wait: time left over |
| `draws`, `created`, `pipelines_created` | renderer draw beats; GPU objects created, render pipelines among them |
| `match_frame`, `hidden` | from `--sim-times` (the spike's definition of in-match); a frame that waited on a hidden page |

The WebGPU calls are timed from JavaScript, by replacing the methods of the device, queue, canvas
context and of the encoders, passes, textures and buffers the device returns with timed calls of
the originals (same `this`, arguments, results and exceptions). The backend in `wasm/render/` is
not edited. Calls made while the backend attaches, before the first frame, are not counted.

### Freezes, slow frames, and a record that survives the tab

- **Flight recorder.** Six words of shared memory: the last completed frame, what the worker is
  doing right now (`core`, `webgpu <method>`, `disc`, `bitmap`, `ack`, `idle`) and the draws so far
  in this frame. A frozen worker cannot post, but the page reads these on every animation frame.
- **Freezes**: no new frame for 250 ms with the page visible. Each one records the frame it is stuck
  in, when, how long, the draws it had reached, and a histogram of what the worker was doing at
  each sample -- e.g. `webgpu device.createRenderPipeline`, or `ack` when it was the page that did
  not answer. The live line under the game says `FROZEN in frame N` while it lasts.
- **Slow frames**: 50 ms or more. Each gets a one-line motive -- its largest part, the three slowest
  WebGPU methods in it, pipelines created, disc bytes read -- and the 200 worst are kept.
- **Sampled phases**: the same flight recorder, sampled at ~60 Hz for the whole session: a
  statistical profile that does not depend on the timer resolution.
- **Persisted record**: every 2 s the page writes the spike's heartbeat record
  (`melee-spike-heartbeat/1`, under its own key `melee-play-heartbeat`) with a compact frame
  summary. A tab that is killed mid-match leaves it; the next visit to the Game screen shows it and
  **Save report** sends it as `melee-play-partial/1`, until Play is pressed again.

### The report's form

`melee-play-report/1` reuses the spike's pieces rather than inventing a second form:
`simTimeStats` for every column (count, mean, p95, p99, max, nearest-rank), `stats_all` /
`stats_in_match` over the core's sim_times rows, the heartbeat record (`heartbeat.ts`) and, with the
core split, `decoderCostReport`. On top: `summary.{all,in_match}` (fps, percent of the time in each
part, frames over 20/33/50/100/250/1000 ms, the meter's estimated own cost), `webgpu_methods`
(calls, ms and the longest single call of every method, all frames and in-match), `slow_frames`,
`freezes`, `sampled_phases`, `page_transfer_ms`, `frames_csv` (the last 36,000 frames) and
`not_measured`. **Save report** downloads it; **Share report** opens the share sheet where the
browser can share files and downloads otherwise.

### What it cannot measure (also written into every report, `not_measured`)

- The GPU process and the GPU after a call has returned. On WebKit each call is an IPC message;
  `webgpu_ms` is only the synchronous send. Metal encoding and GPU execution show up only where a
  later synchronous call has to wait for them (`queue.submit`, `getCurrentTexture`, `bitmap_ms`).
- GPU completion and GPU time: `callMain` never yields, so `onSubmittedWorkDone`, `mapAsync` and
  timestamp queries cannot resolve during the game.
- Simulation against drawing inside `core_ms` without the core split: then `core_ms - webgpu_ms -
  disc_ms` is the simulation and our renderer code together. With it, the profiler's own clock
  reads add time (they cost ~3.4 ms per frame on the iPhone before PR #71, measured then).
- Garbage collection, which lands in whichever part was running.
- Calls shorter than the timer resolution (reported as `timer_resolution_ms`).
- The meter's own cost, about `2 x webgpu_calls x clock_cost_ns` per frame, inside `core_ms`.
- When a presented bitmap reaches the screen (the compositor).

### Step 3: the biggest item is not known yet, and why

There is no phone measurement of the game page in this session, so nothing was optimised: picking
a target now would be the hypothesis the task rules out. What the earlier numbers already say is
that the spike's iPhone frame was ~42 ms of which our own code was ~2.4 ms (an estimate, see the
draw-cost section) and the rest was **inside the WebGPU calls or waiting on the GPU, in proportions
no tool here could split**. The report is built to split exactly that:

| if the report says | then |
| --- | --- |
| `webgpu_ms` dominates, spread over `encode_ms` / `queue_ms` | per-call cost in WebKit: fewer calls -- the renderer's task (`wasm/render/`, another agent) |
| `bitmap_ms` or `present_ms` dominates | the worker waits for the GPU / GPU process: GPU-side work (6 render passes per match frame since PR #86, each loading and storing the EFB; texture uploads) or the presentation path |
| `ack_ms` dominates | the page's main thread is late to present: page-side work (the touch overlay repaints on every pointer event, PR #89) |
| `core_ms - webgpu_ms - disc_ms` dominates | simulation or our renderer code: run a second match with **core split** on |
| slow frames name `device.createRenderPipeline` / `createShaderModule` | pipeline compilation stutter: compile pipelines ahead of use (renderer) |
| freezes in `disc` | synchronous disc reads mid-match |

### Step 4: the intermittent freezes

**Not reproduced.** There is no device here and the disc cannot run in CI. The report now records
each freeze with its frame and what the worker was doing; the next report from the phone is the
measurement.

### What the operator does

1. Game → Play, play a match as before.
2. **Save report** (or **Share report**) and send the JSON.
3. If the report says `core_ms - webgpu_ms - disc_ms` is large: tick **core split** and play a
   second match; send that report too.
4. If the tab dies: open the Game screen again and press **Save report** before Play.

### Verified

- `ci.yml` dispatched on this branch (`gh workflow run ci.yml --ref perf/play-instrument`), run
  `37107061668`: all four jobs green; typecheck; **342 unit tests**, including 21 new ones
  (`web/tests/unit/play-meter.test.ts`, `play-report.test.ts`) that check the partition sums to the
  cycle, that wrapped calls keep `this`/arguments/results/exceptions and restore the flight
  recorder's phase when they throw, the CSV tail, the motive text, freeze detection (and that boot
  and a hidden page are not freezes), the persisted record under its own key; and the Chromium
  e2e suite. The first dispatch (`37106999704`) failed typecheck on a test fake (`submit` without
  its argument), fixed in the next commit.
- `web/tests/spike/playable.spec.ts` now also downloads the report after the three real-core
  selftest frames and checks frames 1-3, three draws each, nine `pass.drawIndexed`, and the
  partition. It runs in `Phase 0 — WASM core` on the pull request.
- `scripts/check_no_game_data.py --all`: clean. PR #89 (`fix/touch-stick`) landed on `main` while
  this was open; `main` is merged into this branch, and `web/src/ui/screens/game.ts` merged without
  a conflict (only this file's own section of `docs/PROGRESS.md` had to be placed after #89's).

### NOT verified by this agent

- **Anything on the phone**: the report's numbers, the meter's overhead on JavaScriptCore
  (~2,300 timed calls per frame: two clock reads and a few typed-array writes each), whether
  Safari's share sheet accepts the JSON file, whether the frame rate changes with the meter on.
- **The trace** `c79c53b9cdf81426fa0277e7497a69e55bc5f571`: not run by this agent. The spike's
  scripted run is unchanged in its arguments; the spike worker only had two helpers moved out
  (`timerResolutionMs` to `spike/clock.ts`, `renderProgress` to `spike/gpu.ts`). The play worker
  now passes `--sim-times`, which reads the scene words and writes no guest state
  (`native/headless_host.cpp`, `record_sim_time` / `current_scene`).
- The core split in a live game: `_melee_decoder_cost(1)` and the incremental read of
  `/work/decoder_cost.csv` have only the selftest path in CI, which runs no simulation, so CI does
  not exercise them; that file grows ~250 bytes per frame in MEMFS while the split is on.
- `--sim-times` and the disc-read meter in a real game: same reason, no disc in CI.
- Long sessions: the page keeps 36,000 frame rows; the statistics spread up to 36,000 values into
  `Math.max`, below JavaScriptCore's argument limit as far as known, not measured.

**Next step.** The operator's report from a match. Then the biggest item it names, per the table
above; if it is inside WebGPU or the GPU, that goes to the renderer's agent with the numbers.

## Transparent pixels stop being drawn: GX alpha test and blending in WebGPU (2026-10-03, `fix/font-alpha`)

**Symptom.** On the phone, magenta blocks behind the memory-card text, a white box around the title
logo, black boxes behind the copyright lines, and labels on the 1-P character select broken in shape
("RY EA" for "VERY EASY", LEVEL / STOCK / OPTION cut up).

**Cause, of the three hypotheses: the first, and it covers the shape corruption too.** No WebGPU
pipeline had blend state and the fragment shader never read alpha (`gxw_draw` in
`wasm/render/gx_webgpu.cpp`): every fragment was written opaque, including what the game draws to be
discarded (alpha test) or faint (blend). The texture decoder (hypothesis 2) is not involved: the
memory-card font is I4, decoded R=G=B=A with a transparent-black background, as GX defines it; the
magenta is in no texture at all, it is the vertex colour (252,14,253, alpha 68) of an untextured
quad whose TEV does not even use it (colour from KONST, alpha from register A0).

**How it was shown** (VPS, not CI: it runs the private core against the disc). A CPU replay of the
web core's WebGPU calls (`~/incoming/phase0/font-alpha/raster.mjs`, not committed, derived from the
draw-cost bench) executes every submitted clear, copy and draw -- pipeline, uniforms, textures,
samplers, viewport, scissor, depth -- and writes the XFB as PNG; the shaders are transcribed, not run.
- With the shipped core it reproduces both phone photos (memory card at retrace 100, title at 600,
  1-P Classic select at 1700 with `classic.txt`).
- With this branch's core (run 37108849528) the glyph backgrounds, the logo box and the copyright
  boxes are gone and every label has its shape (LEVEL, VERY EASY, STOCK, OPTION, HIGH SCORE).
- The same core with the replay told to ignore only the blend / alpha-test / write-mask state gives
  frames **byte-identical** to the shipped core's (md5 of retrace 100 and 1700). So the shape
  corruption has the same cause; the label area is covered by untextured blended draws
  (SRC_ALPHA / INV_SRC_ALPHA) that were written opaque.
- The simulation trace is identical across the three runs (1701 retraces of `classic.txt`,
  `976a31d8…`).

**Change.** `gxw_draw` receives the draw's BP register file. ALPHACOMPARE becomes a `discard` in the
fragment shader (two comparisons against references in a new uniform row 105, AND/OR/XOR/XNOR, an
always-passing test generates nothing); BLENDMODE becomes the blend factors, subtract and the
colour/alpha write mask, with destination alpha read as 1 when the EFB format has none -- Dolphin's
AlphaTest / BlendingState, as upstream's `gx_shader.cpp` and `gx_d3d12.cpp`. The pipeline key grows
by those bits. In 4,602 replayed menu draws: 7 use a logic op alone, all COPY (a plain write); none
uses subtract, colour update off, or early depth with a live alpha test and depth writes -- the
three things this does not implement (with dither and destination constant alpha).

**Test.** `wasm/render/alpha_blend_check.mjs`, run by `phase0-build.yml` after the spike tests, reads
back geometry 40-44 of `gx_webgpu_selftest` on CI Chromium's WebGPU: a magenta RGB5A3 texture at
alpha 0 behind a GREATER 0 test, under SRC_ALPHA blending, at alpha 146 blended once
([160,55,228,193]), at alpha 146 behind GREATER 200, and opaque with colour update off. A backend that
ignores alpha draws magenta in all five; geometry 15 (the same texture opaque) must still draw it.
Run 37108849528: 6/6, and the 42 spike tests pass with the fixtures' new GXInit state (a zeroed BP
means "alpha test never passes"). The check lives outside `web/` because PR #90 was changing `web/`;
the cases can move into `render.spec.ts` as they are.

**Still wrong on screen, a separate defect: colour.** The shader is `vertex colour x texture 0`; the
game's TEV computes colour from KONST and the colour registers (memory-card dialog and text, the
full-screen quad is KONST black but drawn white, the title's ray background, the faint "Handicap"
labels). Now that alpha is honoured, the memory-card frame shows a light pink tint where the magenta
quad blends at alpha 68: on the console that quad's colour is KONST, not magenta. That is the TEV
(RENDERER_MAP priority, "full TEV remains open"), not this change.

**Not verified by this agent.** The phone; the canvas path on a real GPU (CI reads back an offscreen
texture only); the trace `c79c53b9cdf81426fa0277e7497a69e55bc5f571` with `parity_vs_onett.txt` (the
operator runs it; this change touches no simulation code); the character nameplate ("Ma|io") was
not on screen in the replayed frames. Nothing was built locally.

## The EM_JS traps are checked in seconds, not by a build (2026-10-03, `ci/em-js-body-guard`)

**What.** `scripts/tests/test_em_js_bodies.py` (new) reads every `EM_JS` body in
`wasm/render/gx_webgpu.cpp` and models the two lexers that meet there. `EM_JS` stringifies its
body and the preprocessor lexes that text first, so a `//` written inside a template literal is
a C comment: the emitted JavaScript loses the rest of that line, and when what it loses is the
text that closes a literal, an interpolation or a call, the body never parses. The other
direction -- a `//` written through a string literal, `${"// ..."}` -- survives preprocessing and
is emitted into the shader text, where stringification has already turned the body's newlines
into spaces, so it swallows the rest of its WGSL line. The guard checks both: the text
JavaScript receives must still close, and no comment may reach the shader text through a string
literal. The deliberate form is a bare `//` at the start of a line of generated WGSL, which the
preprocessor strips; both live instances in `gxw_draw` (the viewport comment and the alpha-test
comment) use it and pass.

**Why it is worth a file.** Each trap cost a full WASM build to find (runs `37014818279` and
`37038473832`), and neither is visible to any check that runs after the build. The hygiene job
now reads them in seconds.

**Measured, with no compiler** (rules 2 and 3). 9 tests, OK against `main`'s file; the same
guard fails on `render/webgpu-lighting`'s unmerged file (line 147, `${"// Emulate the D3D
viewport in clip space."}`) and passes on that branch's local fix `81681f4`, so the guard and the
renderer thread's own conclusion agree. `python3 -m unittest discover -s scripts/tests` -> Ran
203 tests, OK; `python3 scripts/check_no_game_data.py --all` clean; the deploy guards hold. In
CI: run `37116934962` on `463c93f`, all four jobs green (CI, 1m19s), the hygiene job running the
same 203 tests. It costs no core build: `phase0-build.yml`'s paths do not include
`scripts/tests/`.

**Not covered.** The guard is a model of two lexers, not a compiler: regular-expression literals
are not modelled, a `//` that reaches the shader by concatenation is not detected, and it says
nothing about whether the emitted WGSL is valid. It reads one file, listed in `SOURCES`.

**Next step.** Unchanged, and one leftover shorter. The plan's autonomous work is the renderer's,
and its open thread is PR #70 (`render/webgpu-lighting`, conflicting with `main` since the
alpha/blend merge, with an unpushed version of this same guard file in its worktree). The alpha
fix (PR #91) names the next on-screen defect: the TEV colour (RENDERER_MAP priority 3, "full TEV
remains open"). What remains beyond that still needs the operator: O1's legal call, O2-O9's
credentials, and the device rows M1, M2 and M5.

## Disc stalls: the one-second read is WebKit's worker run loop, and the game stops entering it (2026-10-03, `fix/disc-stalls`)

**The defect, in the operator's three iPhone reports** (iOS 18.7, Safari 27; cores `612a856` and
`b5b3385`). `scripts/analysis/disc_stalls.py` (new) reads them: **31 frames** have disc reads of
250 ms or more, and every one is between **1002.7 and 1046.9 ms**, whatever the size (1,055 bytes in
28 of them, 46,749, 196,031 and 186,719 in the other three). It is a fixed cost, not a slow transfer.
Every one of the 31 came after **2.06 s or more** with no disc read; of the **1,479** reading frames
whose previous read was under a second earlier, **none** took over 63.4 ms. In a match every stall is
the same read, every ~107 retraces.

**What that read is.** The play page's own core, run in Node on the VPS (headless, the operator's
disc, `parity_vs_onett.txt`; harness `~/incoming/phase0/disc-stalls/readlog.mjs`, not committed: it
runs the private core), logging every WORKERFS read and mapping it to the FST. In a match the core
reads one file only: the stage music stream (`onetto.hps` on Onett). Every ~107 retraces it reads a
**32-byte block header** and then ~64 KiB over the next four frames. Through musl's stdio a 32-byte
`fread` is a 31-byte read plus a 1,024-byte buffer fill: the **1,055 bytes** of the reports. In the
menus the same shape is `menu01.hps` and the `.ssm` sound banks. The music plays with `--volume 0`:
the stream advances whatever the volume.

**Hypotheses, as the evidence sorts them.**
- *A network fetch where OPFS was expected*: no. The play page's disc is the `File` from the OPFS
  cache (`DiscCache.downloadDisc` → `getFile()`), mounted with WORKERFS; `/phase0/disc` is only
  fetched to fill that cache, and the asset layer (`web/src/assets/`) is not used by the play page.
- *Decompression or decryption*: no. `disc_read` (native/headless_host.cpp) is `fseeko` + `fread` on
  the raw image; the ADPCM decode is the game's, inside `core_ms`, not `disc_ms`.
- *A blocking write*: no. The meter wraps WORKERFS's `stream_ops.read` only; the core's writes go to
  MEMFS (`/work`, `/card`).
- *A synchronous read on the hot path*: yes, and the second comes from WebKit. WORKERFS reads each
  slice with `FileReaderSync`; WebKit runs that as a synchronous blob load, spinning the worker's run
  loop (`WorkerDedicatedRunLoop::runInMode`) until it completes. Since WebKit **302518@main**
  (commit `7b65bcf29a`, 2025-11-04, "Work around CF timers not being serviced promptly",
  rdar://154763428), when a CFRunLoop timer of the thread is overdue by **more than one second**,
  `runInMode` calls `CFRunLoopRunInMode(kCFRunLoopDefaultMode, 1, returnAfterSourceHandled=true)`.
  A timer firing is not a source, so the call waits out the full second. The play worker never
  returns to its run loop while `callMain` runs: its timers are serviced only inside these reads.
  Reads less than a second apart service them before they are a second overdue (0 stalls in 1,479);
  after a gap of 2 s or more, whether one is overdue depends on when a timer fell due in the gap:
  31 of those 48 reads stalled. In a match the gap is 3.5-10 s (one header every ~107 retraces at
  11-13 fps): 6 of 6 in-match headers stalled in the first report, 8 of 10 in the second (the two
  that did not came under a second after the stall at retrace 2048), 4 of 7 in the third,
  alternating. The source was read on WebKit `main` (2026-10-02); that
  Safari 27 ships this code is inferred from the date and from the measured 1.00 s, not read from
  Apple's build.

**The change.** `web/src/play/disc-reader.ts` (new): before `callMain`, the play worker opens the
cached disc's OPFS file with `createSyncAccessHandle()` and routes WORKERFS's reads of that one file
to `handle.read(view, { at })`, straight into the wasm heap. WebKit implements that read as a seek
and a read on a file handle the worker holds (`FileSystemSyncAccessHandle::read`): no blob load, no
run loop. The meter (`meterDiscReads`) is installed after it and wraps it, so `disc_ms`/`disc_bytes`
are the same measure before and after. `session.ts` passes the cache identity
(`DiscCache.cacheId()`). A picked disc has no handle and keeps `FileReaderSync`; so does a cached
disc whose handle cannot be opened (another tab holding it, say). Either way the report's `notes`
say which path was used (`disc read through an OPFS sync access handle`, or `disc read with
FileReaderSync: <reason>`). A short read throws with the offset, so the game stops and says so.

**Memory.** Nothing is cached. The handle reads into the heap the core already allocated, so the
per-read `ArrayBuffer` that `FileReaderSync` made is gone too.

**Measured here** (Node only, no browser). The real web core, `parity_vs_onett.txt`, 2400
retraces, with `--state-trace` (`~/incoming/phase0/disc-stalls/route.mjs`, which imports the real
`disc-reader.ts` and `frame-meter.ts` with `--experimental-transform-types`). WORKERFS as shipped:
trace SHA-1 `c79c53b9…`, 2,162 reads, 2,162 `FileReaderSync` calls. Through the handle: trace
`c79c53b9…`, 2,162 reads, **0** `FileReaderSync` calls after the mount, and the SHA-256 of every
(position, length, bytes) the core received is the same in both runs (`5dd4fb1e…`). Unit tests:
`web/tests/unit/disc-reader.test.ts` (routing, end of disc, short read, size check, the meter
wrapping it, names agreeing with `opfs-worker.ts`) and `scripts/tests/test_disc_stalls.py`. In CI: run
`37121870236` on `602bcba`, all four jobs green: typecheck, the 8 `disc-reader` tests among 31 test
files, the build, 207 hygiene tests, and the Chromium browser tests. No core build: the change is
outside `phase0-build.yml`'s paths.

**Not reproduced in CI, and why.** The one-second block exists only where WebKit uses CF
(`#if USE(CF)`: Apple platforms). CI's browsers are Chromium and Linux WebKit (GLib), and Node has
no `FileReaderSync` at all; a test there would pass with or without this change. The measure is the
operator's report: `python3 scripts/analysis/disc_stalls.py <report.json>` exits 1 on any disc read
of 250 ms or more and prints which path the worker used.

**Not verified by this agent.** The phone: whether the stalls are gone (expected: `disc_stalls.py`
exits 0 and the report's `notes` name the OPFS handle). That `createSyncAccessHandle()` opens in the
play worker on iOS right after the store worker is closed: no Web Lock is taken, and a second tab
playing would hold the handle (the worker then falls back, with a note). The trace
`c79c53b9cdf81426fa0277e7497a69e55bc5f571` through the operator's own procedure: only the Node run
above. Not addressed: the spike page (`web/src/spike/worker.ts`) still reads with `FileReaderSync`;
the other synchronous entries into the worker's run loop, of which the play worker has none while
the game runs. Nothing was built locally.

### The handle the play worker holds, and pressing Play again (same branch, second pass)

**Re-checked, not re-derived.** The three reports, through `disc_stalls.py` again: 31 stalls, all
1002.7-1046.9 ms, all after a gap of 2.06 s or more; 0 of the 1,485 reading frames with a gap under
2 s took over 63.4 ms. WebKit `7b65bcf29a` read through the GitHub API: the diff is the
`CFRunLoopRunInMode(kCFRunLoopDefaultMode, timeout <= -1 ? 1 : 0, returnAfterSourceHandled=true)`
described above. `FileSystemSyncAccessHandle::read` on WebKit `main` is `m_file.seek` +
`m_file.read` on the worker thread, with no run loop; it takes a `BufferSource`, not an
`AllowSharedBufferSource`, which is fine because the core's memory is not shared (no `-pthread`,
`wasm/core/CMakeLists.txt`).

**The regression the first pass introduced.** The play worker now holds an exclusive sync access
handle on the cached disc for the whole game. Stopping a game terminates the worker; the platform
releases the handle afterwards. Pressing Play again runs `DiscCache.downloadDisc`, whose first
store call on a complete cache is `length()`, which opens a sync access handle on the same file. On
WebKit a held file is refused with `InvalidStateError` (`FileSystemStorageHandle::createSyncAccessHandle`:
`acquireLockForFile` fails), on Chromium with `NoModificationAllowedError`; either way the game
would not start, where before this branch it did.

**Measured in CI, Chromium** (`web/tests/e2e/opfs-handoff.spec.ts`: one worker takes the handle and
spins forever, as the play worker does inside `callMain`; the page terminates it; a second worker
tries to open the file every 25 ms). Run 37122663499 (a first version that retried for 3.15 s): six
refusals, opened at 3,156 ms, on the last attempt. Run 37122843727 (25 ms polling, three runs):
released at **2,011, 2,009 and 2,019 ms** after `terminate()`, 79 `NoModificationAllowedError` each;
a handle that was `close()`d is free at once (13 ms, 0 refusals). The 2 s is Blink's
`kForcibleTerminationDelay` (`worker_thread.cc`): a busy worker is only forced to stop after it.

**The change.** `web/src/spike/sync-handle.ts` (new): `openSyncHandle` retries those two refusals,
at 50, 100, 200 ms and then every 250 ms, for up to `HANDOFF_BUDGET_MS` = 10 s (five times the
Chromium release), then throws "held by another sync access handle, still after 10000 ms" with the
platform's error as `cause`. The store worker (`opfs-worker.ts`, every operation) and the play
worker's own open (`disc-reader.ts`) use it. Any other error passes at once. The browser test fails
if the release takes more than half the budget. Unit tests: `sync-handle.test.ts`, one new case in
`opfs-worker.test.ts` (fake file held for two attempts, then for ever), one in `disc-reader.test.ts`.

**Not verified.** How long WebKit on iOS takes to release the handle of a terminated busy worker:
the browser test is Chromium only. If it is over 10 s, Play again fails with the message above
instead of starting. A game in a second tab still holds the file: that tab's Play now fails after
10 s with that message (before this branch both tabs could play).
## 2026-10-03 — Core budget decision, no implementation

Analysis on `perf/core-budget`, base `029f41d`, in [CORE_BUDGET_DECISION.md](CORE_BUDGET_DECISION.md).
Recomputed the three operator play reports from their raw CSVs: all in-match means agree with
summaries. The internal split excludes a measured 15.991–23.950 ms/frame residual included in the
page's core timer. Backend submission belongs to decode/end-frame (14.648 ms in the split report),
not non-decode. Queue calls are absent from all method tables despite submissions in the code;
API totals therefore need coverage verification before a GPU conclusion.

Decision: first propose attribution of the timer residual and queue coverage; first renderer
candidate is preparing state once per DrawCall instead of per segment. Savings are conditional
scenarios, not device measurements; no evidence yet for 60 fps with four players. No source edits,
local builds/tests, game execution, or game data added; the concurrent TEV file was only read.
Next: review the decision with the operator and choose one experiment. Every implementation must
retain the 2400-checkpoint trace, verify rendering separately, and win on the operator's phone.

## 2026-10-03 — residual attribution instrumentation

Branch `perf/attribute-residual`: added retrace-tagged native CSV duration, previous
callback tail and heartbeat read/finish intervals without moving external clocks.
Reports retain existing fields and explicitly summarize matched signed/absolute
residuals. Queue prototype coverage and a pre-game known submission expose counts,
times and validation status. Details: [ATTRIBUTE_RESIDUAL](ATTRIBUTE_RESIDUAL.md).
No renderer changes or optimizations. Actions/page verification pending; phone live
residual and the 2400-checkpoint replay need operator evidence / runner disc access.

## 2026-10-03 — the CI checkpoint replay is exercised: parity no longer needs the operator

`ci.yml` gained an opt-in `checkpoint_build_run` input in `dd19661` (PR #97): it replays the 2400
checkpoints on a runner against the private R2 disc, and had never been dispatched. It has now
been: run `37148808325` on `main` (`9e9b6e73`), `checkpoint_build_run=37144772311` (the private
`melee-core-wasm-node` artifact of `dd19661`), **success**, five jobs, 1m50s in total, the replay
job 106 s of it. From the job log: the disc came from R2 in 27 s and verified as 1,459,978,240
bytes, SHA-1 `d4e70c064cc714ba8400a849cf299dbd1aa326fc`; the replay took 41 s, 2401 rows, trace
SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`, `final scene: mode=2 state=2 match_frame=762
(retraces=2400)`; the artifact's source tree and `main`'s agree under `native wasm patches upstream
web/src`. Details, and the two dispatches that use it: [ATTRIBUTE_RESIDUAL](ATTRIBUTE_RESIDUAL.md),
"The gate is exercised".

**What it unblocks.** The trace was the one item in nearly every renderer entry of this file that
could not be closed without the operator. It can now be closed in CI, in about two minutes of
runner time, for any branch whose compiled tree matches a successful `phase0-build` run that
uploaded the private Node artifact. The phone rows are unaffected: the gate replays Node, not
Safari.

**Next step.** The first candidate that needs it is `render/webgpu-lighting` (PR #70), open since
2026-10-02 and `CONFLICTING` with `main`; its rebase waits for `fix/tev-colour` to land, because
that branch's `wasm/render/gx_wgsl.cpp` header states that the lights themselves are PR #70's.

## The TEV is generated: name tags, menu colours, and what the stage's shadow pass needed (2026-10-03, `fix/tev-colour`)

**Symptom.** On the phone, in a match, a white rectangle where each player's name tag ("P1", "P2")
should be, with a white triangle under it; in the menus, the 1-P layers drawn washed out (a
magenta cast on the memory-card dialog, white where Melee is dark blue).

**Cause, of the two hypotheses: the TEV; the palette textures are not involved.** The fragment
shader was `vertex colour x texture 0` (PR #91 said so). The CPU replay's per-draw state shows the
tag as three draws: a plate with colour KONST (50,0,0) and alpha from register C0 = 0 (invisible on
the console), drawn opaque white because the vertex colour is white; and the "P1" glyphs and the
triangle, KONST (242,89,89) x an IA4 texture, drawn white for the same reason (P2: KONST
(101,101,255)). On the 1-P select, the backdrop is untextured blended quads whose colour is KONST
blues and purples (0,11,26; 53,14,135; 128,179,255) with alpha A0, a full-screen one included: all
drawn opaque white. None of these draws reads a CI4/CI8 texture (they are untextured, IA4 or I4).

**Change.** `wasm/render/gx_wgsl.cpp` generates the WGSL in C++, once per shader uid, as a
transcription of upstream's `gx_shader.cpp`: every TEV stage on signed integers (the four inputs,
bias, add/subtract, scale, clamp or the 11-bit range, the compare modes, the four output registers
and the overflow wrap), the ras and texture swap tables, konst selections, each stage's texture
map and coordinate; the alpha test on the TEV alpha; fog; texgens with the dual post-transform;
colour channels from the vertex or the material register. Generating in C++ keeps the shader text
out of the EM_JS lexer traps; `gxw_draw` receives the shader's id and, the first time, its WGSL.
Uniforms become variable-size slots of the rows each shader reads (122 + 3 per texgen, 2048 bytes
for a one-texgen draw, was 1792 for all). Two findings on the way:
- Fog's A and C are 11-bit-mantissa floats with the sign in bit 19 (Dolphin's FogParam0/3);
  upstream's `f11` reads bit 20, the projection bit of FogParam3. Probe 48 tells them apart.
- With the TEV honoured, Onett's roofs went black: their stages multiply by the fighters' shadow
  texture, which the game renders and copies out of the EFB. Two things were missing. The copy
  itself: colour copies to RAM are now kept as GPU textures sampled at their guest address, as
  upstream's `execute_copy` / `get_texture` (no format conversion, no half-scale downscale). And
  the shadow pass's white backdrop quad: it lies 1.8e-8 beyond the near plane and was clipped;
  the vertex shader now scales depth by 1 - 1e-7, Dolphin's `VertexShaderGen` for a host without
  depth clamping. Probes 50 and 51.

**How it was shown** (VPS, `~/incoming/phase0/tev/`, not committed: it runs the private core
against the disc). The replay of PR #91 (`raster-tev.mjs`) now shades a TEV-branch core with
`tev-eval.mjs`, a CPU model of the generated shaders that reads each draw's BP/XF registers and its
real uniform rows. Before = the core of run 37108849528 (`main`'s renderer); after = run
37148896688 (`8d62c9c`).
- Name tags, boxes around the tag draws, retraces 1700-2300 (`parity_vs_onett.txt`, every 100):
  P1 white 53.0% -> 0.0%, red 0.0% -> 22.3%; P2 white 56.4% -> 2.7% (the white house behind it),
  blue 0.0% -> 26.3%. Identical at all seven retraces.
- Menus (`classic.txt`), share of near-white pixels: 1-P select (retrace 1700) 55.4% -> 0.4%;
  1-P menu (1000) 13.4% -> 0.0%; title (600) 24.3% -> 2.0%; memory card (300) 81.1% -> 2.4%,
  and its pink/magenta pixels (R and B 40 and 25 above G) 7.9% -> 0.0%.
- The phone's own screenshot of the select has no magenta-tinted pixel in the 1-P panel (0 with
  R and B 6 above G): what it shows is the white the replay reproduces; the cast the replay finds
  is the memory-card one, from the same cause (a quad whose TEV colour is KONST, drawn with its
  magenta vertex colour).
- The simulation trace with the backend attached: 2400 checkpoints, `c79c53b9cdf81426fa0277e7497a69e55bc5f571`,
  before and after.
- Cost: 83 shaders and 112 pipelines in 2400 match retraces, 42 / 52 on the menu path; 1,755 EFB
  copy textures (about one per frame) bound 161,460 times.

**Test.** `wasm/render/pixel_pipeline_check.mjs` (was `alpha_blend_check.mjs`), run by
`phase0-build.yml`, reads the self-test's probes back off CI Chromium's WebGPU. New: 45 the tag
plate (KONST colour, C0 alpha, blended) [137,108,140,191]; 46 its glyphs (KONST x I8, A0 x TEXA)
[122,45,45,128]; 47 two stages through an unclamped register with a swap table, a scale, a
subtraction and per-component compares [23,0,0,223]; 48 fog [84,152,56,192]; 49 192
pseudo-random register states that must all compile; 50 an EFB copy sampled by a later draw; 51 a
triangle one float beyond the near plane. Values computed by hand and, separately, by
`tev-eval.mjs`. The fixtures get the MODULATE state a textured draw sets (a zeroed TEV outputs
PREV: black); `render.spec.ts`'s probe 30 becomes [65,32,16,96], GX's integer MODULATE
((128 x 129 + 128) >> 8) where a float product gave 64. Runs 37143981923, 37146343733,
37148896688: 42 spike tests and every probe green.

**Not done, and what happens instead.**
- Lighting: a lit channel gets its material colour. Every lit draw measured has a white material,
  which is what was drawn before; the lights are PR #70's, which now has to rebase onto the C++
  generator. The title logo's chrome (an environment-mapped reflection) is the visible case.
- Indirect texturing (no measured draw uses it), the texture coordinate scale registers, Z
  textures, dither. EFB copies: no format conversion (intensity copies keep RGB), no downscale,
  depth copies not kept.
- The replay is not a GPU: level-0 sampling, its own transcription of the shader (CI's probes are
  what check the WGSL). Found on the way: the replay's alpha-test emulation for PR #91 parsed a
  `// alpha test:` marker the preprocessor strips from the EM_JS body, so it never ran there.
- Not verified by this agent: the phone (the user's eye is the verdict on colour), the canvas
  path on a real GPU, and iPhone pipeline compile time for the larger shaders.


### 2026-10-04 — finite TEV schedule candidate (fix/lit-tev-flow)

Read/printed the original WGSL: all four loops terminate; TEV count is 1..16,
not zero or unbounded. Prior constant-stages and no-continue probes also stalled.
`docs/LIT_TEV_FLOW.md` records the evidence and its limits. Candidate change:
expand only the TEV loop into 16 uniform-guarded blocks, retaining the one shader
and lit channels. No harness changes. One Actions build/harness cycle pending,
followed by the unchanged private replay only if the build passes. No merge.
