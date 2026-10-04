# Phase 0 task breakdown

Written 2026-09-30 against upstream pin `3aab7172db243c159afa76ecb2c564b3de8e4c0a`. Upstream
paths are relative to `upstream/melee-unlocked/`; paths starting with `docs/`, `wasm/`,
`web/`, `scripts/`, `patches/` or `.github/` are in this repository. Where a fact could not be
established from the tree, it says "unknown".

## 1. What Phase 0 is for

Phase 0 answers one question (`docs/SPEC_PIANO.md`, "Fase 0"): does the game's simulation,
with no graphics, run in a mid-range phone's browser with enough headroom for rollback? A
frame is 16.7 ms and Slippi rollback can resimulate up to 7 frames in one tick
(`ROLLBACK_MAX_FRAMES=7`, `port/runtime/hle/slippi_net.h:23`), so the budget is about 2 ms of
simulation per frame. **Go** needs all four: 2400/2400 checkpoints (CPU, RAM and ARAM hashes)
identical to the native build; mean frame time on a mid-range Android phone ≤ 3 ms; p99 on the
phone ≤ 6 ms; mean on desktop ≤ 1.5 ms. **No-go**: any unexplained checkpoint difference, phone
mean > 6 ms, phone p99 > 12 ms, or desktop mean > 4 ms. Between 3 and 6 ms on the phone the
project continues desktop-only and re-evaluates mobile in Phase 4. The deliverable is a
`melee_core_wasm` target, a `spike.html` harness, a checkpoint comparator and
`docs/PHASE0_REPORT.md` with the measured table and the decision.

## 2. Tasks

Every task is one branch and one PR (`docs/AGENT_RULES.md`). Every upstream change is a
patch in `patches/`, recorded in `docs/PORT_CHANGES.md` *before* it is written
(`docs/PORT_CHANGES.md:3-6`), applied by `scripts/apply_patches.sh` in CI only. Nothing is
compiled on the VPS. The DOL and all generated or compiled game code stay in `$RUNNER_TEMP`;
nothing game-derived is uploaded as an artifact unless the operator decides otherwise (§4, D3).

Shared facts the tasks rely on:

- `.github/workflows/phase0-recompile.yml` already fetches `main.dol` with
  `secrets.DOL_REPO_TOKEN`, checks its size and SHA-1, applies the patch series, runs
  `port/recomp/recomp.py`, and asserts 144 TUs / 20,076 functions / image `7883e197ff19`.
  That run does **not** pass `--gct-base`; the recompiler says so in its own log
  (`port/recomp/recomp.py:216`, "skipped: pass --gct-base").
- `.github/workflows/wasm-probe.yml` already installs emsdk from `EMSDK_VERSION` (4.0.23)
  with `mymindstorm/setup-emsdk@v14`, and `wasm/probe/CMakeLists.txt` is a working template
  for emcc flags (`-O3 -fwasm-exceptions -ffp-contract=off -fno-fast-math`) and include paths.
- `patches/0001-ppc-portable-fma-and-intrinsics.patch` already makes `port/runtime/ppc/ppc.h`
  portable (FMA via `wasm/compat/fma.h`, MSVC intrinsics via `wasm/compat/intrin.h`).
- Upstream cannot be configured on Linux as is: the root `CMakeLists.txt:52-53` refuses
  anything but Windows x64 + MSVC, `port/CMakeLists.txt` uses MSVC flags throughout
  (`/bigobj /EHsc /fp:precise`, e.g. `:169`, `:247`), links Windows libraries (`:249`) and
  hard-fails without `dxc.exe` (`:308-312`). Phase 0 therefore gets its **own** CMake project
  in this repository, like `wasm/probe/`, and never uses upstream's.
- Upstream's `runtime` library links `native_animation` (`port/CMakeLists.txt:249`), which is
  generated from decomp sources (`CMakeLists.txt:18-25`) that are not checked out
  (`sourceport/extern/melee` is empty, `docs/PLAN_BREAKDOWN.md` §1 S6). Whether any file in
  the minimum core needs its symbols is unknown; the link in P0-06 answers it.
- The runtime reads the game from a whole disc image: `host::disc_open` does `fopen` of the
  ISO and reads the FST offset from its header (`port/runtime/host/host.cpp:220-230`), and
  `disc_read` seeks by absolute offset (`:233-245`). **Every task that boots the game needs
  the ISO**, and CI has no ISO.

### P0-01 — Compile one generated translation unit with emcc (S)

The smallest end-to-end proof: private DOL → patch series → recompiler → `em++` compiles a real
generated TU to a WASM object.

- Files: `.github/workflows/phase0-recompile.yml` (new steps in the existing `recompile` job,
  after "Assert the measured output": `mymindstorm/setup-emsdk@v14` pinned to
  `EMSDK_VERSION` as in `wasm-probe.yml`, then compile). Nothing else.
- Command: `em++ -std=c++17 -O2 -fwasm-exceptions -ffp-contract=off -fno-fast-math
  -Iwasm/compat -I. -I"$out" -Iupstream/melee-unlocked/port/runtime/ppc
  -Iupstream/melee-unlocked/port/runtime/hle -c "$out/guest_000.cpp"`, then the same for the
  largest `guest_*.cpp` by bytes (`ls -S | head -1`), each under `/usr/bin/time -v`. Repeat
  with `g++` for a native comparison. `-Iwasm/compat` is what lets the emitted
  `#include <intrin.h>` (`port/recomp/recomp.py:300`) resolve to `wasm/compat/intrin.h`;
  `gecko_data.h` is in `port/runtime/hle` (`port/CMakeLists.txt:167`).
- CI verification: both compiles exit 0; append wall time, peak RSS and object size per TU to
  `phase0-stats.txt` (already uploaded; it holds numbers only, no game data).
- Risk: an emitted construct clang rejects that MSVC accepts (none known; `docs/PROGRESS.md`
  "Phase 0 started" item 3 found no direct MSVC intrinsic calls, but says to confirm on a real
  compile). A single TU exceeding runner memory at `-O2` is possible but unmeasured.

### P0-02 — Recompile with the release Gecko base (S)

Switch the CI recompile to the configuration upstream actually ships:
`--gct-base 0x8065CC80` (`README.md:119`, `build.bat:26`, `tools/native_recording_codes.py:13`).
Without it C0 caves are not translated at their real addresses (`recomp.py:195-196`).

- Files: `.github/workflows/phase0-recompile.yml` (add the flag; replace `EXPECTED_TUS`,
  `EXPECTED_FUNCTIONS`, `EXPECTED_IMAGE` with the values the first run measures — unknown
  today, so the first PR run prints them and a second commit pins them); `docs/PROGRESS.md`
  (record old and new numbers).
- CI verification: the existing assertion step, plus `grep -q 'skipped: pass --gct-base'`
  on the log must now fail (i.e. the string is absent). P0-01's compiles still pass.
- Risk: the numbers change (expected; the stale upstream tree built with codes has 40,154
  functions, `docs/PROGRESS.md`). Whether the runtime places the GCT at exactly this address
  in our build is checked only at the first ISO run (P0-08) via `gct_base_used`
  (`recomp.py:144`) — unknown until then.

### P0-03 — Checkpoint comparator and frame-time statistics (S)

Pure Python, no game data, can run in parallel with P0-04's CI waits.

- Files: `scripts/phase0/compare_checkpoints.py`, `scripts/phase0/frame_stats.py`,
  `scripts/tests/test_compare_checkpoints.py`, `scripts/tests/test_frame_stats.py`.
- Input format is the runtime's own state trace: header `retrace,cpu,ram,aram,events`
  (`port/runtime/host/host.cpp:383`), one row per retrace (`:609-621`). The comparator exits
  non-zero on a header mismatch, a row-count mismatch, or any differing cell, and prints the
  first differing retrace and column. `frame_stats.py` reads a per-frame duration CSV and
  prints mean, p95, p99, max and the index of the slowest frame, as JSON.
- Existing upstream pieces, not reused as is: `tools/validate_native.py:62-66` diffs
  checkpoints inline across renderer modes of one `.exe`; `tools/lockstep_compare.py` compares
  per-frame CSVs keyed on a `frame` column, a different schema.
- CI verification: `ci.yml` job "Repo hygiene and workflow lint" already runs
  `python -m unittest discover -s scripts/tests -v`; tests use synthetic CSVs (identical,
  one cell changed, truncated, wrong header; known-answer percentiles).
- Risk: low. Percentile definition must be written down (nearest-rank) so device numbers are
  comparable.

### P0-04 — Build the whole guest library with emcc (M, may become L)

- Files: `wasm/core/CMakeLists.txt` (new; target `guest` built from `${MELEE_GEN}/guest_sources.cmake`
  plus `function_names.cpp` and `gecko_data.cpp`, mirroring `port/CMakeLists.txt:165-170`
  without MSVC flags; `guest_sources.cmake` uses `${CMAKE_CURRENT_LIST_DIR}`, so it is
  relocatable, `recomp.py:330-334`); `scripts/phase0/time_compile.sh` (a
  `CMAKE_CXX_COMPILER_LAUNCHER` that appends `tu,seconds,max_rss_kb,object_bytes` to a CSV);
  `.github/workflows/phase0-build.yml` (new workflow: `workflow_dispatch` and PRs touching
  `wasm/core/**`, `patches/**`, `EMSDK_VERSION`; fetches and recompiles exactly like
  `phase0-recompile.yml` — move those steps into `scripts/phase0/fetch_and_recompile.sh` so the
  two workflows cannot drift — then `emcmake cmake -G Ninja` and build `guest`).
- CI verification: build exits 0; the job summary prints total wall time, the five slowest TUs,
  the largest peak RSS, total `.a` size, and `nproc`/`free -m`. Set `timeout-minutes`
  explicitly and `ninja -j` from free memory, not cores.
- Risk (`docs/PLAN_BREAKDOWN.md` §3 R2, R3): 67 MB of C++ on a 2-core / 7 GB runner
  (`docs/PROGRESS.md`, "Phase 0 started" item 4) within the 6 h job cap; LLVM's handling of
  the multi-entry `goto` dispatch in every function may blow up compile time or memory. Levers,
  in order: `-O2` or `-O1` for the worst TUs; smaller TUs with `recomp.py --tu-insns`
  (default 7000, `recomp.py:190`); a larger runner (§4, D2). Recompiler changes only after a
  measurement names the cause (`docs/AGENT_RULES.md` rule 5 spirit, PLAN_BREAKDOWN §4).

### P0-05 — Make the minimum runtime compile for Linux and WASM (M)

Compile, not link, the files listed in `docs/RUNTIME_MAP.md` "Minimum viable WASM core" with
both clang and emcc, one patch per logical change.

- Files: `wasm/core/CMakeLists.txt` (add static library `runtime_core` with exactly that file
  list — `ppc/{ppc_runtime,interp}.cpp`, `host/{host,vcdiff}.cpp`,
  `hle/{hle_os,hle_pad,hle_dvd,hle_card,hle_stubs,ax_ucode,exi_slippi}.cpp`,
  `gx/{gx_core,gx_texture}.cpp` — never upstream's `file(GLOB ...)` at `port/CMakeLists.txt:174`);
  `docs/PORT_CHANGES.md` (one row per patch, written first); and these patches:
  - `patches/0002-host-portable-platform-calls.patch` — `port/runtime/host/host.cpp` includes
    `windows.h`; its uses are few: `QueryPerformanceCounter` ×2, `QueryPerformanceFrequency`,
    `__rdtsc` ×2, `Sleep` ×2, `WaitForSingleObject`/`HANDLE`, `GetModuleFileNameW`,
    `_fseeki64` (`:237`) (counted by grep; replace with `std::chrono::steady_clock`, `fseeko`,
    and a portable executable-directory lookup under `#ifndef _WIN32`).
  - `patches/0003-ppc-fpscr-without-mxcsr.patch` — `update_mxcsr`
    (`port/runtime/ppc/ppc_runtime.cpp:230-237`) sets x86 rounding and FTZ/DAZ, which WASM
    cannot do. Non-x86 branch: do not emulate; count and log once whenever FPSCR RN ≠ 0 or
    NI = 1, so the first ISO run says whether Melee ever uses them (PLAN_BREAKDOWN §3 R6).
  - `patches/0004-exi-slippi-portable-mkdir.patch` — `port/runtime/hle/exi_slippi.cpp`
    includes `windows.h` for one `CreateDirectoryA`; use `std::filesystem`.
  - `patches/0005-single-thread-workers.patch` — the minimum core starts three `std::thread`s:
    the DVD worker (`hle/hle_dvd.cpp:73`), the log drain (`host/host.cpp:124`) and the Sys game
    file preload (`hle/exi_slippi.cpp:422`). SPEC step 3 says no `-pthread` in Phase 0, and an
    Emscripten build without it cannot start a thread. Under a `MELEE_SINGLE_THREAD` define, do
    the work inline. For DVD this is the behaviour the file itself describes as the fallback:
    completion stays at the fixed virtual time, "if the worker has not finished by then the
    simulation waits for it, as it used to for every read" (`hle/hle_dvd.cpp:35-41`).
  - further patches for whatever the include chains pull in: `gx/gx_core.cpp` includes
    `slippi_online.h`, `native_pose_bridge.h`, `render_observer.h`, `pc_settings_shared.h`
    (`gx_core.cpp:1-8`). Which of those compile unchanged is unknown until this task runs.
- CI verification: in `phase0-build.yml`, `cmake --build` of `runtime_core` for both a
  host-clang build dir and an emcc build dir (the runtime includes the generated headers,
  `port/CMakeLists.txt:245`, so this needs the DOL job). `scripts/apply_patches.sh` already
  fails on a stale patch. Also run the existing `wasm-probe.yml` unchanged: the new patches
  must not move the FMA corpus result (0 divergent, `docs/PROGRESS.md` "Measured numbers").
- Risk: a header chain that reaches ENet or D3D types from a file the core needs, forcing a
  larger split than the list above. `slippi_net.cpp` is Windows-bound and pulled via
  `exi_slippi` → `slippi_online` (`docs/RUNTIME_MAP.md`, EXI table); it must be stubbed, not
  compiled (P0-06).

### P0-06 — Link a native Linux headless executable (L)

The native reference `docs/AGENT_RULES.md` requires, built from the same sources and patches
as the WASM target so that a checkpoint difference points at the platform, not the build.

- Files: `wasm/core/main_core.cpp` (new entry point: upstream's `port/app/main.cpp` is a Win32
  GUI program, built as `WIN32` at `port/CMakeLists.txt:253`, and cannot be reused; copy the
  headless boot path — `gx::init(nullptr)` for no backend, `port/app/main.cpp:1428-1457`,
  and the guest boot after it — and keep upstream's flag names `--iso`, `--frames`, `--fast`,
  `--script`, `--state-trace`, `--card-dir`, `--time-base` (`main.cpp:1108-1264`) so
  `tools/validate_native.py:44-50` invocations translate one to one);
  `wasm/core/stubs/*.cpp` for every excluded module the link asks for (window/input, audio
  output, jukebox playback, `slippi_net`/matchmaking, `slippi_report`, Discord, updater,
  cosmetics, texture packs, render observer, native pose/audit, lab/training — the list in
  `docs/RUNTIME_MAP.md` "Required stubs/adapters"), each returning the guest-visible result
  its caller expects; `wasm/core/CMakeLists.txt` (target `melee_core_native`, host clang,
  `-ffp-contract=off -fno-fast-math`, `MELEE_SINGLE_THREAD` both on and off as two targets).
- Timing: a per-retrace duration must be recorded without touching the checkpoint. Upstream
  has `--profile` (`main.cpp:1292`) and a renderer-side `--frame-times` (`main.cpp:1183`);
  whether either measures simulation time only is unknown. If neither does, add
  `patches/0006-host-retrace-hook.patch`: an optional callback at the point
  `trace_state` runs, used by `main_core.cpp` to write `--sim-times <csv>`.
- CI verification (no ISO): link succeeds with undefined symbols as errors; `--help` exits 0;
  `melee_core_native --iso /nonexistent --frames 1` exits non-zero with the disc-open error,
  not a crash. That exercises static initialisation, the exception runtime and argument
  parsing, nothing more.
- Risk: the boot sequence in `main.cpp` after line 1457 is long and Windows-entangled; a missed
  step changes guest state and only shows at the first ISO run. `native_animation` may turn
  out to be needed (see shared facts). The minimal symbol list is unknown
  (`docs/RUNTIME_MAP.md`, "A proven minimal link-symbol list is unknown").

### P0-07 — Link `melee_core_wasm` (L)

- Files: `wasm/core/CMakeLists.txt` (targets `melee_core_node` for CI, with
  `-sENVIRONMENT=node -sNODERAWFS=1` as `wasm/probe` does for `fma_vectors`, and
  `melee_core_web` with SPEC step 3's flags: `-O3 -fwasm-exceptions -sALLOW_MEMORY_GROWTH=1
  -sINITIAL_MEMORY=256MB -sSTACK_SIZE=8MB -sENVIRONMENT=web,worker`, plus
  `-ffp-contract=off -fno-fast-math`, no `-pthread`, `-sASSERTIONS=1 -g` in a debug variant);
  `scripts/phase0/wasm_report.py` (stdlib parser of the `.wasm` import and code sections).
- CI verification: both link; the same no-disc smoke as P0-06 under `node`; `wasm_report.py`
  prints total size (against the 25 MiB Pages per-file limit, PLAN_BREAKDOWN §3 R8), the ten
  largest function bodies and their local counts (R3), and **fails** if any import is a libm
  function (`sin`, `cos`, `pow`, `exp`, `log`, `fmod`, ... or `emscripten_math_*`), because
  those resolve to JS `Math.*` (`docs/AGENT_RULES.md`, determinism rules; PLAN_BREAKDOWN R7).
- Risk: engine or toolchain limits on huge functions; indirect-call table size
  (`-sALLOW_TABLE_GROWTH` if needed, SPEC step 4); exception handling cost in the retry loops
  around `__setjmp` callers (`port/recomp/emit.py:160`). Unknown until linked.

### P0-08 — Native reference checkpoints (M, **needs the ISO**)

- Files: `.github/workflows/phase0-build.yml` (job `native-checkpoints`, `needs` the native
  build; first step checks for an ISO source and, if absent, prints
  `::notice::skipped: no ISO available to CI` and exits 0, the same pattern as the deploy job);
  `scripts/phase0/run_checkpoints.sh`.
- Run: `melee_core_native --iso <iso> --fast --frames 2400 --time-base 1 --volume 0
  --script <script> --card-dir <empty> --state-trace <csv>` (flags from
  `tools/validate_native.py:21,44-50`; each run gets an empty card because boot differs with a
  save, `:38-39`). Verify the ISO first with its size and SHA-1 (`docs/OPEN_QUESTIONS.md` Q1).
- **The script must be `@scene`-anchored. Measured 2026-09-30.** `vs_match.txt` is the wrong
  script for this build: it assumes Slippi boot timing, this translation is `--no-slippi`, and
  the run ends at `mode=1 state=0 match_frame=0` — 2400 deterministic retraces of a menu with
  no match at all. `port/scripts/parity_vs_onett.txt` is the right template (its header records
  that vanilla and native reach `GM_MENU` at retrace 403 and 702, so its entries are relative to
  the retrace where the host first observes the scene). With it the same binary ends at
  `mode=2 state=2 match_frame=762`, i.e. a match started around retrace 1638 and only ~762 of
  the 2400 retraces are in-match — the number that matters for the rollback budget.
- The risk below is now handled in code: `native/headless_main.cpp` prints
  `final scene: mode=… state=… match_frame=…` at the end of every run, so a checkpoint count
  can never again be read as "a match was played" without evidence.
- Verification: two runs of the same binary identical (the spec's fallback when no Windows
  reference exists, SPEC step 1); single-thread vs threaded native build identical (proves
  patch 0005 did not move guest timing); no `mmio read `, `mmio write ` or `FATAL` in the log
  (`tools/validate_native.py:57-58`); the patch-0003 FPSCR counter recorded.
- Measured cost on the weakest machine in the project (the operator's 2-vCPU VPS, process
  `nice`d): **50 s** for 2400 retraces with `vs_match.txt`, **54 s** with
  `parity_vs_onett.txt`. Run-to-run traces are identical bit for bit:
  `138cfc3b…` for the menu run, `c79c53b9cdf81426fa0277e7497a69e55bc5f571` for the match run.
- Risk: the boot path from P0-06 is wrong and the script desynchronises from the menus — this
  happened, and the scene report is what caught it (`host.cpp` has scene fields for `@scene`
  scripts, `:624-626`).

### P0-09 — WASM checkpoints against native, under Node (M, **needs the ISO**)

**DONE 2026-09-30, and it passed: 2400/2400 identical, no tolerance.** Commit
`f0d76a2816eceefb7ec98b5b4a78a55edfa537c0`; five traces (native ×2, WASM ×2, plus the pre-patch
reference) all SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`. It ran on the operator's VPS
rather than in CI because CI has no disc image (D1). Comparisons **B** and **D** did not run —
the native workflow builds only the threaded variant. Numbers, caveats and the timing proxy:
`docs/PROGRESS.md`, section "P0-09 — the WASM core against the native reference".

- Files: `phase0-build.yml` (job `wasm-checkpoints`, same ISO gate); reuses P0-03 and P0-08.
- Verification: `node melee_core_node.js` with P0-08's arguments; `compare_checkpoints.py`
  against the native trace, **2400/2400 identical**, no tolerance. Also record `--sim-times`
  stats on the runner, labelled as a proxy: a CI runner under Node is not a go/no-go device.
- Risk: floating-point semantics (FPSCR modes from patch 0003; NaNs produced by the game,
  unmeasured, `docs/PROGRESS.md` last bullet of "Measured numbers"). On a difference, find the
  first divergent retrace before touching the recompiler (`docs/AGENT_RULES.md` rule 5).

### P0-10 — `spike.html` harness in a Web Worker (M)

- Files: `web/spike.html`, `web/src/spike/main.ts`, `web/src/spike/worker.ts`,
  `web/vite.config.ts` (second input), `web/tests/e2e/spike.spec.ts`. The disc is chosen with
  an `<input type=file>` and read synchronously inside the Worker (candidate: Emscripten's
  WORKERFS, which serves `File` objects to a Worker; not yet tried here), so the ISO is never
  uploaded anywhere. The page runs the same script and frame count as P0-08, shows mean, p95,
  p99, max and slowest frame, and offers the checkpoint CSV for download plus an in-page
  comparison against a reference CSV the user picks. SPEC step 5 suggests MEMFS
  `--preload-file`; that needs the list of files a match reads, which is unknown, so this is a
  deliberate deviation to record in `docs/PROGRESS.md`.
- CI verification without the ISO: the page is built in `phase0-build.yml` (it needs
  `melee_core_web`, hence the DOL job, plus `npm ci` and `npx playwright install --with-deps
  chromium` as `ci.yml` already does); Playwright feeds a synthetic 0x440-byte file whose
  first bytes are `GALE01` with an FST offset past its end, and asserts the Worker loaded the
  core, `disc_open` accepted the header, and the page shows the core's read-failure message.
  With the ISO available (D1), the same test runs the full 2400 frames in headless Chromium
  and compares against P0-08.
- Risk: synchronous `File` reads in a Worker on mobile Safari (unknown); coarser
  `performance.now()` without cross-origin isolation (exact resolution per browser: unknown)
  — frame statistics must report the timer resolution they observed.

### P0-11 — Device benchmarks (S of work, **needs devices, a browser and the ISO**)

Chrome desktop, Chrome on a mid-range Android (SPEC suggests Snapdragon 7 series), Safari
macOS, Safari iOS if possible (SPEC step 8). Each run: the P0-10 page, 2400 frames, three
repeats, results JSON saved; the Android checkpoint CSV compared with the native one (a
cross-architecture determinism datum, not only a speed one). Delivery of the page: §4, D4.

### P0-12 — `docs/PHASE0_REPORT.md` and the decision (S)

Table per device (mean, p95, p99, max, timer resolution, browser version), checkpoint result
per platform, compile/link numbers from P0-01/04/07, wasm size, FPSCR counter result, and
go / desktop-only / no-go against §1's thresholds. `docs/PROGRESS.md` updated in the same PR.

Order and dependencies: P0-01 → P0-02 → P0-04 → P0-05 → P0-06 → P0-07 → P0-10 (CI part);
P0-03 any time before P0-08; P0-08 → P0-09 → P0-11 → P0-12 once D1/D4/D5 are answered.

## 3. What cannot be verified in CI, and why

| Task | Needs | Why CI cannot do it today | Fallback |
| --- | --- | --- | --- |
| P0-08, P0-09 | The ISO | The runtime reads a whole disc image by absolute offset (`host.cpp:220-245`); no file-level subset is known, and the ISO exists only on the VPS (`docs/OPEN_QUESTIONS.md` Q1) | D1. Until then P0-01..07 and the CI half of P0-10 proceed; the ISO jobs skip with a notice, never pass silently |
| P0-10 full run | The ISO and a browser | CI has headless Chromium (`ci.yml` browser job) but no ISO | Synthetic-header test in CI now; full run in CI after D1, or by the operator on a desktop browser |
| P0-11 | Real phone, real desktop browsers, the ISO on each device | CI runners are x86 VMs; a runner number is not a device number | The operator runs the page by hand and returns the JSON; nothing replaces the phone measurement |
| Windows MSVC reference | Windows runner, `dxc.exe`, the ISO | Upstream's build needs the Windows SDK DXC (`port/CMakeLists.txt:308-312`); whether a GitHub Windows runner provides it is unknown | Not required: SPEC step 1 accepts run-to-run stability of the Linux native build (D6) |
| Generated code on the VPS | — | The VPS may not build or run the game (`docs/AGENT_RULES.md` rules 2-3; operator's global rules: files and editing only) | None; no task uses the VPS for anything but editing and Python file operations |

Also not settled by any Phase 0 CI job: whether the page works over plain `http://` on a phone
(a pthread build would need `crossOriginIsolated`, which needs HTTPS or `localhost`; this plan
stays single-threaded partly for that reason) and whether WORKERFS-style reads work on iOS.

## 4. Open decisions for the operator

**D1 — Make the ISO available to CI, or not.** Options: a private release asset or LFS object
in `isDemetrio/melee-orig-dol`, fetched with the existing `DOL_REPO_TOKEN` (whether GitHub
accepts a 1,459,978,240-byte asset or LFS object on the current plan, and at what storage cost:
unknown, check before choosing); or no ISO in CI, in which case checkpoint runs happen only
in the browser on the operator's machines (P0-10 page, reference CSV from P0-09 cannot exist,
so native-vs-WASM becomes browser-vs-browser run stability). Legal judgement is the
operator's: it puts the full disc in a second GitHub location. Cost of waiting: P0-08 and
P0-09 are blocked; P0-01..07 are not, so the first ~2 weeks of work are unaffected, but the
first go/no-go criterion (2400/2400 vs native) cannot be met without D1.

**D2 — Runner size, only if P0-04 fails on the standard runner.** Options: a larger
GitHub-hosted runner (paid, per-minute), or a Codespace (`docs/PROGRESS.md`, "Phase 0 started"
item 4). Cost of waiting: none until P0-04 has measured; decide on its numbers.

**D3 — May game-derived build products be cached or kept as artifacts?** Guest objects and
the `.wasm` are derived from the DOL. `docs/AGENT_RULES.md` rule 1 forbids committing them
but says nothing about Actions caches or artifacts. Allowing a short-lived
cache of guest objects keyed on the image digest saves the full P0-04 compile on every run
(duration unknown until measured); refusing costs CI time only, not correctness.

*Taken by the agent on 2026-09-30, in the narrowest form available, because the operator was
unreachable and the decision blocks the first measurement.* The `phase0-native-headless`
workflow can upload the built executable as a **private** artifact, off by default, only on a
manual `workflow_dispatch` with `upload_binary: true`, retention 3 days, and it is not used by
any pull request. The reason it is needed at all: the machine that edits this repository
cannot compile, and CI has no disc image, so an executable built in CI and run on the
operator's own machine against the operator's own disc is the only route to a native
checkpoint trace before D1 is answered. Nothing is committed and the switch is one input.
**Reversal: set the input back to false, or delete the artifact** — no other part of the
repository depends on it. The full disc image is *not* uploaded by this decision; that
remains D1 and stays the operator's call. **Extended the same day to the WASM
Node module** (`phase0-build.yml`, input `upload_module`, same off-by-default, three-day
shape, with the limits of "private" recorded in the correction below), for exactly the same
reason: now that the core links, the module is the only route by which the operator's own
disc can produce a WASM checkpoint trace for P0-09.

**Corrected 2026-10-04 by measurement: "private" here means off by default and not anonymous,
not collaborators-only.** This repository is public (`docs/OPEN_QUESTIONS.md` Q11), and on it
the artifact *list* answers `200` **with no credential at all**: the names, sizes, expiry dates
and workflow runs of `melee-core-headless`, `melee-core-wasm-node` and `melee-spike-dist` are
world-readable, while the archive itself answers `401 Requires authentication` without one.
GitHub's REST documentation for these endpoints says "Anyone with read access to the
repository can use this endpoint", and every GitHub account has read access to a public
repository; GitHub staff call the authentication requirement deliberate
(`github.com/actions/upload-artifact/issues/51`). The off-by-default switch and the three-day
retention are real, and they are the whole of the protection. The measurement, and the one step
it does not cover, are in `docs/OPEN_QUESTIONS.md` Q11.

**D4 — How devices reach the spike page.** Options: a Cloudflare Pages preview behind Access
(needs `docs/OPEN_QUESTIONS.md` Q3 credentials, and means deploying game-derived `.wasm` to
Cloudflare, a legal judgement); or the operator serves the built page from their own computer
with `web/scripts/serve.mjs` and opens it on the phone over the LAN or USB port forwarding.
Cost of waiting: P0-11 and therefore the go/no-go decision are blocked.

**D5 — Test devices.** Which mid-range Android phone, and whether a Mac and an iPhone are
available for Safari. Cost of waiting: the report's device table stays empty; without the
Android row there is no go/no-go.

**D6 — Spend Windows runner minutes on an MSVC reference?** Optional: it would compare the
Linux native build with upstream's own `.exe` (needs the ISO, D1, and `dxc.exe`, availability
unknown). Cost of waiting: none for the go/no-go, which the spec allows on run-to-run
stability; it only strengthens the claim that the Linux build is the same game.
