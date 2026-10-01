# Frame-time consultation — 2026-10-01

Evidence: [progress](PROGRESS.md), [device procedure](PHASE0_DEVICE_PLAN.md),
[optimisation experiment](OPT_LEVEL_EXPERIMENT.md), [harness experiment](HARNESS_OVERHEAD_EXPERIMENT.md),
[iPhone results](DEVICE_TEST_IPHONE16PRO.md), [Phase 0 tasks](PHASE0_TASKS.md), and the
operator's newer OnePlus/VPS measurements supplied with this consultation. No new run was made.

**1. CPU-bound is the leading hypothesis, not an established attribution.**

The headless, unpaced core has no GPU rendering or vsync bottleneck. The iPhone's in-match
mean is 3.03–3.24 ms (p99 3.96–5.64); the 2016 OnePlus 3 takes 13.94 ms in Firefox
(three repeats) and 16.06 ms in Chrome (one), all bit-exact. A slower processor taking
4–5 times longer is consistent with CPU execution dominating, including instruction-cache,
data-cache and memory stalls. It does not prove arithmetic throughput is the bottleneck.

Geekbench 6 single-core (~336 versus ~3408–3539) is a different workload, not a clock-speed
ratio. Its ~10x gap cannot predict this program's scaling. Browser code generation, working
set, thermals and storage differ too: iPhone used the file picker, OnePlus OPFS. Both disc
sources ultimately use WORKERFS in this checkout; OPFS does not mean all reads are in RAM.
Sublinear scaling neither disproves CPU saturation nor proves an I/O floor. The old
7.9–8.4 ms mid-range prediction is not a measured Android result; the OnePlus is not today's
mid-range acceptance device either.

VPS totals, 57 s native versus 84 s Node (~24 versus ~35 ms/retrace), imply only ~1.47x
(~1.45x rounded) end-to-end overhead. They rule out claiming an observed 10x WASM penalty,
but are not in-match simulation timings. Earlier matched in-match means were 15.20 versus
27.34 ms (~1.80x, PROGRESS). Startup, menus, hashing, filesystem work and scheduling prevent
using either total/2400 as the phone's `sim_ms`, or treating 1.45x as an optimisation ceiling.

`native/headless_host.cpp` records `sim_ms` before checkpoint bookkeeping and resumes its
clock afterward. The native trace-on/off experiment found no measurable in-match effect
(−0.8%, versus ~5% noise); it supplies no correction for Safari. Its ~11 s is the sum of
**match** frames, so subtracting it from ~53 s does not isolate I/O: non-match simulation
also belongs in the remainder. Wall time alone cannot tell where time went.

**Cheapest discriminator:** measure CPU seconds against elapsed seconds for one existing
Node run, using `/usr/bin/time -v` around the **Node invocation itself**, after ISO validation
(use the runner's `--dry-run` command, fresh external output/card directory, same arguments).
Do not time the entire shell script: its full-disc SHA-1 is additional CPU and I/O. No build,
phone or hardware is required; the supplied `opt-O1/melee_core_node.js` suffices for this
first diagnostic. Near one CPU-second per elapsed second supports CPU saturation; a large
deficit points to waiting or VPS descheduling/steal, not automatically disc I/O. Inspect those
counters before blaming storage. V8 compilation threads can inflate aggregate CPU usage.
This settles the coarse VPS busy-versus-waiting question, not Safari's in-match attribution;
if mixed, sample the simulation thread over the match interval. A function profile is then
needed to split dispatch, guest code, FMA, memory and host work. No device-independent
measurement can conclusively settle the phone-specific split.

**2. Ranked optimisation candidates for mid-range Android.**

Order is expected useful in-match gain, with confidence and implementation cost considered.
Ranges below are planning hypotheses for total frame-time reduction, not measurements or
promises. If a region occupies fraction `f` and is sped up `s` times, the reduction is
`f × (1 − 1/s)`; no hot-region fractions have been measured here.

| Rank / lever | Expected gain and work | WASM size cost | Bit-exactness risk and verification beyond the common gate |
| --- | --- | --- | --- |
| 1. Per-file `-O2`, then separately `-O3`, on measured hot TUs | First look for single-digit %, plausibly 0–10%; low implementation cost. Profile PPC runtime and generated guest code, not just source size. | Unknown, potentially substantial from inlining; not necessarily “a few bytes.” Keep other files and link at `-Oz`. | Low–medium with strict FP unchanged. Inspect actual compile commands and final module; compare each candidate independently. |
| 2. PPC dispatch / fallback interpreter | Potentially larger than flags if hot, essentially zero if cold; highest structural upside, higher engineering cost. This is a static-recomp port with an interpreter fallback, not evidence of a fully interpreted workload. Profile indirect dispatch versus opcode decoding before trying lookup caching or block dispatch. | Small tables through substantial duplicated block code; measure. | High: preserve PC, interrupts, exceptions, self-modifying-code invalidation and virtual timing. Add focused synthetic dispatch tests, then full gate; diagnose first divergence. |
| 3. Strict wasm SIMD in a proven hot independent loop | Usually small whole-frame gain until a vectorisable hotspot is found; 2–4x kernel throughput is not 2–4x frame throughput. Branch-heavy guest dispatch is a poor target. Hash SIMD mainly speeds excluded bookkeeping. | Typically local code growth; scalar fallback adds more. | Medium–high for FP: preserve operation order, NaN/signed-zero and PPC FMA semantics; no relaxed SIMD or reassociation. Compare scalar/SIMD kernels, FMA corpus and browser traces; feature-test supported devices. |
| 4. `wasm-opt` post-processing | Expect marginal 0–few % or regression: Emscripten already performs Binaryen optimisation at link. Try one pinned pass pipeline, not an unbounded sweep. | Can shrink or grow; measure final web bytes. | Low–medium, never fast-math assumptions. Validate module/features/imports, loader compatibility and full gate after processing both Node and web artifacts. |
| 5. Cut disc I/O / prefetch assets (“T8”) | Likely helps startup and loading tails more than steady match mean; potentially high only if measured in-match reads are costly. Count bytes, calls and elapsed read time separately for match and boot. | Small adapter code; cached assets cost RAM/storage, not executable bytes. No whole-ISO MEMFS copy on phones. | Medium: preserve bytes and virtual DVD completion order. Cold/warm and file/OPFS A/B, read counters, peak RAM, full gate. |
| 6. pthreads / SharedArrayBuffer | Approximately zero automatic serial-simulation gain; can offload independent I/O/audio/render work after measuring it. Rollback frames depend on preceding state and cannot simply run concurrently. | Runtime/worker/atomic overhead plus possibly a second fallback build; quantify. | High: races and completion order. Needs HTTPS, COOP/COEP and isolation; test threaded/fallback traces repeatedly under scheduling variation and measure thermal/memory costs. |

Common gate for **every build change**: all 2400 checkpoints equal the native reference,
trace SHA-1 `c79c53b9cdf81426fa0277e7497a69e55bc5f571`, final scene
`mode=2 state=2 match_frame=762`; retain `-ffp-contract=off -fno-fast-math`, no
`-mrelaxed-simd`. Run Node parity plus real browser parity before shipping. Compare the
762 in-match rows on the same Android/browser/disc source, three alternating baseline/candidate
pairs with cooling; report mean and p99. Node is a screening proxy only.

Toolchain basis: Emscripten documents [separate compile/link optimisation](https://emscripten.org/docs/compiling/Building-Projects.html),
[Binaryen link optimisation](https://emscripten.org/docs/tools_reference/emcc.html),
[SIMD](https://emscripten.org/docs/porting/simd.html) and
[pthread deployment requirements](https://emscripten.org/docs/porting/pthreads.html).
Use the repository's pinned toolchain, not an incidental upgrade.

Task-label correction: PHASE0_TASKS has P0-08 (checkpoints), not T8 disc optimisation.
[PLAN_BREAKDOWN T8](PLAN_BREAKDOWN.md#t8--asset-manifest-tooling-synthetic-disc-only)
is asset-manifest tooling; extraction alone does not remove runtime reads. The relevant current
runtime is `native/headless_host.cpp::disc_read` and the single-thread DVD path.

**3. One next optimisation experiment: compile the two PPC runtime TUs at `-O2`.**

After the cheap CPU accounting above, make one bounded flag experiment: in
`wasm/core/CMakeLists.txt`, append source-specific `COMPILE_OPTIONS -O2` for
`${PORT}/runtime/ppc/ppc_runtime.cpp` and `${PORT}/runtime/ppc/interp.cpp`.
Confirm the final optimisation option is `-O2` in the **offline_core** compile commands;
changing only `runtime_core` would change a compile gate, not the shipped executable.
Keep generated guest files, other sources and final link at `-Oz`; no LTO or SIMD changes.
This tests a plausible dispatch hotspot cheaply; it does not claim those files are already
proven hot. Build baseline and candidate from the same source/toolchain in Actions.

Accept only if the final web WASM is ≤ **26,214,400 bytes**, the complete common trace gate
passes, and the median of three paired Android in-match mean reductions is ≥ **5%**, with
all three pairs improving and no >5% worsening of the worst-repeat p99. Reject inconclusive
thermal/noise-contaminated trials before applying that rule. Require stable Node screening
first; no phone result means no shipping speed claim. Acceptance is an improvement, not a
mobile GO: the existing ≤3 ms mean / ≤6 ms p99 criteria still apply.

Abandon this two-file `-O2` candidate if it exceeds size, changes any checkpoint, or fails that
speed/tail criterion after stable repeats. A profile showing negligible PPC runtime time is
reason to skip it and select the actual hot guest TU, not escalate blindly to `-O3`.

The shipped 16,323,255-byte module has **9,891,145 bytes** of headroom. Global `-O1` stays
closed: 85,658,030 bytes is 5.25x the shipped size and **3.27x the Pages limit**, despite its
measured ~7% speed gain and exact trace. No strip/compression claim fixes that code-size gap.
Keep Pages at 500 builds/month and R2 at 10 GB: one baseline/candidate pair, no broad flag
matrix, paid tier, hosting exception or extra game-data copies. This consultation changes
only this document; it neither runs nor implements the experiment.
