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
